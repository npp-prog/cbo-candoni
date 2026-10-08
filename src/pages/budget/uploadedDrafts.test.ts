import { describe, it, expect } from 'vitest';
import { uploadedDrafts } from './uploadedDrafts';
import type { Appropriation } from '@/types/budget';

const a = (over: Partial<Appropriation>): Appropriation =>
  ({
    id: 'x',
    kind: 'ORIGINAL',
    status: 'DRAFT',
    amount: 100,
    importReference: 'Ord. No. 2026-01',
    importFileName: 'ab2026.xlsx',
    ...over,
  }) as Appropriation;

describe('uploadedDrafts', () => {
  it('gathers the draft lines of each upload, with their total', () => {
    const groups = uploadedDrafts([
      a({ id: '1', amount: 100 }),
      a({ id: '2', amount: 250 }),
      a({ id: '3', importReference: 'Ord. No. 2026-07', kind: 'SUPPLEMENTAL', amount: 5 }),
    ]);
    expect(groups.map((g) => [g.reference, g.ids.length, g.total])).toEqual([
      ['Ord. No. 2026-01', 2, 350],
      ['Ord. No. 2026-07', 1, 5],
    ]);
    expect(groups[0].fileName).toBe('ab2026.xlsx');
  });

  it('leaves out approved lines and lines typed on the screen', () => {
    expect(uploadedDrafts([a({ status: 'APPROVED' }), a({ importReference: null })])).toEqual([]);
  });
});
