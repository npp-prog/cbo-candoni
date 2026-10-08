/**
 * When a budget document may still be corrected in place.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT AN `IF`
 * ---------------------------------------------------------------------------
 * The rule "an appropriation may be edited until it is approved" is written in
 * three places that cannot see each other: the Firestore rule on
 * /appropriations, which permits an update only while `isDraft()`; the engine,
 * which refuses to approve anything not DRAFT; and the screen, which decides
 * whether to offer the button.
 *
 * Two of those are enforcement and one is an offer, and the failure mode when
 * they drift is specific and unpleasant: a button appears, the officer fills in
 * the form, presses save, and Firestore refuses with a permission error that
 * explains nothing. They conclude the system is unreliable about editing,
 * which is a worse outcome than never having offered the button.
 *
 * So the screen asks here, the answer carries its own reason, and
 * `npm run verify` section 37 checks that what this says still matches what
 * the rule enforces.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT IS ONLY EVER "UNTIL APPROVED"
 * ---------------------------------------------------------------------------
 * An approved appropriation is spending authority. Allotments are released
 * against it, obligations are charged against those, and the Registry (RAAO)
 * foots to it. Editing one after approval would move a figure that other
 * documents have already relied on, silently - which is why a change at that
 * point is a supplemental appropriation or an adjustment, both of which leave
 * the original visible and the movement traceable to its own ordinance.
 */

/** The one status in which an appropriation is still the office's own draft. */
export const EDITABLE_APPROPRIATION_STATUS = 'DRAFT';

/**
 * The kinds that are never drafts, and must not become editable if one ever
 * appears as one.
 *
 * A realignment and an augmentation are recorded as a SET of lines that comes
 * to zero - authority taken off one line and put on another - and the engine
 * posts the set whole or not at all. Editing one line of such a set in
 * isolation would leave the set out of balance with nothing to report it: the
 * fund's total appropriation would move, which is the one thing a realignment
 * must never do. They are posted APPROVED and never pass through DRAFT, so
 * this should never fire; it is here because the cost of being wrong about it
 * is a budget that does not foot.
 */
export const SET_POSTED_KINDS = ['REALIGNMENT', 'AUGMENTATION', 'TRANSFER'];

export interface EditableAppropriation {
  status?: string | null;
  kind?: string | null;
}

/**
 * Why this appropriation cannot be edited, in words an officer can act on, or
 * null when it can be.
 *
 * The reason is returned rather than a bare false because a button that is
 * simply absent raises the question the reason answers. Patch 97 settled this
 * on the collections side: where the act is not available, the screen prints
 * why in its place.
 */
export function appropriationNotEditableBecause(
  appropriation: EditableAppropriation | null | undefined,
): string | null {
  if (!appropriation) return 'There is no appropriation here to edit.';

  const status = appropriation.status ?? null;

  if (status === 'CANCELLED') {
    return 'This appropriation has been cancelled. Record a new one rather than reviving this.';
  }

  if (status !== EDITABLE_APPROPRIATION_STATUS) {
    return (
      'This appropriation has been approved, so the authority is already available for ' +
      'allotment and may have been drawn against. Record a supplemental appropriation or an ' +
      'adjustment instead - that way the original stays visible and the change is traceable to ' +
      'its own ordinance.'
    );
  }

  if (appropriation.kind && SET_POSTED_KINDS.includes(appropriation.kind)) {
    return (
      'A realignment is recorded as a set of lines that comes to zero, and is posted whole. ' +
      'Editing one line of the set on its own would move the total appropriation of the fund. ' +
      'Record a correcting realignment instead.'
    );
  }

  return null;
}

/** Whether this appropriation may still be corrected in place. */
export function appropriationEditable(
  appropriation: EditableAppropriation | null | undefined,
): boolean {
  return appropriationNotEditableBecause(appropriation) === null;
}
