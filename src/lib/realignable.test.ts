import { describe, it, expect } from 'vitest';
import { checkRealignableBalances, realignableBalance } from './accounting-rules';

/** Patch 128: only the unobligated balance can be realigned or augmented from. */
describe('realignable balance', () => {
  it('is the appropriation less what is obligated, never below zero', () => {
    expect(realignableBalance({ appropriationRevised: 100_000_00, obligated: 37_000_00 })).toBe(
      63_000_00,
    );
    expect(realignableBalance({ appropriationRevised: 10_00, obligated: 20_00 })).toBe(0);
  });

  it('lets a source give up to its unobligated balance and no more', () => {
    const line = {
      lineNo: 1,
      label: 'Office Supplies, Mayor',
      appropriationRevised: 100_000_00,
      obligated: 90_000_00,
    };
    expect(checkRealignableBalances([{ ...line, amount: -10_000_00 }]).ok).toBe(true);
    const r = checkRealignableBalances([{ ...line, amount: -10_000_01 }]);
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('REALIGNMENT_EXCEEDS_UNOBLIGATED');
    expect(r.violations[0].message).toMatch(/at most 10,000\.00/);
  });

  it('does not look at the receiving side', () => {
    expect(
      checkRealignableBalances([
        { lineNo: 1, label: 'x', amount: 50_00, appropriationRevised: 0, obligated: 0 },
      ]).ok,
    ).toBe(true);
  });
});
