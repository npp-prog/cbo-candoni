import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { db, COL, REGION } from '../lib/firebase';
import { todayPh } from '../lib/period';
import { budgetKeyId } from '../lib/budget';

/**
 * Scheduled integrity and monitoring jobs.
 *
 * These exist because a control that only fires when somebody opens a screen
 * is not a control. Each job runs unattended, writes notifications where a
 * human decision is needed, and records anything alarming in the audit trail.
 */

const TZ = 'Asia/Manila';

/**
 * Nightly: rebuild every budget balance from its source documents and compare
 * against the stored figure.
 *
 * The stored balance is a cache maintained transactionally, so in principle it
 * cannot drift. This job exists to catch the cases that are not "in principle":
 * a failed deploy mid-transaction, a manual console edit, a bug introduced in a
 * later change. A discrepancy here means the budget control has been operating
 * on a wrong number, which is worth waking someone for.
 */
export const verifyBudgetBalances = onSchedule(
  { schedule: '30 1 * * *', timeZone: TZ, region: REGION, timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const year = Number(todayPh().slice(0, 4));

    const [appropriations, allotments, obligations] = await Promise.all([
      db.collection(COL.appropriations).where('fiscalYear', '==', year).where('status', '==', 'APPROVED').get(),
      db.collection(COL.allotments).where('fiscalYear', '==', year).where('status', '==', 'APPROVED').get(),
      db.collection(COL.obligations).where('fiscalYear', '==', year).where('status', 'in', ['OBLIGATED', 'PAID', 'CLOSED']).get(),
    ]);

    type Rebuilt = {
      appropriation: number;
      allotment: number;
      forLaterRelease: number;
      obligated: number;
      disbursed: number;
    };
    const rebuilt = new Map<string, Rebuilt>();
    const bump = (key: string, field: keyof Rebuilt, amount: number) => {
      const cur = rebuilt.get(key) ?? {
        appropriation: 0,
        allotment: 0,
        forLaterRelease: 0,
        obligated: 0,
        disbursed: 0,
      };
      cur[field] += amount;
      rebuilt.set(key, cur);
    };

    /*
     * The document id of a budget balance, derived by the SAME function the
     * transactional writers use.
     *
     * This used to be a hand-written join of the key fields, and it fell one
     * segment behind when the budget key gained the FPP code. Nothing failed
     * and nothing was logged: the rebuilt ids simply stopped matching any
     * stored id, `rebuilt.get(doc.id)` returned nothing, every balance was
     * skipped by the `if (!r) continue` below, and the job reported a clean
     * night every night while verifying not one figure.
     *
     * A second copy of a key derivation is the whole hazard here, so there is
     * no second copy any more. If the key changes again, this follows it.
     */
    const keyOf = (d: Record<string, unknown>) =>
      budgetKeyId({
        fiscalYear: d.fiscalYear as number,
        fundCode: d.fundCode as string,
        officeId: d.officeId as string,
        responsibilityCenterId: (d.responsibilityCenterId as string | null) ?? null,
        programId: (d.programId as string | null) ?? null,
        projectId: (d.projectId as string | null) ?? null,
        activityId: (d.activityId as string | null) ?? null,
        fppCode: (d.fppCode as string) ?? '',
        accountCode: (d.accountCode as string) ?? '',
      });

    for (const doc of appropriations.docs) bump(keyOf(doc.data()), 'appropriation', doc.data().amount ?? 0);
    for (const doc of allotments.docs) {
      const a = doc.data();
      bump(keyOf(a), 'allotment', (a.amount as number) ?? 0);
      // The hold the Allotment Release Order placed on the line. It is carried
      // on the allotment document precisely so that it can be rebuilt here;
      // a figure that moves the balance and has no source document is a figure
      // this job cannot check.
      bump(keyOf(a), 'forLaterRelease', (a.forLaterRelease as number) ?? 0);
    }
    for (const doc of obligations.docs) {
      const o = doc.data();
      const total = (o.totalAmount as number) ?? 0;
      const disbursed = (o.disbursedAmount as number) ?? 0;
      for (const line of (o.lines as Array<Record<string, unknown>>) ?? []) {
        const share = total > 0 ? Math.round(((line.amount as number) / total) * disbursed) : 0;
        // An obligation line is keyed on the object code the APPROPRIATION
        // carried, not on the object being bought - they differ on every
        // project line, where the appropriation named no object at all.
        // `certifyObligation` keys it this way; so must the rebuild.
        const key = keyOf({ ...line, accountCode: line.appropriatedAccountCode ?? '' });
        bump(key, 'obligated', (line.amount as number) ?? 0);
        bump(key, 'disbursed', share);
      }
    }

    const stored = await db.collection(COL.budgetBalances).where('fiscalYear', '==', year).get();
    const discrepancies: Array<Record<string, unknown>> = [];

    for (const doc of stored.docs) {
      const s = doc.data();
      const r = rebuilt.get(doc.id);
      if (!r) continue;

      const checks: Array<[string, number, number]> = [
        ['appropriationRevised', (s.appropriationRevised as number) ?? 0, r.appropriation],
        ['allotmentReleased', (s.allotmentReleased as number) ?? 0, r.allotment],
        ['forLaterRelease', (s.forLaterRelease as number) ?? 0, r.forLaterRelease],
        ['obligated', (s.obligated as number) ?? 0, r.obligated],
      ];

      for (const [field, storedValue, rebuiltValue] of checks) {
        if (storedValue !== rebuiltValue) {
          discrepancies.push({
            budgetKey: doc.id,
            field,
            stored: storedValue,
            rebuilt: rebuiltValue,
            difference: storedValue - rebuiltValue,
          });
        }
      }
    }

    if (discrepancies.length > 0) {
      logger.error('Budget balance discrepancies detected', { count: discrepancies.length, discrepancies: discrepancies.slice(0, 20) });

      await db.collection(COL.auditLogs).add({
        at: new Date().toISOString(),
        actorUid: 'system',
        actorName: 'CBO nightly integrity check',
        actorRoles: ['SYSTEM'],
        event: 'SETTINGS_CHANGE',
        entityType: COL.budgetBalances,
        entityRef: 'Budget balance verification',
        fiscalYear: year,
        severity: 'CRITICAL',
        remarks: `${discrepancies.length} budget balance discrepancies found against rebuilt totals. Budget control decisions may have used incorrect available balances.`,
        changes: discrepancies.slice(0, 50).map((d) => ({
          field: `${d.budgetKey}.${d.field}`,
          previous: d.stored,
          next: d.rebuilt,
        })),
      });

      await db.collection(COL.notifications).add({
        recipientRole: 'SUPER_ADMIN',
        kind: 'UNRECONCILED',
        title: 'Budget balances do not match source documents',
        body: `${discrepancies.length} discrepancies found in fiscal year ${year}. Review before relying on budget availability figures.`,
        severity: 'CRITICAL',
        read: false,
        createdAt: new Date().toISOString(),
      });
    } else {
      logger.info('Budget balance verification passed', { fiscalYear: year, lines: stored.size });
    }
  },
);

/**
 * Daily: flag cash advances past their liquidation deadline.
 *
 * Unliquidated cash advances are the most common COA finding in Philippine
 * LGUs. Catching them at 30 days rather than at year end is the difference
 * between a reminder and a disallowance.
 */
export const flagOverdueCashAdvances = onSchedule(
  { schedule: '0 7 * * 1-5', timeZone: TZ, region: REGION },
  async () => {
    const today = todayPh();

    const snap = await db
      .collection(COL.cashAdvances)
      .where('status', 'in', ['OUTSTANDING', 'PARTIALLY_LIQUIDATED'])
      .where('dueDate', '<', today)
      .get();

    if (snap.empty) {
      logger.info('No overdue cash advances.');
      return;
    }

    const byOfficer = new Map<string, { name: string; count: number; total: number; uid?: string }>();

    for (const doc of snap.docs) {
      const ca = doc.data();
      const key = ca.accountableOfficerId as string;
      const cur = byOfficer.get(key) ?? {
        name: ca.accountableOfficerName as string,
        count: 0,
        total: 0,
      };
      cur.count++;
      cur.total += (ca.outstandingBalance as number) ?? 0;
      byOfficer.set(key, cur);
    }

    const batch = db.batch();
    const now = new Date().toISOString();

    for (const [, officer] of byOfficer) {
      batch.create(db.collection(COL.notifications).doc(), {
        recipientRole: 'MUNICIPAL_ACCOUNTANT',
        kind: 'OVERDUE_CASH_ADVANCE',
        title: `Overdue cash advance: ${officer.name}`,
        body: `${officer.count} unliquidated advance(s) past due, totalling ${(officer.total / 100).toFixed(2)}.`,
        link: '/accounting/liquidation',
        severity: 'WARNING',
        read: false,
        createdAt: now,
      });
    }

    await batch.commit();
    logger.info('Overdue cash advance notifications sent', { officers: byOfficer.size, advances: snap.size });
  },
);

/**
 * Daily: mark checks stale after six months.
 *
 * A stale check still sits in the outstanding-checks column of every bank
 * reconciliation until somebody deals with it, quietly widening the gap
 * between the bank and the books.
 */
export const markStaleChecks = onSchedule(
  { schedule: '15 2 * * *', timeZone: TZ, region: REGION },
  async () => {
    const settings = await db.collection(COL.settings).doc('general').get();
    const months = (settings.data()?.checkStaleMonths as number) ?? 6;

    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const snap = await db
      .collection(COL.checks)
      .where('status', 'in', ['RELEASED', 'SIGNED', 'PREPARED'])
      .where('checkDate', '<', cutoffDate)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, { status: 'STALE' });
    }
    batch.create(db.collection(COL.notifications).doc(), {
      recipientRole: 'MUNICIPAL_TREASURER',
      kind: 'UNRECONCILED',
      title: 'Checks have become stale',
      body: `${snap.size} check(s) dated before ${cutoffDate} have passed ${months} months and are now stale. They need cancellation and, where still owed, replacement.`,
      link: '/accounting/checks',
      severity: 'WARNING',
      read: false,
      createdAt: new Date().toISOString(),
    });
    await batch.commit();

    logger.info('Checks marked stale', { count: snap.size, cutoffDate });
  },
);

/**
 * Daily: flag collections held beyond the deposit deadline.
 *
 * Undeposited collections are where cash goes missing. The window is short on
 * purpose.
 */
export const flagUndepositedCollections = onSchedule(
  { schedule: '30 7 * * 1-5', timeZone: TZ, region: REGION },
  async () => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 2);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const snap = await db
      .collection(COL.collections)
      .where('status', 'in', ['ISSUED', 'IN_RCD'])
      .where('orDate', '<', cutoffDate)
      .get();

    if (snap.empty) return;

    const total = snap.docs.reduce((s, d) => s + ((d.data().totalAmount as number) ?? 0), 0);

    await db.collection(COL.notifications).add({
      recipientRole: 'MUNICIPAL_TREASURER',
      kind: 'UNRECONCILED',
      title: 'Undeposited collections',
      body: `${snap.size} collection(s) dated on or before ${cutoffDate}, totalling ${(total / 100).toFixed(2)}, have not been deposited.`,
      link: '/treasury/deposits',
      severity: 'WARNING',
      read: false,
      createdAt: new Date().toISOString(),
    });

    logger.info('Undeposited collections flagged', { count: snap.size, total });
  },
);
