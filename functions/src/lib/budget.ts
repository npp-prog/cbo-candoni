import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { db, COL } from './firebase';

/**
 * Budget balance maintenance.
 *
 * `budgetBalances/{budgetKeyId}` is a per-line running total. Its document id
 * is derived from the budget key, which means every obligation against the same
 * line contends on the same document. That contention is deliberate and is the
 * mechanism that makes the control real: two simultaneous obligations against
 * the same line cannot both read the same available balance and both succeed,
 * because Firestore aborts and retries the second transaction.
 *
 * The balance document is a cache. It is fully rebuildable from the
 * appropriations, allotments and obligations that produced it, and
 * `verifyBudgetBalances` (scheduled nightly) does exactly that and reports
 * discrepancies. The source documents remain the record.
 */

export interface BudgetKey {
  fiscalYear: number;
  fundCode: string;
  officeId: string;
  responsibilityCenterId?: string | null;
  programId?: string | null;
  projectId?: string | null;
  activityId?: string | null;
  /**
   * The Function, Programme or Project the Sanggunian appropriated to. An
   * object code from the Revised Chart of Accounts where the appropriation was
   * made by object of expenditure, a programme code from the FPP masterlist
   * where it was made by project.
   */
  fppCode: string;
  /**
   * The object of expenditure. EMPTY on a project line - a third of the FY2025
   * ordinance was appropriated by project with no object code at all, and the
   * object only becomes known when the obligation is raised.
   */
  accountCode: string;
}

/**
 * MUST stay identical to budgetKeyId in src/types/budget.ts.
 *
 * The two are not vendored from one file because the client's version carries
 * the client's types. If they ever disagree, the browser and the server would
 * read and write different balance documents for the same budget line, and the
 * control would silently stop controlling anything.
 */
export function budgetKeyId(k: BudgetKey): string {
  return [
    k.fiscalYear,
    k.fundCode,
    k.officeId,
    k.responsibilityCenterId ?? '-',
    k.programId ?? '-',
    k.projectId ?? '-',
    k.activityId ?? '-',
    k.fppCode || '-',
    k.accountCode || '-',
  ].join('__');
}

export function budgetBalanceRef(k: BudgetKey): DocumentReference {
  return db.collection(COL.budgetBalances).doc(budgetKeyId(k));
}

export interface BudgetBalanceData {
  appropriationOriginal: number;
  appropriationSupplemental: number;
  appropriationContinuing: number;
  appropriationAdjustments: number;
  appropriationRevised: number;
  allotmentReleased: number;
  availableAppropriation: number;
  obligated: number;
  availableAllotment: number;
  disbursed: number;
  unpaidObligations: number;
}

export const EMPTY_BALANCE: BudgetBalanceData = {
  appropriationOriginal: 0,
  appropriationSupplemental: 0,
  appropriationContinuing: 0,
  appropriationAdjustments: 0,
  appropriationRevised: 0,
  allotmentReleased: 0,
  availableAppropriation: 0,
  obligated: 0,
  availableAllotment: 0,
  disbursed: 0,
  unpaidObligations: 0,
};

/**
 * Reads the authoritative balance for a budget line inside a transaction.
 *
 * This is the function that makes the frontend's displayed figures irrelevant.
 * However confident the browser was that ₱500,000 remained, this read - taken
 * inside the transaction that will commit the obligation - is what the decision
 * is made on.
 */
export async function readBudgetBalance(
  tx: Transaction,
  key: BudgetKey,
): Promise<BudgetBalanceData> {
  const snap = await tx.get(budgetBalanceRef(key));
  if (!snap.exists) return { ...EMPTY_BALANCE };
  const d = snap.data() as Partial<BudgetBalanceData>;
  return { ...EMPTY_BALANCE, ...d };
}

/** Recomputes the three derived figures from the stored components. */
export function deriveBalance(b: BudgetBalanceData): BudgetBalanceData {
  const appropriationRevised =
    b.appropriationOriginal +
    b.appropriationSupplemental +
    b.appropriationContinuing +
    b.appropriationAdjustments;

  return {
    ...b,
    appropriationRevised,
    availableAppropriation: appropriationRevised - b.allotmentReleased,
    availableAllotment: b.allotmentReleased - b.obligated,
    unpaidObligations: b.obligated - b.disbursed,
  };
}

export interface BudgetLabels {
  officeName: string;
  accountName: string;
  /**
   * Denormalised onto the balance so a registry or an SRE can be cut by FPP
   * and by sector without reading the appropriations back.
   */
  fppName?: string;
  sector?: string | null;
  serviceSector?: string | null;
  expenseClass: string;
}

/**
 * Applies a signed delta to a budget balance and writes it. Call only after
 * all reads in the transaction are complete.
 */
export function applyBudgetDelta(
  tx: Transaction,
  key: BudgetKey,
  current: BudgetBalanceData,
  delta: Partial<BudgetBalanceData>,
  labels: BudgetLabels,
): BudgetBalanceData {
  const merged: BudgetBalanceData = {
    appropriationOriginal: current.appropriationOriginal + (delta.appropriationOriginal ?? 0),
    appropriationSupplemental:
      current.appropriationSupplemental + (delta.appropriationSupplemental ?? 0),
    appropriationContinuing: current.appropriationContinuing + (delta.appropriationContinuing ?? 0),
    appropriationAdjustments:
      current.appropriationAdjustments + (delta.appropriationAdjustments ?? 0),
    appropriationRevised: 0,
    allotmentReleased: current.allotmentReleased + (delta.allotmentReleased ?? 0),
    availableAppropriation: 0,
    obligated: current.obligated + (delta.obligated ?? 0),
    availableAllotment: 0,
    disbursed: current.disbursed + (delta.disbursed ?? 0),
    unpaidObligations: 0,
  };

  const derived = deriveBalance(merged);

  tx.set(
    budgetBalanceRef(key),
    {
      ...key,
      responsibilityCenterId: key.responsibilityCenterId ?? null,
      programId: key.programId ?? null,
      projectId: key.projectId ?? null,
      activityId: key.activityId ?? null,
      ...labels,
      ...derived,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );

  return derived;
}

/**
 * Fund-level rollup used by the dashboard. Updated alongside the line balance
 * so the dashboard does not have to aggregate thousands of documents on every
 * page load.
 */
export function applySummaryDelta(
  tx: Transaction,
  fiscalYear: number,
  fundCode: string,
  delta: {
    appropriationRevised?: number;
    allotmentReleased?: number;
    obligated?: number;
    disbursed?: number;
  },
): void {
  const ref = db.collection(COL.budgetSummaries).doc(`${fiscalYear}__${fundCode}`);
  const inc = (n: number | undefined) => (n ?? 0);

  // FieldValue.increment is safe here because the summary is not used for any
  // control decision - only for display. Control decisions read the line
  // balance transactionally above.
  tx.set(
    ref,
    {
      fiscalYear,
      fundCode,
      appropriationRevised: FieldValueIncrement(inc(delta.appropriationRevised)),
      allotmentReleased: FieldValueIncrement(inc(delta.allotmentReleased)),
      obligated: FieldValueIncrement(inc(delta.obligated)),
      disbursed: FieldValueIncrement(inc(delta.disbursed)),
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

// Imported lazily to keep this module free of a hard dependency on the admin
// FieldValue type at module load, which simplifies unit testing.
function FieldValueIncrement(n: number) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { FieldValue } = require('firebase-admin/firestore');
  return FieldValue.increment(n);
}
