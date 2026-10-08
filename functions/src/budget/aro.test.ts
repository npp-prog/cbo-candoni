import { describe, it, expect } from 'vitest';
import { parseAroOrder } from './aro';

/**
 * Reading an Allotment Release Order on its face.
 *
 * `approveAro` reads the PREPARED order from the database and passes it here
 * before anything is read from the books, so this is the first thing that
 * stands between a prepared order and released authority. It was written as
 * part of the old one-press `issueAro` and never had a test of its own; the
 * server suite is the thin one in this project, and this is the part of it
 * that decides what an order may say.
 */
const order = (over: Record<string, unknown> = {}) => ({
  fiscalYear: 2026,
  fundCode: 'GF',
  expenseClass: 'MOOE',
  purpose: 'Q4 release, MOOE',
  date: '2026-10-01',
  lines: [
    { officeId: 'mayor', fppCode: '50203010', accountCode: '50203010', amount: 100000, forLaterRelease: 0 },
  ],
  ...over,
});

describe('parseAroOrder', () => {
  it('reads a sound order', () => {
    const o = parseAroOrder(order());
    expect(o.expenseClass).toBe('MOOE');
    expect(o.entries).toHaveLength(1);
    expect(o.entries[0].amount).toBe(100000);
  });

  it('upper-cases the expense class, since the form is chosen by it', () => {
    expect(parseAroOrder(order({ expenseClass: 'co' })).expenseClass).toBe('CO');
  });

  /**
   * Two lines on one budget line are summed BEFORE the books are read. Per row,
   * each would read the same balance and the last write would win - the line
   * would carry one row's release and the office would be short by the other's,
   * with nothing to say so.
   */
  it('sums two lines that fall on the same budget line', () => {
    const line = { officeId: 'mayor', fppCode: '50203010', accountCode: '50203010', forLaterRelease: 0 };
    const o = parseAroOrder(
      order({ lines: [{ ...line, amount: 100000 }, { ...line, amount: 50000, forLaterRelease: 2000 }] }),
    );
    expect(o.entries).toHaveLength(1);
    expect(o.entries[0].amount).toBe(150000);
    expect(o.entries[0].forLaterRelease).toBe(2000);
    expect(o.entries[0].indexes).toEqual([1, 2]);
  });

  it('keeps a programme line - no object code - as its own budget line', () => {
    const o = parseAroOrder(
      order({
        expenseClass: 'CO',
        lines: [{ officeId: 'mayor', fppCode: '01', accountCode: '', amount: 500000, forLaterRelease: 0 }],
      }),
    );
    expect(o.entries[0].key.accountCode).toBe('');
    expect(o.entries[0].key.fppCode).toBe('01');
  });

  it('refuses a negative line - an order releases, a withdrawal is recorded on its own', () => {
    expect(() =>
      parseAroOrder(
        order({ lines: [{ officeId: 'mayor', fppCode: 'x', accountCode: 'x', amount: -1, forLaterRelease: 0 }] }),
      ),
    ).toThrow(/negative/);
  });

  it('refuses a line that releases nothing and holds nothing', () => {
    expect(() =>
      parseAroOrder(
        order({ lines: [{ officeId: 'mayor', fppCode: 'x', accountCode: 'x', amount: 0, forLaterRelease: 0 }] }),
      ),
    ).toThrow(/releases nothing/);
  });

  it('refuses an order with no purpose - it is printed on the face of the ARO', () => {
    expect(() => parseAroOrder(order({ purpose: '   ' }))).toThrow(/purpose/);
  });

  it('refuses an expense class the manual has no form for', () => {
    expect(() => parseAroOrder(order({ expenseClass: 'XX' }))).toThrow(/one expense class/);
  });

  it('refuses an order with no lines, and one longer than 200', () => {
    expect(() => parseAroOrder(order({ lines: [] }))).toThrow(/no lines/);
    const many = Array.from({ length: 201 }, (_, i) => ({
      officeId: 'mayor', fppCode: `f${i}`, accountCode: `f${i}`, amount: 1, forLaterRelease: 0,
    }));
    expect(() => parseAroOrder(order({ lines: many }))).toThrow(/at most 200/);
  });

  it('refuses a line that names no budget line', () => {
    expect(() =>
      parseAroOrder(order({ lines: [{ officeId: '', fppCode: '', amount: 1, forLaterRelease: 0 }] })),
    ).toThrow(/does not name an office/);
  });
});
