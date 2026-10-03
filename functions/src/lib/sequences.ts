/**
 * Allocating sequence numbers, separated from the database so it can be tested.
 *
 * The hard part of issuing several document numbers in one transaction is not
 * the reading or the writing - it is that two requests can land on the SAME
 * counter. Ten reserved ADA numbers all draw on one counter, and the one way
 * to get that wrong is to read the counter twice: both reads see the same
 * value, and the same number is issued twice. A duplicate accountable form
 * number is not a cosmetic fault.
 *
 * So the counter is read once, and this works out who gets which number.
 */
export interface Allocation {
  /** One per request, in order. `null` where the request was skipped. */
  sequences: Array<number | null>;
  /** The value each counter must be left at. */
  finals: Map<string, number>;
}

export function allocateSequences(
  /** The counter each request draws on, in order; `null` to skip. */
  counterIds: Array<string | null>,
  /** What each counter stands at now. A counter not present stands at zero. */
  base: Map<string, number>,
): Allocation {
  const taken = new Map<string, number>();
  const sequences: Array<number | null> = [];

  for (const id of counterIds) {
    if (id === null) {
      sequences.push(null);
      continue;
    }
    const n = (taken.get(id) ?? 0) + 1;
    taken.set(id, n);
    sequences.push((base.get(id) ?? 0) + n);
  }

  const finals = new Map<string, number>();
  for (const [id, n] of taken) finals.set(id, (base.get(id) ?? 0) + n);

  return { sequences, finals };
}
