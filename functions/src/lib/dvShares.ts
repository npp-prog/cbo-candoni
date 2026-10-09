import type { BudgetKey } from './budget';

/**
 * How a voucher's amount is spread over the lines of the obligation it draws.
 * Patch 120.
 *
 * ---------------------------------------------------------------------------
 * ONE ALLOCATION, USED IN FOUR PLACES
 * ---------------------------------------------------------------------------
 * Approving a voucher adds its share to each budget line's `disbursed`.
 * Cancelling or un-approving it must take EXACTLY the same shares back, and
 * the nightly verifier must rebuild EXACTLY the same shares from the
 * obligation - or the three disagree by a centavo of rounding and the
 * verifier reports a drift that is not there, which is how a real drift goes
 * unread.
 *
 * Until this patch each of the three had its own copy of the arithmetic, and
 * the cancellation's copy was missing the budget line altogether: it gave the
 * money back to the obligation and to the fund summary and left the budget
 * line still showing it disbursed. Cancel the voucher, then cancel the
 * obligation, and the registry showed more disbursed than obligated - an
 * unpaid figure below zero.
 *
 * Proportional by line amount; the LAST line absorbs the rounding remainder
 * so the shares sum exactly to the voucher.
 */

export interface ShareLine {
  lineNo: number;
  amount: number;
}

export function allocateDvShares<L extends ShareLine>(
  lines: readonly L[],
  obligationTotal: number,
  grossAmount: number,
): Array<{ line: L; share: number }> {
  const total = obligationTotal || 1;
  let allocated = 0;
  return lines.map((line, idx) => {
    const isLast = idx === lines.length - 1;
    const share = isLast
      ? grossAmount - allocated
      : Math.round((line.amount / total) * grossAmount);
    allocated += share;
    return { line, share };
  });
}

/**
 * The budget line an obligation line commits.
 *
 * Keyed on the object code the APPROPRIATION carried, never the object the
 * line buys: they differ on every project line, where the appropriation named
 * no object at all. `certifyObligation`, `approveDv` and the nightly rebuild
 * all key it this way; this is the one place that says how.
 */
export function obligationLineKey(
  obr: { fiscalYear: number; fundCode: string },
  line: BudgetKey & { appropriatedAccountCode?: string },
): BudgetKey {
  return {
    fiscalYear: line.fiscalYear ?? obr.fiscalYear,
    fundCode: line.fundCode ?? obr.fundCode,
    officeId: line.officeId,
    responsibilityCenterId: line.responsibilityCenterId ?? null,
    programId: line.programId ?? null,
    projectId: line.projectId ?? null,
    activityId: line.activityId ?? null,
    fppCode: line.fppCode,
    accountCode: line.appropriatedAccountCode ?? '',
  };
}
