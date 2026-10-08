import { describe, it, expect } from 'vitest';
import {
  augmentationDraftEditable,
  aroDraftWaiting,
  appropriationEditable,
  appropriationNotEditableBecause,
  EDITABLE_APPROPRIATION_STATUS,
} from './budgetEditable';

/**
 * What the screen OFFERS. `firestore.rules` decides what is accepted, and it is
 * the one that matters: it permits an update to /appropriations only while the
 * stored status is DRAFT. These tests pin this file to that, so the button and
 * the database cannot drift apart and leave an officer filling in a form that
 * fails on save.
 */
describe('appropriationEditable', () => {
  it('allows a draft', () => {
    expect(appropriationEditable({ status: 'DRAFT', kind: 'ORIGINAL' })).toBe(true);
    expect(appropriationNotEditableBecause({ status: 'DRAFT', kind: 'ORIGINAL' })).toBeNull();
  });

  it('allows every ordinary kind while it is still a draft', () => {
    for (const kind of ['ORIGINAL', 'SUPPLEMENTAL', 'CONTINUING', 'ADJUSTMENT']) {
      expect(appropriationEditable({ status: 'DRAFT', kind }), kind).toBe(true);
    }
  });

  it('refuses an approved appropriation', () => {
    // The authority is available for allotment and may already have been drawn
    // against. A change at that point is a supplemental or an adjustment, both
    // of which leave the original visible.
    expect(appropriationEditable({ status: 'APPROVED', kind: 'ORIGINAL' })).toBe(false);
  });

  it('refuses a cancelled one', () => {
    expect(appropriationEditable({ status: 'CANCELLED', kind: 'ORIGINAL' })).toBe(false);
  });

  it('refuses a realignment even if one somehow shows as a draft', () => {
    /*
     * A realignment is a SET of lines that comes to zero, posted whole by the
     * engine and never passing through DRAFT. If one ever appeared as a draft,
     * editing a single line of the set would move the fund's total
     * appropriation - the one thing a realignment must never do.
     */
    for (const kind of ['REALIGNMENT', 'AUGMENTATION', 'TRANSFER']) {
      expect(appropriationEditable({ status: 'DRAFT', kind }), kind).toBe(false);
    }
  });

  it('refuses a missing record rather than returning true by accident', () => {
    expect(appropriationEditable(null)).toBe(false);
    expect(appropriationEditable(undefined)).toBe(false);
    // A document with no status at all is not a draft.
    expect(appropriationEditable({})).toBe(false);
  });

  /**
   * The reason is the deliverable, not a nicety. A button that is simply
   * absent raises exactly the question the reason answers, and the officer
   * cannot see the status badge and the missing button as one fact.
   */
  it('says why, in terms of what to do instead', () => {
    const approved = appropriationNotEditableBecause({ status: 'APPROVED', kind: 'ORIGINAL' });
    expect(approved).toContain('supplemental');
    expect(approved).toContain('adjustment');

    const realignment = appropriationNotEditableBecause({ status: 'DRAFT', kind: 'REALIGNMENT' });
    expect(realignment).toContain('comes to zero');
  });

  it('names the one editable status, which the Firestore rule also names', () => {
    expect(EDITABLE_APPROPRIATION_STATUS).toBe('DRAFT');
  });
});

describe('augmentationDraftEditable', () => {
  it('allows a draft set', () => {
    expect(augmentationDraftEditable({ status: 'DRAFT' })).toBe(true);
  });

  it('allows one with no status written, which is what the rule permits', () => {
    expect(augmentationDraftEditable({})).toBe(true);
  });

  it('refuses a status this build does not understand', () => {
    // There is no POSTED: a posted set is deleted and the ledger is the record.
    // A document carrying one is from a build with different rules, and the
    // safe answer to that is no.
    expect(augmentationDraftEditable({ status: 'POSTED' })).toBe(false);
  });

  it('refuses a missing draft', () => {
    expect(augmentationDraftEditable(null)).toBe(false);
    expect(augmentationDraftEditable(undefined)).toBe(false);
  });
});

describe('aroDraftWaiting', () => {
  it('is true of a prepared order', () => {
    expect(aroDraftWaiting({ status: 'DRAFT' })).toBe(true);
  });

  /**
   * An approved order has released authority. It is kept as the record of who
   * prepared it, and it must never show among the orders waiting - an officer
   * pressing Approve on it again would be told it was released already, but
   * offering the button at all would say it had not been.
   */
  it('is false of an approved order', () => {
    expect(aroDraftWaiting({ status: 'APPROVED' })).toBe(false);
  });

  it('is false of a missing order or one with no status', () => {
    expect(aroDraftWaiting(null)).toBe(false);
    expect(aroDraftWaiting({})).toBe(false);
  });
});
