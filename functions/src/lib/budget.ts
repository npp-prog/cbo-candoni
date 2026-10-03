import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db, COL } from './firebase';

/**
 * Refuses, by name, any figure that is not a real number before it reaches a
 * balance document.
 *
 * Two different disasters are stopped here, and neither announces itself.
 *
 * `FieldValue.increment` throws a plain, unreadable error when it is handed
 * anything but a number - which the browser only ever sees as the word
 * "internal". And a balance arithmetic that quietly produces NaN, or
 * concatenates a string, is written to `budgetBalances` as a figure no
 * document caused, where it then governs every later control decision for
 * that line.
 *
 * Fail closed, and name the field. A budget control that cannot be computed
 * must stop the transaction, not write a guess.
 */
function assertFigures(where: string, values: Record<string, unknown>): void {
  const bad = Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v))
    .map(([k]) => k);

  if (bad.length === 0) return;

  throw new HttpsError(
    'failed-precondition',
    `${where} was given ${bad.join(', ')} as something other than a number, so the balance cannot be worked out. Nothing has been saved. This is a damaged record rather than a mistake in what you entered - report it.`,
    { fields: bad },
  );
}

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
  /**
   * The part of the appropriation the Budget Officer has held back, in the
   * Budget Operations Manual's words "For Later Release".
   *
   * Not a reduction of the appropriation - the authority still exists and can
   * be released later - so it never touches appropriationRevised. It only
   * makes the held amount unavailable.
   */
  forLaterRelease: number;
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
  forLaterRelease: 0,
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
/**
 * The stored balance, with whatever labels the line carries.
 *
 * The labels come back as well as the figures because a caller that needs to
 * NAME a budget line - in a refusal message, or on an Allotment Release Order
 * - would otherwise have to read the same document twice, once here for the
 * figures and once outside the transaction for the office name. Reading it
 * twice is how the two come to disagree.
 */
export async function readBudgetBalance(
  tx: Transaction,
  key: BudgetKey,
): Promise<BudgetBalanceData & Partial<BudgetLabels>> {
  const snap = await tx.get(budgetBalanceRef(key));
  if (!snap.exists) return { ...EMPTY_BALANCE };
  const d = snap.data() as Partial<BudgetBalanceData & BudgetLabels>;
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
    // What the office may still be given, which is the appropriation less
    // what is held back and less what has already gone out. A department
    // reading this has to see what it can actually be allotted.
    availableAppropriation:
      appropriationRevised - (b.forLaterRelease ?? 0) - b.allotmentReleased,
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
  assertFigures('The stored balance for this budget line', {
    appropriationOriginal: current.appropriationOriginal,
    appropriationSupplemental: current.appropriationSupplemental,
    appropriationContinuing: current.appropriationContinuing,
    appropriationAdjustments: current.appropriationAdjustments,
    allotmentReleased: current.allotmentReleased,
    forLaterRelease: current.forLaterRelease,
    obligated: current.obligated,
    disbursed: current.disbursed,
  });
  assertFigures('This change to the budget line', { ...delta });

  const merged: BudgetBalanceData = {
    appropriationOriginal: current.appropriationOriginal + (delta.appropriationOriginal ?? 0),
    appropriationSupplemental:
      current.appropriationSupplemental + (delta.appropriationSupplemental ?? 0),
    appropriationContinuing: current.appropriationContinuing + (delta.appropriationContinuing ?? 0),
    appropriationAdjustments:
      current.appropriationAdjustments + (delta.appropriationAdjustments ?? 0),
    appropriationRevised: 0,
    allotmentReleased: current.allotmentReleased + (delta.allotmentReleased ?? 0),
    forLaterRelease: (current.forLaterRelease ?? 0) + (delta.forLaterRelease ?? 0),
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
  assertFigures('The fund-level summary', { ...delta });

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
