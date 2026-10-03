/**
 * When a journal entry has a number, and when it only looks as though it does.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBER IS DRAWN AT POSTING
 * ---------------------------------------------------------------------------
 * A Journal Entry Voucher number is a position in the journal, and the journal
 * is the book of entries that were made. An entry that has been prepared and
 * not yet posted has not been made: it may be corrected, it may be cancelled,
 * it may be sitting behind a voucher whose approval is taken back tomorrow.
 *
 * Giving it a number at preparation puts a number in the series that may never
 * be used, and a gap in a numbered series is a finding. The office cannot
 * prove from the books what happened to JEV 100-26-03-0147 if the entry that
 * held it was discarded before it was ever posted.
 *
 * So the number is issued at the moment of posting, by the engine, in the same
 * transaction that writes the ledger entries. Before that the entry has a
 * placeholder.
 *
 * ---------------------------------------------------------------------------
 * WHY A PLACEHOLDER AND NOT AN EMPTY FIELD
 * ---------------------------------------------------------------------------
 * Because there are drafts in the database already carrying it, and because
 * the security rules forbid the client to change `jevNo` at all - which is the
 * rule that keeps the number the engine's to give. A draft written by the
 * browser therefore has to carry something, and that something must be a value
 * both sides recognise as "none yet". If they ever disagreed about it, an
 * entry would post into the General Ledger with the word "(unnumbered)" in the
 * JEV No. column of every ledger line, and nothing would complain.
 *
 * That is why this file is vendored into the engine rather than written out
 * twice.
 */

/** What a prepared entry carries until the engine gives it a real number. */
export const UNNUMBERED_JEV = '(unnumbered)';

/** True when a real journal number has been issued. */
export function hasJevNumber(jevNo?: string | null): boolean {
  if (!jevNo) return false;
  const trimmed = jevNo.trim();
  if (trimmed.length === 0) return false;
  return trimmed !== UNNUMBERED_JEV;
}
