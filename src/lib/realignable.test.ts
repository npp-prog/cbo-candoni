import { describe, it, expect } from 'vitest';
import { checkRealignableBalances, realignableBalance } from './accounting-rules';

/**
 * Patch 130: only appropriation not yet allotted can be realigned or
 * augmented from. More is freed by withdrawing allotment first.
 */
describe('realignable balance', () => {
  it('is the appropriation less the allotment released and held, never below zero', () => {
    expect(realignableBalance({ appropriationRevised: 200_000_00, allotmentReleased: 100_000_00 })).toBe(100_000_00);
    expect(
      realignableBalance({ appropriationRevised: 200_000_00, allotmentReleased: 90_000_00, forLaterRelease: 10_000_00 }),
    ).toBe(100_000_00);
    expect(realignableBalance({ appropriationRevised: 10_00, allotmentReleased: 20_00 })).toBe(0);
  });

  it('ignores obligations - the allotment is what stands between', () => {
    expect(realignableBalance({ appropriationRevised: 100_00, allotmentReleased: 0, obligated: 100_00 } as never)).toBe(100_00);
  });

  it('lets a source give up its unallotted balance and no more, and says to withdraw', () => {
    const line = { lineNo: 1, label: 'Office Supplies, Mayor', appropriationRevised: 100_000_00, allotmentReleased: 100_000_00 };
    const r = checkRealignableBalances([{ ...line, amount: -10_000_00 }]);
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('REALIGNMENT_EXCEEDS_UNALLOTTED');
    expect(r.violations[0].message).toMatch(/at most 0\.00/);
    expect(r.violations[0].message).toMatch(/Withdraw allotment first/);
    expect(checkRealignableBalances([{ ...line, allotmentReleased: 90_000_00, amount: -10_000_00 }]).ok).toBe(true);
  });

  it('does not look at the receiving side', () => {
    expect(
      checkRealignableBalances([
        { lineNo: 1, label: 'x', amount: 50_00, appropriationRevised: 0, allotmentReleased: 0 },
      ]).ok,
    ).toBe(true);
  });
});
