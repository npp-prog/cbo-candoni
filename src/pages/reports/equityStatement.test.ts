import { describe, it, expect } from 'vitest';
import { buildEquityStatement } from './equityStatement';
import type { FsAccountBalance } from './condensedFs';

const eq = (over: Partial<FsAccountBalance> = {}): FsAccountBalance => ({
  accountCode: '30101010',
  accountName: 'Government Equity',
  classification: 'NET_ASSETS_EQUITY',
  amount: 50_000_000_00,
  ...over,
});

const build = (over: Partial<Parameters<typeof buildEquityStatement>[0]> = {}) =>
  buildEquityStatement({
    current: [eq()],
    prior: [eq({ amount: 45_000_000_00 })],
    surplus: { current: 6_000_000_00, prior: 5_000_000_00 },
    ...over,
  });

describe('the opening balance', () => {
  /**
   * Last year's equity accounts PLUS last year's surplus - the figure at the
   * foot of last year's Statement of Financial Position. Taken from Government
   * Equity alone it would depend on whether the office puts its surplus
   * through a closing entry, which changes that account and does not change
   * what the municipality is worth.
   */
  it('is last year closing net assets, not the equity account alone', () => {
    const s = build();
    expect(s.openingBalance.current).toBe(50_000_000_00);
  });

  it('counts every equity account, not only Government Equity', () => {
    const s = build({
      prior: [
        eq({ amount: 45_000_000_00 }),
        eq({ accountCode: '30401010', accountName: 'Unrealized Gain', amount: 1_000_000_00 }),
      ],
    });
    expect(s.openingBalance.current).toBe(51_000_000_00);
  });

  it('ignores an account that is not equity', () => {
    const s = build({
      prior: [
        eq({ amount: 45_000_000_00 }),
        eq({ accountCode: '10101010', classification: 'CURRENT_ASSET', amount: 9_000_000_00 }),
      ],
    });
    expect(s.openingBalance.current).toBe(50_000_000_00);
  });

  /**
   * With only two years of ledger the comparative column's own opening balance
   * is not knowable. It is reported as nil and the caller can say so, rather
   * than a figure being invented for it.
   */
  it('takes the comparative opening from the caller, or nothing', () => {
    expect(build().openingBalance.prior).toBe(0);
    expect(build({ priorOpening: 40_000_000_00 }).openingBalance.prior).toBe(40_000_000_00);
  });
});

describe('the restated balance', () => {
  it('adds a prior period correction to the opening balance', () => {
    const s = build({
      current: [
        eq(),
        eq({ accountCode: '30101020', accountName: 'Prior Period Adjustment', amount: 250_000_00 }),
      ],
    });
    expect(s.priorPeriodErrors.current).toBe(250_000_00);
    expect(s.restatedBalance.current).toBe(50_250_000_00);
  });

  it('takes a negative correction down', () => {
    const s = build({
      current: [eq(), eq({ accountCode: '30101020', amount: -400_000_00 })],
    });
    expect(s.restatedBalance.current).toBe(49_600_000_00);
  });

  /**
   * A change of accounting policy is restated through the accounts it affects
   * and no account holds it, so the line prints at nil. Annex 7 prints the
   * line, so CFMS prints it, and the flag lets the screen say why.
   */
  it('reports that a change of accounting policy is not tracked', () => {
    const s = build();
    expect(s.changeInAccountingPolicy.current).toBe(0);
    expect(s.accountingPolicyNotTracked).toBe(true);
  });
});

describe('what was recognised during the year', () => {
  /** Section 369(b): revenue and expense recognised directly in equity. */
  it.each(['30401010', '31301010', '31301020'])('takes %s as recognised directly in equity', (code) => {
    const s = build({ current: [eq(), eq({ accountCode: code, amount: 300_000_00 })] });
    expect(s.adjustmentRecognisedInEquity.current).toBe(300_000_00);
  });

  it('does not take Government Equity itself as an adjustment', () => {
    expect(build().adjustmentRecognisedInEquity.current).toBe(0);
  });

  /** Section 369(c): the total is the surplus plus what went straight to equity. */
  it('totals the surplus and the direct adjustments', () => {
    const s = build({ current: [eq(), eq({ accountCode: '30401010', amount: 400_000_00 })] });
    expect(s.totalRecognised.current).toBe(6_400_000_00);
  });

  /**
   * The surplus comes from the Statement of Financial Performance rather than
   * being recomputed. Two computations of one figure disagree eventually, and
   * the transfers block is where they would.
   */
  it('takes the surplus as given, without recomputing it', () => {
    const s = build({ surplus: { current: -2_000_000_00, prior: 0 } });
    expect(s.surplus.current).toBe(-2_000_000_00);
    expect(s.totalRecognised.current).toBe(-2_000_000_00);
  });
});

describe('the closing balance', () => {
  it('is the restated balance plus everything recognised', () => {
    const s = build();
    expect(s.closingBalance.current).toBe(56_000_000_00);
  });

  it('carries a correction and a direct adjustment through to the close', () => {
    const s = build({
      current: [
        eq(),
        eq({ accountCode: '30101020', amount: 250_000_00 }),
        eq({ accountCode: '30401010', amount: 400_000_00 }),
      ],
    });
    // 50,000,000 opening + 250,000 restated + 6,000,000 surplus + 400,000 direct
    expect(s.closingBalance.current).toBe(56_650_000_00);
  });

  it('falls when the year ran a deficit', () => {
    // Prior surplus held at 5,000,000 so the opening balance is unchanged at
    // 50,000,000; only the current year turns negative.
    const s = build({ surplus: { current: -3_000_000_00, prior: 5_000_000_00 } });
    expect(s.openingBalance.current).toBe(50_000_000_00);
    expect(s.closingBalance.current).toBe(47_000_000_00);
  });

  it('builds the comparative column the same way', () => {
    const s = build({ priorOpening: 40_000_000_00 });
    expect(s.restatedBalance.prior).toBe(40_000_000_00);
    expect(s.closingBalance.prior).toBe(45_000_000_00);
  });
});
