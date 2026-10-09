import { describe, it, expect } from 'vitest';
import { buildFundingSources, buildSourceRegister, isRealignmentSource, sourcesForAct } from './fundingSources';

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

  it('leaves an augmentation off the form - it is not part of a supplemental budget (patch 126)', () => {
    const s = buildFundingSources([line({ instrument: 'AUGMENTATION', amount: -4_000_00 })]);
    expect(s.savings).toHaveLength(0);
    expect(s.total).toBe(0);
  });

  it('fills 1.0 and 2.0 from the sources encoded (patch 123)', () => {
    const s = buildFundingSources(
      [line({})],
      [
        {
          section: 'NEW_REVENUE',
          particulars: 'Tax Revenue',
          accountCode: '40101010',
          accountName: 'RPT',
          amount: 1_000_00,
        },
        {
          section: 'EXCESS_COLLECTION',
          particulars: 'Excess collection FY 2025',
          amount: 2_000_00,
        },
        { section: 'CONTINUING', particulars: 'Not on this form', amount: 9_000_00 },
      ],
    );
    expect(s.newRevenue[0].classification).toBe('40101010 - RPT');
    expect(s.excess[0]).toMatchObject({
      particulars: 'Excess collection FY 2025',
      classification: '',
    });
    expect(s.total).toBe(1_000_00 + 2_000_00 + 10_000_00);
  });

  it('fills 3.0 from the savings encoded (patch 126)', () => {
    const s = buildFundingSources(
      [],
      [{ section: 'SAVINGS', particulars: 'Savings, MOOE FY 2026', amount: 7_00 }],
    );
    expect(s.savings[0]).toMatchObject({ particulars: 'Savings, MOOE FY 2026', amount: 7_00 });
    expect(s.total).toBe(7_00);
  });

  it('lists every source in the register, numbered, with where it came from (patch 126)', () => {
    const r = buildSourceRegister(
      [
        line({ authorityReference: 'Ord. 14' }),
        line({ authorityReference: 'Ord. 14', amount: -1_00 }),
      ],
      [
        {
          id: 'b',
          section: 'SAVINGS',
          particulars: 'Savings',
          amount: 3_00,
          actReference: 'Ord. 7',
        },
        { id: 'a', section: 'NEW_REVENUE', particulars: 'Tax', amount: 1_00 },
        { id: 'c', section: 'CONTINUING', particulars: 'Not supplemental', amount: 9_00 },
      ],
    );
    expect(r.map((x) => x.number)).toEqual(['1.0', '3.0', '4.0']);
    expect(r[0]).toMatchObject({ encodedIn: null, sourceId: 'a' });
    expect(r[2]).toMatchObject({ encodedIn: 'Ord. 14', amount: 10_001_00, sourceId: null });
  });
});

describe('one supplemental ordinance\'s Form 8 (patch 129)', () => {
  const sources = [
    { section: 'SAVINGS', particulars: 'Own savings', amount: 20_00, actId: 'A' },
    { section: 'EXCESS_COLLECTION', particulars: 'Open excess', amount: 50_00, actId: null },
    { section: 'NEW_REVENUE', particulars: 'Open tax', amount: 10_00, actId: null },
    { section: 'NEW_REVENUE', particulars: 'Another act', amount: 99_00, actId: 'B' },
    { section: 'CONTINUING', particulars: 'Not supplemental', amount: 99_00, actId: null },
  ];

  it('takes its own sources, then the open ones in the form\'s order, only as far as it needs', () => {
    const r = sourcesForAct({ actId: 'A', sources, needed: 45_00, openAvailable: 60_00 });
    expect(r.map((s) => [s.particulars, s.amount])).toEqual([
      ['Own savings', 20_00],
      ['Open tax', 10_00],
      ['Open excess (part)', 15_00],
    ]);
    expect(buildFundingSources([], r).total).toBe(45_00);
  });

  it('draws no more than is left of the open sources', () => {
    const r = sourcesForAct({ actId: 'A', sources, needed: 1_000_00, openAvailable: 5_00 });
    expect(r.reduce((t, s) => t + s.amount, 0)).toBe(25_00);
  });
});
