import { describe, it, expect } from 'vitest';
import type { ReportPeriod } from '@/lib/reportPeriods';
import {
  buildReceiptsReport,
  endsOnAQuarter,
  estimateForPeriod,
  estimateToDateForPeriod,
  monthsOfQuarter,
  type IncomeEstimates,
  type ReceiptEntry,
} from './quarterlyReceiptsReport';

/**
 * LBAc Form No. 1.
 *
 * The tests that matter are the two columns that can be computed from their
 * neighbours and be wrong for three quarters of the year, and the refusal to
 * invent a monthly estimate the Local Finance Committee never certified.
 */

const quarter = (index: number): ReportPeriod => ({ mode: 'QUARTERLY', index });
const month = (index: number): ReportPeriod => ({ mode: 'MONTHLY', index });
const year: ReportPeriod = { mode: 'ANNUAL', index: 1 };
const asOf = (index: number): ReportPeriod => ({ mode: 'AS_OF', index });

/** A credit to a revenue account - the ledger stores a credit as negative. */
const credit = (accountCode: string, period: number, pesos: number): ReceiptEntry => ({
  accountCode,
  accountName: accountCode === '40101010' ? 'Real Property Tax' : 'Business Tax',
  period,
  signedAmount: -pesos * 100,
});

const estimates: IncomeEstimates = {
  '40101010': { q1: 1_000_000_00, q2: 500_000_00, q3: 500_000_00, q4: 1_000_000_00 },
};

describe('monthsOfQuarter', () => {
  it('maps each quarter onto its three accounting periods', () => {
    expect(monthsOfQuarter(1)).toEqual([1, 2, 3]);
    expect(monthsOfQuarter(3)).toEqual([7, 8, 9]);
    expect(monthsOfQuarter(4)).toEqual([10, 11, 12]);
  });
});

describe('endsOnAQuarter', () => {
  it('is true where the period closes on March, June, September or December', () => {
    expect(endsOnAQuarter(quarter(2))).toBe(true);
    expect(endsOnAQuarter(year)).toBe(true);
    expect(endsOnAQuarter(month(6))).toBe(true);
    expect(endsOnAQuarter(asOf(9))).toBe(true);
  });

  it('is false mid-quarter', () => {
    expect(endsOnAQuarter(month(8))).toBe(false);
    expect(endsOnAQuarter(asOf(5))).toBe(false);
  });
});

describe('the estimate, where it exists', () => {
  it('is the quarter itself on a quarter', () => {
    expect(estimateForPeriod(estimates['40101010'], quarter(3))).toBe(500_000_00);
  });

  it('is the whole year on a year', () => {
    expect(estimateForPeriod(estimates['40101010'], year)).toBe(3_000_000_00);
  });

  /**
   * The Local Finance Committee certifies income BY QUARTER. There is no
   * monthly estimate anywhere, and dividing a quarter by three would produce
   * figures nobody certified and a variance CBO had invented - reported to the
   * Committee as though the Treasurer had projected it.
   */
  it('does not exist for a month, and is not invented', () => {
    expect(estimateForPeriod(estimates['40101010'], month(8))).toBeNull();
    expect(estimateForPeriod(estimates['40101010'], month(6))).toBeNull();
  });

  it('does not exist for an as-of, which has no period of its own', () => {
    expect(estimateForPeriod(estimates['40101010'], asOf(6))).toBeNull();
  });
});

describe('the estimate to date', () => {
  /**
   * The trap this module exists for. Column 5 computed as column 3 + column 4
   * gives the right answer for the second quarter and the wrong one for the
   * third and fourth, so a test written only against Q2 would pass against a
   * broken implementation.
   */
  it('is January to date, not this period plus the last one', () => {
    const e = estimates['40101010'];
    expect(estimateToDateForPeriod(e, quarter(3))).toBe(2_000_000_00);
    // Q2 + Q3 would be 1,000,000. January to September is 2,000,000.
    expect(estimateToDateForPeriod(e, quarter(3))).not.toBe(
      estimateForPeriod(e, quarter(2))! + estimateForPeriod(e, quarter(3))!,
    );
  });

  it('is available where a month or an as-of closes a quarter', () => {
    const e = estimates['40101010'];
    expect(estimateToDateForPeriod(e, month(6))).toBe(1_500_000_00);
    expect(estimateToDateForPeriod(e, asOf(9))).toBe(2_000_000_00);
  });

  /** Half of a certified quarter is not a certified figure. */
  it('is unavailable mid-quarter rather than apportioned', () => {
    expect(estimateToDateForPeriod(estimates['40101010'], month(8))).toBeNull();
    expect(estimateToDateForPeriod(estimates['40101010'], asOf(5))).toBeNull();
  });
});

describe('buildReceiptsReport', () => {
  it('has no previous period in the first quarter', () => {
    const row = buildReceiptsReport([], estimates, quarter(1)).rows[0];
    expect(row.estimatedPrevious).toBeNull();
    expect(row.estimatedToDate).toBe(1_000_000_00);
  });

  it('carries the previous quarter across', () => {
    const row = buildReceiptsReport([], estimates, quarter(3)).rows[0];
    expect(row.estimatedPrevious).toBe(500_000_00); // Q2
    expect(row.estimatedThis).toBe(500_000_00); // Q3
  });

  /**
   * The matching trap on the actual side. The breakdown columns are the months
   * OF THE PERIOD; the to-date figure is January to the end of it and must
   * tally with the Trial Balance.
   */
  it('does not compute the to-date column by adding the breakdown columns', () => {
    const entries = [
      credit('40101010', 1, 300_000), // Q1
      credit('40101010', 2, 200_000), // Q1
      credit('40101010', 7, 100_000), // Q3, first month
      credit('40101010', 9, 50_000), // Q3, third month
    ];
    const row = buildReceiptsReport(entries, estimates, quarter(3)).rows[0];
    expect(row.columns).toEqual([100_000_00, 0, 50_000_00]);
    // The three months come to 150,000. January to September is 650,000.
    expect(row.actualToDate).toBe(650_000_00);
    expect(row.actualToDate).not.toBe(row.columns.reduce((s, v) => s + v, 0));
  });

  it('gives a month one column, and still counts January to date', () => {
    const entries = [credit('40101010', 1, 300_000), credit('40101010', 8, 100_000)];
    const report = buildReceiptsReport(entries, estimates, month(8));
    expect(report.rows[0].columns).toEqual([100_000_00]);
    expect(report.rows[0].actualToDate).toBe(400_000_00);
  });

  it('gives a year four quarter columns', () => {
    const entries = [
      credit('40101010', 2, 100_000),
      credit('40101010', 5, 200_000),
      credit('40101010', 11, 300_000),
    ];
    const report = buildReceiptsReport(entries, estimates, year);
    expect(report.rows[0].columns).toEqual([100_000_00, 200_000_00, 0, 300_000_00]);
    expect(report.rows[0].actualToDate).toBe(600_000_00);
  });

  it('gives an as-of no breakdown at all, only the running total', () => {
    const entries = [credit('40101010', 1, 100_000), credit('40101010', 4, 50_000)];
    const report = buildReceiptsReport(entries, estimates, asOf(6));
    expect(report.rows[0].columns).toEqual([]);
    expect(report.rows[0].actualToDate).toBe(150_000_00);
  });

  /**
   * A monthly report shows real collections and no variance. Showing one would
   * mean CBO had divided a certified quarter, and the Treasurer would sign for
   * a shortfall that CBO made up.
   */
  it('reports a month with collections and no variance', () => {
    const report = buildReceiptsReport([credit('40101010', 8, 90_000)], estimates, month(8));
    expect(report.estimateUnavailable).toBe(true);
    expect(report.rows[0].actualToDate).toBe(90_000_00);
    expect(report.rows[0].estimatedToDate).toBeNull();
    expect(report.rows[0].variance).toBeNull();
    expect(report.rows[0].variancePct).toBeNull();
    expect(report.total.variance).toBeNull();
  });

  it('says plainly when the period closes a quarter and the estimate is usable', () => {
    expect(buildReceiptsReport([], estimates, quarter(2)).estimateUnavailable).toBe(false);
    expect(buildReceiptsReport([], estimates, month(9)).estimateUnavailable).toBe(false);
  });

  it('ignores entries after the period reported', () => {
    const entries = [credit('40101010', 3, 100_000), credit('40101010', 11, 900_000)];
    expect(buildReceiptsReport(entries, estimates, quarter(1)).rows[0].actualToDate).toBe(
      100_000_00,
    );
  });

  it('reads a debit on a revenue account as a reduction, as the Trial Balance does', () => {
    const entries: ReceiptEntry[] = [
      credit('40101010', 1, 100_000),
      { accountCode: '40101010', accountName: 'Real Property Tax', period: 2, signedAmount: 25_000_00 },
    ];
    const row = buildReceiptsReport(entries, estimates, quarter(1)).rows[0];
    expect(row.actualToDate).toBe(75_000_00);
    expect(row.columns).toEqual([100_000_00, -25_000_00, 0]);
  });

  it('computes the variance and its percentage against the estimate to date', () => {
    const row = buildReceiptsReport([credit('40101010', 2, 750_000)], estimates, quarter(1)).rows[0];
    expect(row.estimatedToDate).toBe(1_000_000_00);
    expect(row.variance).toBe(-250_000_00);
    expect(row.variancePct).toBeCloseTo(-0.25, 10);
  });

  /**
   * An account nobody estimated. The manual's percentage divides by the
   * estimate, so a zero estimate has no percentage - and reporting one anyway
   * is how a signed form comes to carry an infinity.
   */
  it('reports no percentage where nothing was estimated', () => {
    const row = buildReceiptsReport([credit('40201010', 1, 40_000)], {}, quarter(1)).rows[0];
    expect(row.accountCode).toBe('40201010');
    expect(row.estimatedToDate).toBe(0);
    expect(row.variance).toBe(40_000_00);
    expect(row.variancePct).toBeNull();
    expect(row.unestimated).toBe(true);
  });

  /**
   * The single most important row on the form: certified income that did not
   * arrive. It has no ledger entries, so anything driven by the ledger alone
   * would drop it.
   */
  it('keeps an estimated account that collected nothing', () => {
    const report = buildReceiptsReport([], estimates, quarter(2));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].actualToDate).toBe(0);
    expect(report.rows[0].variance).toBe(-1_500_000_00);
  });

  it('lists the accounts carrying income nobody estimated', () => {
    const report = buildReceiptsReport(
      [credit('40101010', 1, 10_000), credit('40201010', 1, 5_000)],
      estimates,
      quarter(1),
    );
    expect(report.unestimatedCodes).toEqual(['40201010']);
    expect(report.noEstimates).toBe(false);
  });

  it('says plainly when no estimate has been nominated at all', () => {
    expect(buildReceiptsReport([credit('40101010', 1, 10_000)], {}, quarter(1)).noEstimates).toBe(
      true,
    );
  });

  it('totals every column, and the total variance agrees with its own columns', () => {
    const report = buildReceiptsReport(
      [credit('40101010', 1, 900_000), credit('40201010', 2, 300_000)],
      estimates,
      quarter(1),
    );
    expect(report.total.estimatedToDate).toBe(1_000_000_00);
    expect(report.total.actualToDate).toBe(1_200_000_00);
    expect(report.total.variance).toBe(200_000_00);
    expect(report.total.columns[0]).toBe(900_000_00);
    expect(report.total.columns[1]).toBe(300_000_00);
    // Computed from the totals, not averaged from the rows - averaging
    // percentages would weight a small account like a large one.
    expect(report.total.variancePct).toBeCloseTo(0.2, 10);
  });

  it('sorts the rows by account code', () => {
    const report = buildReceiptsReport(
      [credit('40201010', 1, 1_000), credit('40101010', 1, 1_000)],
      {},
      quarter(1),
    );
    expect(report.rows.map((r) => r.accountCode)).toEqual(['40101010', '40201010']);
  });
});
