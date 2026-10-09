import { describe, it, expect } from 'vitest';
import {
  awaitingJournal,
  buildReairr,
  collectionReportAsRcd,
  type CollectionReportLike,
  type ReairrEstimate,
  type ReairrRcd,
} from './reairrReport';

const est = (over: Partial<ReairrEstimate> = {}): ReairrEstimate => ({
  accountCode: '40101010',
  accountName: 'Real Property Tax - Basic',
  incomeClass: 'REGULAR',
  annual: 5_000_000_00,
  ...over,
});

const rcd = (over: Partial<ReairrRcd> = {}): ReairrRcd => ({
  rcdNo: 'RCD-2026-0031',
  rcdDate: '2026-03-12',
  status: 'POSTED',
  accountSummary: [
    { accountCode: '40101010', accountName: 'Real Property Tax - Basic', amount: 300_000_00 },
  ],
  totalCollections: 300_000_00,
  ...over,
});

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

const build = (
  estimates: ReairrEstimate[],
  rcds: ReairrRcd[],
  over: Partial<Parameters<typeof buildReairr>[0]> = {},
) => buildReairr({ estimates, rcds, ...MARCH, ...over });

describe('Section A, the estimates', () => {
  /**
   * The whole point of the asymmetry. Instruction 2 totals Section A at the
   * END OF THE YEAR; a March filter must not cut the estimate to a quarter of
   * itself, because the Local Finance Committee never certified a March
   * estimate and CFMS must not invent one.
   */
  it('carries the whole year estimate whatever period is filtered', () => {
    const march = build([est()], []);
    const year = build([est()], [], { from: '2026-01-01', to: '2026-12-31' });
    expect(march.estimateTotal).toBe(5_000_000_00);
    expect(march.estimateTotal).toBe(year.estimateTotal);
  });

  it('spreads the estimate across the income account columns', () => {
    const r = build([est(), est({ accountCode: '40201010', annual: 800_000_00 })], []);
    expect(r.estimateByAccount).toEqual({
      '40101010': 5_000_000_00,
      '40201010': 800_000_00,
    });
    expect(r.estimateTotal).toBe(5_800_000_00);
  });

  it('leaves out an account estimated at nothing', () => {
    const r = build([est(), est({ accountCode: '40201010', annual: 0 })], []);
    expect(r.accountCodes).toEqual(['40101010']);
  });

  it('shows no estimate line at all when nothing has been loaded', () => {
    expect(build([], []).estimates).toEqual([]);
  });

  /**
   * The line is labelled with what the figures came from, not called "Annual
   * Budget" on no evidence - CFMS holds no record of which ordinance set them.
   */
  it('labels the line with the source given, and says so plainly otherwise', () => {
    expect(build([est()], []).estimates[0].particulars).toBe('Income estimates on record');
    expect(
      build([est()], [], { estimateParticulars: 'Annual Budget FY2026' }).estimates[0].particulars,
    ).toBe('Annual Budget FY2026');
  });
});

describe('Section B, the actual collections', () => {
  it('lists a report inside the period', () => {
    const r = build([], [rcd()]);
    expect(r.collections).toHaveLength(1);
    expect(r.collectionsThisPeriod).toBe(300_000_00);
    expect(r.collectionsBroughtForward).toBe(0);
  });

  /** Instruction 3's cumulative Total to Date: last month's total on the first line. */
  it('brings an earlier report forward instead of listing it', () => {
    const r = build([], [rcd({ rcdDate: '2026-01-15' })]);
    expect(r.collections).toHaveLength(0);
    expect(r.collectionsBroughtForward).toBe(300_000_00);
    expect(r.collectionsToDate).toBe(300_000_00);
  });

  it('leaves out a report dated after the period', () => {
    const r = build([], [rcd({ rcdDate: '2026-04-02' })]);
    expect(r.collectionsToDate).toBe(0);
  });

  it('adds the month to the brought-forward figure', () => {
    const r = build([], [rcd({ rcdDate: '2026-02-10', rcdNo: 'RCD-2026-0012' }), rcd()]);
    expect(r.collectionsBroughtForward).toBe(300_000_00);
    expect(r.collectionsThisPeriod).toBe(300_000_00);
    expect(r.collectionsToDate).toBe(600_000_00);
  });

  it.each(['SUBMITTED', 'VERIFIED', 'POSTED'])('counts a %s report', (status) => {
    expect(build([], [rcd({ status })]).collectionsToDate).toBe(300_000_00);
  });

  it.each(['DRAFT', 'CANCELLED'])('ignores a %s report', (status) => {
    expect(build([], [rcd({ status })]).collectionsToDate).toBe(0);
  });

  it('reads the account split off the report summary', () => {
    const r = build(
      [],
      [
        rcd({
          accountSummary: [
            { accountCode: '40101010', accountName: 'RPT Basic', amount: 200_000_00 },
            { accountCode: '40201010', accountName: 'Business Tax', amount: 100_000_00 },
          ],
        }),
      ],
    );
    expect(r.collections[0].amount).toBe(300_000_00);
    expect(r.collections[0].byAccount).toEqual({
      '40101010': 200_000_00,
      '40201010': 100_000_00,
    });
  });

  it('foots each account column to the section total', () => {
    const r = build([], [rcd(), rcd({ rcdNo: 'RCD-2026-0032', rcdDate: '2026-03-20' })]);
    const sum = Object.values(r.collectionsThisPeriodByAccount).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.collectionsThisPeriod);
  });

  it('carries the brought-forward split into the accumulated split', () => {
    const r = build([], [rcd({ rcdDate: '2026-01-05' }), rcd()]);
    expect(r.collectionsToDateByAccount['40101010']).toBe(600_000_00);
  });

  it('lists reports by date, then by number', () => {
    const r = build(
      [],
      [
        rcd({ rcdDate: '2026-03-20', rcdNo: 'RCD-2026-0040' }),
        rcd({ rcdDate: '2026-03-04', rcdNo: 'RCD-2026-0022' }),
        rcd({ rcdDate: '2026-03-04', rcdNo: 'RCD-2026-0021' }),
      ],
    );
    expect(r.collections.map((e) => e.reference)).toEqual([
      'RCD-2026-0021',
      'RCD-2026-0022',
      'RCD-2026-0040',
    ]);
  });
});

describe('the columns', () => {
  /**
   * An account that was estimated but never collected, and one collected but
   * never estimated, both have to appear - the first is the shortfall the
   * Finance Committee is asked about, the second is income nobody budgeted.
   */
  it('heads a column for every account on either side', () => {
    const r = build(
      [est({ accountCode: '40101010' })],
      [
        rcd({
          accountSummary: [
            { accountCode: '40606010', accountName: 'Miscellaneous Income', amount: 5_000_00 },
          ],
        }),
      ],
    );
    expect(r.accountCodes).toEqual(['40101010', '40606010']);
  });

  it('keeps the account names it was given, from either side', () => {
    const r = build([est()], [rcd()]);
    expect(r.accountNames['40101010']).toBe('Real Property Tax - Basic');
  });
});

describe('the shortfall', () => {
  it('is the estimate less everything collected to date', () => {
    const r = build([est()], [rcd({ rcdDate: '2026-01-10' }), rcd()]);
    expect(r.collectionsToDate).toBe(600_000_00);
    expect(r.shortfall).toBe(4_400_000_00);
    expect(r.shortfallByAccount['40101010']).toBe(4_400_000_00);
  });

  /**
   * Over-collection is reported as a negative shortfall rather than clamped to
   * zero. It is the figure a supplemental budget is argued from, and hiding it
   * would leave the Committee with no evidence for one.
   */
  it('goes negative when more was collected than estimated', () => {
    const r = build([est({ annual: 100_000_00 })], [rcd()]);
    expect(r.shortfall).toBe(-200_000_00);
  });

  it('shows an unbudgeted account as a negative shortfall of its own', () => {
    const r = build(
      [],
      [
        rcd({
          accountSummary: [
            { accountCode: '40606010', accountName: 'Miscellaneous Income', amount: 5_000_00 },
          ],
        }),
      ],
    );
    expect(r.shortfallByAccount['40606010']).toBe(-5_000_00);
  });
});

/** Patch 131: the reports made on the Treasury Reports screen. */
describe('collection reports from the Treasury Reports screen', () => {
  const report = (over: Partial<CollectionReportLike> = {}): CollectionReportLike => ({
    reportType: 'RCD',
    reportNo: '111',
    reportDate: '2026-10-07',
    status: 'JOURNALIZED',
    totalAmount: 2_00,
    entry: [
      { accountCode: '10101010', accountName: 'Cash - Local Treasury', debit: 2_00, credit: 0 },
      { accountCode: '40102010', accountName: 'Business Tax', debit: 0, credit: 2_00 },
    ],
    ...over,
  });

  it('counts a journalized RCD, by the accounts its entry credits', () => {
    const rcdLine = collectionReportAsRcd(report())!;
    expect(rcdLine.accountSummary).toEqual([
      { accountCode: '40102010', accountName: 'Business Tax', amount: 2_00 },
    ]);
    const r = buildReairr({
      estimates: [],
      rcds: [rcdLine],
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(r.collectionsThisPeriod).toBe(2_00);
    expect(r.collections[0].reference).toBe('111');
  });

  it('does not count a certified report until it is journalized, and names it', () => {
    const certified = report({ status: 'CERTIFIED' });
    const r = buildReairr({
      estimates: [],
      rcds: [collectionReportAsRcd(certified)!],
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(r.collectionsToDate).toBe(0);
    expect(awaitingJournal([certified])).toEqual({ count: 1, total: 2_00, numbers: ['111'] });
  });

  it('reads the e-collection reports and ignores the payment reports', () => {
    expect(collectionReportAsRcd(report({ reportType: 'ERCD_EOR' }))?.particulars).toMatch(
      /e-Collections/,
    );
    expect(collectionReportAsRcd(report({ reportType: 'RCI' }))).toBeNull();
  });
});
