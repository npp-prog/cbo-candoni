/**
 * Patch 159 - matching a bank CREDIT to an e-collection, automatically.
 *
 * An e-collection is credited by the bank itself - the payor paid the
 * account, or the intermediary remitted to it - and the eRCD that reports it
 * debits Cash in Bank directly (patch 156). So a credit on the statement is
 * matched to the e-collection, or to the eRCD as a whole when the
 * intermediary remitted the batch as one credit:
 *
 *   receipt number in the statement text + exact amount   -> MATCHED
 *   eRCD number in the text + the eRCD's total             -> MATCHED
 *   the only e-collection or eRCD of that amount, 5 days   -> MATCHED
 *   several of the same amount within 5 days               -> SUGGESTED
 *
 * Each e-collection and each eRCD is matched to one statement line at most;
 * `used` carries what earlier lines took ("C:<collection>", "R:<report>").
 */

export interface ECollectionReport {
  id: string;
  reportNo: string;
  date: string;
  amount: number;
  lines: Array<{ sourceId: string; sourceNo: string; date?: string; amount: number }>;
}

export interface ECollectionMatch {
  status: 'MATCHED' | 'SUGGESTED';
  type: 'COLLECTION' | 'ERCD';
  id: string;
  ref: string;
  method: 'EXACT_AMOUNT_REF' | 'AMOUNT_DATE';
  confidence: number;
}

const norm = (v: string) =>
  String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export function withinDays(a: string, b: string, days: number): boolean {
  const t1 = Date.parse(`${a}T00:00:00Z`);
  const t2 = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return false;
  return Math.abs(t1 - t2) <= days * 86_400_000;
}

export function matchECollectionCredit(
  credit: { text: string; amount: number; date: string },
  reports: ECollectionReport[],
  used: Set<string>,
): ECollectionMatch | null {
  const hay = norm(credit.text);
  const amount = credit.amount;
  const lines = reports.flatMap((r) =>
    r.lines.map((l) => ({
      id: l.sourceId,
      no: String(l.sourceNo ?? ''),
      date: String(l.date || r.date),
      amount: Number(l.amount ?? 0),
    })),
  );
  const take = (key: string, m: ECollectionMatch) => {
    if (m.status === 'MATCHED') used.add(key);
    return m;
  };

  const byNo = lines.find(
    (e) =>
      !used.has(`C:${e.id}`) &&
      norm(e.no).length >= 4 &&
      hay.includes(norm(e.no)) &&
      e.amount === amount,
  );
  if (byNo) {
    return take(`C:${byNo.id}`, {
      status: 'MATCHED',
      type: 'COLLECTION',
      id: byNo.id,
      ref: byNo.no,
      method: 'EXACT_AMOUNT_REF',
      confidence: 1,
    });
  }

  const byReport = reports.find(
    (r) =>
      !used.has(`R:${r.id}`) &&
      norm(r.reportNo).length >= 4 &&
      hay.includes(norm(r.reportNo)) &&
      r.amount === amount,
  );
  if (byReport) {
    return take(`R:${byReport.id}`, {
      status: 'MATCHED',
      type: 'ERCD',
      id: byReport.id,
      ref: byReport.reportNo,
      method: 'EXACT_AMOUNT_REF',
      confidence: 1,
    });
  }

  const sameLines = lines.filter(
    (e) => !used.has(`C:${e.id}`) && e.amount === amount && withinDays(e.date, credit.date, 5),
  );
  const sameReports = reports.filter(
    (r) =>
      !used.has(`R:${r.id}`) &&
      r.lines.length > 1 &&
      r.amount === amount &&
      withinDays(r.date, credit.date, 5),
  );
  const only = sameLines.length + sameReports.length === 1;
  if (sameLines.length > 0) {
    return take(`C:${sameLines[0].id}`, {
      status: only ? 'MATCHED' : 'SUGGESTED',
      type: 'COLLECTION',
      id: sameLines[0].id,
      ref: sameLines[0].no,
      method: 'AMOUNT_DATE',
      confidence: only ? 0.9 : 0.4,
    });
  }
  if (sameReports.length > 0) {
    return take(`R:${sameReports[0].id}`, {
      status: only ? 'MATCHED' : 'SUGGESTED',
      type: 'ERCD',
      id: sameReports[0].id,
      ref: sameReports[0].reportNo,
      method: 'AMOUNT_DATE',
      confidence: only ? 0.9 : 0.4,
    });
  }
  return null;
}
