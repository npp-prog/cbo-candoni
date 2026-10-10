import { describe, expect, it } from 'vitest';
import {
  blankPriorLines,
  cashFlowKey,
  cashOn,
  priorCashFlowId,
  priorCashFlowTotals,
  unknownCaptions,
} from './priorCashFlow';

describe('prior year cash flows', () => {
  it('lays out the fund statement captions, the shorter one for the Trust Fund', () => {
    const gf = blankPriorLines('GF');
    expect(gf.some((l) => l.caption === 'Collection from taxpayers')).toBe(true);
    const tf = blankPriorLines('TF');
    expect(tf.some((l) => l.caption === 'Collection from taxpayers')).toBe(false);
    expect(tf.some((l) => l.caption === 'Other Receipts')).toBe(true);
  });

  it('works out the totals and the cash at the end', () => {
    const t = priorCashFlowTotals(
      [
        {
          section: 'OPERATING',
          direction: 'IN',
          caption: 'Collection from taxpayers',
          amount: 1000_00,
        },
        {
          section: 'OPERATING',
          direction: 'OUT',
          caption: 'Payments to employees',
          amount: 400_00,
        },
        {
          section: 'INVESTING',
          direction: 'OUT',
          caption: 'Purchase/Construction of Property, Plant and Equipment',
          amount: 250_00,
        },
      ],
      500_00,
    );
    expect(t.bySection.OPERATING.net).toBe(600_00);
    expect(t.bySection.INVESTING.net).toBe(-250_00);
    expect(t.netFlows).toBe(350_00);
    expect(t.endingCash).toBe(850_00);
  });

  it('refuses a caption the fund does not print', () => {
    expect(
      unknownCaptions('TF', [
        { section: 'OPERATING', direction: 'IN', caption: 'Collection from taxpayers', amount: 1 },
      ]),
    ).toEqual(['Collection from taxpayers']);
    expect(
      unknownCaptions('GF', [
        { section: 'OPERATING', direction: 'IN', caption: 'Collection from taxpayers', amount: 1 },
      ]),
    ).toEqual([]);
  });

  it('reads the cash (1-01) off a set of lines, not the time deposits (1-02)', () => {
    expect(
      cashOn([
        { accountCode: '10101010', debit: 100_00 },
        { accountCode: '10102020', debit: 750_00 },
        { accountCode: '10201010', debit: 999_00 },
        { accountCode: '20101010', credit: 850_00 },
      ]),
    ).toBe(850_00);
    expect(priorCashFlowId(2025, 'GF')).toBe('2025__GF');
    expect(cashFlowKey('OPERATING', 'IN', 'X')).toBe('OPERATING::IN::X');
  });
});
