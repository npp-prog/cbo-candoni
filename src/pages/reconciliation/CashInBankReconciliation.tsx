import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Spinner, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Field';
import { BankAccountPicker } from '@/components/pickers';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { RECONCILIATION_TABS } from '@/layout/sections';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useAda,
  useBankAccounts,
  useBankLedger,
  useBankLedgerEntries,
  useChecks,
  useDeposits,
  useLedgerEntries,
  useTreasuryReports,
} from '@/data/queries';
import { useEntity } from '@/data/useEntity';
import { printAs, printFileName } from '@/lib/printTitle';
import { reconcileCashInBank } from '@/lib/cashReconciliation';
import { BANK_LEDGER_INFLOW } from '@/types/bankLedger';
import { fundLabel } from '../budget/Obligations';
import { defaultAsOf, toReconReport } from './CashLocalTreasuryReconciliation';
import {
  ReconciliationOnScreen,
  ReconciliationPrintSheet,
  ReconciliationSummary,
  type StatementSpec,
} from './CashReconciliationStatement';

/**
 * Patch 178 - Reconciliation of Cash in Bank: the Treasury record (the Cash in
 * Bank book of one bank account - its beginning balance, the deposits, checks
 * and ADA the Treasury released, and the entries keyed from the bank) against
 * the Accounting record (the General Ledger account of that bank account, with
 * the account as its subsidiary).
 *
 * The bank's own statement is a different reconciliation - the Bank
 * Reconciliation tab. This one proves that the Treasurer's book and the
 * Accountant's ledger say the same thing about the same account.
 */
export default function CashInBankReconciliation() {
  const { fiscalYear, fundCode } = useFilters();
  const { profile } = useAuth();
  const entity = useEntity();
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(() => defaultAsOf(fiscalYear));
  useEffect(() => setAsOf(defaultAsOf(fiscalYear)), [fiscalYear]);

  const banks = useBankAccounts(fundCode);
  const bank = banks.data.find((b) => b.id === bankAccountId) ?? null;
  const code = bank?.glAccountCode || '__none__';
  const onlyAccountOnCode =
    banks.data.filter((b) => (b.glAccountCode || '') === (bank?.glAccountCode || '')).length === 1;

  const bankLedger = useBankLedger(fiscalYear, bankAccountId);
  const manual = useBankLedgerEntries(fiscalYear, bankAccountId);
  const deposits = useDeposits(bankAccountId ?? undefined);
  const checks = useChecks(bankAccountId ?? undefined);
  const adas = useAda(bankAccountId ?? undefined);
  const ledger = useLedgerEntries(fiscalYear, fundCode, { accountCode: code });

  const rcd = useTreasuryReports('RCD', fiscalYear, fundCode);
  const rci = useTreasuryReports('RCI', fiscalYear, fundCode);
  const radai = useTreasuryReports('RADAI', fiscalYear, fundCode);
  const ear = useTreasuryReports('ERCD_AR', fiscalYear, fundCode);
  const eor = useTreasuryReports('ERCD_EOR', fiscalYear, fundCode);
  const reports = useMemo(
    () => [...rcd.data, ...rci.data, ...radai.data, ...ear.data, ...eor.data].map(toReconReport),
    [rcd.data, rci.data, radai.data, ear.data, eor.data],
  );

  const result = useMemo(() => {
    if (!bankAccountId) return null;
    return reconcileCashInBank({
      asOf,
      onlyAccountOnCode,
      reports,
      book: {
        bankAccountId,
        fiscalYear,
        beginningBalance: bankLedger.data?.beginningBalance ?? 0,
        manualEntries: manual.data.map((e) => ({
          id: e.id,
          entryDate: e.entryDate,
          kind: e.kind,
          inflow: BANK_LEDGER_INFLOW[e.kind],
          referenceNo: e.referenceNo ?? null,
          particulars: e.particulars,
          amount: e.amount,
          voided: e.voided,
        })),
        deposits: deposits.data.map((d) => ({
          id: d.id,
          fiscalYear: d.fiscalYear,
          depositDate: d.depositDate,
          depositSlipNo: d.depositSlipNo,
          amount: d.amount,
          status: d.status,
          collectingOfficerName: d.collectingOfficerName ?? null,
          rcdNo: d.rcdNo ?? null,
          jevId: d.jevId ?? null,
          treasuryReportId: d.treasuryReportId ?? null,
        })),
        checks: checks.data.map((c) => ({
          id: c.id,
          fiscalYear: c.fiscalYear,
          checkDate: c.checkDate,
          checkNo: c.checkNo,
          payeeName: c.payeeName,
          netAmount: c.netAmount,
          status: c.status,
          treasuryReportId: c.treasuryReportId ?? null,
        })),
        adas: adas.data.map((a) => ({
          id: a.id,
          fiscalYear: a.fiscalYear,
          adaDate: a.adaDate,
          adaNo: a.adaNo,
          payeeName: a.payeeName,
          amount: a.amount,
          status: a.status,
          treasuryReportId: a.treasuryReportId ?? null,
        })),
      },
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
    });
  }, [
    bankAccountId,
    asOf,
    onlyAccountOnCode,
    reports,
    fiscalYear,
    bankLedger.data,
    manual.data,
    deposits.data,
    checks.data,
    adas.data,
    ledger.data,
  ]);

  const accountLine = bank
    ? `${bank.bankName ?? ''}${bank.branch ? `, ${bank.branch}` : ''} - Account No. ${bank.accountNumber ?? ''}`
    : '';

  const spec: StatementSpec = {
    title: 'Reconciliation of Cash in Bank',
    subtitle: 'Treasury Records and Accounting Records',
    fundLabel: fundLabel(fundCode),
    lines: accountLine ? [accountLine] : [],
    treasuryLabel: 'Balance per Treasury records (Cash in Bank book)',
    booksLabel: `Balance per General Ledger (${bank?.glAccountCode ?? ''} ${bank?.accountName ?? 'Cash in Bank'}, this account)`,
    preparedBy: {
      name: entity.bookkeeper.name || profile?.displayName || '',
      position: entity.bookkeeper.position || profile?.position || '',
    },
    treasurer: entity.localTreasurer,
    accountant: entity.municipalAccountant,
  };

  const loading =
    bankLedger.loading ||
    manual.loading ||
    deposits.loading ||
    checks.loading ||
    adas.loading ||
    ledger.loading ||
    rcd.loading ||
    rci.loading ||
    radai.loading;

  return (
    <div>
      <PageHeader
        title="Reconciliation of Cash in Bank"
        subtitle={`${fundLabel(fundCode)} - Treasury records and Accounting records`}
        breadcrumbs={[
          { label: 'Reconciliation', to: '/reconciliation' },
          { label: 'Cash in Bank' },
        ]}
        actions={
          <Button
            variant="primary"
            disabled={!result || loading}
            onClick={() =>
              printAs(
                printFileName(
                  'Reconciliation of Cash in Bank',
                  `${bank?.accountNumber ?? ''} ${asOf}`,
                ),
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
          <Field label="Bank account" className="w-full max-w-md">
            <BankAccountPicker
              value={bankAccountId}
              onChange={setBankAccountId}
              fundCode={fundCode}
            />
          </Field>
          <Field label="As of">
            <TextInput
              type="date"
              value={asOf}
              min={`${fiscalYear}-01-01`}
              max={`${fiscalYear}-12-31`}
              onChange={(e) => e.target.value && setAsOf(e.target.value)}
            />
          </Field>
        </div>
        <p className="mt-3 max-w-3xl text-xs text-slate-500">
          The Treasurer&apos;s Cash in Bank book - beginning balance, deposits in transit or
          credited, checks released, ADA submitted, and entries keyed from the bank - is traced
          document by document to the General Ledger of this bank account. Only what does not agree
          is listed, with the reason.
        </p>
      </Card>

      {!bankAccountId ? (
        <Alert tone="info" title="Choose a bank account">
          Each bank account is reconciled on its own, as its Cash in Bank book is kept.
        </Alert>
      ) : bank && !bank.glAccountCode ? (
        <Alert tone="warning" title="This bank account has no General Ledger account">
          Set its GL account under Master Data &rsaquo; Bank Accounts; until then the books cannot
          be read for it.
        </Alert>
      ) : loading || !result ? (
        <Spinner label="Reading the Cash in Bank book and the General Ledger" />
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
