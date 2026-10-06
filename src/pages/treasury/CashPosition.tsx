import { useMemo } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { useBankAccounts, useLedgerEntries, useDeposits, useChecks, useUndepositedCollections } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { CASH_BOOK_TABS } from '@/layout/sections';

interface PositionRow {
  bankAccountId: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  glAccountCode: string;
  bookBalance: Centavos;
  depositsInTransit: Centavos;
  outstandingChecks: Centavos;
  projectedBankBalance: Centavos;
}

/**
 * Cash position.
 *
 * Every figure here is derived from the General Ledger and the open items,
 * never stored as a balance in its own right. The book balance is the sum of
 * posted ledger entries against each bank account's GL account; deposits in
 * transit and outstanding checks come from the documents that are still open.
 *
 * The projected bank balance - book balance less deposits in transit plus
 * outstanding checks - is what the bank statement should be showing today. A
 * treasurer comparing it against online banking has a same-day check on the
 * books, without waiting for the month-end reconciliation.
 */
export default function CashPosition() {
  const { fiscalYear, fundCode } = useFilters();

  const banks = useBankAccounts(fundCode);
  const ledger = useLedgerEntries(fiscalYear, fundCode);
  const deposits = useDeposits(undefined, 'IN_TRANSIT');
  const checks = useChecks(undefined);
  const undeposited = useUndepositedCollections(fundCode);

  const rows = useMemo<PositionRow[]>(() => {
    return banks.data.map((bank) => {
      const bookBalance = ledger.data
        .filter((e) => e.accountCode === bank.glAccountCode && e.subsidiaryId === bank.id)
        .reduce((s, e) => s + (e.signedAmount ?? 0), 0);

      // Where subsidiary detail is absent - for a municipality with a single
      // account per fund it often is - fall back to the account total.
      const fallbackBalance = ledger.data
        .filter((e) => e.accountCode === bank.glAccountCode)
        .reduce((s, e) => s + (e.signedAmount ?? 0), 0);

      const depositsInTransit = deposits.data
        .filter((d) => d.bankAccountId === bank.id)
        .reduce((s, d) => s + d.amount, 0);

      const outstandingChecks = checks.data
        .filter((c) => c.bankAccountId === bank.id && ['RELEASED', 'SIGNED', 'PREPARED'].includes(c.status))
        .reduce((s, c) => s + c.netAmount, 0);

      const book = bookBalance !== 0 ? bookBalance : fallbackBalance;

      return {
        bankAccountId: bank.id,
        bankName: bank.bankName,
        accountNumber: bank.accountNumber,
        accountName: bank.accountName,
        glAccountCode: bank.glAccountCode,
        bookBalance: book,
        depositsInTransit,
        outstandingChecks,
        projectedBankBalance: book - depositsInTransit + outstandingChecks,
      };
    });
  }, [banks.data, ledger.data, deposits.data, checks.data]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          book: acc.book + r.bookBalance,
          transit: acc.transit + r.depositsInTransit,
          outstanding: acc.outstanding + r.outstandingChecks,
          projected: acc.projected + r.projectedBankBalance,
        }),
        { book: 0, transit: 0, outstanding: 0, projected: 0 },
      ),
    [rows],
  );

  const undepositedTotal = undeposited.data.reduce((s, c) => s + c.totalAmount, 0);

  const exportColumns: ExportColumn<PositionRow>[] = [
    { key: 'bank', header: 'Bank', value: (r) => r.bankName },
    { key: 'account', header: 'Account', value: (r) => r.accountNumber },
    { key: 'name', header: 'Account name', value: (r) => r.accountName },
    { key: 'book', header: 'Balance per books', kind: 'amount', value: (r) => r.bookBalance },
    { key: 'transit', header: 'Deposits in transit', kind: 'amount', value: (r) => r.depositsInTransit },
    { key: 'checks', header: 'Outstanding checks', kind: 'amount', value: (r) => r.outstandingChecks },
    { key: 'projected', header: 'Projected bank balance', kind: 'amount', value: (r) => r.projectedBankBalance },
  ];

  const loading = banks.loading || ledger.loading;

  return (
    <ReportShell
      tabs={<SectionTabs tabs={CASH_BOOK_TABS} />}
      meta={{
        title: 'Cash Position Report',
        fundLabel: fundLabel(fundCode),
        periodLabel: `As at ${formatShortDate(todayPh())}`,
      }}
      breadcrumbs={[{ label: 'Treasury' }, { label: 'Cash Position' }]}
      rows={rows}
      exportColumns={exportColumns}
      footnote={
        <>
          Balance per books is the total of posted General Ledger entries against each account.
          The projected bank balance is the book balance less deposits still in transit plus checks
          released but not yet presented - what the bank should be showing today. It is an
          indication, not a reconciliation; the formal reconciliation is prepared monthly under
          Reconciliation.
        </>
      }
    >
      {loading ? (
        <Spinner label="Deriving the cash position from the ledger" />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No bank accounts are configured for the {fundLabel(fundCode)}. Add them under Master Data.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="cbo-th">Bank and account</th>
                  <th className="cbo-th text-right">Balance per books</th>
                  <th className="cbo-th text-right">Deposits in transit</th>
                  <th className="cbo-th text-right">Outstanding checks</th>
                  <th className="cbo-th text-right">Projected bank balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.bankAccountId}>
                    <td className="cbo-td">
                      <span className="text-sm text-navy-900">{r.bankName}</span>
                      <span className="block font-mono text-2xs text-slate-500">
                        {r.accountNumber} - {r.accountName}
                      </span>
                    </td>
                    <td className="cbo-td cbo-amount">{formatPeso(r.bookBalance, { symbol: false })}</td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.depositsInTransit, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.outstandingChecks, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount font-medium">
                      {formatPeso(r.projectedBankBalance, { symbol: false })}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 font-semibold">
                  <td className="cbo-td border-b-0">Total cash in bank</td>
                  <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.book, { symbol: false })}</td>
                  <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.transit, { symbol: false })}</td>
                  <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.outstanding, { symbol: false })}</td>
                  <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.projected, { symbol: false })}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {undepositedTotal > 0 && (
            <Alert tone="warning" className="mt-4">
              A further {formatPeso(undepositedTotal)} sits with collecting officers and has not
              reached a bank account. It is not included in the figures above.
            </Alert>
          )}
        </>
      )}
    </ReportShell>
  );
}
