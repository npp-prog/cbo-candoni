import { describe, expect, it } from 'vitest';
import { matchECollectionCredit, type ECollectionReport } from './eCollectionMatch';

const reports: ECollectionReport[] = [
  {
    id: 'r1',
    reportNo: 'ERCD-2026-10-007',
    date: '2026-10-05',
    amount: 150_000,
    lines: [
      { sourceId: 'c1', sourceNo: 'EOR-000451', date: '2026-10-03', amount: 100_000 },
      { sourceId: 'c2', sourceNo: 'EOR-000452', date: '2026-10-04', amount: 50_000 },
    ],
  },
];

describe('matchECollectionCredit (patch 159)', () => {
  it('matches the receipt number and amount', () => {
    const used = new Set<string>();
    const m = matchECollectionCredit(
      { text: 'IBFT CR REF EOR000452', amount: 50_000, date: '2026-10-04' },
      reports,
      used,
    );
    expect(m).toMatchObject({ status: 'MATCHED', type: 'COLLECTION', id: 'c2' });
    expect(used.has('C:c2')).toBe(true);
  });

  it('matches a batch remittance to the eRCD by number and total', () => {
    const m = matchECollectionCredit(
      { text: 'REMIT ERCD-2026-10-007 GCASH', amount: 150_000, date: '2026-10-06' },
      reports,
      new Set(),
    );
    expect(m).toMatchObject({ status: 'MATCHED', type: 'ERCD', id: 'r1' });
  });

  it('matches the only one of that amount within 5 days', () => {
    expect(
      matchECollectionCredit(
        { text: 'CREDIT', amount: 100_000, date: '2026-10-06' },
        reports,
        new Set(),
      ),
    ).toMatchObject({ status: 'MATCHED', type: 'COLLECTION', id: 'c1', confidence: 0.9 });
    expect(
      matchECollectionCredit(
        { text: 'CREDIT', amount: 150_000, date: '2026-10-06' },
        reports,
        new Set(),
      ),
    ).toMatchObject({ status: 'MATCHED', type: 'ERCD', id: 'r1' });
  });

  it('only suggests when two are alike, and never matches one twice', () => {
    const twin: ECollectionReport[] = [
      {
        ...reports[0],
        lines: [...reports[0].lines, { sourceId: 'c3', sourceNo: 'EOR-9', amount: 50_000 }],
      },
    ];
    expect(
      matchECollectionCredit({ text: 'CR', amount: 50_000, date: '2026-10-05' }, twin, new Set()),
    ).toMatchObject({ status: 'SUGGESTED' });
    const used = new Set<string>(['C:c1']);
    expect(
      matchECollectionCredit({ text: 'CR', amount: 100_000, date: '2026-10-05' }, reports, used),
    ).toBeNull();
    expect(
      matchECollectionCredit(
        { text: 'CR', amount: 100_000, date: '2026-11-30' },
        reports,
        new Set(),
      ),
    ).toBeNull();
  });
});
