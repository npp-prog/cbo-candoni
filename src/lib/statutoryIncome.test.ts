import { describe, it, expect } from 'vitest';
import {
  compareToStated,
  isMaterial,
  ntaSuggestion,
  regularIncomeSuggestion,
  type IncomeEstimateLine,
} from './statutoryIncome';

const line = (over: Partial<IncomeEstimateLine> = {}): IncomeEstimateLine => ({
  accountCode: '40102040',
  accountName: 'Real Property Tax- Basic',
  incomeClass: 'REGULAR',
  annual: 5_000_000_00,
  ...over,
});

describe('the LDRRMF denominator', () => {
  it('adds up the regular income estimates', () => {
    const s = regularIncomeSuggestion([
      line(),
      line({ accountCode: '40102010', annual: 3_000_000_00 }),
    ]);
    expect(s.amount).toBe(8_000_000_00);
    expect(s.empty).toBe(false);
  });

  /**
   * The three-way split of LBP Form No. 1 exists because two statutory limits
   * rest on it. Counting a non-regular receipt would raise the five per cent
   * threshold on income the municipality may not count towards it.
   */
  it.each(['NON_REGULAR', 'NON_INCOME'])('leaves %s income out', (incomeClass) => {
    const s = regularIncomeSuggestion([line(), line({ accountCode: '40402010', incomeClass, annual: 9_000_000_00 })]);
    expect(s.amount).toBe(5_000_000_00);
  });

  it('shows the lines behind the figure, in code order', () => {
    const s = regularIncomeSuggestion([
      line({ accountCode: '40102080' }),
      line({ accountCode: '40102010' }),
    ]);
    expect(s.lines.map((l) => l.accountCode)).toEqual(['40102010', '40102080']);
  });

  it('drops an account estimated at nothing', () => {
    const s = regularIncomeSuggestion([line(), line({ accountCode: '40102080', annual: 0 })]);
    expect(s.lines).toHaveLength(1);
  });

  /**
   * No estimates loaded is not the same as an estimate of nothing, and a
   * screen must not offer the second as though it were a figure.
   */
  it('reports that nothing supports a figure rather than suggesting zero', () => {
    expect(regularIncomeSuggestion([]).empty).toBe(true);
    expect(regularIncomeSuggestion([line({ incomeClass: 'NON_REGULAR' })]).empty).toBe(true);
  });
});

describe('the National Tax Allotment denominator', () => {
  const lines = [
    line(),
    line({ accountCode: '40301010', accountName: 'Subsidy from National Government', annual: 80_000_000_00 }),
  ];

  it('adds up only the accounts the office nominated', () => {
    const s = ntaSuggestion(lines, ['40301010']);
    expect(s.amount).toBe(80_000_000_00);
    expect(s.lines).toHaveLength(1);
  });

  /**
   * The mistake that would matter. The Development Fund is measured against
   * the NTA alone; against total income it would appear to comply at about a
   * fifth of what is really required.
   */
  it.each([[undefined], [[]], [['']]])('suggests nothing when nothing is nominated (%s)', (nominated) => {
    const s = ntaSuggestion(lines, nominated as string[] | undefined);
    expect(s.empty).toBe(true);
    expect(s.amount).toBe(0);
  });

  it('suggests nothing when a nominated account carries no estimate', () => {
    expect(ntaSuggestion(lines, ['40401010']).empty).toBe(true);
  });

  it('adds several nominated accounts together', () => {
    const s = ntaSuggestion(
      [...lines, line({ accountCode: '40401010', annual: 500_000_00 })],
      ['40301010', '40401010'],
    );
    expect(s.amount).toBe(80_500_000_00);
  });

  it('ignores whitespace around a nominated code', () => {
    expect(ntaSuggestion(lines, ['  40301010 ']).amount).toBe(80_000_000_00);
  });

  /** A nomination pays no attention to the income class - the NTA is what it is. */
  it('takes a nominated account whatever its income class', () => {
    const s = ntaSuggestion([line({ accountCode: '40301010', incomeClass: 'NON_REGULAR', annual: 7_00 })], [
      '40301010',
    ]);
    expect(s.amount).toBe(7_00);
  });
});

describe('the typed figure against the estimates', () => {
  const s = regularIncomeSuggestion([line()]);

  it('agrees only to the centavo', () => {
    expect(compareToStated(5_000_000_00, s).agrees).toBe(true);
    expect(compareToStated(5_000_000_01, s).agrees).toBe(false);
  });

  it('reports which way round the difference lies', () => {
    expect(compareToStated(6_000_000_00, s).difference).toBe(1_000_000_00);
    expect(compareToStated(4_000_000_00, s).difference).toBe(-1_000_000_00);
  });

  it('says plainly when there is nothing to compare against', () => {
    const c = compareToStated(5_000_000_00, regularIncomeSuggestion([]));
    expect(c.cannotCompare).toBe(true);
    expect(c.agrees).toBe(false);
  });
});

/**
 * One per cent. Below that it is a rounding or a late amendment to one line;
 * above it the five per cent LDRRMF threshold has moved by enough to change a
 * verdict, and what is at stake is the whole ordinance.
 */
describe('when a difference is worth interrupting for', () => {
  const s = regularIncomeSuggestion([line({ annual: 100_000_000_00 })]);

  it('says nothing when the two agree', () => {
    expect(isMaterial(compareToStated(100_000_000_00, s))).toBe(false);
  });

  it('says nothing about a difference under one per cent', () => {
    expect(isMaterial(compareToStated(100_500_000_00, s))).toBe(false);
  });

  it('interrupts at one per cent', () => {
    expect(isMaterial(compareToStated(101_000_000_00, s))).toBe(true);
  });

  it('interrupts the other way round too', () => {
    expect(isMaterial(compareToStated(98_000_000_00, s))).toBe(true);
  });

  it('does not interrupt when there is nothing to compare', () => {
    expect(isMaterial(compareToStated(50_000_00, regularIncomeSuggestion([])))).toBe(false);
  });
});
