/**
 * The columns of a journal entry grid, in order.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORDER IS WHAT IT IS
 * ---------------------------------------------------------------------------
 * Account, what it was for, how much - and only then the two classifications:
 * who the line is traced to, and which budget line it is charged against.
 *
 * It used to run Account, Budget line, Subsidiary, Particulars, Debit, Credit,
 * which put two long dropdowns between the account and its own figures. On a
 * voucher with four lines the amounts were off the right-hand edge, so the one
 * thing the Accountant is checking - does this balance - needed a sideways
 * scroll to see.
 *
 * The trailing order is also the order the columns are FILLED in. An encoder
 * knows the account and the amount before they know which budget line the
 * Budget Office wants it against.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT IS A LIST RATHER THAN JSX
 * ---------------------------------------------------------------------------
 * The totals row has to span exactly the columns before Debit and exactly the
 * ones after Credit, and both counts depend on which optional columns are
 * showing. That arithmetic has been wrong once already - the budget line
 * column was missed, so on an entry that charged one, "Total" sat a column to
 * the left of its own figures.
 *
 * Counting from the same list the header is built from makes the two
 * impossible to disagree, and makes the counting testable without rendering
 * anything.
 */

export interface EntryGridLayout {
  /** Column keys, in display order. */
  keys: string[];
  /** Columns before Debit: what the "Total" label spans. */
  leading: number;
  /** Columns after Credit, excluding the row-delete column. */
  trailing: number;
}

export function entryGridColumns(opts: {
  showParticulars: boolean;
  /** The budget line column appears only where budget lines are offered. */
  withFpp: boolean;
}): EntryGridLayout {
  const keys = [
    'lineNo',
    'account',
    ...(opts.showParticulars ? ['particulars'] : []),
    'debit',
    'credit',
    'subsidiary',
    ...(opts.withFpp ? ['fpp'] : []),
  ];

  const debitAt = keys.indexOf('debit');
  return {
    keys,
    leading: debitAt,
    trailing: keys.length - keys.indexOf('credit') - 1,
  };
}
