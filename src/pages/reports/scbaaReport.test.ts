import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildScbaaExpenditure,
  buildScbaaRevenue,
  type ScbaaBudgetLine,
} from './scbaaReport';
import { SCBAA_REVENUE, autoMatchSector, revenueLineFor } from '@/lib/scbaaLines';
import { SECTORS } from '@/lib/sectors';

const bl = (over: Partial<ScbaaBudgetLine> = {}): ScbaaBudgetLine => ({
  sector: 'General Public Services',
  expenseClass: 'MOOE',
  appropriationOriginal: 10_000_000_00,
  appropriationContinuing: 0,
  appropriationRevised: 10_000_000_00,
  obligated: 8_000_000_00,
  disbursed: 6_000_000_00,
  ...over,
});

const findRow = (r: ReturnType<typeof buildScbaaRevenue>, label: string) =>
  r.rows.find((x) => x.line.label === label)!;

describe('the five columns', () => {
  /** Section 371: the original budget INCLUDES the continuing appropriations. */
  it('puts the carry-on continuing appropriation in the original budget', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ appropriationOriginal: 10_000_000_00, appropriationContinuing: 2_000_000_00 })],
      basis: 'OBLIGATIONS',
    });
    expect(e.blocks[0].rows[0].figures.original).toBe(12_000_000_00);
  });

  /** Section 372: the final budget is the revised appropriation. */
  it('takes the final budget from the revised appropriation', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ appropriationRevised: 11_500_000_00 })],
      basis: 'OBLIGATIONS',
    });
    expect(e.blocks[0].rows[0].figures.final).toBe(11_500_000_00);
  });

  it('strikes both difference columns', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ appropriationOriginal: 10_000_000_00, appropriationRevised: 12_000_000_00, obligated: 9_000_000_00 })],
      basis: 'OBLIGATIONS',
    });
    const f = e.blocks[0].rows[0].figures;
    expect(f.differenceOriginalFinal).toBe(-2_000_000_00);
    expect(f.differenceFinalActual).toBe(3_000_000_00);
  });
});

/**
 * Section 373 says only "the amounts that result from execution of the budget",
 * and both readings have support. The choice is the municipality's; what must
 * not happen is the statement being printed without saying which it used.
 */
describe('the basis of the actual column', () => {
  it('counts obligations when that is the basis', () => {
    const e = buildScbaaExpenditure({ lines: [bl()], basis: 'OBLIGATIONS' });
    expect(e.blocks[0].rows[0].figures.actual).toBe(8_000_000_00);
  });

  it('counts disbursements when that is the basis', () => {
    const e = buildScbaaExpenditure({ lines: [bl()], basis: 'DISBURSEMENTS' });
    expect(e.blocks[0].rows[0].figures.actual).toBe(6_000_000_00);
  });

  it('changes the unused-budget column with it', () => {
    const o = buildScbaaExpenditure({ lines: [bl()], basis: 'OBLIGATIONS' });
    const d = buildScbaaExpenditure({ lines: [bl()], basis: 'DISBURSEMENTS' });
    expect(o.blocks[0].rows[0].figures.differenceFinalActual).toBe(2_000_000_00);
    expect(d.blocks[0].rows[0].figures.differenceFinalActual).toBe(4_000_000_00);
  });
});

describe('the expenditure half', () => {
  it('breaks each sector into its expense classes', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ expenseClass: 'PS' }), bl({ expenseClass: 'MOOE' }), bl({ expenseClass: 'CO' })],
      basis: 'OBLIGATIONS',
    });
    expect(e.blocks[0].rows.map((r) => r.classKey)).toEqual(['PS', 'MOOE', 'CO']);
  });

  /**
   * Annex 8 prints three classes and has no Financial Expenses line. Candoni
   * uses FE, so it is carried as a fourth row and marked: an expenditure total
   * that does not foot to the appropriation is a worse fault on this statement
   * than a row the annex does not show.
   */
  it('carries Financial Expenses and marks it as not on the annex', () => {
    const e = buildScbaaExpenditure({ lines: [bl({ expenseClass: 'FE' })], basis: 'OBLIGATIONS' });
    const row = e.blocks[0].rows[0];
    expect(row.classKey).toBe('FE');
    expect(row.onAnnex).toBe(false);
  });

  it('keeps the sectors in the order the annex prints them', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ sector: 'Economic Services' }), bl({ sector: 'General Public Services' })],
      basis: 'OBLIGATIONS',
    });
    expect(e.blocks.map((b) => b.sector)).toEqual([
      'General Public Services',
      'Economic Services',
    ]);
  });

  it('does not print a sector nothing was appropriated to', () => {
    const e = buildScbaaExpenditure({ lines: [bl()], basis: 'OBLIGATIONS' });
    expect(e.blocks).toHaveLength(1);
  });

  it('totals each sector and the whole statement', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ expenseClass: 'PS' }), bl({ expenseClass: 'MOOE' })],
      basis: 'OBLIGATIONS',
    });
    expect(e.blocks[0].total.final).toBe(20_000_000_00);
    expect(e.total.final).toBe(20_000_000_00);
  });
});

/**
 * The annex's sector list is the national one and Candoni's ordinance does not
 * use it. Eight match by name; the rest are the office's to nominate.
 */
describe('matching the ordinance sectors to the annex', () => {
  it.each([
    'General Public Services',
    'Economic Services',
    'Social Services and Social Welfare',
    'Health, Nutrition and Population Control',
    'Housing and Community Development',
    'LDRRMF',
    '20% Development Fund',
    'Others',
  ])('matches %s by name', (name) => {
    expect(autoMatchSector(name)).toBe(name);
  });

  it('ignores case and spacing', () => {
    expect(autoMatchSector('  general   public services ')).toBe('General Public Services');
  });

  /**
   * A near match is not a match. These two might be the same thing or might
   * not, and a submitted statement is not the place to find out.
   */
  it('refuses a near match', () => {
    expect(autoMatchSector('Social Services')).toBeNull();
    expect(autoMatchSector('Education, Culture and Sports')).toBeNull();
  });

  it('names an unmatched sector instead of sweeping it into Others', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ sector: 'Allocation for Senior Citizens and PWD', appropriationRevised: 3_000_000_00 })],
      basis: 'OBLIGATIONS',
    });
    expect(e.blocks).toHaveLength(0);
    expect(e.unmatchedSectors).toEqual([
      { sector: 'Allocation for Senior Citizens and PWD', amount: 3_000_000_00 },
    ]);
  });

  it('uses the nomination once it is given', () => {
    const e = buildScbaaExpenditure({
      lines: [bl({ sector: 'Allocation for Senior Citizens and PWD' })],
      basis: 'OBLIGATIONS',
      sectorMapping: { 'Allocation for Senior Citizens and PWD': 'Social Services and Social Welfare' },
    });
    expect(e.unmatchedSectors).toEqual([]);
    expect(e.blocks[0].sector).toBe('Social Services and Social Welfare');
  });

  it('names a line with no sector recorded at all', () => {
    const e = buildScbaaExpenditure({ lines: [bl({ sector: '' })], basis: 'OBLIGATIONS' });
    expect(e.unmatchedSectors[0].sector).toBe('(no sector recorded)');
  });

  /**
   * How much of Candoni's own list needs nominating. Not an assertion about
   * what the answer should be - a record of the gap, so it fails loudly if
   * either list changes.
   */
  it('leaves exactly the sectors the two lists disagree on', () => {
    const unmatched = SECTORS.map((s) => s.name).filter((n) => autoMatchSector(n) === null);
    expect(unmatched).toEqual(['Allocation for Senior Citizens and PWD', 'Debt Services']);
  });
});

describe('the revenue half', () => {
  const est = (accountCode: string, annual: number, accountName = 'x') => ({
    accountCode,
    accountName,
    annual,
  });

  it('files an account on the annex line its code names', () => {
    const r = buildScbaaRevenue({
      estimates: [est('40102040', 5_000_000_00, 'Real Property Tax - Basic')],
      actuals: [{ accountCode: '40102040', amount: 4_200_000_00 }],
    });
    const row = findRow(r, 'a. Tax Revenue - Property');
    expect(row.figures.final).toBe(5_000_000_00);
    expect(row.figures.actual).toBe(4_200_000_00);
    expect(row.figures.differenceFinalActual).toBe(800_000_00);
  });

  it.each([
    ['40102040', 'a. Tax Revenue - Property'],
    ['40103010', 'b. Tax Revenue - Goods and Services'],
    ['40101010', 'c. Other Local Taxes'],
    ['40105020', 'c. Other Local Taxes'],
    ['40201010', 'a. Service Income'],
    ['40202010', 'b. Business Income'],
    ['40601010', 'c. Other Income and Receipts'],
    ['40106010', '1. Share from the National Internal Revenue Taxes (IRA)'],
    ['40401010', '2. Share from GOCCs'],
    ['40106050', 'a. Share from Ecozone'],
    ['40106020', 'b. Share from EVAT'],
    ['40106030', 'c. Share from National Wealth'],
    ['40106040', 'd. Share from Tobacco Excise Tax'],
    ['40402010', 'a. Grants and Donations'],
    ['40301010', 'b. Other Subsidy Income'],
    ['40302010', '5. Inter-Local Transfer'],
  ])('%s goes on %s', (code, label) => {
    expect(revenueLineFor(code)?.label).toBe(label);
  });

  it('adds the subtotals from the lines beneath them', () => {
    const r = buildScbaaRevenue({
      estimates: [est('40102040', 5_000_000_00), est('40201010', 1_000_000_00)],
      actuals: [],
    });
    expect(findRow(r, 'Total Tax Revenue').figures.final).toBe(5_000_000_00);
    expect(findRow(r, 'Total Non-Tax Revenue').figures.final).toBe(1_000_000_00);
    expect(findRow(r, 'Total Local Sources').figures.final).toBe(6_000_000_00);
  });

  it('adds the external sources into the grand total', () => {
    const r = buildScbaaRevenue({
      estimates: [est('40102040', 5_000_000_00), est('40106010', 80_000_000_00)],
      actuals: [],
    });
    expect(r.total.final).toBe(85_000_000_00);
  });

  /**
   * CBO holds one estimate per income account and no record of which ordinance
   * set it, so it cannot separate an annual budget from a supplemental. The
   * two columns carry the same figure and the flag lets the screen say so.
   */
  it('reports that the original and final revenue budgets are the same figure', () => {
    const r = buildScbaaRevenue({ estimates: [est('40102040', 5_000_000_00)], actuals: [] });
    const row = findRow(r, 'a. Tax Revenue - Property');
    expect(row.figures.original).toBe(row.figures.final);
    expect(r.originalEqualsFinal).toBe(true);
  });

  it('reports a collection on an account no annex line takes', () => {
    const r = buildScbaaRevenue({
      estimates: [],
      actuals: [{ accountCode: '49901010', amount: 12_000_00 }],
    });
    expect(r.unmapped).toHaveLength(1);
    expect(r.unmapped[0].accountCode).toBe('49901010');
  });

  /** Printed because the annex prints them, and each says why it is empty. */
  it('keeps the lines the chart cannot answer, with a reason', () => {
    const withReason = SCBAA_REVENUE.filter((l) => l.notInChart);
    expect(withReason.map((l) => l.label)).toEqual([
      'a. Sale of Capital Assets',
      'b. Sale of Investments',
      'c. Proceeds from Collections of Loans Receivable',
      'C. Receipts from Borrowings',
    ]);
  });
});

/**
 * Every income account the municipality actually has must reach a line, or a
 * collection disappears off a statement that still adds up.
 */
describe('against the municipality own chart of accounts', () => {
  it('files every income account on an annex line', () => {
    const csv = readFileSync(
      resolve(__dirname, '..', '..', '..', 'data', 'chart-of-accounts.csv'),
      'utf8',
    );
    const orphans = csv
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ code: l.slice(0, l.indexOf(',')).trim(), name: l.slice(l.indexOf(',') + 1) }))
      .filter((a) => /^4\d{7}$/.test(a.code))
      // 4-05 Gains are not receipts: a gain on disposal is the difference
      // between proceeds and carrying amount, and the annex reports the
      // proceeds under capital receipts, not the gain.
      .filter((a) => !a.code.startsWith('405'))
      .filter((a) => !revenueLineFor(a.code));
    expect(orphans.map((a) => `${a.code} ${a.name}`)).toEqual([]);
  });
});
