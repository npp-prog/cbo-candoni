import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PERIOD,
  firstMonthOf,
  lastMonthOf,
  monthsToDate,
  periodColumns,
  periodHeading,
  periodLabel,
  periodMonths,
  periodRange,
  previousPeriod,
  showsManualColumnNumbers,
  type ReportPeriod,
} from './reportPeriods';

const month = (index: number): ReportPeriod => ({ mode: 'MONTHLY', index });
const quarter = (index: number): ReportPeriod => ({ mode: 'QUARTERLY', index });
const year: ReportPeriod = { mode: 'ANNUAL', index: 1 };
const asOf = (index: number): ReportPeriod => ({ mode: 'AS_OF', index });

describe('periodMonths', () => {
  it('gives a month its own month and a quarter its three', () => {
    expect(periodMonths(month(7))).toEqual([7]);
    expect(periodMonths(quarter(3))).toEqual([7, 8, 9]);
    expect(periodMonths(year)).toHaveLength(12);
  });

  /** An as-of period IS the running total, so its months run from January. */
  it('runs an as-of period from January', () => {
    expect(periodMonths(asOf(5))).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not run off the end of the year on a bad index', () => {
    expect(periodMonths(month(99))).toEqual([12]);
    expect(periodMonths(quarter(0))).toEqual([1, 2, 3]);
  });
});

describe('monthsToDate', () => {
  it('is January to the end of the period, whatever the period is', () => {
    expect(monthsToDate(quarter(2))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(monthsToDate(month(4))).toEqual([1, 2, 3, 4]);
    expect(monthsToDate(asOf(2))).toEqual([1, 2]);
    expect(monthsToDate(year)).toHaveLength(12);
  });
});

describe('previousPeriod', () => {
  it('steps back one of the same kind', () => {
    expect(previousPeriod(quarter(3))).toEqual({ mode: 'QUARTERLY', index: 2 });
    expect(previousPeriod(month(8))).toEqual({ mode: 'MONTHLY', index: 7 });
  });

  /**
   * Nothing precedes January in a fiscal year. A "previous" column reaching
   * into last year would double-count the carry-over, which is already loaded
   * as a continuing appropriation.
   */
  it('has nothing before the first month or quarter', () => {
    expect(previousPeriod(quarter(1))).toBeNull();
    expect(previousPeriod(month(1))).toBeNull();
  });

  /** A whole year and a running total have nothing before them by definition. */
  it('has nothing before a year or an as-of', () => {
    expect(previousPeriod(year)).toBeNull();
    expect(previousPeriod(asOf(6))).toBeNull();
  });
});

describe('periodRange', () => {
  it('runs from the first day to the last day of the period', () => {
    expect(periodRange(quarter(2), 2026)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(periodRange(year, 2026)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(periodRange(asOf(5), 2026)).toEqual({ from: '2026-01-01', to: '2026-05-31' });
  });

  /**
   * These bounds are compared as plain strings. "2028-02-29" is GREATER than
   * "2028-02-28" as a string, so a collection on the 29th of a leap February
   * would fall outside a February that ended on the 28th and vanish from the
   * report.
   */
  it('ends February on the 29th in a leap year', () => {
    expect(periodRange(month(2), 2028).to).toBe('2028-02-29');
    expect(periodRange(month(2), 2026).to).toBe('2026-02-28');
  });

  it('knows 2100 is not a leap year and 2000 was', () => {
    expect(periodRange(month(2), 2100).to).toBe('2100-02-28');
    expect(periodRange(month(2), 2000).to).toBe('2000-02-29');
  });
});

describe('periodHeading', () => {
  it('keeps the manual’s wording for a quarter', () => {
    expect(periodHeading(quarter(1), 2026)).toBe('For the Quarter Ending March 2026');
  });

  it('says plainly what the other periods are', () => {
    expect(periodHeading(month(8), 2026)).toBe('For the Month Ending August 2026');
    expect(periodHeading(year, 2026)).toBe('For the Year Ended December 2026');
    expect(periodHeading(asOf(5), 2026)).toBe('As of May 2026');
  });
});

describe('periodLabel', () => {
  /** Written to read when lowercased and dropped into a sentence. */
  it('reads as a noun phrase mid-sentence', () => {
    expect(`and ${periodLabel(quarter(3)).toLowerCase()} does not close on one`).toBe(
      'and the third quarter does not close on one',
    );
    expect(`and ${periodLabel(month(8)).toLowerCase()} does not close on one`).toBe(
      'and august does not close on one',
    );
    expect(periodLabel(year)).toBe('The whole year');
    expect(periodLabel(asOf(5))).toBe('The period to May');
  });
});

describe('showsManualColumnNumbers', () => {
  /**
   * The "(1)" to "(13)" belong to the quarterly form. Carrying them onto a
   * monthly view would label a column "(6) 1st Month" on a report that has no
   * first month, and would invite somebody to file it.
   */
  it('is true only for the quarterly form', () => {
    expect(showsManualColumnNumbers(quarter(2))).toBe(true);
    expect(showsManualColumnNumbers(month(2))).toBe(false);
    expect(showsManualColumnNumbers(year)).toBe(false);
    expect(showsManualColumnNumbers(asOf(9))).toBe(false);
  });
});

describe('periodColumns', () => {
  /** The manual's form: three month columns. */
  it('gives a quarter its three months', () => {
    expect(periodColumns(quarter(2)).map((c) => c.label)).toEqual(['April', 'May', 'June']);
  });

  it('gives a month one column', () => {
    expect(periodColumns(month(11)).map((c) => c.label)).toEqual(['November']);
  });

  /** Twelve month columns would not fit the form, and nobody reads them. */
  it('gives a year four quarter columns, not twelve months', () => {
    const cols = periodColumns(year);
    expect(cols.map((c) => c.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(cols[2].months).toEqual([7, 8, 9]);
  });

  /** Splitting a running total would make it a different report. */
  it('gives an as-of period no breakdown at all', () => {
    expect(periodColumns(asOf(6))).toEqual([]);
  });

  it('covers the period exactly, with no month counted twice', () => {
    for (const p of [month(5), quarter(4), year, asOf(7)]) {
      const covered = periodColumns(p).flatMap((c) => c.months);
      const expected = periodColumns(p).length === 0 ? [] : periodMonths(p);
      expect([...covered].sort((a, b) => a - b)).toEqual(expected);
      expect(new Set(covered).size).toBe(covered.length);
    }
  });
});

describe('first and last month', () => {
  it('bracket the period', () => {
    expect(firstMonthOf(quarter(4))).toBe(10);
    expect(lastMonthOf(quarter(4))).toBe(12);
    expect(lastMonthOf(asOf(7))).toBe(7);
    expect(firstMonthOf(asOf(7))).toBe(1);
  });
});

describe('DEFAULT_PERIOD', () => {
  it('opens on the quarterly form, which is the one that is filed', () => {
    expect(DEFAULT_PERIOD.mode).toBe('QUARTERLY');
  });
});
