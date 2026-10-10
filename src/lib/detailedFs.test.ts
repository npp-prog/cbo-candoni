import { describe, expect, it } from 'vitest';
import { POSITION_LAYOUT, PERFORMANCE_LAYOUT } from './detailedFsLayout';
import {
  balancesFor,
  buildDetailed,
  equityFigures,
  lineValue,
  naturalBalances,
} from './detailedFs';

const row = (s: ReturnType<typeof buildDetailed>, label: string) =>
  s.rows.find((r) => r.label === label)!;

describe('the detailed financial statements (patch 168)', () => {
  it('takes natural balances: debit for assets and expenses, credit for the rest', () => {
    const m = naturalBalances(
      [
        { accountCode: '10101010', period: 1, signedAmount: 1000 },
        { accountCode: '40101050', period: 2, signedAmount: -500 },
        { accountCode: '10703011', period: 2, signedAmount: -40 },
        { accountCode: '50101010', period: 13, signedAmount: 99 },
      ],
      12,
    );
    expect(m.get('10101010')).toBe(1000);
    expect(m.get('40101050')).toBe(500);
    expect(m.get('10703011')).toBe(-40);
    expect(m.has('50101010')).toBe(false);
  });

  it('lays out the performance statement and works its surplus as the office sheet does', () => {
    const cur = new Map([
      ['40101050', 169_701_51],
      ['40106010', 180_053_636_00],
      ['50101010', 41_967_166_14],
      ['40301040', 480_900_00],
      ['50214030', 4_918_152_65],
      ['40601010', 4_080_00],
    ]);
    const s = buildDetailed(PERFORMANCE_LAYOUT, { current: cur, prior: new Map() });
    expect(row(s, 'Total Tax Revenue').current).toBe(169_701_51);
    expect(row(s, 'TOTAL REVENUE').current).toBe(169_701_51 + 180_053_636_00);
    expect(row(s, 'Total Personnel Services').current).toBe(41_967_166_14);
    expect(row(s, 'NET FINANCIAL ASSISTANCE/SUBSIDY').current).toBe(480_900_00 - 4_918_152_65);
    const surplus = lineValue(s, /^SURPLUS \(DEFICIT\) FOR THE PERIOD$/).current;
    expect(surplus).toBe(
      169_701_51 + 180_053_636_00 - 41_967_166_14 + 480_900_00 - 4_918_152_65 + 4_080_00,
    );
  });

  it('carries a code that appears twice on the appearance the office uses', () => {
    // Leave Benefits Payable is listed under current and non-current payables.
    const cur = new Map([
      ['10101010', 1000],
      ['20101110', 400],
      ['31000000', 50],
    ]);
    const bal = { current: cur, prior: new Map<string, number>() };
    const eq = equityFigures(POSITION_LAYOUT, bal, { current: 550, prior: 0 });
    const s = buildDetailed(POSITION_LAYOUT, bal, eq);
    expect(row(s, 'TOTAL CURRENT LIABILITIES').current).toBe(0);
    expect(row(s, 'TOTAL NON- CURRENT LIABILITIES').current).toBe(400);
    expect(row(s, 'TOTAL ASSETS').current).toBe(1000);
    expect(row(s, 'TOTAL LIABILITIES AND EQUITY').current).toBe(1000);
    expect(s.unplaced).toEqual([]);
  });

  it('prints an account the layout lacks beside the nearest one, inside its totals', () => {
    const s = buildDetailed(
      POSITION_LAYOUT,
      {
        current: new Map([
          ['19901030', 10_000_00],
          ['10901020', 5_00],
        ]),
        prior: new Map(),
      },
      { current: 0, prior: 0 },
      new Map([['19901030', 'Advances to Special Disbursing Officer']]),
    );
    expect(s.unplaced).toEqual([{ code: '19901030', current: 10_000_00, prior: 0 }]);
    const i = s.rows.findIndex((r) => r.code === '19901030');
    expect(s.rows[i]).toMatchObject({
      extra: true,
      label: 'Advances to Special Disbursing Officer',
    });
    expect(row(s, 'TOTAL ASSETS').current).toBe(10_000_00 + 5_00);
    expect(
      buildDetailed(PERFORMANCE_LAYOUT, {
        current: balancesFor(new Map([['10101010', 9]]), 'performance'),
        prior: new Map(),
      }).unplaced,
    ).toEqual([]);
  });
});
