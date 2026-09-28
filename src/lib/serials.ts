/**
 * Serial-range arithmetic for accountable forms.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * An accountable form is not money and it is not a document: it is a numbered
 * piece of paper that becomes money the moment somebody writes on it. COA
 * audits the municipality's custody of those numbers, and the question it asks
 * is always the same one - for each form type, which serials did this officer
 * hold at the start of the month, which did they receive, which did they issue,
 * and which are still in their hands.
 *
 * Every one of those four answers is a SET OF SERIAL RANGES, not a quantity.
 * "412 forms on hand" is not an answer; "0007705351 to 0007705762, 412 forms"
 * is. So the arithmetic here is interval arithmetic, and the quantity is a
 * consequence of it rather than a number kept alongside it. That choice is what
 * makes the ending balance provable: the engine computes it twice, once by
 * subtracting ranges and once by counting, and refuses to file a report where
 * the two disagree.
 *
 * ---------------------------------------------------------------------------
 * THE BOOKLET
 * ---------------------------------------------------------------------------
 * Accountable forms are bound in booklets - fifty receipts to a booklet for the
 * Official Receipt - and the RCD reports issuances one booklet at a time, never
 * as one run spanning two booklets. 0007705801 to 0007705868 is two lines on
 * the report, not one. `splitIntoBooklets` is what produces those lines, and
 * the booklet size is a property of the form type rather than a constant,
 * because the cash ticket is not bound in fifties.
 *
 * ---------------------------------------------------------------------------
 * NON-NUMERIC SERIALS
 * ---------------------------------------------------------------------------
 * Some forms carry a letter prefix or a check digit. Nothing here guesses at
 * those: `toNumber` returns null, the range functions leave such serials alone
 * as single-serial ranges, and the report prints the issuance without computing
 * a balance, with a footnote saying so. A wrong balance is worse than a missing
 * one, because only the missing one gets asked about.
 * ---------------------------------------------------------------------------
 */

/** A closed, inclusive run of serials. `qty` is always `to - from + 1`. */
export interface SerialRange {
  from: string;
  to: string;
  qty: number;
}

/** The same run held numerically, for arithmetic. */
export interface NumericRange {
  from: number;
  to: number;
  /** Width to zero-pad back to, taken from the widest serial that produced it. */
  width: number;
}

export const DEFAULT_BOOKLET_SIZE = 50;

// ---------------------------------------------------------------------------
// Single serials
// ---------------------------------------------------------------------------

/**
 * The numeric value of a serial, or null when it is not purely numeric.
 *
 * Leading zeros are insignificant for comparison - 0007700678 and 7700678 are
 * the same receipt, and an office that drops the padding in one spreadsheet and
 * keeps it in another must not end up with two histories for one form.
 */
export function toNumber(serial: string | number | null | undefined): number | null {
  if (serial === null || serial === undefined) return null;
  const raw = String(serial).trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** True when the serial can take part in range arithmetic. */
export function isNumericSerial(serial: string | null | undefined): boolean {
  return toNumber(serial) !== null;
}

/** Zero-pads a number back to the width the office writes it at. */
export function pad(value: number, width: number): string {
  const s = String(Math.max(0, Math.trunc(value)));
  return width > s.length ? s.padStart(width, '0') : s;
}

/** The printed width of a serial, used to pad computed serials to match. */
export function serialWidth(...serials: Array<string | null | undefined>): number {
  let w = 0;
  for (const s of serials) {
    if (!s) continue;
    const t = String(s).trim();
    if (/^\d+$/.test(t)) w = Math.max(w, t.length);
  }
  return w || 1;
}

/** The next serial after this one, preserving width. Null if not numeric. */
export function nextSerial(serial: string): string | null {
  const n = toNumber(serial);
  if (n === null) return null;
  return pad(n + 1, serialWidth(serial));
}

// ---------------------------------------------------------------------------
// Booklets
// ---------------------------------------------------------------------------

/** The first serial of the booklet a serial belongs to. */
export function bookletStart(n: number, size: number = DEFAULT_BOOKLET_SIZE): number {
  if (size <= 0) return n;
  return Math.floor((n - 1) / size) * size + 1;
}

/** The last serial of the booklet a serial belongs to. */
export function bookletEnd(n: number, size: number = DEFAULT_BOOKLET_SIZE): number {
  return bookletStart(n, size) + size - 1;
}

/**
 * Splits a run at every booklet boundary.
 *
 * This is what turns one continuous issuance into the several lines the RCD
 * prints, because the form is accounted for booklet by booklet. A run that sits
 * inside one booklet comes back unchanged.
 */
export function splitIntoBooklets(
  range: NumericRange,
  size: number = DEFAULT_BOOKLET_SIZE,
): NumericRange[] {
  if (size <= 0 || range.to < range.from) return [range];
  const out: NumericRange[] = [];
  let cursor = range.from;
  while (cursor <= range.to) {
    const end = Math.min(bookletEnd(cursor, size), range.to);
    out.push({ from: cursor, to: end, width: range.width });
    cursor = end + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Range arithmetic
// ---------------------------------------------------------------------------

/** Sorts and merges touching or overlapping ranges into a canonical set. */
export function normalise(ranges: NumericRange[]): NumericRange[] {
  const valid = ranges.filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to >= r.from);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: NumericRange[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i += 1) {
    const r = sorted[i];
    const last = out[out.length - 1];
    // `r.from <= last.to + 1` merges 1-10 and 11-20 into 1-20: they are
    // contiguous custody even though they arrived as two receipts.
    if (r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
      last.width = Math.max(last.width, r.width);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** True when two runs share at least one serial. */
export function overlaps(a: NumericRange, b: NumericRange): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** The serials present in `base` and also in `other`. */
export function intersect(base: NumericRange[], other: NumericRange[]): NumericRange[] {
  const out: NumericRange[] = [];
  for (const a of normalise(base)) {
    for (const b of normalise(other)) {
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      if (to >= from) out.push({ from, to, width: Math.max(a.width, b.width) });
    }
  }
  return normalise(out);
}

/** The serials present in `base` but not in `remove`. */
export function subtract(base: NumericRange[], remove: NumericRange[]): NumericRange[] {
  let current = normalise(base);
  for (const cut of normalise(remove)) {
    const next: NumericRange[] = [];
    for (const r of current) {
      if (!overlaps(r, cut)) {
        next.push(r);
        continue;
      }
      if (cut.from > r.from) next.push({ from: r.from, to: cut.from - 1, width: r.width });
      if (cut.to < r.to) next.push({ from: cut.to + 1, to: r.to, width: r.width });
    }
    current = normalise(next);
  }
  return current;
}

/** Every serial in either set. */
export function union(a: NumericRange[], b: NumericRange[]): NumericRange[] {
  return normalise([...a, ...b]);
}

/** How many serials a set of ranges holds. */
export function count(ranges: NumericRange[]): number {
  return normalise(ranges).reduce((sum, r) => sum + (r.to - r.from + 1), 0);
}

/** True when every serial of `inner` is held by `outer`. */
export function contains(outer: NumericRange[], inner: NumericRange[]): boolean {
  return count(subtract(inner, outer)) === 0;
}

// ---------------------------------------------------------------------------
// Conversion to and from what people type and read
// ---------------------------------------------------------------------------

/** Builds a numeric range from two serials as written. Null if not numeric. */
export function rangeFrom(from: string, to: string): NumericRange | null {
  const f = toNumber(from);
  const t = toNumber(to);
  if (f === null || t === null || t < f) return null;
  return { from: f, to: t, width: serialWidth(from, to) };
}

/** Renders a numeric range back into padded serials with its quantity. */
export function render(range: NumericRange): SerialRange {
  return {
    from: pad(range.from, range.width),
    to: pad(range.to, range.width),
    qty: range.to - range.from + 1,
  };
}

/** Renders a whole set, splitting at booklet boundaries when a size is given. */
export function renderSet(ranges: NumericRange[], bookletSize?: number): SerialRange[] {
  const normalised = normalise(ranges);
  const expanded = bookletSize
    ? normalised.flatMap((r) => splitIntoBooklets(r, bookletSize))
    : normalised;
  return expanded.map(render);
}

/**
 * Collapses a list of individual serials into contiguous runs.
 *
 * This is how a month of encoded receipts becomes the two or three lines that
 * print on the report. Repeated serials do not extend a run - they are counted
 * once here and reported separately by `analyzeContinuity`, because a duplicate
 * is a finding, not a quantity.
 */
export function collapse(serials: Array<string | null | undefined>): NumericRange[] {
  const width = serialWidth(...serials);
  const numbers = serials
    .map(toNumber)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);

  const ranges: NumericRange[] = numbers.map((n) => ({ from: n, to: n, width }));
  return normalise(ranges);
}

/** The serials in the list that are not numeric, kept so nothing is lost. */
export function nonNumeric(serials: Array<string | null | undefined>): string[] {
  return serials
    .map((s) => (s === null || s === undefined ? '' : String(s).trim()))
    .filter((s) => s !== '' && !isNumericSerial(s));
}

// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

export interface ContinuityGap {
  /** The serial before the hole. */
  after: string;
  /** The serial after the hole. */
  before: string;
  /** How many serials are unaccounted for between them. */
  missing: number;
}

export interface ContinuityReport {
  /** Serials that appear more than once, with how many times. */
  duplicates: Array<{ serial: string; times: number }>;
  /** Holes in the run of serials actually used. */
  gaps: ContinuityGap[];
  /** Serials that could not be compared at all. */
  unreadable: string[];
}

/**
 * Finds duplicated and missing serials in a set of issuances.
 *
 * Both are findings and neither is an error the system should refuse, because
 * both have innocent explanations - a cancelled receipt leaves a hole, and a
 * re-encoded one leaves a duplicate. What the office needs is to be told, on
 * the face of the report, which serials to go and account for.
 */
export function analyzeContinuity(serials: Array<string | null | undefined>): ContinuityReport {
  const seen = new Map<number, number>();
  const width = serialWidth(...serials);

  for (const s of serials) {
    const n = toNumber(s);
    if (n === null) continue;
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }

  const duplicates = [...seen.entries()]
    .filter(([, times]) => times > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([n, times]) => ({ serial: pad(n, width), times }));

  const ordered = [...seen.keys()].sort((a, b) => a - b);
  const gaps: ContinuityGap[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (current > previous + 1) {
      gaps.push({
        after: pad(previous, width),
        before: pad(current, width),
        missing: current - previous - 1,
      });
    }
  }

  return { duplicates, gaps, unreadable: nonNumeric(serials) };
}

// ---------------------------------------------------------------------------
// Accountability
// ---------------------------------------------------------------------------

export interface AccountabilityInput {
  /** Held at the start of the period. */
  beginning: NumericRange[];
  /** Received during the period. */
  receipt: NumericRange[];
  /** Issued or used during the period. */
  issued: NumericRange[];
  /** Spoiled, cancelled or returned during the period. */
  withdrawn?: NumericRange[];
}

export interface AccountabilitySection {
  qty: number;
  ranges: SerialRange[];
}

export interface Accountability {
  beginning: AccountabilitySection;
  receipt: AccountabilitySection;
  issued: AccountabilitySection;
  withdrawn: AccountabilitySection;
  ending: AccountabilitySection;
  /**
   * Set when the ending balance computed by subtracting ranges disagrees with
   * the ending balance computed by counting. It means a serial was issued that
   * the officer never held, and the report must not be filed until it is
   * explained.
   */
  discrepancy: string | null;
}

/**
 * The four columns of the RAAF, and the proof that they foot.
 *
 * beginning + receipt - issued - withdrawn = ending, and the same answer has to
 * come out whether you do that arithmetic on the serial ranges or on the
 * quantities. Where it does not, an issuance has been recorded against serials
 * the officer was never given: the classic shape of a receipt booklet used
 * outside the system.
 */
export function accountability(
  input: AccountabilityInput,
  bookletSize?: number,
): Accountability {
  const beginning = normalise(input.beginning);
  const receipt = normalise(input.receipt);
  const issued = normalise(input.issued);
  const withdrawn = normalise(input.withdrawn ?? []);

  const held = union(beginning, receipt);
  const consumed = union(issued, withdrawn);
  const ending = subtract(held, consumed);

  const byCount = count(beginning) + count(receipt) - count(issued) - count(withdrawn);
  const byRange = count(ending);

  const notHeld = subtract(consumed, held);
  let discrepancy: string | null = null;
  if (count(notHeld) > 0) {
    const all = renderSet(notHeld);
    const shown = all.slice(0, 3).map((r) => (r.qty === 1 ? r.from : `${r.from}-${r.to}`));
    const missing = count(notHeld);
    discrepancy =
      `${missing} serial${missing === 1 ? '' : 's'} were issued or withdrawn ` +
      `without ever being received into this officer's custody: ${shown.join(', ')}` +
      `${all.length > shown.length ? ' and others' : ''}.`;
  } else if (byCount !== byRange) {
    discrepancy =
      `The ending balance does not foot: the quantities give ${byCount} forms but the ` +
      `serial ranges give ${byRange}.`;
  }

  return {
    beginning: { qty: count(beginning), ranges: renderSet(beginning, bookletSize) },
    receipt: { qty: count(receipt), ranges: renderSet(receipt, bookletSize) },
    issued: { qty: count(issued), ranges: renderSet(issued, bookletSize) },
    withdrawn: { qty: count(withdrawn), ranges: renderSet(withdrawn, bookletSize) },
    ending: { qty: byRange, ranges: renderSet(ending, bookletSize) },
    discrepancy,
  };
}

/** A set of ranges as one readable phrase, for a table cell or a message. */
export function describe(ranges: SerialRange[]): string {
  if (ranges.length === 0) return '—';
  return ranges.map((r) => (r.from === r.to ? r.from : `${r.from} to ${r.to}`)).join(', ');
}
