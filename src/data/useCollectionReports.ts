import { useMemo } from 'react';
import { useRcds, useTreasuryReports } from '@/data/queries';
import {
  awaitingJournal,
  collectionReportAsRcd,
  type ReairrRcd,
} from '@/pages/budget/reairrReport';

/**
 * Every report of collections for a year and fund, in one shape. Patch 131.
 *
 * The old `rcds` records and the reports made on the Treasury Reports screen
 * (RCD, and the two e-collection reports). The Registry of Income and the
 * Statement of Comparison of Budget and Actual Amounts both read this, so the
 * two count the same collections.
 */
export function useCollectionReports(fiscalYear: number, fundCode: string) {
  const legacy = useRcds(fiscalYear, fundCode);
  const rcd = useTreasuryReports('RCD', fiscalYear, fundCode);
  const ar = useTreasuryReports('ERCD_AR', fiscalYear, fundCode);
  const eor = useTreasuryReports('ERCD_EOR', fiscalYear, fundCode);

  const data = useMemo<ReairrRcd[]>(
    () => [
      ...legacy.data,
      ...[...rcd.data, ...ar.data, ...eor.data]
        .map(collectionReportAsRcd)
        .filter((r): r is ReairrRcd => r !== null),
    ],
    [legacy.data, rcd.data, ar.data, eor.data],
  );

  const waiting = useMemo(
    () => awaitingJournal([...rcd.data, ...ar.data, ...eor.data]),
    [rcd.data, ar.data, eor.data],
  );

  return {
    data,
    waiting,
    loading: legacy.loading || rcd.loading || ar.loading || eor.loading,
    error: legacy.error ?? rcd.error ?? ar.error ?? eor.error,
  };
}
