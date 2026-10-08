// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/treasurySources.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
/**
 * Which register each treasury report draws its documents from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE OF ITS OWN
 * ---------------------------------------------------------------------------
 * A treasury report's lines each carry a `sourceId` - the id of the document
 * the line covers - and nothing on the line says which COLLECTION that id
 * belongs to. It cannot: an id is an id. What decides it is the kind of
 * report, and that is the whole of this mapping.
 *
 *   RCI       the checks drawn
 *   RADAI     the advices to debit account sent to the bank
 *   RCD       the receipts issued over the counter
 *   ERCD_AR   receipts an intermediary issued on our behalf     )  the SAME
 *   ERCD_EOR  electronic receipts our own officer issued        )  collection
 *   RCDISB    the payrolls paid out in cash
 *
 * The three collection reports draw on ONE pile of documents - an e-collection
 * is an ordinary `collections` document carrying a kind. What divides that pile
 * is `eCollections.ts`, not this; this only says which pile to look in.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT IS SHARED RATHER THAN WRITTEN TWICE
 * ---------------------------------------------------------------------------
 * The ENGINE needs it to claim each covered document when a report is certified
 * and to release it when one is withdrawn. The BROWSER needs it to open the
 * document when somebody clicks a line of the report.
 *
 * Written in both places, the failure is quiet and specific. A seventh report
 * type added next year with a new source register would be claimed correctly by
 * the engine and read from the wrong register by the screen - which would not
 * raise an error. It would report that the document is "no longer in CFMS",
 * which is a sentence that means something serious and would be false.
 *
 * So there is one copy. `scripts/sync-rules.mjs` vendors it into the engine and
 * CI fails if the two ever differ.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IMPORTS NOTHING, ON PURPOSE
 * ---------------------------------------------------------------------------
 * It is copied verbatim into the functions build, which does not share the
 * browser's module graph or its path aliases. The collection names are written
 * as the plain strings they are - which is exactly what `COL.checks` and the
 * engine's own `COL` resolve to - rather than imported from either side's
 * constants.
 */

export type TreasuryReportTypeCode =
  | 'RCI'
  | 'RADAI'
  | 'RCD'
  | 'RCDISB'
  | 'ERCD_AR'
  | 'ERCD_EOR';

/**
 * The register each report type covers.
 *
 * Plain Firestore collection names. Both sides' `COL` constants map to these
 * same strings; see the note above on why they are not imported.
 */
export const TREASURY_SOURCE_COLLECTION: Record<TreasuryReportTypeCode, string> = {
  RCI: 'checks',
  RADAI: 'ada',
  RCD: 'collections',
  RCDISB: 'payrolls',
  // All three collection reports draw on the SAME register as the RCD. An
  // e-collection is an ordinary collections document carrying a kind; what
  // divides the pile is eCollections.ts, not a separate store.
  ERCD_AR: 'collections',
  ERCD_EOR: 'collections',
};

/** The field on a covered document that records which report claimed it. */
export const TREASURY_SOURCE_REPORT_FIELD = 'treasuryReportId';

/**
 * The register a report of this type covers, or null for a type this build does
 * not know.
 *
 * Returning null rather than throwing is deliberate on the browser side: an
 * unknown type should leave a line unclickable, not take the screen down. The
 * engine checks the type against its own list long before it gets here.
 */
export function sourceCollectionFor(reportType: string): string | null {
  return Object.prototype.hasOwnProperty.call(TREASURY_SOURCE_COLLECTION, reportType)
    ? TREASURY_SOURCE_COLLECTION[reportType as TreasuryReportTypeCode]
    : null;
}
