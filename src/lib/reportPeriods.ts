import type { IsoDate, PeriodNo } from '@/types/common';

/**
 * The period a report covers, when that is the reader's choice.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FORMS STOPPED BEING QUARTERLY
 * ---------------------------------------------------------------------------
 * LBAc Form No. 1 and LBAc Form No. 2 are SUBMITTED quarterly, and their
 * printed headings say "For the Quarter Ending ___". But the office looks at
 * them far more often than it submits them: a month's receipts against the
 * estimate, the whole year at closing, the position as of today.
 *
 * Fixed to a quarter, the only way to see one month was to read three columns
 * and subtract - which is how somebody eventually subtracts the wrong pair.
 *
 * So the period is chosen and the form follows it. Choosing Quarterly gives
 * back exactly the manual's form, its columns and its numbering included.
 * That is the one that is filed, and it has not moved.
 *
 * ---------------------------------------------------------------------------
 * ONE INDEX, READ ACCORDING TO THE MODE
 * ---------------------------------------------------------------------------
 * A period is a mode and a single number. Holding a month AND a quarter would
 * mean holding two numbers of which one is always stale, and eventually
 * reading the stale one.
 *
 *     MONTHLY     index is the month, 1 to 12
 *     QUARTERLY   index is the quarter, 1 to 4
 *     ANNUAL      index is ignored
 *     AS_OF       index is the month it runs up to, 1 to 12
 */

export type PeriodMode = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'AS_OF';

export interface ReportPeriod {
  mode: PeriodMode;
  index: number;
}

export const PERIOD_MODE_LABELS: Record<PeriodMode, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  ANNUAL: 'Annual',
  AS_OF: 'As of a month',
};

export const PERIOD_MODE_HINTS: Record<PeriodMode, string> = {
  MONTHLY: 'One month on its own.',
  QUARTERLY: 'The form as the Budget Operations Manual prints it, and the one that is submitted.',
  ANNUAL: 'The whole fiscal year, broken into its four quarters.',
  AS_OF: 'January to the end of the month chosen. A running total, with no breakdown.',
};

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ORDINALS = ['first', 'second', 'third', 'fourth'];

/** The quarterly form is what the office actually files. */
export const DEFAULT_PERIOD: ReportPeriod = { mode: 'QUARTERLY', index: 1 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The last day of a month.
 *
 * February is worked out properly rather than fixed at 28, and that matters
 * here for one specific reason: these bounds are compared as plain
 * `YYYY-MM-DD` STRINGS. "2028-02-29" is greater than "2028-02-28" as a string,
 * so a collection on the 29th of a leap February would fall outside a February
 * that ended on the 28th, and would silently vanish from the report.
 */
function lastDayOf(fiscalYear: number, month: PeriodNo): number {
  if (month !== 2) return DAYS_IN_MONTH[month - 1];
  const leap = (fiscalYear % 4 === 0 && fiscalYear % 100 !== 0) || fiscalYear % 400 === 0;
  return leap ? 29 : 28;
}

// ---------------------------------------------------------------------------
// The months a period covers
// ---------------------------------------------------------------------------

/** The months the period itself covers, in order. */
export function periodMonths(period: ReportPeriod): PeriodNo[] {
  switch (period.mode) {
    case 'MONTHLY':
      return [clamp(period.index, 1, 12)];
    case 'QUARTERLY': {
      const first = (clamp(period.index, 1, 4) - 1) * 3 + 1;
      return [first, first + 1, first + 2];
    }
    case 'ANNUAL':
      return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    case 'AS_OF':
      // An as-of period IS the running total, so its own months run from
      // January. There is no separate "this period" for it at all.
      return Array.from({ length: clamp(period.index, 1, 12) }, (_, i) => i + 1);
  }
}

export function firstMonthOf(period: ReportPeriod): PeriodNo {
  return periodMonths(period)[0];
}

export function lastMonthOf(period: ReportPeriod): PeriodNo {
  const months = periodMonths(period);
  return months[months.length - 1];
}

/** January to the end of the period - what every "to date" column runs over. */
export function monthsToDate(period: ReportPeriod): PeriodNo[] {
  return Array.from({ length: lastMonthOf(period) }, (_, i) => i + 1);
}

/**
 * The period immediately before this one, within the same fiscal year.
 *
 * Null for the first month, the first quarter, a whole year and an as-of. A
 * "previous" column that reached back into last year would double-count the
 * carry-over, which is already loaded as a continuing appropriation; and a
 * running total has nothing before it by definition.
 */
export function previousPeriod(period: ReportPeriod): ReportPeriod | null {
  switch (period.mode) {
    case 'MONTHLY':
      return period.index > 1 ? { mode: 'MONTHLY', index: period.index - 1 } : null;
    case 'QUARTERLY':
      return period.index > 1 ? { mode: 'QUARTERLY', index: period.index - 1 } : null;
    case 'ANNUAL':
    case 'AS_OF':
      return null;
  }
}

/** First and last day of the period, as plain dates. */
export function periodRange(
  period: ReportPeriod,
  fiscalYear: number,
): { from: IsoDate; to: IsoDate } {
  const first = firstMonthOf(period);
  const last = lastMonthOf(period);
  return {
    from: `${fiscalYear}-${pad(first)}-01`,
    to: `${fiscalYear}-${pad(last)}-${pad(lastDayOf(fiscalYear, last))}`,
  };
}

// ---------------------------------------------------------------------------
// How it reads
// ---------------------------------------------------------------------------

/** The heading the form carries, in the manual's phrasing where it has one. */
export function periodHeading(period: ReportPeriod, fiscalYear: number): string {
  const ending = `${MONTH_NAMES[lastMonthOf(period) - 1]} ${fiscalYear}`;
  switch (period.mode) {
    case 'MONTHLY':
      return `For the Month Ending ${ending}`;
    case 'QUARTERLY':
      return `For the Quarter Ending ${ending}`;
    case 'ANNUAL':
      return `For the Year Ended ${ending}`;
    case 'AS_OF':
      return `As of ${ending}`;
  }
}

/**
 * A noun phrase, for use inside a sentence.
 *
 * Written to read when lowercased and dropped mid-sentence - "…and the third
 * quarter does not close on one" - because that is where the screens use it.
 */
export function periodLabel(period: ReportPeriod): string {
  switch (period.mode) {
    case 'MONTHLY':
      return MONTH_NAMES[clamp(period.index, 1, 12) - 1];
    case 'QUARTERLY':
      return `The ${ORDINALS[clamp(period.index, 1, 4) - 1]} quarter`;
    case 'ANNUAL':
      return 'The whole year';
    case 'AS_OF':
      return `The period to ${MONTH_NAMES[clamp(period.index, 1, 12) - 1]}`;
  }
}

/**
 * Whether to print the manual's column numbers.
 *
 * The "(1)" to "(13)" on LBAc Form No. 2, and "(1)" to "(12)" on Form No. 1,
 * belong to the quarterly form. Carrying them onto a monthly or annual view
 * would label a column "(6) 1st Month" on a report that has no first month,
 * and would invite somebody to file it.
 */
export function showsManualColumnNumbers(period: ReportPeriod): boolean {
  return period.mode === 'QUARTERLY';
}

// ---------------------------------------------------------------------------
// The breakdown columns
// ---------------------------------------------------------------------------

export interface PeriodColumn {
  key: string;
  label: string;
  months: PeriodNo[];
}

/**
 * The period's own parts, as columns.
 *
 *     a month      one column, that month
 *     a quarter    three columns, its months      <- the manual's form
 *     a year       four columns, its quarters
 *     as of        none; the point of it is the running total
 *
 * Twelve month-columns for a year would not fit the paper the form is printed
 * on, and nobody reads a twelve-column row anyway.
 */
export function periodColumns(period: ReportPeriod): PeriodColumn[] {
  switch (period.mode) {
    case 'MONTHLY': {
      const m = clamp(period.index, 1, 12);
      return [{ key: `m${m}`, label: MONTH_NAMES[m - 1], months: [m] }];
    }
    case 'QUARTERLY':
      return periodMonths(period).map((m) => ({
        key: `m${m}`,
        label: MONTH_NAMES[m - 1],
        months: [m],
      }));
    case 'ANNUAL':
      return [1, 2, 3, 4].map((q) => ({
        key: `q${q}`,
        label: `Q${q}`,
        months: [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3],
      }));
    case 'AS_OF':
      return [];
  }
}
