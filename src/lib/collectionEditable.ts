/**
 * Whether a collection can still be corrected.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHAT DID NOT
 * ---------------------------------------------------------------------------
 * CFMS used to let only the payor's name, TIN and remarks be corrected, on the
 * principle that an official receipt issued to a citizen is not editable - it
 * is cancelled and reissued. That is the right principle for the PAPER, and it
 * was the wrong rule for the ENCODING of it: an OR number or an amount
 * mistyped at the counter could not be put right at all, and the only route
 * left was to cancel a receipt the taxpayer is holding.
 *
 * So the receipt is not what is protected. What is protected is everything
 * downstream of it:
 *
 *   A CERTIFIED REPORT HAS CLAIMED IT. The Treasurer has sworn to a list and a
 *   total, Accounting has raised an entry from it, and the figure is in the
 *   General Ledger. Editing the receipt afterwards would move a posted entry's
 *   total with nothing anywhere saying it had moved.
 *
 *   IT HAS BEEN CANCELLED. A cancellation is not undone by editing the record
 *   back into shape.
 *
 * Deliberately NOT a condition: having been deposited. A deposit says where
 * the money went, not what the receipt said, and a wrong payor name on a
 * banked receipt is exactly the sort of thing somebody notices later and
 * should be able to fix.
 *
 * ---------------------------------------------------------------------------
 * AND THE SECURITY RULES SAY THE SAME
 * ---------------------------------------------------------------------------
 * This decides what the SCREEN offers. `firestore.rules` decides what is
 * accepted, in the same two conditions, and it is the one that matters - a
 * browser can send any update it likes. If the two ever disagree the screen
 * offers an edit the database then refuses, which is a bad experience; if only
 * the screen checked, it would be no control at all.
 */

export interface EditableCollection {
  status?: string;
  /** Written by the engine when a treasury report covering it is certified. */
  treasuryReportId?: string | null;
}

export function collectionEditable(collection: EditableCollection | null | undefined): boolean {
  if (!collection) return false;
  /*
   * A report that was withdrawn sets this back to null, and a receipt it
   * released has to be editable again - otherwise withdrawing a report would
   * be a one-way door for every receipt it touched.
   */
  if (collection.treasuryReportId) return false;
  if (collection.status === 'CANCELLED') return false;
  return true;
}

/** Why it cannot be edited, for a screen that has to say so. */
export function whyNotEditable(collection: EditableCollection | null | undefined): string | null {
  if (!collection) return null;
  if (collection.treasuryReportId) {
    return 'It is on a certified report. The Treasurer has certified that total and Accounting has raised an entry from it, so the receipt behind it cannot change. Withdraw the report first if the figure is genuinely wrong.';
  }
  if (collection.status === 'CANCELLED') {
    return 'This receipt has been cancelled.';
  }
  return null;
}
