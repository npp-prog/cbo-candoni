import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Field';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { RECONCILIATION_TABS } from '@/layout/sections';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDeposits, useLedgerEntries, useTreasuryReports } from '@/data/queries';
import { useEntity } from '@/data/useEntity';
import { CASH_LOCAL_TREASURY } from '@/lib/chartOfAccounts';
import { todayPh } from '@/lib/dates';
import { printAs, printFileName } from '@/lib/printTitle';
import { reconcileLocalTreasury, type ReconReport } from '@/lib/cashReconciliation';
import type { TreasuryReport } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import {
  ReconciliationOnScreen,
  ReconciliationPrintSheet,
  ReconciliationSummary,
  type StatementSpec,
} from './CashReconciliationStatement';

/**
 * Patch 178 - Reconciliation of Cash in Local Treasury: the Treasury records
 * (the Cash in Local Treasury cash book, built from the certified RCDs)
 * against the Accounting records (the General Ledger, Cash - Local Treasury).
 *
 * Every RCD is looked for in the books, and every line of the books on Cash -
 * Local Treasury is traced to the RCD (or the deposit) that raised it. What
 * agrees is counted; what does not is listed with the reason - certified but
 * not yet forwarded, forwarded but not journalized, journalized after the
 * date, journalized for a different amount, withdrawn with its entry still
 * standing, or an entry made in Accounting with no RCD behind it.
 */

export function toReconReport(r: TreasuryReport): ReconReport {
  return {
    id: r.id,
    reportType: r.reportType,
    reportNo: r.reportNo ?? null,
    reportDate: r.reportDate,
    status: r.status,
    forwardedAt: r.forwardedAt,
    jevId: r.jevId ?? null,
    jevNo: r.jevNo ?? null,
    accountableOfficerName: r.accountableOfficerName ?? null,
    cancelledReason: r.cancelledReason ?? (r as { cancelReason?: string }).cancelReason ?? null,
    lines: (r.lines ?? []).map((l) => ({
      sourceId: l.sourceId,
      sourceNo: l.sourceNo,
      amount: l.amount,
      excluded: l.excluded,
    })),
    deposits: (r.deposits ?? []).map((d) => ({
      sourceId: d.sourceId,
      depositSlipNo: d.depositSlipNo ?? null,
      amount: d.amount,
    })),
  };
}

export function defaultAsOf(fiscalYear: number): string {
  const today = todayPh();
  return today.slice(0, 4) === String(fiscalYear) ? today : `${fiscalYear}-12-31`;
}

export default function CashLocalTreasuryReconciliation() {
  const { fiscalYear, fundCode } = useFilters();
  const { profile } = useAuth();
  const entity = useEntity();
  const [asOf, setAsOf] = useState(() => defaultAsOf(fiscalYear));
  useEffect(() => setAsOf(defaultAsOf(fiscalYear)), [fiscalYear]);

  const rcds = useTreasuryReports('RCD', fiscalYear, fundCode);
  const ledger = useLedgerEntries(fiscalYear, fundCode, { accountCode: CASH_LOCAL_TREASURY.code });
  const deposits = useDeposits();

  const result = useMemo(
    () =>
      reconcileLocalTreasury({
        fiscalYear,
        asOf,
        rcds: rcds.data.map(toReconReport),
        ledger: ledger.data.map((e) => ({
          id: e.id,
          jevId: e.jevId,
          jevNo: e.jevNo,
          entryDate: e.entryDate,
          accountCode: e.accountCode,
          debit: e.debit,
          credit: e.credit,
          sourceType: e.sourceType,
          sourceId: e.sourceId ?? null,
          referenceNo: e.referenceNo ?? null,
          particulars: e.particulars ?? null,
          subsidiaryId: e.subsidiaryId ?? null,
        })),
        deposits: deposits.data.map((d) => ({ id: d.id, treasuryReportId: d.treasuryReportId })),
      }),
    [fiscalYear, asOf, rcds.data, ledger.data, deposits.data],
  );

  const spec: StatementSpec = {
    title: 'Reconciliation of Cash in Local Treasury',
    subtitle: 'Treasury Records and Accounting Records',
    fundLabel: fundLabel(fundCode),
    treasuryLabel: 'Balance per Treasury records (Cash in Local Treasury cash book, from the RCDs)',
    booksLabel: `Balance per General Ledger (${CASH_LOCAL_TREASURY.code} ${CASH_LOCAL_TREASURY.name})`,
    preparedBy: {
      name: entity.bookkeeper.name || profile?.displayName || '',
      position: entity.bookkeeper.position || profile?.position || '',
    },
    treasurer: entity.localTreasurer,
    accountant: entity.municipalAccountant,
  };

  const loading = rcds.loading || ledger.loading;

  return (
    <div>
      <PageHeader
        title="Reconciliation of Cash in Local Treasury"
        subtitle={`${fundLabel(fundCode)} - Treasury records and Accounting records`}
        breadcrumbs={[
          { label: 'Reconciliation', to: '/reconciliation' },
          { label: 'Cash in Local Treasury' },
        ]}
        actions={
          <Button
            variant="primary"
            disabled={loading}
            onClick={() =>
              printAs(
                printFileName('Reconciliation of Cash in Local Treasury', `${fundCode} ${asOf}`),
              )
            }
          >
            Print
          </Button>
        }
      />
      <SectionTabs tabs={RECONCILIATION_TABS} />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="As of">
            <TextInput
              type="date"
              value={asOf}
              min={`${fiscalYear}-01-01`}
              max={`${fiscalYear}-12-31`}
              onChange={(e) => e.target.value && setAsOf(e.target.value)}
            />
          </Field>
          <p className="max-w-2xl text-xs text-slate-500">
            Each certified RCD (its collections in, its deposits out) is traced to its journal entry
            on {CASH_LOCAL_TREASURY.code} {CASH_LOCAL_TREASURY.name}, and every line of that account
            in the General Ledger to the RCD or deposit that raised it. Only what does not agree is
            listed, with the reason.
          </p>
        </div>
      </Card>

      {loading ? (
        <Spinner label="Reading the RCDs and the General Ledger" />
      ) : (
        <>
          <ReconciliationSummary result={result} />
          <ReconciliationOnScreen result={result} spec={spec} />
          <ReconciliationPrintSheet result={result} spec={spec} />
        </>
      )}
    </div>
  );
}
