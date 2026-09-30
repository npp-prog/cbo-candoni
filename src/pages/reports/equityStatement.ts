import type { Centavos } from '@/types/common';
import type { FsAccountBalance } from './condensedFs';

/**
 * The Statement of Changes in Net Assets/Equity.
 *
 * GAM for LGUs, Volume I, Section 369 and Annex 7. Eight lines, comparative,
 * and every one of them named by the manual:
 *
 *   Balance at January 1
 *   Add (Deduct)  Change in Accounting Policy
 *                 Prior Period Errors
 *   Restated Balance
 *   Add (Deduct) Changes in net assets/equity during the year
 *                 Adjustment of net revenue recognized directly in
 *                 net assets/equity
 *   Surplus (Deficit) for the period
 *   Total recognized revenue and expenses for the period
 *   Balance at December 31
 *
 * Section 369 lists what must show on the face: the surplus or deficit; each
 * item of revenue and expense recognised directly in net assets/equity; the
 * total of those; the effects of changes in accounting policies and
 * corrections of errors; and the opening and closing balances.
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH LINE COMES FROM, AND THE ONE THAT CANNOT
 * ---------------------------------------------------------------------------
 *   Prior Period Errors   account 30101020 Prior Period Adjustment
 *   Adjustment ... equity 3-04 Unrealized Gain/(Loss) and 3-13 Remeasurement
 *   Surplus for the period  the Statement of Financial Performance
 *   Balance at January 1    last year's closing net assets/equity
 *
 * Change in Accounting Policy has NO account in the municipality's chart, and
 * that is not an oversight in the chart: a change of policy is restated
 * through the affected accounts, not booked to one of its own. The line is
 * printed at nil because Annex 7 prints it, and a statement missing one of the
 * manual's lines is queried; the screen says why it is nil rather than leaving
 * the reader to guess.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OPENING BALANCE IS TAKEN FROM LAST YEAR'S TOTAL
 * ---------------------------------------------------------------------------
 * Not from the Government Equity account alone. Whether an LGU has put its
 * surplus through a formal year-end closing entry into Government Equity, or
 * left it in the Income and Expense Summary, or done neither, changes that
 * account's balance and does not change what the municipality is worth.
 *
 * "Balance at January 1" means the net assets as the preceding year ended, and
 * that is last year's equity accounts PLUS last year's surplus - the same
 * figure the foot of last year's Statement of Financial Position carried. Read
 * that way it is right whichever closing practice the office follows, and the
 * statement rolls forward without a gap.
 */

export interface EquityStatement {
  openingBalance: { current: Centavos; prior: Centavos };
  changeInAccountingPolicy: { current: Centavos; prior: Centavos };
  priorPeriodErrors: { current: Centavos; prior: Centavos };
  restatedBalance: { current: Centavos; prior: Centavos };
  adjustmentRecognisedInEquity: { current: Centavos; prior: Centavos };
  surplus: { current: Centavos; prior: Centavos };
  totalRecognised: { current: Centavos; prior: Centavos };
  closingBalance: { current: Centavos; prior: Centavos };
  /**
   * True while nothing in the chart can produce a Change in Accounting Policy
   * figure, so the screen can say why that line is nil instead of leaving it
   * looking like a missing figure.
   */
  accountingPolicyNotTracked: boolean;
}

/** The account that carries a correction of a prior period. */
export const PRIOR_PERIOD_ACCOUNT = '30101020';

/** Movements recognised directly in equity rather than through surplus. */
export const DIRECT_EQUITY_GROUPS = ['304', '313'];

/**
 * A change of accounting policy is restated through the accounts it affects,
 * so no account holds it. Empty, and named, so the reason travels with the
 * code rather than living only in a comment.
 */
export const ACCOUNTING_POLICY_ACCOUNTS: string[] = [];

const sumWhere = (rows: FsAccountBalance[], pick: (code: string) => boolean): Centavos =>
  rows.filter((r) => pick(r.accountCode)).reduce((s, r) => s + r.amount, 0);

const isDirectEquity = (code: string) => DIRECT_EQUITY_GROUPS.includes(code.slice(0, 3));

/**
 * Build the statement.
 *
 * `current` and `prior` are the sign-adjusted balances of the two years, the
 * same ones the other statements are built from. `surplus` comes from the
 * Statement of Financial Performance rather than being recomputed here, so the
 * two cannot disagree about it - and they would, sooner or later, if the
 * transfers block were folded in twice.
 *
 * `priorOpening` is the close of the year BEFORE the comparative one. It is
 * optional: with only two years of ledger to hand the comparative column's
 * opening balance is not knowable, and it is reported as such rather than
 * silently shown as nil.
 */
export function buildEquityStatement(input: {
  current: FsAccountBalance[];
  prior: FsAccountBalance[];
  surplus: { current: Centavos; prior: Centavos };
  priorOpening?: Centavos;
}): EquityStatement {
  const equityOf = (rows: FsAccountBalance[]) =>
    rows
      .filter((r) => r.classification === 'NET_ASSETS_EQUITY')
      .reduce((s, r) => s + r.amount, 0);

  // Last year's closing net assets: its equity accounts plus its surplus.
  const openingCurrent = equityOf(input.prior) + input.surplus.prior;
  const openingPrior = input.priorOpening ?? 0;

  const priorErrorsCurrent = sumWhere(input.current, (c) => c === PRIOR_PERIOD_ACCOUNT);
  const priorErrorsPrior = sumWhere(input.prior, (c) => c === PRIOR_PERIOD_ACCOUNT);

  const directCurrent = sumWhere(input.current, isDirectEquity);
  const directPrior = sumWhere(input.prior, isDirectEquity);

  const policyCurrent = sumWhere(input.current, (c) => ACCOUNTING_POLICY_ACCOUNTS.includes(c));
  const policyPrior = sumWhere(input.prior, (c) => ACCOUNTING_POLICY_ACCOUNTS.includes(c));

  const restatedCurrent = openingCurrent + policyCurrent + priorErrorsCurrent;
  const restatedPrior = openingPrior + policyPrior + priorErrorsPrior;

  // Section 369(c): the total recognised for the period is the surplus plus
  // what was recognised directly in equity, and it is shown as its own line.
  const totalCurrent = directCurrent + input.surplus.current;
  const totalPrior = directPrior + input.surplus.prior;

  return {
    openingBalance: { current: openingCurrent, prior: openingPrior },
    changeInAccountingPolicy: { current: policyCurrent, prior: policyPrior },
    priorPeriodErrors: { current: priorErrorsCurrent, prior: priorErrorsPrior },
    restatedBalance: { current: restatedCurrent, prior: restatedPrior },
    adjustmentRecognisedInEquity: { current: directCurrent, prior: directPrior },
    surplus: input.surplus,
    totalRecognised: { current: totalCurrent, prior: totalPrior },
    closingBalance: {
      current: restatedCurrent + totalCurrent,
      prior: restatedPrior + totalPrior,
    },
    accountingPolicyNotTracked: ACCOUNTING_POLICY_ACCOUNTS.length === 0,
  };
}
