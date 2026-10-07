import { useMemo, useState } from 'react';
import { UnpostedEntriesNote } from '@/components/UnpostedEntriesNote';
import { Link } from 'react-router-dom';
import { ReportShell } from '@/components/ReportShell';
import { Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate, monthName } from '@/lib/dates';
import { JOURNAL_BOOKS, type JournalBook } from '@/types/enums';
import type { ExportColumn } from '@/lib/export';
import type { LedgerEntry } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { REPORT_TAB_GROUPS } from '@/layout/sections';

const BOOK_LABELS: Record<JournalBook, string> = {
  GENERAL_JOURNAL: 'General Journal',
  CASH_DISBURSEMENTS_JOURNAL: 'Cash Disbursements Journal',
  CHECK_DISBURSEMENTS_JOURNAL: 'Check Disbursements Journal',
  ADA_DISBURSEMENTS_JOURNAL: 'ADA Disbursements Journal',
  CASH_RECEIPTS_JOURNAL: 'Cash Receipts Journal',
  PROCUREMENT_RECEIVED_JOURNAL: 'Procurement Received Journal',
};

/**
 * The books of original entry.
 *
 * Which book an entry lands in is decided at posting time by the kind of
 * transaction it came from - a voucher paid by check goes to the Check
 * Disbursements Journal, a report of collections to the Cash Receipts
 * Journal - so the journals are a view of the ledger rather than a separate
 * set of records that could drift from it.
 */
export default function Journals() {
  const { fiscalYear, fundCode, period } = useFilters();
  const [book, setBook] = useState<JournalBook>('GENERAL_JOURNAL');
  const [selectedPeriod, setSelectedPeriod] = useState<number>(period ?? 0);

  const ledger = useLedgerEntries(fiscalYear, fundCode, { book });

  const rows = useMemo(
    () =>
      ledger.data
        .filter((e) => selectedPeriod === 0 || e.period === selectedPeriod)
        .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.jevNo.localeCompare(b.jevNo) || a.jevLineNo - b.jevLineNo),
    [ledger.data, selectedPeriod],
  );

  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + (r.debit ?? 0), credit: acc.credit + (r.credit ?? 0) }),
    { debit: 0, credit: 0 },
  );

  const exportColumns: ExportColumn<LedgerEntry>[] = [
    { key: 'date', header: 'Date', kind: 'date', value: (r) => r.entryDate },
    { key: 'jev', header: 'JEV No.', value: (r) => r.jevNo },
    // The transaction type and the reference together say where the entry came
    // from: "DV 2026-09-0123" rather than a number with no kind attached.
    { key: 'type', header: 'Transaction Type', value: (r) => r.sourceType ?? '' },
    { key: 'ref', header: 'Source Reference No.', value: (r) => r.referenceNo ?? '' },
    { key: 'payee', header: 'Payee', value: (r) => r.payeeName ?? '' },
    { key: 'code', header: 'Account Code', value: (r) => r.accountCode },
    { key: 'account', header: 'Account Title', value: (r) => r.accountName },
    { key: 'fpp', header: 'FPP Code', value: (r) => r.fppCode ?? '' },
    { key: 'fppName', header: 'FPP Name', value: (r) => r.fppName ?? '' },
    { key: 'subsidiary', header: 'Subsidiary', value: (r) => r.subsidiaryName ?? '' },
    { key: 'particulars', header: 'Particulars', value: (r) => r.particulars ?? '' },
    { key: 'debit', header: 'Debit', kind: 'amount', value: (r) => r.debit },
    { key: 'credit', header: 'Credit', kind: 'amount', value: (r) => r.credit },
  ];

  return (
    <ReportShell
      tabs={<GroupedSectionTabs groups={REPORT_TAB_GROUPS} />}
      meta={{
        title: BOOK_LABELS[book],
        fundLabel: fundLabel(fundCode),
        periodLabel:
          selectedPeriod === 0
            ? `For the fiscal year ${fiscalYear}`
            : `For the month of ${monthName(selectedPeriod)} ${fiscalYear}`,
        preparedBy: 'Municipal Accountant',
        certifiedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Journals' }]}
      rows={rows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="Journal" className="min-w-[18rem]">
            <Select value={book} onChange={(e) => setBook(e.target.value as JournalBook)}>
              {JOURNAL_BOOKS.map((b) => (
                <option key={b} value={b}>
                  {BOOK_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Period">
            <Select value={selectedPeriod} onChange={(e) => setSelectedPeriod(Number(e.target.value))}>
              <option value={0}>Whole year</option>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={<>{rows.length} lines from posted journal entries.</>}
    >
      {ledger.loading ? (
        <Spinner label="Reading the journal" />
      ) : rows.length === 0 ? (
        <div className="py-8">
          <p className="text-center text-sm text-slate-500">
            No entries have been posted to the {BOOK_LABELS[book]} for this fund and period.
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
                <th className="cbo-th w-28">Type / Reference</th>
                <th className="cbo-th">Account and particulars</th>
                <th className="cbo-th w-36 text-right">Debit</th>
                <th className="cbo-th w-36 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="cbo-td text-xs">{formatShortDate(r.entryDate)}</td>
                  <td className="cbo-td">
                    <Link to={`/accounting/general-transactions/${r.jevId}`} className="font-mono text-xs text-brand-700 hover:underline">
                      {r.jevNo}
                    </Link>
                  </td>
                  <td className="cbo-td">
                    <span className="block text-2xs uppercase tracking-wide text-slate-400">
                      {r.sourceType}
                    </span>
                    <span className="font-mono text-xs text-slate-500">{r.referenceNo ?? '-'}</span>
                  </td>
                  <td className="cbo-td">
                    <span className="font-mono text-2xs text-slate-400">{r.accountCode}</span>{' '}
                    <span className="text-sm">{r.accountName}</span>
                    {r.fppCode && (
                      <span className="block text-2xs text-slate-500">
                        FPP {r.fppCode} {r.fppName}
                      </span>
                    )}
                    <span className="block text-2xs text-slate-500">
                      {[r.subsidiaryName, r.payeeName, r.particulars].filter(Boolean).join(' - ')}
                    </span>
                  </td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.debit, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.credit, { symbol: false, dash: true })}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy-800 font-semibold">
                <td className="cbo-td border-b-0" colSpan={4}>
                  Total
                </td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.debit, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.credit, { symbol: false })}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </ReportShell>
  );
}
