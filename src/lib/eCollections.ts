/**
 * Which e-collection belongs on which report, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE OF ITS OWN
 * ---------------------------------------------------------------------------
 * COA Circular 2021-014 prescribes three reports, and a collection belongs on
 * exactly one of them:
 *
 *   ERCD_AR      AR      an intermediary collected and issued its own
 *                        Acknowledgement Receipt          (Annex E)
 *   ERCD_EOR     EOR     our officer issued an electronic
 *                        Official Receipt                 (Annex F)
 *   ERCD_DIRECT  DIRECT  the payor paid the bank account
 *                        itself                           (Annex G)
 *   RCD          none    cash or a check over the counter
 *
 * An e-collection is an ordinary `collections` document carrying a kind - the
 * reasoning for that is on `Collection.eCollectionKind` - so all four reports
 * draw on one pile of documents, and this mapping is what divides it. The
 * browser uses it to decide what to OFFER; the engine uses it to decide what
 * to ACCEPT, inside the transaction that certifies the report.
 *
 * If the two copies ever disagreed, the browser would offer a receipt to a
 * report the engine then refused - or, far worse the other way round, a GCash
 * receipt would be certified onto the Report of Collections and Deposits. The
 * first report to certify claims the document; the other one is then short by
 * that amount, and nothing anywhere says why.
 *
 * So this file is vendored into `functions/` by scripts/sync-rules.mjs and the
 * build fails if the copies drift. It imports NOTHING, which is the condition
 * of being vendorable.
 */

/** The kind recorded on a collection. Absent means it came over the counter. */
export type ECollectionKindCode = 'AR' | 'EOR' | 'DIRECT';

/** The report types that gather electronic money. */
export type ECollectionReportKey = 'ERCD_AR' | 'ERCD_EOR' | 'ERCD_DIRECT';

const KIND_BY_REPORT: Record<ECollectionReportKey, ECollectionKindCode> = {
  ERCD_AR: 'AR',
  ERCD_EOR: 'EOR',
  ERCD_DIRECT: 'DIRECT',
};

export function isECollectionReportType(reportType: string): reportType is ECollectionReportKey {
  return Object.prototype.hasOwnProperty.call(KIND_BY_REPORT, reportType);
}

/**
 * The kind of collection a report of this type gathers.
 *
 * `null` for the RCD, and that is the whole point of returning null rather
 * than undefined: the RCD gathers collections with NO kind, so null is an
 * answer, not a missing one. Anything else returns undefined.
 */
export function kindForReportType(reportType: string): ECollectionKindCode | null | undefined {
  if (isECollectionReportType(reportType)) return KIND_BY_REPORT[reportType];
  if (reportType === 'RCD') return null;
  return undefined;
}

/**
 * Whether a collection of this kind may be reported on a report of this type.
 *
 * Both sides are normalised to null first, so a document written before
 * e-collections existed (no field at all) and one explicitly recorded as a
 * counter receipt are treated the same - which they are.
 */
export function collectionBelongsOnReport(
  reportType: string,
  collectionKind: string | null | undefined,
): boolean {
  const wanted = kindForReportType(reportType);
  if (wanted === undefined) return false;
  const actual = collectionKind ? String(collectionKind) : null;
  return wanted === actual;
}
