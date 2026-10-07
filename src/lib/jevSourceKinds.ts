/**
 * Which journal entries a document raises, and which the Accountant writes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIST IS ITS OWN FILE, WITH NO IMPORTS
 * ---------------------------------------------------------------------------
 * Both halves of CFMS now decide things with it. The browser uses it to split
 * General Transactions from the Journal Entries Register; the engine uses it
 * to decide whether a posted entry's AMOUNT may be corrected, because an entry
 * raised by a signed voucher carries that voucher's figure and an entry
 * written in Accounting carries nobody's but the Accountant's.
 *
 * A rule that decides what may be changed about money, kept in two files that
 * could drift, is the shape of fault this project has had before. So it is
 * written once and vendored into the engine, like the accounting rules
 * themselves - which is only possible if it imports nothing.
 */

/** Raised by a document somewhere else in CFMS. */
export const DOCUMENT_SOURCED_KINDS: readonly string[] = [
  'DV',
  'CHECK',
  'ADA',
  'RCI',
  'RADAI',
  'RCD',
  'RCDISB',
  /*
   * COA Circular 2021-014's three reports, added in patch 91. They are
   * document-sourced for exactly the reason the RCD is: the figure comes from
   * a report an officer certified under oath, not from the Accountant.
   *
   * Left off this list they would have counted as DIRECT entries - the
   * fallback - and the amount of a certified report's journal entry would have
   * been editable in Accounting. That is the one thing the split between
   * certifying and journalizing exists to prevent.
   */
  'ERCD_AR',
  'ERCD_EOR',
  'PAYROLL',
  'LIQUIDATION',
];

/**
 * True for an entry the Accountant writes rather than one a document raises.
 *
 * An unknown kind counts as DIRECT. That is deliberate in both halves: on the
 * screen it means a new kind nobody classified appears on a short list
 * somebody reads rather than vanishing; in the engine it means the amount is
 * editable, which is the state of an entry with no signed document behind it,
 * and the conservative answer is the one that does not invent a document.
 */
export function isDirectEntry(sourceType?: string | null): boolean {
  if (!sourceType) return true;
  return !DOCUMENT_SOURCED_KINDS.includes(sourceType);
}
