import { describe, it, expect } from 'vitest';
import { collectionEditable, whyNotEditable } from './collectionEditable';

/**
 * The two conditions, and the ones that deliberately are not conditions.
 *
 * `firestore.rules` enforces the same two on the collections document. This
 * decides what the screen OFFERS; the rules decide what is accepted, and they
 * are the ones that matter. If the two disagree the screen offers an edit the
 * database then refuses.
 */
describe('collectionEditable', () => {
  it('allows a receipt nothing has claimed yet', () => {
    expect(collectionEditable({ status: 'ISSUED' })).toBe(true);
  });

  it('refuses one a certified report has claimed', () => {
    // The Treasurer has sworn to that total and Accounting has raised an entry
    // from it. Editing the receipt would move a posted entry with nothing
    // saying it had moved.
    expect(collectionEditable({ status: 'ISSUED', treasuryReportId: 'rep1' })).toBe(false);
    expect(whyNotEditable({ status: 'ISSUED', treasuryReportId: 'rep1' })).toContain(
      'certified report',
    );
  });

  it('allows one again after its report is withdrawn', () => {
    // Withdrawing a report sets the field back to null. If a null still
    // counted as claimed, withdrawing would be a one-way door for every
    // receipt the report touched.
    expect(collectionEditable({ status: 'ISSUED', treasuryReportId: null })).toBe(true);
  });

  it('refuses a cancelled receipt', () => {
    // A cancellation is not undone by editing the record back into shape.
    expect(collectionEditable({ status: 'CANCELLED' })).toBe(false);
    expect(whyNotEditable({ status: 'CANCELLED' })).toContain('cancelled');
  });

  it('still allows one that has been deposited', () => {
    // Deliberately not a condition. A deposit says where the money went, not
    // what the receipt said, and a wrong payor name on a banked receipt is
    // exactly what somebody notices later and should be able to fix.
    expect(collectionEditable({ status: 'DEPOSITED' })).toBe(true);
    expect(collectionEditable({ status: 'IN_RCD' })).toBe(true);
  });

  it('refuses nothing at all', () => {
    expect(collectionEditable(null)).toBe(false);
    expect(collectionEditable(undefined)).toBe(false);
    expect(whyNotEditable(null)).toBeNull();
  });

  it('gives no reason when it is editable', () => {
    expect(whyNotEditable({ status: 'ISSUED' })).toBeNull();
  });
});
