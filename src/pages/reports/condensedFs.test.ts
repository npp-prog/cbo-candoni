import { describe, it, expect } from 'vitest';
import {
  condensePerformance,
  condensePosition,
  type FsAccountBalance,
} from './condensedFs';

const bal = (over: Partial<FsAccountBalance> = {}): FsAccountBalance => ({
  accountCode: '10101010',
  accountName: 'Cash Local Treasury',
  classification: 'CURRENT_ASSET',
  amount: 1_000_000_00,
  ...over,
});

const line = (p: CondensedFinder, caption: string) =>
  p.sections.flatMap((s) => s.lines).find((l) => l.caption === caption);
type CondensedFinder = ReturnType<typeof condensePosition>;

describe('the Statement of Financial Position', () => {
  it('folds several accounts of one group onto one caption', () => {
    const p = condensePosition(
      [
        bal({ accountCode: '10101010', amount: 400_000_00 }),
        bal({ accountCode: '10102010', accountName: 'Cash in Bank', amount: 600_000_00 }),
      ],
      [],
    );
    const cash = line(p, 'Cash and Cash Equivalents')!;
    expect(cash.current).toBe(1_000_000_00);
    expect(cash.accounts).toHaveLength(2);
  });

  it('puts the prior year beside the current one', () => {
    const p = condensePosition([bal({ amount: 1_000_000_00 })], [bal({ amount: 800_000_00 })]);
    const cash = line(p, 'Cash and Cash Equivalents')!;
    expect(cash.current).toBe(1_000_000_00);
    expect(cash.prior).toBe(800_000_00);
  });

  it('keeps an account that existed only last year', () => {
    const p = condensePosition([], [bal({ accountName: 'Closed account', amount: 50_000_00 })]);
    const cash = line(p, 'Cash and Cash Equivalents')!;
    expect(cash.current).toBe(0);
    expect(cash.prior).toBe(50_000_00);
  });

  it('prints the captions in the order Annex 5 prints them', () => {
    const p = condensePosition(
      [
        bal({ accountCode: '10401010', accountName: 'Inventory', classification: 'CURRENT_ASSET' }),
        bal({ accountCode: '10101010' }),
        bal({ accountCode: '10301010', accountName: 'Receivable', classification: 'CURRENT_ASSET' }),
      ],
      [],
    );
    const section = p.sections.find((s) => s.key === 'CURRENT_ASSET')!;
    expect(section.lines.map((l) => l.caption)).toEqual([
      'Cash and Cash Equivalents',
      'Receivables',
      'Inventories',
    ]);
  });

  it('leaves out a caption nothing was posted to', () => {
    const p = condensePosition([bal()], []);
    const section = p.sections.find((s) => s.key === 'CURRENT_ASSET')!;
    expect(section.lines.map((l) => l.caption)).toEqual(['Cash and Cash Equivalents']);
  });

  it('totals each section and both sides', () => {
    const p = condensePosition(
      [
        bal({ amount: 1_000_000_00 }),
        bal({
          accountCode: '10701010',
          accountName: 'Land',
          classification: 'NON_CURRENT_ASSET',
          amount: 5_000_000_00,
        }),
        bal({
          accountCode: '20101010',
          accountName: 'Accounts Payable',
          classification: 'CURRENT_LIABILITY',
          amount: 300_000_00,
        }),
      ],
      [],
    );
    expect(p.totalAssets.current).toBe(6_000_000_00);
    expect(p.totalLiabilities.current).toBe(300_000_00);
  });

  it('gathers the equity groups in their own block', () => {
    const p = condensePosition(
      [
        bal({
          accountCode: '30101010',
          accountName: 'Government Equity',
          classification: 'NET_ASSETS_EQUITY',
          amount: 4_000_000_00,
        }),
      ],
      [],
    );
    expect(p.equity.map((l) => l.caption)).toEqual(['Government Equity']);
    expect(p.equityTotal.current).toBe(4_000_000_00);
  });

  /**
   * The failure a condensed statement is prone to: drop an account and the
   * thing still balances, because the figure leaves the caption, the section
   * and the grand total together. Nothing points at it again.
   */
  it('reports an account no caption takes, rather than dropping it', () => {
    const p = condensePosition(
      [bal({ accountCode: '79901010', accountName: 'Invented account', amount: 9_000_00 })],
      [],
    );
    expect(p.unmapped).toHaveLength(1);
    expect(p.unmapped[0].accountCode).toBe('79901010');
    expect(p.unmapped[0].current).toBe(9_000_00);
  });

  it('reports a revenue account that wandered onto the position statement', () => {
    const p = condensePosition(
      [bal({ accountCode: '40101010', accountName: 'Tax', classification: 'REVENUE' })],
      [],
    );
    expect(p.unmapped[0].reason).toContain('Financial Performance');
  });

  /**
   * CBO does not post to the 3-05 registry accounts - the budgetary registry
   * is kept in budgetBalances and never journalised - so the Fund Balance
   * block of Annex 5 cannot be filled from the ledger. They are set aside so
   * the blank block can say why rather than just being empty.
   */
  it('sets the budgetary registry accounts aside from the equity block', () => {
    const p = condensePosition(
      [
        bal({
          accountCode: '30501010',
          accountName: 'Unappropriated Surplus',
          classification: 'NET_ASSETS_EQUITY',
          amount: 2_000_000_00,
        }),
      ],
      [],
    );
    expect(p.equity).toEqual([]);
    expect(p.fundBalanceAccounts).toHaveLength(1);
    expect(p.fundBalanceAccounts[0].current).toBe(2_000_000_00);
  });

  it('ignores an account that is nil in both years', () => {
    const p = condensePosition([bal({ amount: 0 })], [bal({ amount: 0 })]);
    expect(p.sections.flatMap((s) => s.lines)).toEqual([]);
  });
});

describe('the Statement of Financial Performance', () => {
  const rev = (over: Partial<FsAccountBalance> = {}) =>
    bal({ accountCode: '40101010', accountName: 'Real Property Tax', classification: 'REVENUE', ...over });
  const exp = (over: Partial<FsAccountBalance> = {}) =>
    bal({ accountCode: '50101010', accountName: 'Salaries', classification: 'EXPENSE', ...over });

  it('totals revenue and expenses and strikes the surplus', () => {
    const p = condensePerformance(
      [rev({ amount: 10_000_000_00 }), exp({ amount: 7_000_000_00 })],
      [],
    );
    expect(p.totalRevenue.current).toBe(10_000_000_00);
    expect(p.totalExpenses.current).toBe(7_000_000_00);
    expect(p.surplusFromOperation.current).toBe(3_000_000_00);
    expect(p.surplus.current).toBe(3_000_000_00);
  });

  /**
   * Unlike the position statement, a nil line here is still printed: the annex
   * prints it, and a reader comparing two years needs the line to exist in
   * both.
   */
  it('prints every revenue caption of the annex, including the empty ones', () => {
    const p = condensePerformance([rev()], []);
    expect(p.revenue.map((l) => l.caption)).toEqual([
      'Tax Revenue',
      'Share from Internal Revenue Collections',
      'Other Share from National Taxes',
      'Service and Business Income',
      'Shares, Grants and Donations',
      'Gains',
      'Other Income',
    ]);
    expect(p.revenue.find((l) => l.caption === 'Other Share from National Taxes')!.current).toBe(0);
  });

  /**
   * The correction from patch 49. These accounts sit in sub-major group
   * 4-01-06, INSIDE major group 4-01 Tax Revenue, and the annex prints them on
   * two lines of their own. Patch 48 left both lines empty on a false finding
   * that the chart had no such accounts.
   */
  it('reports the IRA on its own line and keeps it out of Tax Revenue', () => {
    const p = condensePerformance(
      [
        rev({ accountCode: '40102040', accountName: 'RPT Basic', amount: 5_000_000_00 }),
        rev({
          accountCode: '40106010',
          accountName: 'Share from Internal Revenue Collections (IRA)',
          amount: 80_000_000_00,
        }),
        rev({
          accountCode: '40106030',
          accountName: 'Share from National Wealth',
          amount: 2_000_000_00,
        }),
      ],
      [],
    );
    const by = (c: string) => p.revenue.find((l) => l.caption === c)!;
    expect(by('Tax Revenue').current).toBe(5_000_000_00);
    expect(by('Share from Internal Revenue Collections').current).toBe(80_000_000_00);
    expect(by('Other Share from National Taxes').current).toBe(2_000_000_00);
    expect(p.totalRevenue.current).toBe(87_000_000_00);
  });

  it('prints the expense captions in the annex order', () => {
    const p = condensePerformance([exp()], []);
    expect(p.expenses.map((l) => l.caption)).toEqual([
      'Personnel Services',
      'Maintenance and Other Operating Expenses',
      'Non-Cash Expenses',
      'Financial Expenses',
      'Direct Costs',
    ]);
  });

  /**
   * The transfers block sits beneath the surplus from current operation, not
   * in the revenue list. Group 4-03 holds both directions and the sign says
   * which.
   */
  it('reports transfers beneath the surplus, not as revenue', () => {
    const p = condensePerformance(
      [
        rev({ amount: 10_000_000_00 }),
        exp({ amount: 7_000_000_00 }),
        bal({
          accountCode: '40301010',
          accountName: 'Subsidy from National Government',
          classification: 'REVENUE',
          amount: 2_000_000_00,
        }),
      ],
      [],
    );
    expect(p.totalRevenue.current).toBe(10_000_000_00);
    expect(p.transfersFrom.current).toBe(2_000_000_00);
    expect(p.surplusFromOperation.current).toBe(3_000_000_00);
    expect(p.surplus.current).toBe(5_000_000_00);
  });

  it('takes a negative transfer as an outward one and deducts it', () => {
    const p = condensePerformance(
      [
        bal({
          accountCode: '40301010',
          accountName: 'Subsidy to another fund',
          classification: 'REVENUE',
          amount: -500_000_00,
        }),
      ],
      [],
    );
    expect(p.transfersTo.current).toBe(500_000_00);
    expect(p.surplus.current).toBe(-500_000_00);
  });

  it('leaves the balance sheet accounts alone', () => {
    const p = condensePerformance([bal()], []);
    expect(p.totalRevenue.current).toBe(0);
    expect(p.unmapped).toEqual([]);
  });

  it('reports a revenue account no line takes', () => {
    const p = condensePerformance(
      [rev({ accountCode: '49901010', accountName: 'Invented revenue' })],
      [],
    );
    expect(p.unmapped).toHaveLength(1);
    expect(p.unmapped[0].reason).toContain('499');
  });

  it('carries the prior year through every line', () => {
    const p = condensePerformance([rev({ amount: 10_000_00 })], [rev({ amount: 8_000_00 })]);
    const tax = p.revenue.find((l) => l.caption === 'Tax Revenue')!;
    expect(tax.prior).toBe(8_000_00);
    expect(p.totalRevenue.prior).toBe(8_000_00);
  });
});
