import { describe, it, expect } from 'vitest';
import {
  figuresForPeriod,
  quarterOf,
  quarterRange,
  totalPeriod,
  type PeriodAllotment,
  type PeriodObligation,
} from './budgetPeriods';

const allot = (over: Partial<PeriodAllotment> = {}): PeriodAllotment => ({
  allotmentDate: '2026-02-15',
  status: 'APPROVED',
  officeId: 'o1',
  officeName: 'Mayor',
  fppCode: '5-02-03-010',
  accountCode: '5-02-03-010',
  expenseClass: 'MOOE',
  amount: 100_000_00,
  ...over,
});

const oblige = (over: Partial<PeriodObligation> = {}): PeriodObligation => ({
  obrDate: '2026-02-20',
  status: 'OBLIGATED',
  lines: [
    {
      officeId: 'o1',
      officeName: 'Mayor',
      fppCode: '5-02-03-010',
      appropriatedAccountCode: '5-02-03-010',
      expenseClass: 'MOOE',
      amount: 40_000_00,
    },
  ],
  ...over,
});

describe('quarters', () => {
  it('places a date in its quarter', () => {
    expect(quarterOf('2026-01-01')).toBe(1);
    expect(quarterOf('2026-03-31')).toBe(1);
    expect(quarterOf('2026-04-01')).toBe(2);
    expect(quarterOf('2026-12-31')).toBe(4);
  });

  it('gives the first and last day of each quarter', () => {
    expect(quarterRange(2026, 1)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(quarterRange(2026, 2)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(quarterRange(2026, 4)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
  });

  /**
   * A leap year needs no special case: no quarter ends in February. A release
   * dated 29 February falls in the first quarter because it is before
   * 31 March, which is all the comparison asks.
   */
  it('gives the same quarter ends in a leap year', () => {
    expect(quarterRange(2024, 1).to).toBe('2024-03-31');
    expect(quarterRange(2024, 2).to).toBe('2024-06-30');
    expect(quarterOf('2024-02-29')).toBe(1);
  });
});

describe('figuresForPeriod', () => {
  const q2 = quarterRange(2026, 2);

  it('splits releases and commitments at the start of the period', () => {
    const rows = figuresForPeriod(
      [allot({ allotmentDate: '2026-02-15' }), allot({ allotmentDate: '2026-05-10', amount: 50_000_00 })],
      [
        oblige({ obrDate: '2026-03-01' }),
        oblige({ obrDate: '2026-05-20', lines: oblige().lines.map((l) => ({ ...l, amount: 25_000_00 })) }),
      ],
      q2.from,
      q2.to,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].allotmentPrevious).toBe(100_000_00);
    expect(rows[0].allotmentThisPeriod).toBe(50_000_00);
    expect(rows[0].obligationPrevious).toBe(40_000_00);
    expect(rows[0].obligationThisPeriod).toBe(25_000_00);
  });

  /**
   * A report for the second quarter that quietly included October would not be
   * a report for the second quarter - and because it would still foot to its
   * own columns, nothing would look wrong.
   */
  it('leaves out anything dated after the period', () => {
    const rows = figuresForPeriod(
      [allot({ allotmentDate: '2026-10-05' })],
      [oblige({ obrDate: '2026-11-02' })],
      q2.from,
      q2.to,
    );
    expect(rows).toHaveLength(0);
  });

  it('includes the first and last day of the period', () => {
    const rows = figuresForPeriod(
      [allot({ allotmentDate: '2026-04-01' })],
      [oblige({ obrDate: '2026-06-30' })],
      q2.from,
      q2.to,
    );
    expect(rows[0].allotmentThisPeriod).toBe(100_000_00);
    expect(rows[0].obligationThisPeriod).toBe(40_000_00);
  });

  /**
   * A draft allotment has been released to nobody and a cancelled obligation
   * commits nothing. Counting either would show a department authority it does
   * not have, which is what the registry exists to prevent.
   */
  it('counts only released allotments and live obligations', () => {
    const rows = figuresForPeriod(
      [allot({ status: 'DRAFT' }), allot({ status: 'CANCELLED' })],
      [oblige({ status: 'DRAFT' }), oblige({ status: 'CANCELLED' }), oblige({ status: 'RETURNED' })],
      '2026-01-01',
      '2026-12-31',
    );
    expect(rows).toHaveLength(0);
  });

  it('counts an obligation from certification onwards', () => {
    for (const status of ['CERTIFIED', 'OBLIGATED', 'PAID', 'CLOSED']) {
      const rows = figuresForPeriod([], [oblige({ status })], '2026-01-01', '2026-12-31');
      expect(rows[0]?.obligationThisPeriod, status).toBe(40_000_00);
    }
  });

  /**
   * On a project line the appropriation names no object and the obligation
   * names the thing actually bought. Keying the obligation on what it bought
   * would open a second row for a line whose allotment sits on the first, and
   * the report would show an unobligated allotment beside an unallotted
   * obligation for the same project.
   */
  it('keys an obligation on the appropriated object, not the one it commits', () => {
    const rows = figuresForPeriod(
      [allot({ fppCode: 'Barangay Road', accountCode: '' })],
      [
        oblige({
          lines: [
            {
              officeId: 'o1',
              officeName: 'Mayor',
              fppCode: 'Barangay Road',
              appropriatedAccountCode: '',
              expenseClass: 'CO',
              amount: 40_000_00,
            },
          ],
        }),
      ],
      '2026-01-01',
      '2026-12-31',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].allotmentThisPeriod).toBe(100_000_00);
    expect(rows[0].obligationThisPeriod).toBe(40_000_00);
  });

  it('keeps two offices on the same FPP apart', () => {
    const rows = figuresForPeriod(
      [allot({ officeId: 'o1', officeName: 'Mayor' }), allot({ officeId: 'o2', officeName: 'Health' })],
      [],
      '2026-01-01',
      '2026-12-31',
    );
    expect(rows).toHaveLength(2);
  });

  it('takes a withdrawal of allotment as the negative it is', () => {
    const rows = figuresForPeriod(
      [allot(), allot({ allotmentDate: '2026-05-01', amount: -30_000_00 })],
      [],
      q2.from,
      q2.to,
    );
    expect(rows[0].allotmentThisPeriod).toBe(-30_000_00);
    expect(rows[0].allotmentPrevious).toBe(100_000_00);
  });
});

describe('totalPeriod', () => {
  it('foots the columns the accountability forms foot', () => {
    const rows = figuresForPeriod(
      [allot({ allotmentDate: '2026-02-01' }), allot({ allotmentDate: '2026-05-01', amount: 50_000_00 })],
      [oblige({ obrDate: '2026-05-05' })],
      quarterRange(2026, 2).from,
      quarterRange(2026, 2).to,
    );
    const t = totalPeriod(rows);
    expect(t.allotmentTotal).toBe(150_000_00);
    expect(t.obligationTotal).toBe(40_000_00);
    expect(t.allotmentPrevious + t.allotmentThisPeriod).toBe(t.allotmentTotal);
  });
});
