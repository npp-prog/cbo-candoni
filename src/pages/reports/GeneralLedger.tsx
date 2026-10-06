import { useMemo, useState } from 'react';
import { UnpostedEntriesNote } from '@/components/UnpostedEntriesNote';
import { Link } from 'react-router-dom';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field } from '@/components/ui/Field';
import { AccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAccounts, useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import type { LedgerEntry } from '@/types/accounting';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { REPORT_TABS } from '@/layout/sections';

interface GlRow extends LedgerEntry {
  runningBalance: Centavos;
}

/**
 * The General Ledger.
 *
 * One account at a time, in date order, with a running balance. Each row links
 * back to the journal entry that produced it and from there to the source
 * document, which is the trail an auditor follows: a figure on a statement,
 * to the ledger, to the JEV, to the voucher, to the scanned invoice.
 */
export default function GeneralLedger() {
  const { fiscalYear, fundCode } = useFilters();
  const accounts = useAccounts(false);
  const [accountCode, setAccountCode] = useState<string | null>(null);

  const ledger = useLedgerEntries(fiscalYear, fundCode, { accountCode: accountCode ?? undefined });

  const account = accounts.data.find((a) => a.code === accountCode);

  const rows = useMemo<GlRow[]>(() => {
    if (!accountCode) return [];
    let running = 0;
    return [...ledger.data]
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.jevNo.localeCompare(b.jevNo))
      .map((e) => {
        running += e.signedAmount ?? 0;
        return { ...e, runningBalance: running };
      });
  }, [ledger.data, accountCode]);

  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + (r.debit ?? 0), credit: acc.credit + (r.credit ?? 0) }),
    { debit: 0, credit: 0 },
  );

  const closingBalance = rows.length > 0 ? rows[rows.length - 1].runningBalance : 0;
  const isCreditNormal = account?.normalBalance === 'CREDIT';

  const exportColumns: ExportColumn<GlRow>[] = [
    { key: 'date', header: 'Date', value: (r) => r.entryDate, kind: 'date' },
    { key: 'jev', header: 'JEV No.', value: (r) => r.jevNo },
    { key: 'ref', header: 'Reference', value: (r) => r.referenceNo ?? '' },
    { key: 'payee', header: 'Payee', value: (r) => r.payeeName ?? '' },
    { key: 'particulars', header: 'Particulars', value: (r) => r.particulars ?? '' },
    { key: 'debit', header: 'Debit', kind: 'amount', value: (r) => r.debit },
    { key: 'credit', header: 'Credit', kind: 'amount', value: (r) => r.credit },
    { key: 'balance', header: 'Balance', kind: 'amount', value: (r) => r.runningBalance },
  ];

  return (
    <ReportShell
      tabs={<SectionTabs tabs={REPORT_TABS} />}
      meta={{
        title: 'General Ledger',
        fundLabel: fundLabel(fundCode),
        periodLabel: account
          ? `${account.code} - ${account.name}, fiscal year ${fiscalYear}`
          : `Fiscal year ${fiscalYear}`,
        preparedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'General Ledger' }]}
      rows={rows}
      exportColumns={accountCode ? exportColumns : undefined}
      filters={
        <Field label="Account" className="min-w-[24rem]">
          <AccountPicker value={accountCode} onChange={(code) => setAccountCode(code)} />
        </Field>
      }
      footnote={
        account && (
          <>
            {account.name} is {isCreditNormal ? 'credit' : 'debit'}-normal. A positive running
            balance above means a debit balance; a figure in parentheses is a credit balance.
          </>
        )
      }
    >
      {!accountCode ? (
        <Alert tone="info">
          Choose an account to see its ledger. The ledger is the record of truth for every balance
          in CFMS - every financial statement figure traces back to entries shown here.
        </Alert>
      ) : ledger.loading ? (
        <Spinner label="Reading the General Ledger" />
      ) : rows.length === 0 ? (
        <div className="py-8">
          <p className="text-center text-sm text-slate-500">
            No entries have been posted against {account?.code} {account?.name} for the{' '}
            {fundLabel(fundCode)} in {fiscalYear}.
          </p>
          <UnpostedEntriesNote fiscalYear={fiscalYear} fundCode={fundCode} className="mt-4" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="cbo-th w-24">Date</th>
                <th className="cbo-th w-32">JEV No.</th>
                <th className="cbo-th w-28">Reference</th>
                <th className="cbo-th">Particulars</th>
                <th className="cbo-th w-36 text-right">Debit</th>
                <th className="cbo-th w-36 text-right">Credit</th>
                <th className="cbo-th w-40 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.isReversal ? 'bg-violet-50/40' : undefined}>
                  <td className="cbo-td text-xs">{formatShortDate(r.entryDate)}</td>
                  <td className="cbo-td">
                    <Link
                      to={`/accounting/general-transactions/${r.jevId}`}
                      className="font-mono text-xs text-brand-700 hover:underline no-print"
                    >
                      {r.jevNo}
                    </Link>
                    <span className="hidden font-mono text-xs print:inline">{r.jevNo}</span>
                  </td>
                  <td className="cbo-td font-mono text-xs text-slate-500">{r.referenceNo ?? '-'}</td>
                  <td className="cbo-td">
                    <span className="text-xs text-navy-800">{r.particulars}</span>
                    {r.payeeName && <span className="block text-2xs text-slate-500">{r.payeeName}</span>}
                  </td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.debit, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.credit, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount font-medium">
                    {formatPeso(r.runningBalance, { symbol: false, parens: true })}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy-800 font-semibold">
                <td className="cbo-td border-b-0" colSpan={4}>
                  Total - {rows.length} entries
                </td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.debit, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.credit, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(closingBalance, { symbol: false, parens: true })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </ReportShell>
  );
}
