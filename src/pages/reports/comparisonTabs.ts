/**
 * The two ways of putting the budget beside what happened.
 *
 * The statement is GAM Annex 8 - the form that is submitted, with its five
 * columns and its sector-by-expense-class shape. The comparison is CFMS's own
 * control report: the budget module beside the general ledger, line by line,
 * which is the screen that finds a disagreement between the two records.
 *
 * Both are needed and they are not the same thing, so they are tabs on one
 * menu item rather than two entries that read alike.
 */
export const COMPARISON_TABS = [
  { label: 'Statement (Annex 8)', to: '/reports/budget-vs-actual' },
  { label: 'By budget line', to: '/reports/budget-vs-actual/lines' },
];
