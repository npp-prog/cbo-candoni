import { describe, it, expect } from 'vitest';
import { actReadiness, lineBelongsTo, ordinanceId, setBelongsTo, summariseOrdinance } from './ordinanceModel';
import type { Appropriation, AugmentationDraft, Ordinance } from '@/types/budget';

const ord = (over: Partial<Ordinance> = {}): Ordinance => ({
  id: 'x',
  fiscalYear: 2026,
  fundCode: 'GF',
  kind: 'ORIGINAL',
  reference: 'Ord. No. 2026-01',
  date: '2026-01-02',
  ...over,
});

const line = (over: Partial<Appropriation> = {}): Appropriation =>
  ({
    id: 'l',
    fiscalYear: 2026,
    fundCode: 'GF',
    kind: 'ORIGINAL',
    authorityReference: 'Ord. No. 2026-01',
    amount: 100_00,
    status: 'DRAFT',
    ...over,
  }) as Appropriation;

describe('ordinanceId', () => {
  it('is the same for the same ordinance, however the number is spaced', () => {
    expect(
      ordinanceId({
        fiscalYear: 2026,
        fundCode: 'GF',
        kind: 'ORIGINAL',
        reference: 'Ord. No. 2026-01',
      }),
    ).toBe(
      ordinanceId({
        fiscalYear: 2026,
        fundCode: 'GF',
        kind: 'ORIGINAL',
        reference: '  ord. no. 2026-01 ',
      }),
    );
  });

  it('differs by year, fund and kind', () => {
    const base = { fiscalYear: 2026, fundCode: 'GF', kind: 'ORIGINAL', reference: 'X' };
    expect(ordinanceId(base)).not.toBe(ordinanceId({ ...base, kind: 'SUPPLEMENTAL' }));
    expect(ordinanceId(base)).not.toBe(ordinanceId({ ...base, fundCode: 'SEF' }));
  });
});

describe('lineBelongsTo', () => {
  it('is true of a line of the same year, fund and kind naming the ordinance', () => {
    expect(lineBelongsTo(line(), ord())).toBe(true);
  });

  it('is false across kinds, and for a cancelled line', () => {
    expect(lineBelongsTo(line({ kind: 'SUPPLEMENTAL' }), ord())).toBe(false);
    expect(lineBelongsTo(line({ status: 'CANCELLED' }), ord())).toBe(false);
    expect(lineBelongsTo(line({ authorityReference: 'Ord. No. 2026-02' }), ord())).toBe(false);
  });
});

describe('summariseOrdinance', () => {
  it('reads the stage from the lines: nothing, drafts, partly, approved', () => {
    expect(summariseOrdinance(ord(), [], []).stage).toBe('EMPTY');
    expect(summariseOrdinance(ord(), [line()], []).stage).toBe('DRAFT');
    expect(
      summariseOrdinance(ord(), [line(), line({ id: 'b', status: 'APPROVED' })], []).stage,
    ).toBe('PARTLY');
    expect(summariseOrdinance(ord(), [line({ status: 'APPROVED' })], []).stage).toBe('APPROVED');
  });

  it('totals what is approved and what still waits', () => {
    const s = summariseOrdinance(
      ord(),
      [line({ amount: 100_00 }), line({ id: 'b', amount: 250_00, status: 'APPROVED' })],
      [],
    );
    expect(s.draftTotal).toBe(100_00);
    expect(s.approvedTotal).toBe(250_00);
    expect(s.waitingCount).toBe(1);
  });

  it('counts a prepared realignment set as the ordinance waiting, on its positive side', () => {
    const o = ord({ kind: 'REALIGNMENT', reference: 'Ord. No. 2026-14' });
    const set = {
      id: 's',
      fiscalYear: 2026,
      fundCode: 'GF',
      instrument: 'REALIGNMENT',
      authorityReference: 'Ord. No. 2026-14',
      authorityDate: '2026-10-01',
      status: 'DRAFT',
      lines: [{ amount: -30_00 }, { amount: 30_00 }],
    } as AugmentationDraft;
    expect(setBelongsTo(set, o)).toBe(true);
    expect(setBelongsTo({ ...set, instrument: 'AUGMENTATION' } as AugmentationDraft, o)).toBe(
      false,
    );
    const s = summariseOrdinance(o, [], [set]);
    expect(s.stage).toBe('DRAFT');
    expect(s.draftTotal).toBe(30_00);
    expect(s.waitingCount).toBe(2);
  });

  it("takes a posted realignment's positive side as what the ordinance enacted", () => {
    const o = ord({ kind: 'REALIGNMENT', reference: 'Ord. No. 2026-14' });
    const s = summariseOrdinance(
      o,
      [
        line({
          kind: 'REALIGNMENT',
          authorityReference: 'Ord. No. 2026-14',
          amount: -30_00,
          status: 'APPROVED',
        }),
        line({
          id: 'b',
          kind: 'REALIGNMENT',
          authorityReference: 'Ord. No. 2026-14',
          amount: 30_00,
          status: 'APPROVED',
        }),
      ],
      [],
    );
    expect(s.approvedTotal).toBe(30_00);
    expect(s.stage).toBe('APPROVED');
  });
});

describe('an augmentation as an act (patch 123)', () => {
  const aug = ord({ id: 'a', kind: 'AUGMENTATION', reference: 'Office Order No. 2026-03' });
  it('owns the augmentation lines and set, not a realignment of the same number', () => {
    const l = line({ kind: 'REALIGNMENT', instrument: 'AUGMENTATION', authorityReference: 'Office Order No. 2026-03' });
    expect(lineBelongsTo(l, aug)).toBe(true);
    expect(lineBelongsTo({ ...l, instrument: 'REALIGNMENT' } as Appropriation, aug)).toBe(false);
    const set = {
      fiscalYear: 2026,
      fundCode: 'GF',
      instrument: 'AUGMENTATION',
      authorityReference: 'Office Order No. 2026-03',
      lines: [],
    } as unknown as AugmentationDraft;
    expect(setBelongsTo(set, aug)).toBe(true);
    expect(setBelongsTo(set, { ...aug, kind: 'REALIGNMENT' })).toBe(false);
  });
});

describe('actReadiness (patch 123)', () => {
  it('wants the signed copy and the estimated revenue for an original budget', () => {
    const o = ord({ id: '2026__GF__ORIGINAL__ORD-NO-2026-01' });
    const lines = [line({ amount: 80_00 })];
    const summary = summariseOrdinance(o, lines, []);
    const none = actReadiness({ summary, attachmentCount: 0, appropriations: lines, sources: [], estimatedRevenue: 0 });
    expect(none.ready).toBe(false);
    expect(none.problems).toHaveLength(2);
    const ok = actReadiness({ summary, attachmentCount: 1, appropriations: lines, sources: [], estimatedRevenue: 100_00 });
    expect(ok.ready).toBe(true);
  });

  it('finances a supplemental from its own and open sources', () => {
    const o = ord({ id: 's1', kind: 'SUPPLEMENTAL', reference: 'Ord. No. 2026-07' });
    const lines = [line({ kind: 'SUPPLEMENTAL', authorityReference: 'Ord. No. 2026-07', amount: 50_00 })];
    const summary = summariseOrdinance(o, lines, []);
    const short = actReadiness({
      summary,
      attachmentCount: 1,
      appropriations: lines,
      sources: [{ section: 'NEW_REVENUE', amount: 20_00, actId: 's1' }],
      estimatedRevenue: 0,
    });
    expect(short.ready).toBe(false);
    expect(short.problems[0]).toMatch(/30\.00 more/);
    const ok = actReadiness({
      summary,
      attachmentCount: 1,
      appropriations: lines,
      sources: [
        { section: 'NEW_REVENUE', amount: 20_00, actId: 's1' },
        { section: 'EXCESS_COLLECTION', amount: 30_00 },
      ],
      estimatedRevenue: 0,
    });
    expect(ok.ready).toBe(true);
  });

  it('asks a realignment only for its signed copy - it finances itself', () => {
    const o = ord({ id: 'r', kind: 'REALIGNMENT', reference: 'Ord. No. 2026-14' });
    const lines = [
      line({ kind: 'REALIGNMENT', instrument: 'REALIGNMENT', authorityReference: 'Ord. No. 2026-14', amount: -40_00, status: 'APPROVED' }),
      line({ kind: 'REALIGNMENT', instrument: 'REALIGNMENT', authorityReference: 'Ord. No. 2026-14', amount: 40_00, status: 'APPROVED' }),
    ];
    const r = actReadiness({ summary: summariseOrdinance(o, lines, []), attachmentCount: 1, appropriations: lines, sources: [], estimatedRevenue: 0 });
    expect(r).toMatchObject({ ready: true, cover: null, takenFrom: 40_00 });
  });
});
