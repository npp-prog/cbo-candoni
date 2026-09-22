import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, PERIOD_CONTROL_ROLES, invalid } from '../lib/context';
import { auditInTransaction, notifyInTransaction, recordTransition } from '../lib/audit';
import { periodDocId, monthName } from '../lib/period';
import { trialBalance } from '../lib/ledger';

/**
 * Accounting period control.
 *
 * Closing a period is what converts "the books so far" into "the books". After
 * a close, nothing new can be posted into the month, so a report run in March
 * for January returns the same figures it returned in February.
 *
 * Reopening is deliberately awkward: it requires a reason, it is logged as a
 * CRITICAL audit event, and it notifies the accountant. Reopening a closed
 * month is sometimes genuinely necessary; it should never be routine, and the
 * record should make it obvious how often it happens.
 */

export const closePeriod = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, PERIOD_CONTROL_ROLES);
  const { fiscalYear, period, fundCode } = (request.data ?? {}) as {
    fiscalYear?: number;
    period?: number;
    fundCode?: string;
  };

  if (!fiscalYear || !period || !fundCode) {
    throw invalid('A fiscal year, period and fund are required.');
  }
  if (period < 1 || period > 13) {
    throw invalid('Period must be between 1 and 13.');
  }

  // Before closing, prove the ledger foots. Closing a month whose trial
  // balance does not balance freezes an error in place.
  const tb = await trialBalance({ fiscalYear, fundCode, throughPeriod: period });

  // Refuse to close while documents are still in flight: a voucher approved
  // but unposted, or a JEV drafted but unposted, belongs in this month and
  // will have nowhere to go once it is closed.
  const [pendingJevs, pendingDvs] = await Promise.all([
    db
      .collection(COL.jevs)
      .where('fiscalYear', '==', fiscalYear)
      .where('fundCode', '==', fundCode)
      .where('period', '==', period)
      .where('status', 'in', ['DRAFT', 'FOR_REVIEW', 'REVIEWED', 'APPROVED'])
      .get(),
    db
      .collection(COL.disbursementVouchers)
      .where('fiscalYear', '==', fiscalYear)
      .where('fundCode', '==', fundCode)
      .where('period', '==', period)
      .where('status', 'in', ['SUBMITTED', 'REVIEWED'])
      .get(),
  ]);

  if (pendingJevs.size > 0) {
    throw new HttpsError(
      'failed-precondition',
      `${pendingJevs.size} journal entr${pendingJevs.size === 1 ? 'y' : 'ies'} for ${monthName(period)} ${fiscalYear} (${fundCode}) ${pendingJevs.size === 1 ? 'is' : 'are'} still unposted. Post or cancel them before closing the period.`,
      { pendingJevNos: pendingJevs.docs.map((d) => d.data().jevNo) },
    );
  }

  if (pendingDvs.size > 0) {
    throw new HttpsError(
      'failed-precondition',
      `${pendingDvs.size} disbursement voucher(s) for ${monthName(period)} ${fiscalYear} (${fundCode}) are still in review. Approve, return or cancel them before closing the period.`,
      { pendingDvNos: pendingDvs.docs.map((d) => d.data().dvNo) },
    );
  }

  const id = periodDocId(fiscalYear, period, fundCode);

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.accountingPeriods).doc(id);
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data()?.status as string) : 'OPEN';

    if (current === 'CLOSED') {
      throw new HttpsError(
        'failed-precondition',
        `${monthName(period)} ${fiscalYear} (${fundCode}) is already closed.`,
      );
    }

    const now = new Date().toISOString();
    tx.set(
      ref,
      {
        fiscalYear,
        period,
        fundCode,
        status: 'CLOSED',
        closedAt: now,
        closedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
        trialBalanceTotal: tb.totalDebit,
      },
      { merge: true },
    );

    auditInTransaction(tx, {
      caller,
      event: 'PERIOD_CLOSE',
      entityType: COL.accountingPeriods,
      entityId: id,
      entityRef: `${monthName(period)} ${fiscalYear} (${fundCode})`,
      fiscalYear,
      fundCode,
      remarks: `Period closed. Trial balance totals ${(tb.totalDebit / 100).toFixed(2)} on each side across ${tb.rows.length} accounts.`,
      severity: 'NOTICE',
    });

    return { periodId: id };
  });
});

export const reopenPeriod = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, PERIOD_CONTROL_ROLES);
  const { fiscalYear, period, fundCode, reason } = (request.data ?? {}) as {
    fiscalYear?: number;
    period?: number;
    fundCode?: string;
    reason?: string;
  };

  if (!fiscalYear || !period || !fundCode) {
    throw invalid('A fiscal year, period and fund are required.');
  }
  if (!reason?.trim() || reason.trim().length < 15) {
    throw invalid(
      'Reopening a closed accounting period requires a written reason of at least 15 characters. It is recorded permanently in the audit trail and will be visible to COA.',
    );
  }

  const id = periodDocId(fiscalYear, period, fundCode);

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.accountingPeriods).doc(id);
    const snap = await tx.get(ref);

    if (!snap.exists || snap.data()?.status !== 'CLOSED') {
      throw new HttpsError(
        'failed-precondition',
        `${monthName(period)} ${fiscalYear} (${fundCode}) is not closed, so there is nothing to reopen.`,
      );
    }

    const fySnap = await tx.get(db.collection(COL.fiscalYears).doc(String(fiscalYear)));
    if (fySnap.exists && fySnap.data()?.status === 'CLOSED') {
      throw new HttpsError(
        'failed-precondition',
        `Fiscal year ${fiscalYear} has been closed out. A period inside a closed year cannot be reopened; use a prior period adjustment in the current year instead.`,
      );
    }

    const now = new Date().toISOString();
    const previousReopenings = (snap.data()?.reopenCount as number) ?? 0;

    tx.update(ref, {
      status: 'REOPENED',
      reopenedAt: now,
      reopenReason: reason.trim(),
      reopenCount: previousReopenings + 1,
      reopenedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });

    auditInTransaction(tx, {
      caller,
      event: 'PERIOD_REOPEN',
      entityType: COL.accountingPeriods,
      entityId: id,
      entityRef: `${monthName(period)} ${fiscalYear} (${fundCode})`,
      fiscalYear,
      fundCode,
      remarks: `Closed period reopened (reopening #${previousReopenings + 1}). Reason: ${reason.trim()}`,
      severity: 'CRITICAL',
    });

    notifyInTransaction(tx, {
      recipientRole: 'SUPER_ADMIN',
      kind: 'DEADLINE',
      title: 'Closed accounting period reopened',
      body: `${caller.name} reopened ${monthName(period)} ${fiscalYear} (${fundCode}). Reason: ${reason.trim()}`,
      entityType: COL.accountingPeriods,
      entityId: id,
      severity: 'CRITICAL',
    });

    return { periodId: id };
  });
});

/** Temporarily locks a period during month-end review without closing it. */
export const lockPeriod = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, PERIOD_CONTROL_ROLES);
  const { fiscalYear, period, fundCode, locked } = (request.data ?? {}) as {
    fiscalYear?: number;
    period?: number;
    fundCode?: string;
    locked?: boolean;
  };
  if (!fiscalYear || !period || !fundCode) {
    throw invalid('A fiscal year, period and fund are required.');
  }

  const id = periodDocId(fiscalYear, period, fundCode);
  const now = new Date().toISOString();

  await db.runTransaction(async (tx) => {
    const ref = db.collection(COL.accountingPeriods).doc(id);
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.status === 'CLOSED') {
      throw new HttpsError(
        'failed-precondition',
        'That period is closed. Reopen it rather than unlocking it.',
      );
    }

    tx.set(
      ref,
      {
        fiscalYear,
        period,
        fundCode,
        status: locked ? 'TEMPORARILY_LOCKED' : 'OPEN',
        updatedAt: now,
      },
      { merge: true },
    );

    auditInTransaction(tx, {
      caller,
      event: 'SETTINGS_CHANGE',
      entityType: COL.accountingPeriods,
      entityId: id,
      entityRef: `${monthName(period)} ${fiscalYear} (${fundCode})`,
      fiscalYear,
      fundCode,
      remarks: locked ? 'Period temporarily locked for review.' : 'Period unlocked.',
      severity: 'NOTICE',
    });
  });

  return { periodId: id };
});
