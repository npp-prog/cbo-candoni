import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid } from '../lib/context';
import { auditInTransaction } from '../lib/audit';
import { budgetKeyId } from '../lib/budget';
import { allocateDvShares } from '../lib/dvShares';

/**
 * Rebuilding the budget figures from their source documents. Patch 120.
 *
 * ---------------------------------------------------------------------------
 * ONE REBUILD, TWO READERS
 * ---------------------------------------------------------------------------
 * The nightly verifier (`verifyBudgetBalances`) rebuilds every balance of
 * the year from the approved appropriations, the approved allotments and the
 * committed obligations, and compares it with the stored figure. The repair
 * below rebuilds the same way and WRITES the one figure that was found to
 * drift - `disbursed`.
 *
 * They share this function so that what the repair writes is exactly what
 * the verifier will check the next night. Two rebuilds that differ by a
 * rounding rule would have the repair "fixing" a balance the verifier then
 * reports again, every night, for ever.
 */

/**
 * The statuses in which an obligation has committed allotment.
 *
 * MUST match COMMITTED in src/lib/budgetPeriods.ts, less the
 * pre-certification ones this never sees. Listed rather than derived because
 * a Firestore `in` needs literals - and checked against the client's list by
 * check-rules.
 */
export const COMMITTED_OBLIGATION_STATUSES = ['OBLIGATED', 'WITH_DV', 'PAID', 'CLOSED'];

export interface RebuiltFigures {
  appropriation: number;
  allotment: number;
  forLaterRelease: number;
  obligated: number;
  disbursed: number;
}

/** The document id of a budget balance, by the SAME function the writers use. */
export function balanceKeyOf(d: Record<string, unknown>): string {
  return budgetKeyId({
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
}

export async function rebuildBudgetFigures(year: number): Promise<Map<string, RebuiltFigures>> {
  const [appropriations, allotments, obligations] = await Promise.all([
    db
      .collection(COL.appropriations)
      .where('fiscalYear', '==', year)
      .where('status', '==', 'APPROVED')
      .get(),
    db
      .collection(COL.allotments)
      .where('fiscalYear', '==', year)
      .where('status', '==', 'APPROVED')
      .get(),
    db
      .collection(COL.obligations)
      .where('fiscalYear', '==', year)
      .where('status', 'in', COMMITTED_OBLIGATION_STATUSES)
      .get(),
  ]);

  const rebuilt = new Map<string, RebuiltFigures>();
  const bump = (key: string, field: keyof RebuiltFigures, amount: number) => {
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

  for (const doc of appropriations.docs)
    bump(balanceKeyOf(doc.data()), 'appropriation', doc.data().amount ?? 0);
  for (const doc of allotments.docs) {
    const a = doc.data();
    bump(balanceKeyOf(a), 'allotment', (a.amount as number) ?? 0);
    // The hold the Allotment Release Order placed on the line. It is carried
    // on the allotment document precisely so that it can be rebuilt here.
    bump(balanceKeyOf(a), 'forLaterRelease', (a.forLaterRelease as number) ?? 0);
  }
  for (const doc of obligations.docs) {
    const o = doc.data();
    const total = (o.totalAmount as number) ?? 0;
    const disbursed = (o.disbursedAmount as number) ?? 0;
    const lines: Array<Record<string, unknown> & { lineNo: number; amount: number }> = (
      (o.lines as Array<Record<string, unknown>>) ?? []
    ).map((l) => ({ ...l, lineNo: (l.lineNo as number) ?? 0, amount: (l.amount as number) ?? 0 }));
    // The SAME allocation approveDv used, remainder on the last line, so a
    // centavo of rounding never reads as a discrepancy.
    for (const { line, share } of allocateDvShares(lines, total, disbursed)) {
      // An obligation line is keyed on the object code the APPROPRIATION
      // carried, not on the object being bought - they differ on every
      // project line, where the appropriation named no object at all.
      const key = balanceKeyOf({ ...line, accountCode: line.appropriatedAccountCode ?? '' });
      bump(key, 'obligated', line.amount);
      bump(key, 'disbursed', share);
    }
  }

  return rebuilt;
}

export interface DisbursedDrift {
  budgetKey: string;
  fundCode: string;
  officeName: string;
  fppCode: string;
  accountCode: string;
  accountName: string;
  obligated: number;
  stored: number;
  rebuilt: number;
}

/**
 * repairBudgetDisbursed - put the `disbursed` of every budget line of a year
 * back to what its obligations say.
 *
 * `apply: false` only reports the lines that differ, so the administrator
 * sees what will change before anything does. `apply: true` writes them, one
 * transaction per line, re-reading the balance inside it so a voucher
 * approved between the report and the repair is not overwritten.
 *
 * Only the Super Administrator. This is the one place a budget figure is
 * written from a rebuild rather than from a transaction, and every line it
 * changes goes into the audit trail with the figure before and after.
 */
export const repairBudgetDisbursed = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK, timeoutSeconds: 300, memory: '1GiB' },
  async (request) => {
    const caller = await requireCaller(request, ['SUPER_ADMIN']);
    const { fiscalYear, apply } = (request.data ?? {}) as { fiscalYear?: number; apply?: boolean };
    if (!fiscalYear || !Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

    const rebuilt = await rebuildBudgetFigures(fiscalYear);
    const stored = await db
      .collection(COL.budgetBalances)
      .where('fiscalYear', '==', fiscalYear)
      .get();

    const drifts: DisbursedDrift[] = [];
    for (const doc of stored.docs) {
      const s = doc.data();
      // A balance no committed obligation touches has nothing disbursed.
      const r = rebuilt.get(doc.id)?.disbursed ?? 0;
      const current = (s.disbursed as number) ?? 0;
      if (current === r) continue;
      drifts.push({
        budgetKey: doc.id,
        fundCode: (s.fundCode as string) ?? '',
        officeName: (s.officeName as string) ?? (s.officeId as string) ?? '',
        fppCode: (s.fppCode as string) ?? '',
        accountCode: (s.accountCode as string) ?? '',
        accountName: (s.accountName as string) ?? '',
        obligated: (s.obligated as number) ?? 0,
        stored: current,
        rebuilt: r,
      });
    }

    if (!apply) return { fiscalYear, applied: false, drifts };

    let repaired = 0;
    for (const d of drifts) {
      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.budgetBalances).doc(d.budgetKey);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const b = snap.data() as Record<string, number>;
        // Re-read: a voucher approved since the report moved this line and
        // moved its obligation too, so the rebuilt figure would be stale.
        if ((b.disbursed ?? 0) !== d.stored) {
          throw new HttpsError(
            'aborted',
            `${d.officeName} ${d.accountCode || d.fppCode} changed while the repair was running. Run the report again.`,
          );
        }
        const obligated = b.obligated ?? 0;
        tx.update(ref, { disbursed: d.rebuilt, unpaidObligations: obligated - d.rebuilt });
        auditInTransaction(tx, {
          caller,
          event: 'BUDGET_OVERRIDE',
          entityType: COL.budgetBalances,
          entityId: d.budgetKey,
          entityRef: `${d.officeName} - ${d.accountCode || d.fppCode}`,
          fiscalYear,
          fundCode: d.fundCode,
          changes: [{ field: 'disbursed', previous: d.stored, next: d.rebuilt }],
          remarks:
            'Disbursed put back to the sum of the obligations drawn on this line. The difference was left behind by a cancelled or un-approved voucher before patch 120.',
          severity: 'CRITICAL',
        });
        repaired += 1;
      });
    }

    return { fiscalYear, applied: true, drifts, repaired };
  },
);
