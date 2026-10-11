import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { assertAttachedBeforePosting } from '../lib/attachmentGate';
import {
  requireCaller,
  POSTING_ROLES,
  CORRECTING_ROLES,
  assertFundInScope,
  notFound,
  invalid,
} from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, issueNumbers, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { hasJevNumber, UNNUMBERED_JEV } from '../lib/jevNumbers';
import {
  assertPeriodOpen,
  assertFiscalYearOpen,
  periodOf, validReversalDate,
  monthName,
  todayPh,
} from '../lib/period';
import { isDirectEntry } from '../lib/jevSourceKinds';
import { paymentReversalLines } from '../lib/rciReversal';
import { TRUST_LIABILITIES } from '../lib/chartOfAccounts';
import {
  postJevInTransaction,
  replaceLedgerLines,
  buildReversalLines,
  createJevInTransaction,
  type JevData,
  type JevLineData,
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

    /*
     * Patch 180: the month is the entry's DATE's month. A draft is written by
     * the browser, and a stored \`period\` that disagrees with the date would
     * check (and post into) a month other than the one the entry is dated in.
     */
    const datePeriod = periodOf(jev.jevDate);
    const period =
      Number(String(jev.jevDate).slice(0, 4)) === jev.fiscalYear
        ? datePeriod
        : (jev.period ?? datePeriod);
    await assertFiscalYearOpen(jev.fiscalYear, tx);
    await assertPeriodOpen(jev.fiscalYear, period, jev.fundCode, `JEV ${jev.jevNo || jevId}`, tx);

    /*
     * Patch 177: an entry written in Accounting is posted only with its
     * papers on the record - the memorandum, the bank advice, the office's
     * journal voucher. An entry raised by a document (a voucher, a treasury
     * report, a liquidation) carries its papers on that document, and the
     * document's own approval already required them.
     */
    const ownPapers = ['MANUAL', 'ADJUSTING', 'CLOSING', 'PRIOR_PERIOD'].includes(
      String(jev.sourceType ?? 'MANUAL'),
    );
    if (ownPapers) {
      await assertAttachedBeforePosting(
        tx,
        COL.jevs,
        jevId,
        `JEV ${hasJevNumber(jev.jevNo) ? jev.jevNo : 'this entry'}`,
        'posting it',
      );
    }


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
    // Patch 180: an RCD-sourced entry raised by a treasury report (or a
    // deposit) has no document in the old \`rcds\` collection; updating one
    // that does not exist failed the posting. Read it here, before any write.
    const rcdRef =
      jev.sourceType === 'RCD' && jev.sourceId
        ? db.collection(COL.rcds).doc(jev.sourceId)
        : null;
    const rcdExists = rcdRef ? (await tx.get(rcdRef)).exists : false;

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

    const result = postJevInTransaction(tx, caller, jevId, { ...jev, jevNo, period });
    if (ownPapers) {
      tx.update(ref, {
        attachmentsLockedAt: result.postedAt,
        attachmentsLockedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: result.postedAt,
        },
      });
    }

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
      // Patch 180: jevId too - after correctJev the posted entry is a new
      // document, and a voucher still pointing at the reversed one would be
      // unapproved or cancelled against the wrong entry.
      tx.update(db.collection(COL.disbursementVouchers).doc(jev.sourceId), {
        jevId,
        jevNo,
        jevPostedAt: result.postedAt,
      });
    }
    if (rcdRef && rcdExists) {
      tx.update(rcdRef, { status: 'POSTED' });
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
    assertNoCheckReversed(original);
    assertNotSefShare(original);

    assertFundInScope(caller, original.fundCode);

    // The reversal is dated in an open period. Defaulting to today rather than
    // to the original date keeps a closed month closed - reopening a period to
    // book a correction should be a deliberate act, not a side effect.
    const revDate = validReversalDate(reversalDate ?? todayPh(), original.jevDate);
    const revPeriod = periodOf(revDate);
    const revYear = Number(revDate.slice(0, 4));

    await assertFiscalYearOpen(revYear, tx);
    await assertPeriodOpen(revYear, revPeriod, original.fundCode, `Reversal dated ${revDate}`, tx);

    /*
     * Patch 161: reversing an RCD's entry RELEASES what it booked and
     * reported - its deposits go back to Recorded (no entry, on no RCD) and
     * its remittances received are no longer claimed - so a corrected RCD can
     * report them again. Patch 162: and the RCD is withdrawn, releasing its
     * receipts too. Read now: a transaction reads before it writes.
     */
    const isRcd = original.sourceType === 'RCD' && !!original.sourceId;
    const bookedDeposits = isRcd
      ? await tx.get(db.collection(COL.deposits).where('jevId', '==', jevId))
      : null;
    const rcdReport = isRcd
      ? await tx.get(db.collection(COL.treasuryReports).doc(String(original.sourceId)))
      : null;
    const claimedRemittances =
      rcdReport?.exists
        ? ((rcdReport.data()?.remittances ?? []) as Array<{ sourceId: string }>)
        : [];

    /*
     * Patch 176: an RCD of AF 56 receipts posted a matching entry in the SEF
     * books. Reversing the RCD reverses that too, on the same date, so the
     * two funds' interfund accounts never disagree. Read now.
     */
    const sefJevId = rcdReport?.exists ? (rcdReport.data()?.sefJevId as string | undefined) : undefined;
    const sefSnap = sefJevId ? await tx.get(db.collection(COL.jevs).doc(sefJevId)) : null;
    const sefOriginal =
      sefSnap?.exists && (sefSnap.data() as JevData).status === 'POSTED'
        ? (sefSnap.data() as JevData & { reversedByJevId?: string })
        : null;
    if (sefOriginal && !sefOriginal.reversedByJevId) {
      await assertPeriodOpen(revYear, revPeriod, 'SEF', `Reversal of the SEF share, dated ${revDate}`, tx);
    }
    const reverseSef = Boolean(sefOriginal && !sefOriginal.reversedByJevId);

    const bookCode = await bookCodeForFund(original.fundCode);
    const sefBookCode = reverseSef ? await bookCodeForFund('SEF') : '';
    const [reversingNo, sefReversingNo] = (await issueNumbers(tx, [
      {
        cfg: jevConfig,
        parts: { bookCode, fundCode: original.fundCode, fiscalYear: revYear, month: revPeriod },
      },
      {
        cfg: jevConfig,
        parts: { bookCode: sefBookCode, fundCode: 'SEF', fiscalYear: revYear, month: revPeriod },
        skip: !reverseSef,
      },
    ])) as [string, string | null];

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

    // Patch 176: the SEF books' matching entry goes with it.
    if (reverseSef && sefOriginal && sefJevId && sefReversingNo) {
      const sefLines = buildReversalLines(sefOriginal.lines);
      const sefRev: JevData = {
        jevNo: sefReversingNo,
        jevDate: revDate,
        fiscalYear: revYear,
        period: revPeriod,
        fundCode: 'SEF',
        book: sefOriginal.book,
        sourceType: 'REVERSING',
        sourceId: sefJevId,
        referenceNo: sefOriginal.jevNo,
        particulars: `Reversal of JEV ${sefOriginal.jevNo}, with the General Fund's JEV ${original.jevNo}. ${reason.trim()}`,
        lines: sefLines,
        totalDebit: sefOriginal.totalCredit,
        totalCredit: sefOriginal.totalDebit,
        status: 'DRAFT',
      };
      const { jevId: sefRevId } = createJevInTransaction(tx, caller, sefRev);
      postJevInTransaction(tx, caller, sefRevId, sefRev, { isReversal: true });
      tx.update(db.collection(COL.jevs).doc(sefJevId), {
        status: 'REVERSED',
        reversedByJevId: sefRevId,
        remarks: `Reversed by JEV ${sefReversingNo} on ${revDate}, with the General Fund's JEV ${original.jevNo}: ${reason.trim()}`,
      });
      tx.update(db.collection(COL.jevs).doc(sefRevId), { reversesJevId: sefJevId });
    }

    if (isRcd) {
      for (const d of bookedDeposits?.docs ?? []) {
        tx.update(d.ref, {
          jevId: null,
          jevNo: null,
          // A deposit the bank has already credited stays credited.
          ...(d.data().status === 'IN_TRANSIT' ? { status: 'RECORDED' } : {}),
          bookedByTreasuryReportId: null,
          treasuryReportId: null,
          treasuryReportNo: null,
          treasuryReportType: null,
          releasedByReversalJevNo: reversingNo,
        });
      }
      for (const r of claimedRemittances) {
        tx.update(db.collection(COL.collectionRemittances).doc(r.sourceId), {
          liquidatingReportId: null,
          liquidatingReportNo: null,
        });
      }
      if (rcdReport?.exists) {
        /*
         * Patch 162: the reversed RCD is WITHDRAWN, so its receipts can be
         * reported again on a corrected one. Its lines stay on it as the record
         * of what it said; the receipts themselves are released.
         */
        const lines = (rcdReport.data()?.lines ?? []) as Array<{ sourceId: string }>;
        for (const l of lines) {
          tx.update(db.collection(COL.collections).doc(l.sourceId), {
            treasuryReportId: null,
            treasuryReportNo: null,
            treasuryReportType: null,
          });
        }
        tx.update(rcdReport.ref, {
          status: 'CANCELLED',
          cancelReason: `Withdrawn: its entry, JEV ${original.jevNo}, was reversed by JEV ${reversingNo}. ${reason.trim()}`,
          withdrawnAt: new Date().toISOString(),
          reversedByJevId: reversingJevId,
          reversedByJevNo: reversingNo,
          depositsReleased: (bookedDeposits?.docs ?? []).map((d) => d.id),
        });
      }
    }

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
 * Patch 151. An RCI entry some of whose checks have already been reversed
 * one by one (reverseRciChecks) cannot be reversed, corrected or amended as a
 * whole: those checks would be undone twice. The rest of its checks are
 * reversed the same way, one by one.
 */
function assertNoCheckReversed(jev: {
  jevNo?: string;
  checkReversals?: Array<{ checkNos?: string[] }>;
}): void {
  const done = (jev.checkReversals ?? []).flatMap((r) => r.checkNos ?? []);
  if (done.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      `No. ${done.join(', ')} of JEV ${jev.jevNo ?? ''} ${done.length === 1 ? 'has' : 'have'} already been reversed on ${done.length === 1 ? 'its' : 'their'} own. Reverse the others the same way - Reverse checks / Reverse ADAs, then choose - so none is reversed twice.`,
    );
  }
}

/**
 * reverseRciChecks - take the CHOSEN checks out of an RCI's entry, or the
 * chosen ADAs out of a RADAI's. Patch 151; RADAI and trust liabilities in
 * patch 153. (The name is kept so the deployed function and its Cloud Run
 * permission stay as they are.)
 *
 * A report is journalized as one entry for all its checks or advices. When
 * one of them is to be cancelled or replaced, only its lines are taken out:
 * the cash goes back to its bank account, and what is still owed to the payee
 * becomes a TRUST LIABILITY (lib/rciReversal.ts). The voucher's number cannot
 * be used again - the payee is repaid by a new voucher of the Trust liability
 * kind. The documents properly paid stay paid.
 *
 * The amounts come from the CHECKS / ADAs, read here - not from the browser.
 *
 * Afterwards each document carries the JEV that took it out, which is what
 * lets the Treasurer cancel it (cancelCheck / cancelAda refuse a document
 * whose report is in the books otherwise). When every document of the report
 * has been taken out, the original entry is marked REVERSED.
 */
export const reverseRciChecks = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, POSTING_ROLES);
    const { jevId, checkIds, documentIds, reason, reversalDate } = (request.data ?? {}) as {
      jevId?: string;
      checkIds?: string[];
      documentIds?: string[];
      reason?: string;
      reversalDate?: string;
    };

    if (!jevId) throw invalid('A journal entry voucher id is required.');
    const ids = [
      ...new Set((documentIds ?? checkIds ?? []).filter((x) => typeof x === 'string' && x)),
    ];
    if (ids.length === 0) throw invalid('Choose at least one check or ADA to reverse.');
    if (!reason?.trim()) {
      throw invalid(
        'A reason for the reversal is required. It is printed on the reversing entry and recorded in the audit trail.',
      );
    }

    const jevConfig = await loadNumberingConfig('JEV');

    return db.runTransaction(async (tx) => {
      // ---- reads -----------------------------------------------------------
      const ref = db.collection(COL.jevs).doc(jevId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The journal entry voucher');
      const original = snap.data() as JevData & {
        reversedByJevId?: string;
        checkReversals?: Array<{ checkIds?: string[]; checkNos?: string[] }>;
      };

      const kind = original.sourceType;
      if ((kind !== 'RCI' && kind !== 'RADAI') || !original.sourceId) {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} is not the entry of an RCI or a RADAI. Reverse it as a whole.`,
        );
      }
      const isAda = kind === 'RADAI';
      const label = isAda ? 'ADA No.' : 'Check No.';
      const noun = isAda ? 'ADA' : 'check';

      if (original.status !== 'POSTED') {
        throw new HttpsError(
          'failed-precondition',
          `Only a posted entry can be reversed. JEV ${original.jevNo} is ${String(original.status).toLowerCase()}.`,
        );
      }
      if (original.reversedByJevId) {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} has already been reversed in full.`,
        );
      }
      assertFundInScope(caller, original.fundCode);

      const reportSnap = await tx.get(db.collection(COL.treasuryReports).doc(original.sourceId));
      if (!reportSnap.exists) throw notFound(`The ${kind} behind this entry`);
      const report = reportSnap.data() as {
        reportNo?: string;
        lines?: Array<{ sourceId: string; sourceNo: string; excluded?: boolean }>;
      };
      const onReport = new Map(
        (report.lines ?? []).filter((l) => !l.excluded).map((l) => [l.sourceId, l]),
      );
      const already = new Set((original.checkReversals ?? []).flatMap((r) => r.checkIds ?? []));

      const docRefs = ids.map((id) => db.collection(isAda ? COL.ada : COL.checks).doc(id));
      const docSnaps = await Promise.all(docRefs.map((r) => tx.get(r)));
      const docs = docSnaps.map((ds, i) => {
        if (!ds.exists) throw notFound(`A chosen ${noun}`);
        const d = ds.data() as {
          checkNo?: string;
          adaNo?: string;
          status: string;
          netAmount?: number;
          amount?: number;
          notPostedAmount?: number;
          entryReversedByJevId?: string;
        };
        const id = ids[i];
        const no = String((isAda ? d.adaNo : d.checkNo) ?? '');
        if (!onReport.has(id)) {
          throw invalid(`${label} ${no} is not on ${kind} ${report.reportNo ?? ''}.`);
        }
        if (already.has(id) || d.entryReversedByJevId) {
          throw new HttpsError('failed-precondition', `${label} ${no} has already been reversed.`);
        }
        if (d.status === 'CANCELLED') {
          throw new HttpsError('failed-precondition', `${label} ${no} is cancelled.`);
        }
        if (!isAda && d.status === 'CLEARED') {
          throw new HttpsError(
            'failed-precondition',
            `Check No. ${no} has cleared the bank - the payee has been paid, and there is nothing to reverse. If the payment was wrong, record the refund and an adjusting entry.`,
          );
        }
        if (isAda && (d.status === 'SUBMITTED' || d.status === 'DEBITED')) {
          throw new HttpsError(
            'failed-precondition',
            `ADA No. ${no} has been posted online by the bank - the payees have been credited, and there is nothing to reverse. A credit the bank did not post is already a trust liability, by the adjusting entry of the RADAI.`,
          );
        }
        return {
          id,
          ref: docRefs[i],
          no,
          amount: Number(isAda ? d.amount : d.netAmount) || 0,
        };
      });

      let lines: JevLineData[];
      try {
        lines = paymentReversalLines(
          original.lines,
          docs.map((d) => ({ no: d.no, amount: d.amount })),
          {
            label,
            trustLiability: { code: TRUST_LIABILITIES.code, name: TRUST_LIABILITIES.name },
          },
        );
      } catch (err) {
        throw invalid(err instanceof Error ? err.message : String(err));
      }
      const total = lines.reduce((s, l) => s + (l.debit || 0), 0);

      const revDate = validReversalDate(reversalDate ?? todayPh(), original.jevDate);
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

      // ---- writes ----------------------------------------------------------
      const nos = docs.map((d) => d.no);
      const particulars = `Reversal of JEV ${original.jevNo} (${kind} ${report.reportNo ?? ''}) - ${label} ${nos.join(', ')}; amount still owed held as trust liability. ${reason.trim()}`;

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
        payeeId: null,
        payeeName: null,
        particulars,
        lines,
        totalDebit: total,
        totalCredit: total,
        status: 'DRAFT',
      };
      const { jevId: reversingJevId } = createJevInTransaction(tx, caller, reversingJev);
      postJevInTransaction(tx, caller, reversingJevId, reversingJev, { isReversal: true });
      tx.update(db.collection(COL.jevs).doc(reversingJevId), {
        reversesJevId: jevId,
        reversesCheckIds: docs.map((d) => d.id),
      });

      const now = new Date().toISOString();
      const record = {
        kind: isAda ? 'ADA' : 'CHECK',
        jevId: reversingJevId,
        jevNo: reversingNo,
        date: revDate,
        // Named for checks in patch 151; they hold ADA ids and numbers on a RADAI.
        checkIds: docs.map((d) => d.id),
        checkNos: nos,
        amount: total,
        reason: reason.trim(),
        at: now,
      };
      const allDone = [...onReport.keys()].every(
        (id) => already.has(id) || docs.some((d) => d.id === id),
      );
      tx.update(ref, {
        checkReversals: FieldValue.arrayUnion(record),
        ...(allDone
          ? {
              status: 'REVERSED',
              reversedByJevId: reversingJevId,
              remarks: `Every ${noun} reversed; the last by JEV ${reversingNo} on ${revDate}.`,
            }
          : {}),
      });

      for (const d of docs) {
        tx.update(d.ref, {
          entryReversedByJevId: reversingJevId,
          entryReversedByJevNo: reversingNo,
          entryReversedAt: now,
        });
      }

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
        newStatus: allDone ? 'REVERSED' : 'POSTED',
        remarks: `${label} ${nos.join(', ')} taken out by JEV ${reversingNo} (to trust liabilities). ${reason.trim()}`,
        severity: 'CRITICAL',
      });

      return {
        originalJevId: jevId,
        reversingJevId,
        reversingJevNo: reversingNo,
        checkNos: nos,
        amount: total,
        fullyReversed: allDone,
      };
    });
  },
);

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
      assertNoCheckReversed(original as never);
      assertNotSefShare(original);

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
 * amendPostedJev - correct a posted entry in place, while the month is open.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, HAVING ARGUED AGAINST IT
 * ---------------------------------------------------------------------------
 * CFMS used to refuse this absolutely: a posted entry was corrected by
 * reversing it and posting a replacement, because a ledger that can be
 * rewritten is not evidence of anything.
 *
 * That is the right rule for a month that has been CLOSED - reported on,
 * submitted, relied upon by somebody outside this office. It is the wrong rule
 * for a wrong account code found on the same afternoon it was keyed, and
 * insisting on it there produces books in which every small mistake drags
 * three entries behind it. Accountants do not work that way and should not
 * have to.
 *
 * So the line moves from "never" to "while the month is open", and what makes
 * that defensible is not the edit but everything attached to it:
 *
 *   THE PERIOD AND THE FISCAL YEAR MUST BOTH BE OPEN. Closing a month is
 *   already a deliberate act in CFMS. From that moment this is refused and
 *   the only correction is a reversing entry.
 *
 *   ONLY THE MUNICIPAL ACCOUNTANT, with a reason, recorded as a CRITICAL
 *   audit event - the severity an auditor filters on.
 *
 *   THE ENTRY KEEPS ITS OWN HISTORY. Every correction appends what the date,
 *   the particulars and the total WERE, who changed them and why. The screen
 *   shows it. An entry corrected twice says so on its face.
 *
 *   AN AMOUNT THAT LEAVES ITS DOCUMENT SAYS SO. The total was once refused on
 *   an entry raised by a voucher or a certified treasury report, because the
 *   amount is a figure another officer signed. The Municipal Accountant has
 *   asked for it to be correctable, so instead of refusing, CFMS records what
 *   the document was signed for and shows the disagreement on the entry, on
 *   the document, and in the audit trail until it is resolved. Correcting the
 *   entry back to the signed figure clears it. Refusing only ever moved the
 *   correction somewhere CFMS could not see.
 *
 *   THE MONTH CANNOT CHANGE. The JEV number carries the month it belongs to,
 *   and the journal series is kept per month. Moving an entry into another
 *   month would leave its number in the wrong series, which no report could
 *   explain. Moving an entry between months is a reversal and a re-entry.
 */
export const amendPostedJev = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, CORRECTING_ROLES);
    const {
      jevId,
      jevDate,
      particulars,
      lines: linesIn,
      reason,
    } = (request.data ?? {}) as {
      jevId?: string;
      jevDate?: string;
      particulars?: string;
      lines?: JevLineData[];
      reason?: string;
    };

    if (!jevId) throw invalid('A journal entry voucher id is required.');
    if (!reason?.trim()) {
      throw invalid(
        'A reason for the correction is required. It is recorded against the entry and in the audit trail.',
      );
    }
    if (!Array.isArray(linesIn) || linesIn.length === 0) {
      throw invalid('The corrected entry has no lines.');
    }
    if (!particulars?.trim()) throw invalid('The entry needs its particulars.');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.jevs).doc(jevId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The journal entry voucher');

      const original = snap.data() as JevData & {
        reversedByJevId?: string;
        postedAt?: string;
        corrections?: unknown[];
        signedTotal?: number | null;
      };

      if (original.status !== 'POSTED') {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} is ${original.status.toLowerCase()}, not posted. An entry that has not reached the ledger is edited directly.`,
        );
      }
      if (original.reversedByJevId) {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} has been reversed. Correct the entry that replaced it.`,
        );
      }
      assertNoCheckReversed(original as never);
      // Patch 180: a reversing entry must keep mirroring its original, and the
      // SEF share must keep matching the General Fund's Due to Other Funds.
      if (original.sourceType === 'REVERSING') {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} reverses another entry and must mirror it. Correct the original entry instead.`,
        );
      }
      assertNotSefShare(original);

      assertFundInScope(caller, original.fundCode);

      const newDate = String(jevDate ?? original.jevDate).trim();
      const newPeriod = periodOf(newDate);
      const newYear = Number(newDate.slice(0, 4));

      if (newYear !== original.fiscalYear || newPeriod !== original.period) {
        throw new HttpsError(
          'failed-precondition',
          `JEV ${original.jevNo} is dated ${original.jevDate} and its number belongs to that month's series. A correction can move the date within ${monthName(original.period)}, but moving the entry to another month would leave its number in the wrong series - that is a reversing entry and a new one.`,
        );
      }

      /*
       * The month this entry is IN must be open. Not the month it is being
       * moved to - it cannot move - so one check, on its own period.
       */
      await assertFiscalYearOpen(original.fiscalYear, tx);
      await assertPeriodOpen(
        original.fiscalYear,
        original.period,
        original.fundCode,
        `JEV ${original.jevNo}`,
        tx,
      );

      const lines = linesIn.map((l, i) => ({ ...l, lineNo: i + 1 }));
      let totalDebit = 0;
      let totalCredit = 0;
      for (const l of lines) {
        totalDebit += l.debit ?? 0;
        totalCredit += l.credit ?? 0;
      }

      const corrected: JevData = {
        ...original,
        jevDate: newDate,
        particulars: particulars.trim(),
        lines,
        totalDebit,
        totalCredit,
      };


      /*
       * ---------------------------------------------------------------------
       * THE AMOUNT ON A DOCUMENT-SOURCED ENTRY
       * ---------------------------------------------------------------------
       * CFMS used to REFUSE this outright, and the argument for refusing is
       * still true: the total on an entry raised by a disbursement voucher or
       * a certified treasury report is a figure another officer signed, and an
       * entry that quietly stops agreeing with the paper behind it is the
       * thing an auditor is looking for.
       *
       * The Municipal Accountant has asked for the amount to be correctable
       * like everything else, and that is his call to make. So the control
       * moves from PREVENTING the disagreement to RECORDING it, which is the
       * next best thing and arguably the more honest one: the refusal only
       * ever pushed the correction somewhere CFMS could not see it.
       *
       * `signedTotal` is the figure on the paper, captured the FIRST time the
       * entry diverges and never overwritten afterwards - a second correction
       * must not quietly reset the baseline to the first correction's figure,
       * which would make the entry look as though it agreed with a document it
       * no longer agrees with. Correcting back to the signed figure clears it.
       */
      const documentSourced = !isDirectEntry(original.sourceType);
      const signedBefore = original.signedTotal ?? null;
      /** What the document was signed for, whether or not it has diverged yet. */
      const signedTotal = documentSourced ? signedBefore ?? original.totalDebit : null;
      const divergesNow = signedTotal !== null && totalDebit !== signedTotal;
      const divergedBefore = signedBefore !== null && original.totalDebit !== signedBefore;

      // ---- WRITE PHASE ----------------------------------------------------

      const postedAt = original.postedAt ?? new Date().toISOString();
      const result = await replaceLedgerLines(tx, caller, jevId, corrected, postedAt);

      const now = new Date().toISOString();

      tx.update(ref, {
        jevDate: newDate,
        particulars: particulars.trim(),
        lines,
        totalDebit,
        totalCredit,
        /*
         * What it said before, appended rather than replaced. An entry
         * corrected twice carries both corrections, and the screen shows them.
         */
        /*
         * Set while the ledger disagrees with the signed paper, cleared when a
         * later correction brings it back. Both screens read this one field.
         */
        signedTotal: divergesNow ? signedTotal : null,
        corrections: FieldValue.arrayUnion({
          at: now,
          by: { uid: caller.uid, name: caller.name, position: caller.position ?? null },
          reason: reason.trim(),
          previous: {
            jevDate: original.jevDate,
            particulars: original.particulars,
            totalDebit: original.totalDebit,
            lineCount: (original.lines ?? []).length,
          },
        }),
      });

      recordTransition(tx, {
        caller,
        event: 'EDIT',
        entityType: COL.jevs,
        entityId: jevId,
        entityRef: `JEV ${original.jevNo}`,
        fiscalYear: original.fiscalYear,
        fundCode: original.fundCode,
        action: 'POST',
        previousStatus: 'POSTED',
        newStatus: 'POSTED',
        remarks: [
          `Posted entry corrected in an open month: ${result.removed} ledger ${result.removed === 1 ? 'line' : 'lines'} replaced with ${result.written}.`,
          /*
           * Spelled out in the audit trail rather than left to be worked out
           * from two totals in two places. An auditor filtering on CRITICAL
           * gets the sentence that matters without opening anything.
           */
          divergesNow
            ? `AMOUNT NO LONGER AGREES WITH THE SOURCE DOCUMENT: ${
                original.referenceNo
                  ? `${original.sourceType} ${original.referenceNo}`
                  : `the ${original.sourceType.toLowerCase()}`
              } was signed for ${(signedTotal! / 100).toFixed(2)}; this entry now carries ${(
                totalDebit / 100
              ).toFixed(2)}.`
            : divergedBefore
              ? `Amount brought back to the ${(signedTotal! / 100).toFixed(
                  2,
                )} the source document was signed for.`
              : null,
          reason.trim(),
        ]
          .filter(Boolean)
          .join(' '),
        severity: 'CRITICAL',
      });

      return {
        jevId,
        jevNo: original.jevNo,
        ledgerEntryCount: result.written,
        replaced: result.removed,
        /** So the screen can say so without re-reading the entry. */
        signedTotal: divergesNow ? signedTotal : null,
      };
    });
  },
);

/**
 * Patch 176: the SEF books' share of an AF 56 RCD is reversed only with the
 * General Fund entry it matches (reverse the RCD's entry), so the Due from
 * Other Funds in the SEF can never outlive the Due to Other Funds in the GF.
 */
function assertNotSefShare(jev: { sourceType?: string | null; jevNo?: string | null; referenceNo?: string | null }) {
  if (jev.sourceType === 'RPT_SEF_SHARE') {
    throw new HttpsError(
      'failed-precondition',
      `JEV ${jev.jevNo} is the SEF share of the real property tax on RCD ${jev.referenceNo ?? ''}. Reverse the RCD's entry in the General Fund; this entry is reversed with it.`,
    );
  }
}

