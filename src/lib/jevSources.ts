import { JEV_SOURCE_TYPES, type JevSourceType } from '@/types/enums';
import { DOCUMENT_SOURCED_KINDS, isDirectEntry } from './jevSourceKinds';

/**
 * Which journal entries the Accountant writes, and which ones a document
 * raises.
 *
 * ---------------------------------------------------------------------------
 * THE DISTINCTION, AND WHY A SCREEN DEPENDS ON IT
 * ---------------------------------------------------------------------------
 * Most entries in the books are not written by anybody. A disbursement voucher
 * is approved and an entry appears; the Treasurer's report of checks issued is
 * journalized and an entry appears. Nobody chose the accounts - the document
 * did, from what it is.
 *
 * A smaller number of entries have no document behind them at all. The
 * depreciation at the end of the month, the closing of the income accounts at
 * the end of the year, the correction of last year's figure, the reversal of
 * an entry that should not have been made: these begin in Accounting, on the
 * Accountant's judgement, and there is nothing to raise them from.
 *
 * Those are the ones that need a screen where an entry can be written from
 * nothing. The rest already have one - the voucher's screen, the report's
 * screen - and listing them all together turned that screen into a register of
 * everything, where the handful of entries somebody actually had to write were
 * lost among the hundreds the system had generated.
 *
 * So: General Transactions shows the entries below that are DIRECT. The Journal
 * Entries Register shows every entry, whatever raised it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIST NAMES THE DOCUMENTS AND NOT THE DIRECT ENTRIES
 * ---------------------------------------------------------------------------
 * An entry is direct unless CFMS knows of a document that raises it. A new
 * source type that nobody remembered to classify therefore turns up in
 * General Transactions, which is a short list somebody reads, instead of hidden
 * from it - and an entry that appears where it does not belong is noticed in a
 * day, whereas one that appears nowhere is noticed when the books are closed.
 */
export const DOCUMENT_SOURCED: readonly JevSourceType[] =
  DOCUMENT_SOURCED_KINDS as readonly JevSourceType[];

/**
 * True for an entry the Accountant writes rather than one a document raises.
 *
 * Takes a plain string rather than the union, because this is also asked of
 * entries read back from the database, where the value is whatever was stored.
 */
export { isDirectEntry };

/** The direct kinds, in the order they appear in the registry. */
export const DIRECT_ENTRY_TYPES: readonly JevSourceType[] = JEV_SOURCE_TYPES.filter((t) =>
  isDirectEntry(t),
);

/** The entries written in Accounting itself, out of a list of all of them. */
export function directEntries<T extends { sourceType: string }>(rows: T[]): T[] {
  return rows.filter((r) => isDirectEntry(r.sourceType));
}
