import { renumberPaymentEntry } from './treasuryEntry';

/**
 * Patch 149. What a draft treasury report saves when its number is changed:
 * the number, and - on an RCI - the Cash in Bank lines that quote it
 * ("Payment of RCI <no> Check No. ...", patch 147). Lines the Accountant
 * reworded are left alone (see renumberPaymentEntry).
 */
export function renumberedDraft<L extends { credit: number; particulars?: string | null }>(
  report: { reportType: string; entry?: L[] | null },
  reportNo: string,
): { reportNo: string; entry?: L[] } {
  const no = reportNo.trim();
  if (report.reportType === 'RCI' && report.entry && report.entry.length > 0) {
    return { reportNo: no, entry: renumberPaymentEntry(report.entry, 'RCI', no) };
  }
  return { reportNo: no };
}
