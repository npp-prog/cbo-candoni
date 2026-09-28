// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/clearing.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
/**
 * Payee names the clearing house will not accept.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A RULE AND NOT A PREFERENCE
 * ---------------------------------------------------------------------------
 * The Philippine Clearing House Corporation refuses checks whose payee is
 * "CASH" or contains "and/or". A check drawn that way is not a slow payment or
 * an awkward one: it is returned, and the municipality finds out weeks later
 * when a supplier telephones. By then the check is in the register, the RCI has
 * been certified, and the journal entry is posted - so unwinding it costs three
 * offices a morning each.
 *
 * Catching it at the moment the check number is typed costs nothing, which is
 * the only reason a rule this small earns a file of its own.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS VENDORED
 * ---------------------------------------------------------------------------
 * The browser warns and the server decides, and the two must agree exactly. A
 * browser that warns about a name the server accepts trains people to ignore
 * the warning; a server that refuses a name the browser passed looks like a
 * fault. `scripts/sync-rules.mjs` copies this file into the functions build and
 * CI fails if the two drift.
 * ---------------------------------------------------------------------------
 */

export interface ClearingObjection {
  /** The offending text, as it appears in the name. */
  found: string;
  /** What to tell the person at the screen. */
  message: string;
}

/**
 * Returns why the clearing house would refuse this payee, or null.
 *
 * The objection is to a check that IS payable to cash - not to every payee
 * whose name happens to contain the word. CASHIER OF THE MUNICIPALITY,
 * PETTY CASH FUND and CASH & CARRY TRADING are all real payees, and warning
 * about them would teach people to click through the warning, which is worse
 * than not having one. So the name is stripped of the words a teller writes
 * around a payee - "pay to the order of" and its parts - and refused only if
 * what remains is the word cash by itself.
 *
 * "and/or" is different: it is matched anywhere, because a check payable to
 * one party or another cannot clear whatever surrounds the phrase.
 */
export function clearingObjection(payeeName: string | null | undefined): ClearingObjection | null {
  const name = String(payeeName ?? '').trim();
  if (!name) return null;

  const upper = name.toUpperCase();

  const bare = upper
    .replace(/^PAY\s+TO\s+(THE\s+)?(ORDER\s+OF\s+)?/, '')
    .replace(/[^A-Z]/g, '');

  if (bare === 'CASH') {
    return {
      found: 'CASH',
      message:
        'The clearing house refuses a check whose payee is CASH, and the bank will return it. ' +
        'Draw it in the name of the person or supplier being paid.',
    };
  }

  if (upper.includes('AND/OR') || upper.includes(' AND / OR ')) {
    return {
      found: 'and/or',
      message:
        'The clearing house refuses a check payable to one party "and/or" another, and the bank ' +
        'will return it. Name a single payee.',
    };
  }

  return null;
}

/** How long an acknowledgement must be before it counts as a decision. */
export const CLEARING_OVERRIDE_MIN_LENGTH = 15;
