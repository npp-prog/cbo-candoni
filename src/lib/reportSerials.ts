/**
 * Patch 148. The first and last check (or ADA) number a treasury report
 * covers - for the certification ("Check Nos. 123460 to 123465 inclusive").
 *
 * The engine writes `serialFrom` / `serialTo` when the report is certified,
 * and an uploaded report carries them from the upload. A DRAFT prepared by
 * hand has neither, yet its certification is what the Treasurer reads and
 * signs - so the range is worked out from the report's own lines, the same
 * way the engine works it out at certification: the documents not cancelled,
 * sorted by number.
 */
export function reportSerials(report: {
  serialFrom?: string | null;
  serialTo?: string | null;
  lines?: Array<{ sourceNo?: string | null; excluded?: boolean }> | null;
}): { from: string | null; to: string | null } {
  if (report.serialFrom) {
    return { from: report.serialFrom, to: report.serialTo || report.serialFrom };
  }
  const serials = (report.lines ?? [])
    .filter((l) => !l.excluded && String(l.sourceNo ?? '').trim() !== '')
    .map((l) => String(l.sourceNo).trim())
    .sort();
  if (serials.length === 0) return { from: null, to: null };
  return { from: serials[0], to: serials[serials.length - 1] };
}
