import type { Centavos, PeriodNo } from '@/types/common';
import {
  lastMonthOf,
  monthsToDate,
  periodColumns,
  periodMonths,
  previousPeriod,
  type ReportPeriod,
} from '@/lib/reportPeriods';

/**
 * LBAc Form No. 1 — the Report of Receipts.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 5 of Part II, Item
 * 5.5. Prepared by the Local Treasurer, certified correct by the Local
 * Accountant, submitted to the Local Finance Committee through the Local
 * Budget Officer on or before the tenth day of the month following the quarter
 * reported.
 *
 * ---------------------------------------------------------------------------
 * THE SUBMISSION IS QUARTERLY; THE QUESTION IS NOT
 * ---------------------------------------------------------------------------
 * The manual's form is a quarter. The quarter is the deadline, not the only
 * period anybody asks about: the Budget Officer looking at December wants
 * December, and somebody answering a query in August wants it as of August.
 * So the period is chosen, and `@/lib/reportPeriods` is the one definition of
 * what a period is.
 *
 * The manual's layout is still exactly what comes out when the period is a
 * quarter, down to its column numbers.
 *
 * ---------------------------------------------------------------------------
 * TWO COLUMNS THAT CAN BE COMPUTED FROM THEIR NEIGHBOURS AND BE WRONG
 * ---------------------------------------------------------------------------
 *   The estimate to date is NOT this period's estimate plus the previous
 *   one's. The manual says "the estimated income from January to the end of
 *   the quarter reported" - the whole year to date. For the second quarter the
 *   two happen to agree, which is exactly why the mistake survives testing.
 *
 *   The actual to date is NOT the breakdown columns added up. Those are the
 *   months of the period; the to-date figure is January to the end of it, and
 *   the manual adds that it "should tally with the income account per Trial
 *   Balance as of date".
 *
 * Both are computed from the periods they actually cover, and there are tests
 * for each that fail if either is derived from its neighbours.
 *
 * ---------------------------------------------------------------------------
 * WHY A MONTHLY REPORT HAS NO VARIANCE
 * ---------------------------------------------------------------------------
 * The Local Finance Committee certifies estimated income BY QUARTER. There is
 * no monthly estimate anywhere, and CFMS does not make one up: dividing a
 * quarter by three would produce figures nobody certified and a variance CFMS
 * invented, reported to the Committee as though the Treasurer had projected
 * it.
 *
 * So the estimate is reported where it exists - on a quarter, on a year, and
 * as of a month that closes a quarter - and where it does not, the estimate
 * and variance columns say so instead of showing a number.
 */

/**
 * One General Ledger entry on a revenue account.
 *
 * The actual income comes from the ledger, not from the collections register,
 * because the manual ties the to-date column to the Trial Balance. A
 * collection that has been receipted but not yet journalised is not yet
 * income, and a report that counted it would disagree with the books it is
 * filed beside.
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
 * CFMS does not derive these from anything. Estimated income is a budget
 * PREPARATION figure - what the Local Finance Committee certified as the
 * income reasonably expected - and it is the denominator of the variance this
 * whole form exists to show. Guessing it from last year's collections would
 * produce a form that looks complete and reports a variance against a number
 * nobody certified.
 */
export type IncomeEstimates = Record<string, QuarterEstimate>;

const QUARTER_KEYS = ['q1', 'q2', 'q3', 'q4'] as const;

/** The estimate for one quarter, treating an absent figure as nothing. */
export function estimateForQuarter(
  estimate: QuarterEstimate | undefined,
  quarter: number,
): Centavos {
  if (!estimate || quarter < 1 || quarter > 4) return 0;
  return estimate[QUARTER_KEYS[quarter - 1]] ?? 0;
}

/** True where the period closes exactly on a quarter end. */
export function endsOnAQuarter(period: ReportPeriod): boolean {
  return lastMonthOf(period) % 3 === 0;
}

/**
 * The estimate for the period itself.
 *
 * Null where the period is not one the Committee certified. A month has no
 * estimate of its own and never will; an as-of is a running total and has no
 * "this period" at all.
 */
export function estimateForPeriod(
  estimate: QuarterEstimate | undefined,
  period: ReportPeriod,
): Centavos | null {
  if (period.mode === 'QUARTERLY') return estimateForQuarter(estimate, period.index);
  if (period.mode === 'ANNUAL') {
    return [1, 2, 3, 4].reduce((s, q) => s + estimateForQuarter(estimate, q), 0);
  }
  return null;
}

/**
 * January to the end of the period - the manual's column 5.
 *
 * Available only where the period closes on a quarter, because the estimate
 * itself is quarterly. Half of a certified quarter is not a certified figure.
 */
export function estimateToDateForPeriod(
  estimate: QuarterEstimate | undefined,
  period: ReportPeriod,
): Centavos | null {
  if (!endsOnAQuarter(period)) return null;
  const quarters = lastMonthOf(period) / 3;
  let total = 0;
  for (let q = 1; q <= quarters; q++) total += estimateForQuarter(estimate, q);
  return total;
}

export interface ReceiptRow {
  /** Column 2 on the quarterly form. */
  accountCode: string;
  /** Column 1. */
  accountName: string;
  /** Column 3 - the estimate for the period before this one, where there is one. */
  estimatedPrevious: Centavos | null;
  /** Column 4 - the estimate for the period reported. */
  estimatedThis: Centavos | null;
  /** Column 5 - January to the end of the period reported. */
  estimatedToDate: Centavos | null;
  /** Columns 6 to 8 on a quarter: one figure per breakdown column. */
  columns: Centavos[];
  /** Column 9 - January to the end of the period reported. */
  actualToDate: Centavos;
  /** Column 10 - column 9 less column 5. Null where nothing was estimated. */
  variance: Centavos | null;
  /**
   * Column 11 - the variance over the estimate, as a fraction.
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
  period: ReportPeriod;
  rows: ReceiptRow[];
  total: Omit<ReceiptRow, 'accountCode' | 'accountName' | 'unestimated'>;
  /** True where no estimate has been nominated for any account. */
  noEstimates: boolean;
  /** Accounts carrying income that nobody estimated. */
  unestimatedCodes: string[];
  /**
   * True where the period does not close on a quarter, so the estimate and
   * variance columns cannot be filled at all.
   */
  estimateUnavailable: boolean;
}

/**
 * Income on a revenue account, from the ledger's signed amounts.
 *
 * A revenue account carries a credit balance, and the ledger stores a credit
 * as a negative. Income is therefore the NEGATED sum - which also means a
 * debit to a revenue account, a refund or a correction, reduces it. That is
 * the behaviour the Trial Balance shows, and the to-date column has to agree
 * with it.
 */
function incomeOf(entries: ReceiptEntry[]): Centavos {
  let total = 0;
  for (const e of entries) total -= e.signedAmount;
  return total;
}

/**
 * Builds the form for one period.
 *
 * An account appears if it was estimated or if it collected anything. An
 * account that was estimated and collected nothing must appear - that is a
 * shortfall, and it is the single most important thing this form reports.
 */
export function buildReceiptsReport(
  entries: ReceiptEntry[],
  estimates: IncomeEstimates,
  period: ReportPeriod,
): ReceiptsReport {
  const columns = periodColumns(period);
  const toDate = new Set(monthsToDate(period));
  const lastPeriod = lastMonthOf(period);
  const previous = previousPeriod(period);

  const byAccount = new Map<string, ReceiptEntry[]>();
  const names = new Map<string, string>();

  for (const e of entries) {
    // Entries after the period reported are not part of it. The caller may
    // hand over a whole year; the form covers January to the end of the period
    // and nothing beyond.
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

    const estimatedThis = estimateForPeriod(estimate, period);
    const estimatedPrevious = previous ? estimateForPeriod(estimate, previous) : null;
    const estimatedToDate = estimateToDateForPeriod(estimate, period);

    const columnAmounts = columns.map((c) => {
      const months = new Set(c.months);
      return incomeOf(mine.filter((e) => months.has(e.period)));
    });

    // January to the end of the period, over every month in that range - not
    // the breakdown columns above. For any period after the first month those
    // differ.
    const actualToDate = incomeOf(mine.filter((e) => toDate.has(e.period)));

    const hasEstimate = estimate !== undefined;
    const hasIncome = actualToDate !== 0 || columnAmounts.some((m) => m !== 0);
    if (!hasEstimate && !hasIncome) continue;

    const variance = estimatedToDate === null ? null : actualToDate - estimatedToDate;

    rows.push({
      accountCode: code,
      accountName: names.get(code) ?? '',
      estimatedPrevious,
      estimatedThis,
      estimatedToDate,
      columns: columnAmounts,
      actualToDate,
      variance,
      variancePct:
        estimatedToDate === null || estimatedToDate === 0 ? null : variance! / estimatedToDate,
      unestimated: (estimatedToDate ?? 0) === 0 && hasIncome,
    });
  }

  /** Sums a nullable column: null only where every row is null. */
  const sumNullable = (pick: (r: ReceiptRow) => Centavos | null): Centavos | null => {
    const present = rows.map(pick).filter((v): v is Centavos => v !== null);
    if (rows.length > 0 && present.length === 0) return null;
    return present.reduce((s, v) => s + v, 0);
  };

  const totalEstimatedToDate = sumNullable((r) => r.estimatedToDate);
  const totalActualToDate = rows.reduce((s, r) => s + r.actualToDate, 0);
  const totalVariance =
    totalEstimatedToDate === null ? null : totalActualToDate - totalEstimatedToDate;

  return {
    period,
    rows,
    total: {
      estimatedPrevious: sumNullable((r) => r.estimatedPrevious),
      estimatedThis: sumNullable((r) => r.estimatedThis),
      estimatedToDate: totalEstimatedToDate,
      columns: columns.map((_, i) => rows.reduce((s, r) => s + (r.columns[i] ?? 0), 0)),
      actualToDate: totalActualToDate,
      variance: totalVariance,
      // Computed from the totals, not averaged from the rows - averaging
      // percentages would weight a small account like a large one.
      variancePct:
        totalEstimatedToDate === null || totalEstimatedToDate === 0
          ? null
          : totalVariance! / totalEstimatedToDate,
    },
    noEstimates: Object.keys(estimates).length === 0,
    unestimatedCodes: rows.filter((r) => r.unestimated).map((r) => r.accountCode),
    estimateUnavailable: !endsOnAQuarter(period),
  };
}

/** Kept for the screens that still name the months of a quarter directly. */
export function monthsOfQuarter(quarter: number): PeriodNo[] {
  return periodMonths({ mode: 'QUARTERLY', index: quarter });
}
