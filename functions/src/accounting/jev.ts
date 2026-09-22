import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, POSTING_ROLES, assertFundInScope, notFound, invalid } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
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
 * immutability is the whole basis on which a trial balance printed from CBO can
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
    await assertPeriodOpen(jev.fiscalYear, period, jev.fundCode, `JEV ${jev.jevNo}`, tx);

    const result = postJevInTransaction(tx, caller, jevId, jev);

    recordTransition(tx, {
      caller,
      event: 'POST',
      entityType: COL.jevs,
      entityId: jevId,
      entityRef: `JEV ${jev.jevNo}`,
      fiscalYear: jev.fiscalYear,
      fundCode: jev.fundCode,
      action: 'POST',
      previousStatus: jev.status,
      newStatus: 'POSTED',
      remarks: `${result.ledgerEntryCount} ledger entries, ${(jev.totalDebit / 100).toFixed(2)}.`,
    });

    // Mark the source document as posted so its screen reflects reality.
    if (jev.sourceType === 'DV' && jev.sourceId) {
      tx.update(db.collection(COL.disbursementVouchers).doc(jev.sourceId), {
        status: 'PAID',
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
      jevNo: jev.jevNo,
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
