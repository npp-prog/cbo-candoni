import { describe, it, expect } from 'vitest';
import { postingFromPreparedSet, preparedSetId } from './preparedSets';

/**
 * Approving a prepared augmentation or realignment posts what the STORED set
 * says. These are the rules for reading it. Patch 112.
 */
const set = (over: Record<string, unknown> = {}) => ({
  fiscalYear: 2026,
  fundCode: 'GF',
  instrument: 'REALIGNMENT',
  authorityReference: 'Ord. No. 2026-14',
  authorityDate: '2026-10-08',
  status: 'DRAFT',
  lines: [
    {
      officeName: 'Office of the Municipal Mayor',
      fppCode: '50203010',
      accountCode: '50203010',
      sector: 'General Public Services',
      serviceSector: '',
      expenseClass: 'MOOE',
      amount: -10_000_00,
      particulars: ' savings ',
    },
    {
      officeName: 'Office of the Municipal Engineer',
      fppCode: 'Road repair, Gatuslao',
      accountCode: '',
      sector: 'Economic Services',
      expenseClass: 'CO',
      amount: 10_000_00,
    },
  ],
  ...over,
});

describe('postingFromPreparedSet', () => {
  it('reads a realignment, with everything from the set and nothing from elsewhere', () => {
    const p = postingFromPreparedSet(set());
    expect(p.appropriationKind).toBe('REALIGNMENT');
    expect(p.instrument).toBe('REALIGNMENT');
    expect(p.reference).toBe('Ord. No. 2026-14');
    expect(p.date).toBe('2026-10-08');
    expect(p.fiscalYear).toBe(2026);
    expect(p.rows.map((r) => r.amount)).toEqual([-10_000_00, 10_000_00]);
    expect(p.rows.map((r) => r.lineNo)).toEqual([1, 2]);
  });

  it('keeps a programme line without an object code', () => {
    const p = postingFromPreparedSet(set());
    expect(p.rows[1].accountCode).toBeUndefined();
    expect(p.rows[1].fpp).toBe('Road repair, Gatuslao');
    expect(p.rows[0].particulars).toBe('savings');
    expect(p.rows[0].serviceSector).toBeUndefined();
  });

  it('reads an augmentation the same way', () => {
    expect(postingFromPreparedSet(set({ instrument: 'augmentation' })).instrument).toBe(
      'AUGMENTATION',
    );
  });

  it('refuses a set that is not waiting', () => {
    expect(() => postingFromPreparedSet(set({ status: 'APPROVED' }))).toThrow(/not waiting/);
  });

  it('refuses a set that does not say which act it is', () => {
    expect(() => postingFromPreparedSet(set({ instrument: '' }))).toThrow(
      /augmentation or a realignment/,
    );
  });

  it('refuses a set with no authority, which is also its guard against posting twice', () => {
    expect(() => postingFromPreparedSet(set({ authorityReference: '  ' }))).toThrow(/authority/);
  });

  it('refuses a set with no lines', () => {
    expect(() => postingFromPreparedSet(set({ lines: [] }))).toThrow(/no lines/);
  });
});

describe('preparedSetId', () => {
  it('is the same for the same file, so it cannot be prepared twice', () => {
    expect(preparedSetId(2026, 'GF', 'REALIGNMENT', 'ORD-NO-2026-14')).toBe(
      preparedSetId(2026, 'GF', 'REALIGNMENT', 'ORD-NO-2026-14'),
    );
    expect(preparedSetId(2026, 'GF', 'REALIGNMENT', 'X')).not.toBe(
      preparedSetId(2026, 'GF', 'AUGMENTATION', 'X'),
    );
  });
});
