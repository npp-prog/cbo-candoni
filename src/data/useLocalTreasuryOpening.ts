import { useBankLedger, useTreasuryReports } from './queries';
import { REPORTED_STATUSES, rcdCashEffect } from '@/lib/cashReconciliation';
import { toReconReport } from '@/pages/reconciliation/reconReports';

/**
 * Patch 179 - where the Cash in Local Treasury book opens the year.
 *
 *   SET      the Treasurer (or the Accountant) typed it - Cash in Local
 *            Treasury > Opening balance. Kept as "<year>__CLT__<fund>".
 *   CARRIED  nobody typed it, so it is carried from last year's book: last
 *            year's opening (if typed) plus last year's certified RCDs,
 *            collections in and deposits out.
 *   NONE     neither exists - the book opens at nil.
 */
export interface LocalTreasuryOpening {
  amount: number;
  source: 'SET' | 'CARRIED' | 'NONE';
  loading: boolean;
}

export function localTreasuryLedgerKey(fundCode: string): string {
  return `CLT__${fundCode.toUpperCase()}`;
}

export function useLocalTreasuryOpening(
  fiscalYear: number,
  fundCode: string,
): LocalTreasuryOpening {
  const key = localTreasuryLedgerKey(fundCode);
  const set = useBankLedger(fiscalYear, key);
  const prevSet = useBankLedger(fiscalYear - 1, key);
  const prevRcds = useTreasuryReports('RCD', fiscalYear - 1, fundCode);

  const loading = set.loading || prevSet.loading || prevRcds.loading;
  if (set.data) return { amount: set.data.beginningBalance ?? 0, source: 'SET', loading };

  const prevNet = prevRcds.data
    .map(toReconReport)
    .filter((r) => REPORTED_STATUSES.has(r.status))
    .reduce((s, r) => {
      const e = rcdCashEffect(r);
      return s + e.collections - e.deposits;
    }, 0);
  const prevOpening = prevSet.data?.beginningBalance ?? 0;
  if (prevSet.data || prevRcds.data.length > 0) {
    return { amount: prevOpening + prevNet, source: 'CARRIED', loading };
  }
  return { amount: 0, source: 'NONE', loading };
}
