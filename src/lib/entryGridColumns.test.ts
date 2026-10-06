import { describe, it, expect } from 'vitest';
import { entryGridColumns } from './entryGridColumns';

/**
 * The totals row has to sit under its own figures.
 *
 * It did not, once: the budget line column was left out of the count, so on an
 * entry that charged a budget line - which is most of them - "Total" sat one
 * column to the left of the Debit and Credit it added up. Nothing failed; the
 * numbers were right and in the wrong place.
 */
describe('entryGridColumns', () => {
  it('puts the amounts next to the account, and the classifications after', () => {
    expect(entryGridColumns({ showParticulars: true, withFpp: true }).keys).toEqual([
      'lineNo',
      'account',
      'particulars',
      'debit',
      'credit',
      'subsidiary',
      'fpp',
    ]);
  });

  it('spans exactly the columns before Debit', () => {
    // #, Account, Particulars
    expect(entryGridColumns({ showParticulars: true, withFpp: true }).leading).toBe(3);
    // #, Account
    expect(entryGridColumns({ showParticulars: false, withFpp: true }).leading).toBe(2);
  });

  it('spans exactly the columns after Credit', () => {
    // Subsidiary, Budget line
    expect(entryGridColumns({ showParticulars: true, withFpp: true }).trailing).toBe(2);
    // Subsidiary alone
    expect(entryGridColumns({ showParticulars: true, withFpp: false }).trailing).toBe(1);
  });

  /*
   * The property that actually matters, stated once for every combination:
   * everything before Debit, plus Debit and Credit themselves, plus everything
   * after Credit, is the whole row.
   */
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('accounts for every column (particulars=%s, fpp=%s)', (showParticulars, withFpp) => {
    const l = entryGridColumns({ showParticulars, withFpp });
    expect(l.leading + 2 + l.trailing).toBe(l.keys.length);
  });
});
