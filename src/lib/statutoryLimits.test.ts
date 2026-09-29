import { describe, it, expect } from 'vitest';
import {
  checkDevelopmentFund,
  checkLdrrmf,
  checkPsCap,
  checkQrf,
  checkStatutoryLimits,
  psCapRate,
  type AppropriationTotals,
  type StatutoryInputs,
} from './statutoryLimits';

const inputs = (over: Partial<StatutoryInputs> = {}): StatutoryInputs => ({
  incomeClass: '4',
  regularIncomePrecedingYear: 200_000_000_00,
  estimatedRegularIncome: 210_000_000_00,
  nationalTaxAllotment: 180_000_000_00,
  ...over,
});

const totals = (over: Partial<AppropriationTotals> = {}): AppropriationTotals => ({
  personalServices: 80_000_000_00,
  ldrrmf: 10_500_000_00,
  quickResponseFund: 3_150_000_00,
  developmentFund: 36_000_000_00,
  ...over,
});

describe('psCapRate', () => {
  it('is 45% for first to third class and 55% below that', () => {
    expect(psCapRate('1')).toBe(0.45);
    expect(psCapRate('3')).toBe(0.45);
    expect(psCapRate('4')).toBe(0.55);
    expect(psCapRate('6')).toBe(0.55);
  });
});

describe('checkPsCap', () => {
  it('passes an appropriation inside the cap', () => {
    const r = checkPsCap(inputs(), totals());
    expect(r.verdict).toBe('OK');
    expect(r.threshold).toBe(110_000_000_00);
  });

  it('fails one over the cap and says by how much', () => {
    const r = checkPsCap(inputs(), totals({ personalServices: 115_000_000_00 }));
    expect(r.verdict).toBe('BREACH');
    expect(r.shortfall).toBe(5_000_000_00);
  });

  /**
   * The same appropriation passes for a fourth class municipality and fails
   * for a third class one. Getting the class wrong is the quiet way to pass a
   * test that should have failed.
   */
  it('applies the class the LGU actually is', () => {
    const ps = totals({ personalServices: 95_000_000_00 });
    expect(checkPsCap(inputs({ incomeClass: '4' }), ps).verdict).toBe('OK');
    expect(checkPsCap(inputs({ incomeClass: '3' }), ps).verdict).toBe('BREACH');
  });

  it('says it cannot tell when the preceding year income is not entered', () => {
    const r = checkPsCap(inputs({ regularIncomePrecedingYear: 0 }), totals());
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.threshold).toBeNull();
  });
});

describe('checkLdrrmf', () => {
  it('passes an appropriation at the minimum', () => {
    const r = checkLdrrmf(inputs(), totals());
    expect(r.threshold).toBe(10_500_000_00);
    expect(r.verdict).toBe('OK');
  });

  /**
   * The one that voids the whole ordinance rather than part of it, which is
   * why it is reported first.
   */
  it('fails one below the minimum and names the consequence', () => {
    const r = checkLdrrmf(inputs(), totals({ ldrrmf: 9_000_000_00 }));
    expect(r.verdict).toBe('BREACH');
    expect(r.shortfall).toBe(1_500_000_00);
    expect(r.consequence).toContain('IN ITS ENTIRETY');
  });

  it('fails an ordinance that appropriates none at all', () => {
    expect(checkLdrrmf(inputs(), totals({ ldrrmf: 0 })).verdict).toBe('BREACH');
  });
});

describe('checkQrf', () => {
  it('passes exactly thirty per cent', () => {
    expect(checkQrf(totals()).verdict).toBe('OK');
  });

  /**
   * The manual cites a departure from 30% as a CONDITION of the review, not as
   * something that voids anything. Reporting it as a breach would send the
   * office chasing an amendment it does not need.
   */
  it('reports a departure as a condition, not a breach', () => {
    const more = checkQrf(totals({ quickResponseFund: 4_000_000_00 }));
    expect(more.verdict).toBe('CONDITION');
    expect(more.note).toContain('More');

    const less = checkQrf(totals({ quickResponseFund: 2_000_000_00 }));
    expect(less.verdict).toBe('CONDITION');
    expect(less.note).toContain('Less');
  });

  /**
   * Nothing nominated is not the same as nothing appropriated. Calling it a
   * condition would report a finding against an ordinance that may be
   * perfectly compliant and simply unmarked in CBO.
   */
  it('says it cannot tell when no line has been nominated', () => {
    const r = checkQrf(totals({ quickResponseFund: 0 }));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.threshold).toBe(3_150_000_00);
  });

  it('says it cannot tell when there is no LDRRMF to take a share of', () => {
    expect(checkQrf(totals({ ldrrmf: 0, quickResponseFund: 0 })).verdict).toBe('UNKNOWN');
  });
});

describe('checkDevelopmentFund', () => {
  it('passes an appropriation at the minimum', () => {
    const r = checkDevelopmentFund(inputs(), totals());
    expect(r.threshold).toBe(36_000_000_00);
    expect(r.verdict).toBe('OK');
  });

  it('fails one below it', () => {
    const r = checkDevelopmentFund(inputs(), totals({ developmentFund: 30_000_000_00 }));
    expect(r.verdict).toBe('BREACH');
    expect(r.shortfall).toBe(6_000_000_00);
  });

  it('says it cannot tell without the National Tax Allotment', () => {
    expect(
      checkDevelopmentFund(inputs({ nationalTaxAllotment: 0 }), totals()).verdict,
    ).toBe('UNKNOWN');
  });
});

describe('checkStatutoryLimits', () => {
  /**
   * The order is the review checklist's, not alphabetical: the two that void
   * the whole ordinance come before the one that voids part of it.
   */
  it('reports them in the order the checklist applies them', () => {
    expect(checkStatutoryLimits(inputs(), totals()).map((r) => r.key)).toEqual([
      'ldrrmf',
      'qrf',
      'devFund',
      'ps',
    ]);
  });

  it('reports every one as unknown when nothing has been entered', () => {
    const blank = checkStatutoryLimits(
      inputs({
        regularIncomePrecedingYear: 0,
        estimatedRegularIncome: 0,
        nationalTaxAllotment: 0,
      }),
      totals({ ldrrmf: 0, quickResponseFund: 0 }),
    );
    expect(blank.every((r) => r.verdict === 'UNKNOWN')).toBe(true);
  });
});
