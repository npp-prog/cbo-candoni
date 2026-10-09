import { describe, it, expect } from 'vitest';
import { buildFundingSources, isRealignmentSource } from './fundingSources';

const line = (over: Record<string, unknown>) => ({
  kind: 'REALIGNMENT',
  instrument: 'REALIGNMENT',
  status: 'APPROVED',
  accountCode: '50203010',
  accountName: 'Office Supplies Expenses',
  amount: -10_000_00,
  ...over,
});

describe('LBP Form No. 8 - funding sources', () => {
  it('lists what a realignment took away, as positive figures by account', () => {
    const s = buildFundingSources([
      line({}),
      line({ accountCode: '50299080', accountName: 'Donations', amount: -5_000_00 }),
      // The side that received it is on LBP Form No. 2, not here.
      line({ accountCode: '50202010', accountName: 'Training Expenses', amount: 15_000_00 }),
    ]);
    expect(s.realignment.map((r) => [r.classification, r.amount])).toEqual([
      ['50203010 - Office Supplies Expenses', 10_000_00],
      ['50299080 - Donations', 5_000_00],
    ]);
    expect(s.totalRealignment).toBe(15_000_00);
  });

  it('adds two realignments that took from the same account', () => {
    const s = buildFundingSources([line({}), line({ amount: -2_50 })]);
    expect(s.realignment).toHaveLength(1);
    expect(s.realignment[0].amount).toBe(10_002_50);
  });

  it('leaves out an augmentation, a draft, and anything else', () => {
    expect(isRealignmentSource(line({ instrument: 'AUGMENTATION' }))).toBe(false);
    expect(isRealignmentSource(line({ status: 'DRAFT' }))).toBe(false);
    expect(isRealignmentSource(line({ kind: 'ADJUSTMENT' }))).toBe(false);
    expect(isRealignmentSource(line({ amount: 1_00 }))).toBe(false);
  });

  it("still reads a realignment recorded under the old 'SUPPLEMENTAL' instrument", () => {
    expect(isRealignmentSource(line({ instrument: 'SUPPLEMENTAL' }))).toBe(true);
  });

  it('names the programme where the line had no object', () => {
    const s = buildFundingSources([
      line({ accountCode: '', accountName: '', fppCode: 'CO-1', fppName: 'Road, Gatuslao' }),
    ]);
    expect(s.realignment[0].classification).toBe('Road, Gatuslao');
  });
});
