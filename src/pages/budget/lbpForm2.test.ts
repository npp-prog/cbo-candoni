import { describe, it, expect } from 'vitest';
import { buildLbpForm2, inFirstSemester } from './lbpForm2';

/** LBP Form No. 2, built from an ordinance's lines and the books before it. Patch 119. */
const base = {
  budgetYear: 2026,
  lgu: 'MUNICIPAL GOVERNMENT OF CANDONI',
  headingLines: [],
  reference: 'Ord. No. 2026-01',
  kindLabel: 'Original',
  prepared: true,
  pastYear: [],
  currentYear: [],
  currentBalances: [],
};

const mayor = (over: Record<string, unknown>) => ({
  officeId: 'mayor',
  officeName: 'Office of the Municipal Mayor',
  accountCode: '50203010',
  accountName: 'Office Supplies Expenses',
  expenseClass: 'MOOE',
  sector: 'General Public Services',
  amount: 100_000_00,
  ...over,
});

describe('buildLbpForm2', () => {
  it('puts each office on its own form, grouped by expense class, with totals', () => {
    const s = buildLbpForm2({
      ...base,
      lines: [
        mayor({}),
        mayor({
          accountCode: '50101010',
          accountName: 'Salaries and Wages - Regular',
          expenseClass: 'PS',
          amount: 500_000_00,
        }),
        mayor({
          officeId: 'acct',
          officeName: 'Office of the Municipal Accountant',
          amount: 20_000_00,
        }),
      ],
    });
    expect(s.offices.map((o) => o.officeName)).toEqual([
      'Office of the Municipal Accountant',
      'Office of the Municipal Mayor',
    ]);
    const m = s.offices[1];
    expect(m.groups[0].heading).toBe('Personal Services');
    expect(m.groups[0].rows[0].proposed).toBe(500_000_00);
    expect(m.groups[1].rows[0].object).toBe('Office Supplies Expenses');
    expect(m.total.proposed).toBe(600_000_00);
    expect(s.grand.proposed).toBe(620_000_00);
  });

  it('sums two lines of the ordinance on the same object into one row', () => {
    const s = buildLbpForm2({ ...base, lines: [mayor({}), mayor({ amount: 50_000_00 })] });
    expect(s.offices[0].groups[1].rows).toHaveLength(1);
    expect(s.offices[0].groups[1].rows[0].proposed).toBe(150_000_00);
  });

  it('fills columns 3 to 6 from the books of the two years before', () => {
    const obr = (year: string, month: string, amount: number, status = 'OBLIGATED') => ({
      obrDate: `${year}-${month}-15`,
      status,
      lines: [{ officeId: 'mayor', accountCode: '50203010', amount }],
    });
    const s = buildLbpForm2({
      ...base,
      lines: [mayor({}), mayor({ amount: 1_00 })],
      pastYear: [
        obr('2024', '03', 80_000_00),
        obr('2024', '11', 5_000_00),
        obr('2024', '12', 99_00, 'DRAFT'),
      ],
      currentYear: [
        obr('2025', '02', 30_000_00),
        obr('2025', '06', 10_000_00),
        obr('2025', '07', 25_000_00),
      ],
      currentBalances: [
        { officeId: 'mayor', accountCode: '50203010', appropriationRevised: 90_000_00 },
      ],
    });
    const row = s.offices[0].groups[1].rows[0];
    expect(row.pastYear).toBe(85_000_00);
    expect(row.firstSemester).toBe(40_000_00);
    // Columns 5 and 6 are left blank for the Department Head (patch 129).
    expect(row.secondSemester).toBe(0);
    expect(row.currentTotal).toBe(0);
    expect(row.proposed).toBe(100_001_00);
  });

  it('prints a 20% Development Fund line under Special Purpose Appropriations', () => {
    const s = buildLbpForm2({
      ...base,
      lines: [
        mayor({
          sector: '20% Development Fund',
          expenseClass: 'CO',
          accountCode: '',
          accountName: '',
          fppName: 'Road, Gatuslao',
        }),
      ],
    });
    const o = s.offices[0];
    expect(o.groups.every((g) => g.rows.length === 0)).toBe(true);
    expect(o.spas[0].heading).toBe('20% Development Fund');
    expect(o.spas[0].rows[0].object).toBe('Road, Gatuslao');
    expect(o.total.proposed).toBe(100_000_00);
  });

  it("leaves out a realignment's negative side - that is LBP Form No. 8", () => {
    const s = buildLbpForm2({
      ...base,
      lines: [mayor({ amount: -10_00 }), mayor({ amount: 10_00 })],
    });
    expect(s.grand.proposed).toBe(10_00);
  });

  it('knows the first semester', () => {
    expect(inFirstSemester('2025-06-30', 2025)).toBe(true);
    expect(inFirstSemester('2025-07-01', 2025)).toBe(false);
    expect(inFirstSemester('2024-03-01', 2025)).toBe(false);
  });
});
