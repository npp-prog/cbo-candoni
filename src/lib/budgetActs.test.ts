import { describe, it, expect } from 'vitest';
import {
  actId,
  actKindOfLine,
  actsLeftUnfunded,
  coverEncoded,
  coverOriginal,
  coverShortfall,
  fundingBasis,
  sectionsFinancing,
} from './budgetActs';

/** Patch 123: every act needs its sources. */
describe('acts', () => {
  it('names an augmentation line as an augmentation, and leaves corrections ungated', () => {
    expect(actKindOfLine({ kind: 'REALIGNMENT', instrument: 'AUGMENTATION' })).toBe('AUGMENTATION');
    expect(actKindOfLine({ kind: 'REALIGNMENT', instrument: 'SUPPLEMENTAL' })).toBe('REALIGNMENT');
    expect(actKindOfLine({ kind: 'SUPPLEMENTAL' })).toBe('SUPPLEMENTAL');
    expect(actKindOfLine({ kind: 'ADJUSTMENT' })).toBeNull();
  });

  it('keys an act on year, fund, kind and number', () => {
    expect(
      actId({
        fiscalYear: 2026,
        fundCode: 'GF',
        kind: 'AUGMENTATION',
        reference: 'Office Order No. 2026-03',
      }),
    ).toBe('2026__GF__AUGMENTATION__OFFICE-ORDER-NO-2026-03');
  });

  it('knows what finances each act', () => {
    expect(fundingBasis('ORIGINAL')).toBe('ESTIMATED_REVENUE');
    expect(sectionsFinancing('SUPPLEMENTAL')).toEqual([
      'NEW_REVENUE',
      'EXCESS_COLLECTION',
      'SAVINGS',
    ]);
    expect(sectionsFinancing('CONTINUING')).toEqual(['CONTINUING']);
    expect(fundingBasis('REALIGNMENT')).toBe('OWN_LINES');
    expect(fundingBasis('AUGMENTATION')).toBe('OWN_LINES');
  });
});

describe('coverOriginal', () => {
  it('holds the original budget within the estimated revenue', () => {
    expect(coverOriginal({ estimated: 100_00, approvedOriginal: 60_00, adding: 40_00 }).ok).toBe(
      true,
    );
    expect(coverOriginal({ estimated: 100_00, approvedOriginal: 60_00, adding: 40_01 }).ok).toBe(
      false,
    );
  });
  it('refuses when no estimate is recorded', () => {
    const c = coverOriginal({ estimated: 0, approvedOriginal: 0, adding: 1 });
    expect(c.ok).toBe(false);
    expect(coverShortfall('ORIGINAL', 'Ord. 1', c)).toMatch(/no Estimated Revenue/);
  });
});

describe('coverEncoded', () => {
  const A = 'A';
  const B = 'B';

  it('finances an act from the sources encoded in it', () => {
    const c = coverEncoded({
      kind: 'SUPPLEMENTAL',
      actId: A,
      sources: [{ section: 'NEW_REVENUE', amount: 50_00, actId: A }],
      approvedByAct: new Map(),
      adding: 50_00,
    });
    expect(c).toMatchObject({ ok: true, own: 50_00, open: 0 });
  });

  it('draws on the open sources for what its own do not cover', () => {
    const c = coverEncoded({
      kind: 'SUPPLEMENTAL',
      actId: A,
      sources: [
        { section: 'NEW_REVENUE', amount: 30_00, actId: A },
        { section: 'EXCESS_COLLECTION', amount: 50_00 },
      ],
      approvedByAct: new Map(),
      adding: 80_00,
    });
    expect(c.ok).toBe(true);
    expect(c.available).toBe(80_00);
  });

  it('leaves the next act only what the earlier ones did not draw', () => {
    const sources = [{ section: 'EXCESS_COLLECTION', amount: 100_00 }];
    const approved = new Map([[A, 70_00]]);
    expect(
      coverEncoded({
        kind: 'SUPPLEMENTAL',
        actId: B,
        sources,
        approvedByAct: approved,
        adding: 30_00,
      }).ok,
    ).toBe(true);
    expect(
      coverEncoded({
        kind: 'SUPPLEMENTAL',
        actId: B,
        sources,
        approvedByAct: approved,
        adding: 30_01,
      }).ok,
    ).toBe(false);
  });

  it("never lets one act take another's own sources", () => {
    const c = coverEncoded({
      kind: 'SUPPLEMENTAL',
      actId: B,
      sources: [{ section: 'NEW_REVENUE', amount: 100_00, actId: A }],
      approvedByAct: new Map(),
      adding: 1_00,
    });
    expect(c.ok).toBe(false);
  });

  it('counts only the sections that finance the kind', () => {
    const c = coverEncoded({
      kind: 'CONTINUING',
      actId: A,
      sources: [{ section: 'NEW_REVENUE', amount: 100_00 }],
      approvedByAct: new Map(),
      adding: 1_00,
    });
    expect(c.ok).toBe(false);
    expect(coverShortfall('CONTINUING', 'Cont. 2025', c)).toMatch(/Continuing sources/);
  });

  it('counts what the act already has approved', () => {
    const c = coverEncoded({
      kind: 'SUPPLEMENTAL',
      actId: A,
      sources: [{ section: 'NEW_REVENUE', amount: 100_00, actId: A }],
      approvedByAct: new Map([[A, 90_00]]),
      adding: 20_00,
    });
    expect(c).toMatchObject({ ok: false, needed: 110_00 });
  });
});

describe('actsLeftUnfunded', () => {
  it('names the approved act a deleted source would strand', () => {
    const approved = new Map([['A', 80_00]]);
    expect(
      actsLeftUnfunded({
        kind: 'SUPPLEMENTAL',
        sources: [{ section: 'EXCESS_COLLECTION', amount: 80_00 }],
        approvedByAct: approved,
      }),
    ).toEqual([]);
    expect(
      actsLeftUnfunded({
        kind: 'SUPPLEMENTAL',
        sources: [{ section: 'EXCESS_COLLECTION', amount: 79_99 }],
        approvedByAct: approved,
      }),
    ).toEqual(['A']);
  });
});

describe('3.0 Savings (patch 126)', () => {
  it('finances a supplemental budget when encoded', () => {
    const c = coverEncoded({
      kind: 'SUPPLEMENTAL',
      actId: 'A',
      sources: [{ section: 'SAVINGS', amount: 40_00, actId: 'A' }],
      approvedByAct: new Map(),
      adding: 40_00,
    });
    expect(c.ok).toBe(true);
  });
});
