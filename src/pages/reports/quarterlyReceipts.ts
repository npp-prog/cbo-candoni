import type { Centavos, PeriodNo } from '@/types/common';
import type { Quarter } from '@/lib/budgetPeriods';

/**
 * LBAc Form No. 1 — Quarterly Report of Receipts.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 5 of Part II, Item
 * 5.5. Prepared by the Local Treasurer, certified correct by the Local
 * Accountant, submitted to the Local Finance Committee through the Local
 * Budget Officer on or before the tenth day of the month following the quarter
 * reported.
 *
 * The computation lives here rather than in the screen because two of the
 * manual's columns are easy to get wrong in a way that still looks right, and
 * a wrong figure on a submitted form is not something the officer who signs it
 * can be expected to catch:
 *
 *   Column 5 is NOT column 3 plus column 4. The manual says "the estimated
 *   income from January to the end of the quarter reported" - the whole year
 *   to date, not the two quarters shown beside it. For the second quarter the
 *   two happen to agree, which is exactly why the mistake survives testing.
 *
 *   Column 9 is NOT columns 6 to 8 added up. Those are the three months OF THE
 *   QUARTER; column 9 is January to the end of it, and the manual adds that it
 *   "should tally with the income account per Trial Balance as of date".
 *
 * Both are computed from the periods they actually cover, and there are tests
 * for each that fail if either is derived from its neighbours.
 */

/**
 * One General Ledger entry on a revenue account.
 *
 * The actual income comes from the ledger, not from the collections register,
 * because the manual ties column 9 to the Trial Balance. A collection that has
 * been receipted but not yet journalised is not yet income, and a report that
 * counted it would disagree with the books it is filed beside.
 */
export interface ReceiptEntry {
  accountCode: string;
  accountName: string;
  /** Accounting period, 1 to 12. */
  period: PeriodNo;
  /** Positive is a debit, negative a credit - the ledger's own convention. */
  signedAmount: Centavos;
}

/** What the office estimated it would collect, per quarter. */
export interface QuarterEstimate {
  q1?: Centavos;
  q2?: Centavos;
  q3?: Centavos;
  q4?: Centavos;
}

/**
 * The estimates, keyed by account code.
 *
 * CBO does not derive these from anything. Estimated income is a budget
 * PREPARATION figure - it is what the Local Finance Committee certified as the
 * income reasonably expected, and it is the denominator of the variance this
 * whole form exists to show. Guessing it from last year's collections would
 * produce a form that looks complete and reports a variance against a number
 * nobody certified.
 */
export type IncomeEstimates = Record<string, QuarterEstimate>;

const QUARTER_KEYS = ['q1', 'q2', 'q3', 'q4'] as const;

/** The estimate for one quarter, treating an absent figure as nothing. */
export function estimateFor(estimate: QuarterEstimate | undefined, quarter: Quarter): Centavos {
  if (!estimate) return 0;
  return estimate[QUARTER_KEYS[quarter - 1]] ?? 0;
}

/** January to the end of the quarter reported - the manual's column 5. */
export function estimateToDate(
  estimate: QuarterEstimate | undefined,
  quarter: Quarter,
): Centavos {
  let total = 0;
  for (let q = 1; q <= quarter; q++) total += estimateFor(estimate, q as Quarter);
  return total;
}

/** The three accounting periods making up a quarter. */
export function monthsOfQuarter(quarter: Quarter): [PeriodNo, PeriodNo, PeriodNo] {
  const first = (quarter - 1) * 3 + 1;
  return [first, first + 1, first + 2];
}

export interface ReceiptRow {
  /** Column 2. */
  accountCode: string;
  /** Column 1. */
  accountName: string;
  /** Column 3 - the estimate for the quarter before the one reported. */
  estimatedPrevious: Centavos;
  /** Column 4 - the estimate for the quarter reported. */
  estimatedThis: Centavos;
  /** Column 5 - January to the end of the quarter reported. */
  estimatedToDate: Centavos;
  /** Columns 6, 7 and 8 - the three months of the quarter reported. */
  months: [Centavos, Centavos, Centavos];
  /** Column 9 - January to the end of the quarter reported. */
  actualToDate: Centavos;
  /** Column 10 - column 9 less column 5. */
  variance: Centavos;
  /**
   * Column 11 - column 10 over column 5, as a fraction.
   *
   * Null where nothing was estimated. The manual's formula divides by column
   * 5, and an account with no estimate would divide by zero; showing that as
   * an infinite or a hundred per cent increase would be a figure the Treasurer
   * signs for and cannot defend.
   */
  variancePct: number | null;
  /** True where this account has income but no certified estimate at all. */
  unestimated: boolean;
}

export interface ReceiptsReport {
  quarter: Quarter;
  rows: ReceiptRow[];
  total: Omit<ReceiptRow, 'accountCode' | 'accountName' | 'unestimated'>;
  /** True where no estimate has been nominated for any account. */
  noEstimates: boolean;
  /** Accounts carrying income that nobody estimated. */
  unestimatedCodes: string[];
}

/**
 * Income on a revenue account, from the ledger's signed amounts.
 *
 * A revenue account carries a credit balance, and the ledger stores a credit
 * as a negative. Income is therefore the NEGATED sum - which also means a
 * debit to a revenue account, a refund or a correction, reduces it. That is
 * the behaviour the Trial Balance shows, and column 9 has to agree with it.
 */
function incomeOf(entries: ReceiptEntry[]): Centavos {
  let total = 0;
  for (const e of entries) total -= e.signedAmount;
  return total;
}

/**
 * Builds the form for one quarter.
 *
 * An account appears if it was estimated or if it collected anything. An
 * account that was estimated and collected nothing must appear - that is a
 * shortfall, and it is the single most important thing this form reports.
 */
export function buildReceiptsReport(
  entries: ReceiptEntry[],
  estimates: IncomeEstimates,
  quarter: Quarter,
): ReceiptsReport {
  const months = monthsOfQuarter(quarter);
  const lastPeriod = months[2];

  const byAccount = new Map<string, ReceiptEntry[]>();
  const names = new Map<string, string>();

  for (const e of entries) {
    // Entries after the quarter reported are not part of it. The caller may
    // hand over a whole year; the form covers January to the end of the
    // quarter and nothing beyond.
    if (e.period > lastPeriod) continue;
    const list = byAccount.get(e.accountCode) ?? [];
    list.push(e);
    byAccount.set(e.accountCode, list);
    if (e.accountName) names.set(e.accountCode, e.accountName);
  }

  const codes = new Set<string>([...byAccount.keys(), ...Object.keys(estimates)]);

  const rows: ReceiptRow[] = [];

  for (const code of [...codes].sort()) {
    const estimate = estimates[code];
    const mine = byAccount.get(code) ?? [];

    const estimatedThis = estimateFor(estimate, quarter);
    const estimatedPrevious =
      quarter === 1 ? 0 : estimateFor(estimate, (quarter - 1) as Quarter);
    const toDateEstimate = estimateToDate(estimate, quarter);

    const monthAmounts = months.map((p) => incomeOf(mine.filter((e) => e.period === p))) as [
      Centavos,
      Centavos,
      Centavos,
    ];

    // January to the end of the quarter, over every period - not the three
    // months above. For any quarter after the first those differ.
    const actualToDate = incomeOf(mine);

    const hasEstimate = toDateEstimate !== 0 || estimate !== undefined;
    const hasIncome = actualToDate !== 0 || monthAmounts.some((m) => m !== 0);
    if (!hasEstimate && !hasIncome) continue;

    rows.push({
      accountCode: code,
      accountName: names.get(code) ?? '',
      estimatedPrevious,
      estimatedThis,
      estimatedToDate: toDateEstimate,
      months: monthAmounts,
      actualToDate,
      variance: actualToDate - toDateEstimate,
      variancePct: toDateEstimate === 0 ? null : (actualToDate - toDateEstimate) / toDateEstimate,
      unestimated: toDateEstimate === 0 && hasIncome,
    });
  }

  const sumOf = (pick: (r: ReceiptRow) => Centavos) => rows.reduce((s, r) => s + pick(r), 0);

  const totalEstimatedToDate = sumOf((r) => r.estimatedToDate);
  const totalActualToDate = sumOf((r) => r.actualToDate);

  return {
    quarter,
    rows,
    total: {
      estimatedPrevious: sumOf((r) => r.estimatedPrevious),
      estimatedThis: sumOf((r) => r.estimatedThis),
      estimatedToDate: totalEstimatedToDate,
      months: [sumOf((r) => r.months[0]), sumOf((r) => r.months[1]), sumOf((r) => r.months[2])],
      actualToDate: totalActualToDate,
      variance: totalActualToDate - totalEstimatedToDate,
      variancePct:
        totalEstimatedToDate === 0
          ? null
          : (totalActualToDate - totalEstimatedToDate) / totalEstimatedToDate,
    },
    noEstimates: Object.keys(estimates).length === 0,
    unestimatedCodes: rows.filter((r) => r.unestimated).map((r) => r.accountCode),
  };
}
