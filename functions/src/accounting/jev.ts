import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import {
  requireCaller,
  POSTING_ROLES,
  CORRECTING_ROLES,
  assertFundInScope,
  notFound,
  invalid,
} from '../lib/context';
import { recordTransition } from '../lib/audit';
import { checkExpenseDebitsHaveFpp } from '../lib/rules';
import { issueNumber, issueNumbers, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { hasJevNumber, UNNUMBERED_JEV } from '../lib/jevNumbers';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf, todayPh } from '../lib/period';
import {
  postJevInTransaction,
  buildReversalLines,
  createJevInTransaction,
  type JevData,
} from '../lib/ledger';

/**
 * postJev - the one place the General Ledger is written.
 *
 * Posting is restricted to the Municipal Accountant and administrators. Once
 * posted, the entry is immutable: security rules refuse client updates to a
 * POSTED JEV and nothing anywhere updates a `ledgerEntries` document. That
 * immutability is the whole basis on which a trial balance printed from CFMS can
 * be relied upon.
 */
export const postJev = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, POSTING_ROLES);
  const { jevId } = (request.data ?? {}) as { jevId?: string };
  if (!jevId) throw invalid('A journal entry voucher id is required.');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.jevs).doc(jevId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The journal entry voucher');

    const jev = snap.data() as JevData;

    assertFundInScope(caller, jev.fundCode);

    const period = jev.period ?? periodOf(jev.jevDate);
    await assertFiscalYearOpen(jev.fiscalYear, tx);
    await assertPeriodOpen(jev.fiscalYear, period, jev.fundCode, `JEV ${jev.jevNo || jevId}`, tx);

    await assertExpenseDebitsCarryAnFpp(jev);

    /*
     * ---- THE JEV NUMBER IS DRAWN HERE, AT POSTING --------------------
     *
     * Not when the voucher that raised the entry was approved. An entry that
     * has not been posted is not in the journal, and a number taken from the
     * journal series for an entry that may never be posted - a voucher whose
     * approval is undone, say - leaves a hole in the series that nobody can
     * account for.
     *
     * Only when the entry has none. Every other path in CFMS creates and posts
     * an entry in one act and brings its number with it; this touches nothing
     * there.
     *
     * Drawn before any write, as the ordering requires.
     */
    let jevNo = jev.jevNo;
    if (!hasJevNumber(jevNo)) {
      const cfg = await loadNumberingConfig('JEV');
      const bookCode = await bookCodeForFund(jev.fundCode);
      const [issued] = await issueNumbers(tx, [
        {
          cfg,
          parts: { bookCode, fundCode: jev.fundCode, fiscalYear: jev.fiscalYear, month: period },
        },
      ]);
      jevNo = issued as string;
    }

    const result = postJevInTransaction(tx, caller, jevId, { ...jev, jevNo });

    recordTransition(tx, {
      caller,
      event: 'POST',
      entityType: COL.jevs,
      entityId: jevId,
      entityRef: `JEV ${jevNo}`,
      fiscalYear: jev.fiscalYear,
      fundCode: jev.fundCode,
      action: 'POST',
      previousStatus: jev.status,
      newStatus: 'POSTED',
      remarks: `${result.ledgerEntryCount} ledger entries, ${(jev.totalDebit / 100).toFixed(2)}.`,
    });

    /*
     * Tell the source document that its entry is now in the books.
     *
     * ---- WHY THIS NO LONGER SETS THE VOUCHER TO PAID ------------------
     *
     * It used to, and that was two different facts wearing one word. Posting
     * writes the books; it does not pay anybody. A voucher is paid when the
     * Treasurer draws a check or an advice against it, which is a different
     * officer on a different day.
     *
     * The cost of conflating them was concrete: the Treasury payment queue
     * lists APPROVED vouchers, so an entry posted by the Accountant took the
     * voucher out of the queue before any check had been drawn, and the
     * Treasurer could no longer see a voucher that nobody had paid.
     *
     * What is written instead is the number the entry has just been given and
     * the moment it was posted, so the voucher's own screen can say "in the
     * General Ledger as JEV ..." without asking the entry.
     */
    if (jev.sourceType === 'DV' && jev.sourceId) {
      tx.update(db.collection(COL.disbursementVouchers).doc(jev.sourceId), {
        jevNo,
        jevPostedAt: result.postedAt,
      });
    }
    if (jev.sourceType === 'RCD' && jev.sourceId) {
      tx.update(db.collection(COL.rcds).doc(jev.sourceId), { status: 'POSTED' });
    }
    if (jev.sourceType === 'PAYROLL' && jev.sourceId) {
      tx.update(db.collection(COL.payrolls).doc(jev.sourceId), { status: 'PAID' });
    }
    if (jev.sourceType === 'LIQUIDATION' && jev.sourceId) {
      tx.update(db.collection(COL.liquidations).doc(jev.sourceId), { status: 'POSTED' });
    }

    return {
      jevId,
      jevNo,
      ledgerEntryCount: result.ledgerEntryCount,
      postedAt: result.postedAt,
    };
  });
});

/**
 * reverseJev - the only way to undo a posted entry.
 *
 * Creates a mirror-image JEV and posts it immediately, then marks the original
 * as REVERSED with a pointer in each direction. Both entries remain in the
 * ledger forever.
 *
 * This is deliberately not a delete. An auditor reading the books should be
 * able to see that an error was made and that it was corrected, and by whom. A
 * ledger that can be quietly rewritten is not evidence of anything, and a
 * system that permits it will eventually be asked to.
 */
export const reverseJev = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, POSTING_ROLES);
  const { jevId, reason, reversalDate } = (request.data ?? {}) as {
    jevId?: string;
    reason?: string;
    reversalDate?: string;
  };

  if (!jevId) throw invalid('A journal entry voucher id is required.');
  if (!reason?.trim()) {
    throw invalid('A reason for the reversal is required. It is printed on the reversing entry and recorded in the audit trail.');
  }

  const jevConfig = await loadNumberingConfig('JEV');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.jevs).doc(jevId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The journal entry voucher');

    const original = snap.data() as JevData & { reversedByJevId?: string };

    if (original.status !== 'POSTED') {
      throw new HttpsError(
        'failed-precondition',
        `Only a posted entry can be reversed. JEV ${original.jevNo} is ${original.status.toLowerCase()}. An unposted entry can simply be cancelled.`,
      );
    }
    if (original.reversedByJevId) {
      throw new HttpsError(
        'failed-precondition',
        `JEV ${original.jevNo} has already been reversed. Reversing it twice would double the correction.`,
      );
    }

    assertFundInScope(caller, original.fundCode);

    // The reversal is dated in an open period. Defaulting to today rather than
    // to the original date keeps a closed month closed - reopening a period to
    // book a correction should be a deliberate act, not a side effect.
    const revDate = reversalDate ?? todayPh();
    const revPeriod = periodOf(revDate);
    const revYear = Number(revDate.slice(0, 4));

    await assertFiscalYearOpen(revYear, tx);
    await assertPeriodOpen(revYear, revPeriod, original.fundCode, `Reversal dated ${revDate}`, tx);

    const bookCode = await bookCodeForFund(original.fundCode);
    const reversingNo = await issueNumber(tx, jevConfig, {
      bookCode,
      fundCode: original.fundCode,
      fiscalYear: revYear,
      month: revPeriod,
    });

    const reversingLines = buildReversalLines(original.lines);

    const { jevId: reversingJevId } = createJevInTransaction(tx, caller, {
      jevNo: reversingNo,
      jevDate: revDate,
      fiscalYear: revYear,
      period: revPeriod,
      fundCode: original.fundCode,
      book: original.book,
      sourceType: 'REVERSING',
      sourceId: jevId,
      referenceNo: original.jevNo,
      payeeId: original.payeeId ?? null,
      payeeName: original.payeeName ?? null,
      particulars: `Reversal of JEV ${original.jevNo}. ${reason.trim()}`,
      lines: reversingLines,
    });

    const reversingJev: JevData = {
      jevNo: reversingNo,
      jevDate: revDate,
      fiscalYear: revYear,
      period: revPeriod,
      fundCode: original.fundCode,
      book: original.book,
      sourceType: 'REVERSING',
      sourceId: jevId,
      referenceNo: original.jevNo,
      payeeId: original.payeeId ?? null,
      payeeName: original.payeeName ?? null,
      particulars: `Reversal of JEV ${original.jevNo}. ${reason.trim()}`,
      lines: reversingLines,
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      status: 'DRAFT',
    };

    postJevInTransaction(tx, caller, reversingJevId, reversingJev, { isReversal: true });

    tx.update(ref, {
      status: 'REVERSED',
      reversedByJevId: reversingJevId,
      remarks: `Reversed by JEV ${reversingNo} on ${revDate}: ${reason.trim()}`,
    });

    tx.update(db.collection(COL.jevs).doc(reversingJevId), {
      reversesJevId: jevId,
    });

    recordTransition(tx, {
      caller,
      event: 'REVERSE',
      entityType: COL.jevs,
      entityId: jevId,
      entityRef: `JEV ${original.jevNo}`,
      fiscalYear: original.fiscalYear,
      fundCode: original.fundCode,
      action: 'REVERSE',
      previousStatus: 'POSTED',
      newStatus: 'REVERSED',
      remarks: `Reversed by JEV ${reversingNo}. ${reason.trim()}`,
      severity: 'CRITICAL',
    });

    return { originalJevId: jevId, reversingJevId, reversingJevNo: reversingNo };
  });
});

/**
 * correctJev - reverse a posted entry and open an editable copy of it.
 *
 * ---------------------------------------------------------------------------
 * WHY A POSTED ENTRY IS NOT EDITED IN PLACE
 * ---------------------------------------------------------------------------
 * The request behind this was reasonable and ordinary: the month is still
 * open, the entry has a wrong account on it, let the Accountant fix it.
 *
 * What cannot be done is rewrite the ledger lines. The General Ledger is the
 * single accounting source of truth in CFMS, and a trial balance printed from
 * it is relied upon precisely because a posted entry is never changed. The
 * moment it can be, an auditor reading the books cannot tell a correction from
 * a cover-up - and neither can the office, six months later, when somebody
 * asks why March moved.
 *
 * So this does in one act what the Accountant would otherwise do in three:
 *
 *   1. posts the reversal of the posted entry, dated today, in an open period
 *   2. marks the original REVERSED, pointing at its reversal
 *   3. opens a NEW DRAFT carrying the same lines, for correcting and posting
 *
 * The books end up carrying the mistake, its reversal and the corrected entry,
 * which is what the standard asks for and what an auditor expects to find. The
 * Accountant ends up on an editable screen, which is what was asked for.
 *
 * The new draft holds no journal number. It draws one when it is posted, like
 * every other entry.
 */
export const correctJev = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, CORRECTING_ROLES);
    const { jevId, reason } = (request.data ?? {}) as { jevId?: string; reason?: string };

    if (!jevId) throw invalid('A journal entry voucher id is required.');
    if (!reason?.trim()) {
      throw invalid(
        'A reason is required. It is printed on the reversing entry and recorded in the audit trail.',
      );
    }

    const jevConfig = await loadNumberingConfig('JEV');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.jevs).doc(jevId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The journal entry voucher');

      const original = snap.data() as JevData & { reversedByJevId?: string };

      if (original.status !== 'POSTED') {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} is ${original.status.toLowerCase()}, not posted. An entry that has not reached the ledger is edited directly.`,
        );
      }
      if (original.reversedByJevId) {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} has already been reversed. Correct the entry that replaced it.`,
        );
      }

      assertFundInScope(caller, original.fundCode);

      /*
       * Dated today, in an open month, like any reversal. Writing the
       * correction back into the original's month would reopen a period that
       * has been closed and reported on, which is a deliberate act of its own
       * and not a side effect of fixing a typo.
       */
      const revDate = todayPh();
      const revPeriod = periodOf(revDate);
      const revYear = Number(revDate.slice(0, 4));

      await assertFiscalYearOpen(revYear, tx);
      await assertPeriodOpen(revYear, revPeriod, original.fundCode, 'The correction', tx);

      const bookCode = await bookCodeForFund(original.fundCode);
      const reversingNo = await issueNumber(tx, jevConfig, {
        bookCode,
        fundCode: original.fundCode,
        fiscalYear: revYear,
        month: revPeriod,
      });

      // ---- WRITE PHASE ----------------------------------------------------

      const reversingLines = buildReversalLines(original.lines);
      const reversalParticulars = `Reversal of JEV ${original.jevNo} for correction. ${reason.trim()}`;

      const { jevId: reversingJevId } = createJevInTransaction(tx, caller, {
        jevNo: reversingNo,
        jevDate: revDate,
        fiscalYear: revYear,
        period: revPeriod,
        fundCode: original.fundCode,
        book: original.book,
        sourceType: 'REVERSING',
        sourceId: jevId,
        referenceNo: original.jevNo,
        payeeId: original.payeeId ?? null,
        payeeName: original.payeeName ?? null,
        particulars: reversalParticulars,
        lines: reversingLines,
      });

      postJevInTransaction(
        tx,
        caller,
        reversingJevId,
        {
          jevNo: reversingNo,
          jevDate: revDate,
          fiscalYear: revYear,
          period: revPeriod,
          fundCode: original.fundCode,
          book: original.book,
          sourceType: 'REVERSING',
          sourceId: jevId,
          referenceNo: original.jevNo,
          payeeId: original.payeeId ?? null,
          payeeName: original.payeeName ?? null,
          particulars: reversalParticulars,
          lines: reversingLines,
          totalDebit: original.totalCredit,
          totalCredit: original.totalDebit,
          status: 'DRAFT',
        },
        { isReversal: true },
      );

      tx.update(ref, {
        status: 'REVERSED',
        reversedByJevId: reversingJevId,
        remarks: `Reversed by JEV ${reversingNo} on ${revDate} for correction: ${reason.trim()}`,
      });

      tx.update(db.collection(COL.jevs).doc(reversingJevId), { reversesJevId: jevId });

      /*
       * The copy to correct.
       *
       * Deliberately NOT sourceType REVERSING - it is a fresh entry of the
       * same kind as the one it replaces, and it will be posted on its own
       * merits. It carries the original's own reference so the paper behind
       * the entry still leads to it.
       *
       * An entry raised by a document keeps pointing at that document, so the
       * corrected entry is still the voucher's or the report's entry.
       */
      const { jevId: correctedJevId } = createJevInTransaction(tx, caller, {
        jevNo: UNNUMBERED_JEV,
        jevDate: revDate,
        fiscalYear: revYear,
        period: revPeriod,
        fundCode: original.fundCode,
        book: original.book,
        sourceType: original.sourceType,
        sourceId: original.sourceId ?? null,
        referenceNo: original.referenceNo ?? null,
        payeeId: original.payeeId ?? null,
        payeeName: original.payeeName ?? null,
        particulars: `Correcting JEV ${original.jevNo}. ${original.particulars}`,
        lines: original.lines,
      });

      recordTransition(tx, {
        caller,
        event: 'REVERSE',
        entityType: COL.jevs,
        entityId: jevId,
        entityRef: `JEV ${original.jevNo}`,
        fiscalYear: original.fiscalYear,
        fundCode: original.fundCode,
        action: 'REVERSE',
        previousStatus: 'POSTED',
        newStatus: 'REVERSED',
        remarks: `Reversed by JEV ${reversingNo} for correction, and a draft copy opened. ${reason.trim()}`,
        severity: 'CRITICAL',
      });

      return {
        originalJevId: jevId,
        reversingJevId,
        reversingJevNo: reversingNo,
        correctedJevId,
      };
    });
  },
);

/**
 * An expense debit must say which line of the budget it is charged to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CHECKED AT POSTING AND NOT AT SAVING
 * ---------------------------------------------------------------------------
 * A draft may be incomplete; a posted entry may not. Posting is the moment the
 * General Ledger takes the entry, and the ledger is what the Statement of
 * Comparison of Budget and Actual Amounts is built from. An expense posted
 * without an FPP does not appear in that statement at all - it is spent money
 * that no budget line accounts for - and because the statement still foots to
 * its own columns, nothing looks wrong.
 *
 * Only a DEBIT is checked. A credit to an expense account is a correction of
 * something already charged, and it carries the FPP of whatever it undoes; a
 * reversal generated by CFMS copies the line it reverses, FPP and all.
 *
 * Entries with no budget line behind them are untouched: a collection, a
 * deposit, a bank charge, an opening balance. None of those debits an expense.
 * ---------------------------------------------------------------------------
 */
async function assertExpenseDebitsCarryAnFpp(jev: JevData): Promise<void> {
  const lines = jev.lines ?? [];
  // Nothing to check, and nothing to read the Chart of Accounts for, unless a
  // debit is missing its budget line.
  if (!lines.some((l) => (l.debit ?? 0) > 0 && !l.fppCode)) return;

  const snap = await db.collection(COL.accounts).get();
  const expense = new Set<string>();
  for (const doc of snap.docs) {
    const a = doc.data() as { code?: string; accountClass?: string };
    if (a.code && a.accountClass === 'EXPENSE') expense.add(a.code.trim());
  }

  const check = checkExpenseDebitsHaveFpp(
    lines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debit: l.debit ?? 0,
      credit: l.credit ?? 0,
      fppCode: l.fppCode ?? null,
    })),
    (code) => expense.has(code),
  );

  if (!check.ok) {
    throw new HttpsError('failed-precondition', check.violations[0].message, {
      violations: check.violations,
    });
  }
}
