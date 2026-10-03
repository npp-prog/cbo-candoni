import type { Centavos } from '@/types/common';

/**
 * Journal entries prepared and waiting for the Municipal Accountant.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE DEFINITION AND NOT THREE
 * ---------------------------------------------------------------------------
 * "Which entries are waiting to be posted" was written out as a literal in
 * three places - the journal entry list, and twice more as the reports grew.
 * A fourth state would have had to be remembered in all of them, and the one
 * that was forgotten would have quietly reported a different number from the
 * others, on screens the Accountant reads side by side.
 *
 * An entry reaches the General Ledger when it is POSTED. One that is CANCELLED
 * or REVERSED has finished its life. Everything else is waiting.
 */
const FINISHED = new Set(['POSTED', 'CANCELLED', 'REVERSED']);

export interface PostableEntry {
  status: string;
  totalDebit?: Centavos;
}

export function awaitingPosting<T extends PostableEntry>(jevs: T[]): T[] {
  return jevs.filter((j) => !FINISHED.has(j.status));
}

export function totalAwaitingPosting(jevs: PostableEntry[]): Centavos {
  return awaitingPosting(jevs).reduce((sum, j) => sum + (j.totalDebit ?? 0), 0);
}
