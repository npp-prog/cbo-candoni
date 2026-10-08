import { useMemo, useState } from 'react';
import { awaitingPosting } from '@/lib/postingQueue';
import { directEntries } from '@/lib/jevSources';
import { hasJevNumber } from '@/lib/jevNumbers';
import { newestFirst } from '@/lib/registerOrder';
import { useOpenWithReturn } from '@/components/ui/BackButton';
import { PageHeader } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useJevs } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate, monthName } from '@/lib/dates';
import { JEV_STATUSES, STATUS_LABELS } from '@/types/enums';
import type { JournalEntryVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

const BOOK_LABELS: Record<string, string> = {
  GENERAL_JOURNAL: 'General Journal',
  CASH_DISBURSEMENTS_JOURNAL: 'Cash Disbursements',
  CHECK_DISBURSEMENTS_JOURNAL: 'Check Disbursements',
  ADA_DISBURSEMENTS_JOURNAL: 'ADA Disbursements',
  CASH_RECEIPTS_JOURNAL: 'Cash Receipts',
  PROCUREMENT_RECEIVED_JOURNAL: 'Procurement Received',
};

/**
 * The entries Accounting writes itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE ANY MORE
 * ---------------------------------------------------------------------------
 * The entries raised by a document - every disbursement voucher, every
 * treasury report, every liquidation - used to be listed here as well, and
 * there are hundreds of them in a year. The dozen entries somebody actually
 * had to sit down and write were lost among them.
 *
 * Those entries each have a screen of their own already: the voucher's screen,
 * the report's screen. This one is for the entries that have no document
 * behind them - adjusting, closing, reversing, prior-period, and the bank
 * adjustments - which is to say the ones that begin here.
 *
 * Every entry in the books, whatever raised it, is in the JOURNAL ENTRIES
 * REGISTER, the next item on the menu.
 */
export default function Jevs() {
  const { fiscalYear, fundCode, period } = useFilters();
  const { can } = useAuth();
  /* Opens a document remembering this table, so its Back button returns here. */
  const open = useOpenWithReturn();
  const [status, setStatus] = useState('');

  const { data, loading, error } = useJevs(fiscalYear, fundCode, status || undefined);

  const rows = useMemo(() => {
    const inPeriod = period ? data.filter((j) => j.period === period) : data;
    return newestFirst(directEntries(inPeriod), (j) => ({
      ref: hasJevNumber(j.jevNo) ? j.jevNo : '',
      date: j.jevDate,
    }));
  }, [data, period]);

  const unposted = awaitingPosting(rows);

  const columns: Column<JournalEntryVoucher>[] = [
    {
      key: 'jevNo',
      header: 'JEV No.',
      width: '10rem',
      value: (j) => (hasJevNumber(j.jevNo) ? j.jevNo : ''),
      cell: (j) =>
        hasJevNumber(j.jevNo) ? (
          <span className="font-mono text-xs text-navy-900">{j.jevNo}</span>
        ) : (
          // An entry draws its number from the journal series when it is
          // posted, so one that is waiting has none.
          <span className="text-xs italic text-slate-400">not yet posted</span>
        ),
    },
    {
      key: 'jevDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (j) => j.jevDate,
      cell: (j) => <span className="text-xs">{formatShortDate(j.jevDate)}</span>,
    },
    {
      key: 'book',
      header: 'Book',
      width: '11rem',
      value: (j) => BOOK_LABELS[j.book] ?? j.book,
      cell: (j) => <span className="text-xs text-slate-600">{BOOK_LABELS[j.book] ?? j.book}</span>,
    },
    {
      key: 'source',
      header: 'Source',
      width: '9rem',
      value: (j) => j.referenceNo ?? j.sourceType,
      cell: (j) => (
        <div className="text-xs">
          <span className="text-slate-500">{j.sourceType}</span>
          {j.referenceNo && <span className="block font-mono text-navy-800">{j.referenceNo}</span>}
        </div>
      ),
    },
    {
      key: 'particulars',
      header: 'Particulars',
      value: (j) => j.particulars,
      cell: (j) => (
        <span className="line-clamp-2 text-xs text-slate-600" title={j.particulars}>
          {j.particulars}
        </span>
      ),
    },
    {
      key: 'totalDebit',
      header: 'Debit',
      kind: 'amount',
      value: (j) => j.totalDebit,
      cell: (j) => formatPeso(j.totalDebit, { symbol: false }),
    },
    {
      key: 'totalCredit',
      header: 'Credit',
      kind: 'amount',
      value: (j) => j.totalCredit,
      cell: (j) => formatPeso(j.totalCredit, { symbol: false }),
    },
    {
      key: 'status',
      header: 'Status',
      width: '8rem',
      value: (j) => j.status,
      cell: (j) => <StatusBadge status={j.status} />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="General transactions"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${period ? `, ${monthName(period)}` : ''}${
          unposted.length ? ` - ${unposted.length} awaiting posting` : ''
        }`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'General Transactions' }]}
        actions={
          can('accounting', 'create') && (
            <Button variant="primary" size="sm" onClick={() => open('/accounting/general-transactions/new')}>
              New journal entry
            </Button>
          )
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(j) => j.id}
        loading={loading}
        error={error}
        onRowClick={(j) => open(`/accounting/general-transactions/${j.id}`)}
        searchPlaceholder="JEV number, reference or particulars"
        emptyTitle="No entries written here"
        emptyMessage="This screen holds the entries Accounting writes itself - adjusting, closing, reversing and prior-period entries, and bank adjustments. Entries raised by a voucher or a treasury report are on the document's own screen, and all of them together are in the Journal Entries Register."
        filters={
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-auto py-1.5 text-sm"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {JEV_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        }
        exportMeta={{
          title: 'Journal Entry Voucher Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: period
            ? `For the month of ${monthName(period)} ${fiscalYear}`
            : `For the fiscal year ${fiscalYear}`,
        }}
      />
    </div>
  );
}
