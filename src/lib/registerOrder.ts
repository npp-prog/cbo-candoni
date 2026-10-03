/**
 * Newest reference number at the top, in every register.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORDER IS DECIDED HERE AND NOT IN THE DATABASE QUERY
 * ---------------------------------------------------------------------------
 * The queries already ask for the newest DATE first, and that is nearly right.
 * What it does not settle is the order of the documents written on the same
 * day, which is most of them: an office raises eleven obligation requests on a
 * Tuesday, and Firestore returns those eleven in whatever order it likes.
 *
 * The clerk who has just encoded OBR 0042 looks for it at the top. Finding it
 * in the middle of Tuesday's eleven - or, on a register sorted the other way,
 * at the bottom of four hundred - is the difference between a register that
 * can be worked from and one that has to be searched every time.
 *
 * Settling it in the database instead would mean a second ordering field on
 * nine collections and the composite indexes to go with them, which is a
 * deployment and a wait for every list in CFMS. The lists are already fetched
 * whole, for a fund and a year, so ordering them here costs nothing and the
 * rule can be read, and tested, in one place.
 *
 * ---------------------------------------------------------------------------
 * HOW THE NUMBERS COMPARE
 * ---------------------------------------------------------------------------
 * A reference number in CFMS is not a number. It is "100-26-10-0009", and
 * comparing those as text works only as long as the digits are padded - which
 * they are when CFMS issues them, and which nobody can promise now that staff
 * assign the OBR and DV numbers by hand from the office's own book. A typed
 * "100-26-10-9" must still come before "100-26-10-10".
 *
 * So the comparison walks each number in runs of digits and non-digits: runs
 * of digits compare as numbers, everything else as text. "RCD-9" before
 * "RCD-10", "0009" before "0010", and a number with letters in it behaves the
 * way a person would read it.
 */

/** A row that carries a reference number and the date it was written. */
export interface Numbered {
  /** The office's reference: OBR number, DV number, check number, report number. */
  ref?: string | null;
  /** The document's own date, as a plain YYYY-MM-DD string. */
  date?: string | null;
}

/**
 * Compares two reference numbers the way a person reads them.
 *
 * Returns a negative number when `a` comes BEFORE `b` in ascending order.
 */
export function compareRefs(a: string, b: string): number {
  const partsOf = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const left = partsOf(a);
  const right = partsOf(b);

  const shorter = Math.min(left.length, right.length);
  for (let i = 0; i < shorter; i += 1) {
    const l = left[i];
    const r = right[i];
    const lNum = /^\d/.test(l);
    const rNum = /^\d/.test(r);

    if (lNum && rNum) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      // Equal in value but written differently ("07" and "7"). Keep a stable
      // answer rather than declaring them identical and falling through.
      if (l !== r) return l.length - r.length;
      continue;
    }

    if (l !== r) return l < r ? -1 : 1;
  }

  return left.length - right.length;
}

/**
 * The newest first.
 *
 * A row with NO number yet goes to the very top. That is not a special case
 * for its own sake: an unnumbered row is a draft somebody is working on this
 * minute - a voucher being encoded, an entry not yet posted - and it is the
 * row they are coming back to. Sorting it to the bottom among four hundred
 * finished documents is the one placement that is certainly wrong.
 *
 * Rows that carry the same number, or none, fall back to the document date,
 * newest first, so the order is never left to chance.
 */
export function newestFirst<T>(
  rows: readonly T[],
  read: (row: T) => Numbered,
): T[] {
  return rows.slice().sort((rowA, rowB) => {
    const a = read(rowA);
    const b = read(rowB);

    const refA = (a.ref ?? '').trim();
    const refB = (b.ref ?? '').trim();

    if (refA === '' && refB !== '') return -1;
    if (refB === '' && refA !== '') return 1;

    if (refA !== '' && refB !== '') {
      const byRef = compareRefs(refA, refB);
      if (byRef !== 0) return -byRef;
    }

    const dateA = a.date ?? '';
    const dateB = b.date ?? '';
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    return 0;
  });
}
