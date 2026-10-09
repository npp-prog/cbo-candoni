import { describe, it, expect } from 'vitest';
import { ledgerRows } from './ledgerRows';
import type { Appropriation } from '@/types/budget';

const a = (over: Partial<Appropriation>): Appropriation =>
  ({
    id: Math.random().toString(36),
    fiscalYear: 2026,
    fundCode: 'GF',
    kind: 'ORIGINAL',
    status: 'APPROVED',
    officeName: 'Office of the Municipal Mayor',
    accountCode: '50203010',
    accountName: 'Office Supplies Expenses',
    fppCode: '50203010',
    fppName: 'Office Supplies Expenses',
    expenseClass: 'MOOE',
    amount: 100_000_00,
    authorityReference: '2026-01',
    authorityDate: '2026-01-01',
    ...over,
  }) as Appropriation;

/** Patch 128: a realignment or augmentation is one row per authority, net nil. */
describe('ledgerRows', () => {
  it('shows an augmentation once, with what it moved and no net effect', () => {
    const rows = ledgerRows([
      a({}),
      a({
        kind: 'REALIGNMENT',
        instrument: 'AUGMENTATION',
        authorityReference: '1',
        amount: 10_000_00,
      }),
      a({
        kind: 'REALIGNMENT',
        instrument: 'AUGMENTATION',
        authorityReference: '1',
        amount: -10_000_00,
        accountCode: '50299080',
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].lump).toMatchObject({ actKind: 'AUGMENTATION', moved: 10_000_00 });
    expect(rows[1].amount).toBe(0);
    expect(rows[1].lump!.lines).toHaveLength(2);
  });

  it('keeps a realignment and an augmentation of the same number apart, and appropriations as they are', () => {
    const rows = ledgerRows([
      a({ kind: 'REALIGNMENT', instrument: 'REALIGNMENT', authorityReference: '7', amount: 5_00 }),
      a({ kind: 'REALIGNMENT', instrument: 'AUGMENTATION', authorityReference: '7', amount: 5_00 }),
      a({ kind: 'SUPPLEMENTAL', authorityReference: '7' }),
    ]);
    expect(rows.map((r) => r.lump?.actKind ?? r.kind)).toEqual([
      'REALIGNMENT',
      'AUGMENTATION',
      'SUPPLEMENTAL',
    ]);
  });

  it('names every office it touched', () => {
    const rows = ledgerRows([
      a({
        kind: 'REALIGNMENT',
        instrument: 'REALIGNMENT',
        authorityReference: '14',
        amount: -5_00,
      }),
      a({
        kind: 'REALIGNMENT',
        instrument: 'REALIGNMENT',
        authorityReference: '14',
        amount: 5_00,
        officeName: 'Office of the Municipal Engineer',
      }),
    ]);
    expect(rows[0].officeName).toBe(
      'Office of the Municipal Mayor, Office of the Municipal Engineer',
    );
  });
});
