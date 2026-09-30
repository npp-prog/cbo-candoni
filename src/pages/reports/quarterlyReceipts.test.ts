import { describe, it, expect } from 'vitest';
import {
  buildReceiptsReport,
  estimateToDate,
  monthsOfQuarter,
  type IncomeEstimates,
  type ReceiptEntry,
} from './quarterlyReceipts';

/**
 * LBAc Form No. 1.
 *
 * The tests that matter here are the two columns that can be computed from
 * their neighbours and be wrong for three quarters of the year.
 */

/** A credit to a revenue account - the ledger stores a credit as negative. */
const credit = (accountCode: string, period: number, pesos: number): ReceiptEntry => ({
  accountCode,
  accountName: accountCode === '40101010' ? 'Real Property Tax' : 'Business Tax',
  period,
  signedAmount: -pesos * 100,
});

describe('monthsOfQuarter', () => {
  it('maps each quarter onto its three accounting periods', () => {
    expect(monthsOfQuarter(1)).toEqual([1, 2, 3]);
    expect(monthsOfQuarter(2)).toEqual([4, 5, 6]);
    expect(monthsOfQuarter(3)).toEqual([7, 8, 9]);
    expect(monthsOfQuarter(4)).toEqual([10, 11, 12]);
  });
});

describe('estimateToDate', () => {
  it('is January to the end of the quarter, not the two quarters on the form', () => {
    const e = { q1: 100_00, q2: 200_00, q3: 400_00, q4: 800_00 };
    expect(estimateToDate(e, 1)).toBe(100_00);
    expect(estimateToDate(e, 2)).toBe(300_00);
    expect(estimateToDate(e, 3)).toBe(700_00);
    expect(estimateToDate(e, 4)).toBe(1_500_00);
  });

  it('treats an account with no estimate as nothing, not as a gap', () => {
    expect(estimateToDate(undefined, 4)).toBe(0);
    expect(estimateToDate({ q2: 50_00 }, 4)).toBe(50_00);
  });
});

describe('buildReceiptsReport', () => {
  const estimates: IncomeEstimates = {
    '40101010': { q1: 1_000_000_00, q2: 500_000_00, q3: 500_000_00, q4: 1_000_000_00 },
  };

  /**
   * The trap this whole module exists for.
   *
   * Column 5 computed as column 3 + column 4 gives the right answer for the
   * second quarter and the wrong one for the third and fourth. A test written
   * only against Q2 would pass against a broken implementation.
   */
  it('does not compute column 5 as column 3 plus column 4', () => {
    const q3 = buildReceiptsReport([], estimates, 3).rows[0];
    expect(q3.estimatedPrevious).toBe(500_000_00); // Q2
    expect(q3.estimatedThis).toBe(500_000_00); // Q3
    // 3 + 4 would be 1,000,000. January to September is 2,000,000.
    expect(q3.estimatedToDate).toBe(2_000_000_00);
    expect(q3.estimatedToDate).not.toBe(q3.estimatedPrevious + q3.estimatedThis);
  });

  it('has no previous quarter in the first quarter', () => {
    const q1 = buildReceiptsReport([], estimates, 1).rows[0];
    expect(q1.estimatedPrevious).toBe(0);
    expect(q1.estimatedToDate).toBe(1_000_000_00);
  });

  /**
   * The matching trap on the actual side. Columns 6 to 8 are the three months
   * OF THE QUARTER; column 9 is January to the end of it and must tally with
   * the Trial Balance.
   */
  it('does not compute column 9 by adding columns 6 to 8', () => {
    const entries = [
      credit('40101010', 1, 300_000), // Q1
      credit('40101010', 2, 200_000), // Q1
      credit('40101010', 7, 100_000), // Q3, first month
      credit('40101010', 9, 50_000), // Q3, third month
    ];
    const row = buildReceiptsReport(entries, estimates, 3).rows[0];
    expect(row.months).toEqual([100_000_00, 0, 50_000_00]);
    // The three months come to 150,000. January to September is 650,000.
    expect(row.actualToDate).toBe(650_000_00);
    expect(row.actualToDate).not.toBe(row.months[0] + row.months[1] + row.months[2]);
  });

  it('ignores entries after the quarter reported', () => {
    const entries = [credit('40101010', 3, 100_000), credit('40101010', 11, 900_000)];
    const row = buildReceiptsReport(entries, estimates, 1).rows[0];
    expect(row.actualToDate).toBe(100_000_00);
  });

  it('reads a debit on a revenue account as a reduction, as the Trial Balance does', () => {
    const entries: ReceiptEntry[] = [
      credit('40101010', 1, 100_000),
      // A refund of tax collected in error.
      { accountCode: '40101010', accountName: 'Real Property Tax', period: 2, signedAmount: 25_000_00 },
    ];
    const row = buildReceiptsReport(entries, estimates, 1).rows[0];
    expect(row.actualToDate).toBe(75_000_00);
    expect(row.months).toEqual([100_000_00, -25_000_00, 0]);
  });

  it('computes the variance and its percentage against the estimate to date', () => {
    const entries = [credit('40101010', 2, 750_000)];
    const row = buildReceiptsReport(entries, estimates, 1).rows[0];
    expect(row.estimatedToDate).toBe(1_000_000_00);
    expect(row.actualToDate).toBe(750_000_00);
    expect(row.variance).toBe(-250_000_00);
    expect(row.variancePct).toBeCloseTo(-0.25, 10);
  });

  /**
   * An account nobody estimated. The manual's column 11 divides by column 5,
   * so a zero estimate has no percentage - and reporting one anyway is how a
   * signed form comes to carry an infinity.
   */
  it('reports no percentage where nothing was estimated, rather than a division by zero', () => {
    const row = buildReceiptsReport([credit('40201010', 1, 40_000)], {}, 1).rows[0];
    expect(row.accountCode).toBe('40201010');
    expect(row.estimatedToDate).toBe(0);
    expect(row.variance).toBe(40_000_00);
    expect(row.variancePct).toBeNull();
    expect(row.unestimated).toBe(true);
  });

  /**
   * The single most important row on the form: certified income that did not
   * arrive. It has no ledger entries at all, so anything driven by the ledger
   * would drop it.
   */
  it('keeps an estimated account that collected nothing', () => {
    const report = buildReceiptsReport([], estimates, 2);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].actualToDate).toBe(0);
    expect(report.rows[0].variance).toBe(-1_500_000_00);
  });

  it('leaves out an account with neither an estimate nor any income', () => {
    const report = buildReceiptsReport(
      [{ accountCode: '40301010', accountName: 'Other', period: 1, signedAmount: 0 }],
      {},
      1,
    );
    expect(report.rows).toHaveLength(0);
  });

  it('lists the accounts carrying income nobody estimated', () => {
    const report = buildReceiptsReport(
      [credit('40101010', 1, 10_000), credit('40201010', 1, 5_000)],
      estimates,
      1,
    );
    expect(report.unestimatedCodes).toEqual(['40201010']);
    expect(report.noEstimates).toBe(false);
  });

  it('says plainly when no estimate has been nominated at all', () => {
    expect(buildReceiptsReport([credit('40101010', 1, 10_000)], {}, 1).noEstimates).toBe(true);
  });

  it('totals every column, and the total variance agrees with its own columns', () => {
    const report = buildReceiptsReport(
      [credit('40101010', 1, 900_000), credit('40201010', 2, 300_000)],
      estimates,
      1,
    );
    expect(report.total.estimatedToDate).toBe(1_000_000_00);
    expect(report.total.actualToDate).toBe(1_200_000_00);
    expect(report.total.variance).toBe(200_000_00);
    expect(report.total.months[0]).toBe(900_000_00);
    expect(report.total.months[1]).toBe(300_000_00);
    // The total percentage is computed from the totals, not averaged from the
    // rows - averaging percentages would weight a small account like a large
    // one.
    expect(report.total.variancePct).toBeCloseTo(0.2, 10);
  });

  it('sorts the rows by account code', () => {
    const report = buildReceiptsReport(
      [credit('40201010', 1, 1_000), credit('40101010', 1, 1_000)],
      {},
      1,
    );
    expect(report.rows.map((r) => r.accountCode)).toEqual(['40101010', '40201010']);
  });
});
