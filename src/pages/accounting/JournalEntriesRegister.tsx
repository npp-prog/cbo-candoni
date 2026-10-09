import { useMemo, useState } from 'react';
import { useOpenWithReturn } from '@/components/ui/BackButton';
import { PageHeader } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useJevs } from '@/data/queries';
import { awaitingPosting, totalAwaitingPosting } from '@/lib/postingQueue';
import { isDirectEntry } from '@/lib/jevSources';
import { hasJevNumber } from '@/lib/jevNumbers';
import { newestFirst } from '@/lib/registerOrder';
import { formatPeso } from '@/lib/money';
import { formatShortDate, monthName } from '@/lib/dates';
import { JEV_STATUSES, JEV_SOURCE_LABELS, STATUS_LABELS } from '@/types/enums';
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

/** Which entries this screen is showing. */
const ORIGINS = [
  { id: '', label: 'Every entry' },
  { id: 'DOCUMENT', label: 'Raised by a document' },
  { id: 'DIRECT', label: 'Written in Accounting' },
];

/**
 * The Journal Entries Register - every entry in the books, whatever raised it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 * A journal entry in CFMS can be raised in six or seven different places - a
 * disbursement voucher, each of the four treasury reports, a liquidation, a
 * payroll - and each of those has a screen of its own. That is right for the
 * work: the Accountant checking a voucher's entry wants the voucher in front
 * of them.
 *
 * It is wrong for the question "what entries were made in March". Answering
 * that meant opening six screens and adding them up, and an entry that was
 * made somewhere nobody thought to look was simply not found.
 *
 * So this is the book: one row per Journal Entry Voucher, in number order,
 * showing where it came from and whether it has reached the General Ledger. It
 * is read, not worked in. An entry is still posted where it belongs - on the
 * voucher that raised it, or on General Transactions for the entries Accounting
 * writes itself - and clicking a row here opens it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is not the General Ledger and it does not show balances. An entry listed
 * here as DRAFT is not in the ledger and is not in any financial statement,
 * and the Status column is the only honest way to say so. The register lists
 * the vouchers; the ledger carries the posted ones.
 */
/** Patch 152: the default status filter. */
const NOT_CANCELLED = '__NOT_CANCELLED__';

export default function JournalEntriesRegister() {
  const { fiscalYear, fundCode, period } = useFilters();
  /* Opens a document remembering this table, so its Back button returns here. */
  const open = useOpenWithReturn();
  /*
   * Patch 152: by default every status EXCEPT cancelled - a cancelled entry
   * never reached the books, and it is looked for on purpose, not scrolled
   * past every day.
   */
  const [status, setStatus] = useState(NOT_CANCELLED);
  const [origin, setOrigin] = useState('');

  const { data, loading, error } = useJevs(
    fiscalYear,
    fundCode,
    status && status !== NOT_CANCELLED ? status : undefined,
  );

  const rows = useMemo(() => {
    let out = period ? data.filter((j) => j.period === period) : data;
    if (status === NOT_CANCELLED) out = out.filter((j) => j.status !== 'CANCELLED');
    if (origin === 'DIRECT') out = out.filter((j) => isDirectEntry(j.sourceType));
    if (origin === 'DOCUMENT') out = out.filter((j) => !isDirectEntry(j.sourceType));
    const sorted = newestFirst(out, (j) => ({
      ref: hasJevNumber(j.jevNo) ? j.jevNo : '',
      date: j.jevDate,
    }));
    /*
     * Patch 152: the entries with no JEV number yet go LAST - after every
     * numbered entry, so the register reads as the book, in number order.
     * Those waiting to be posted are still counted at the top (awaitingPosting).
     */
    return [
      ...sorted.filter((j) => hasJevNumber(j.jevNo)),
      ...sorted.filter((j) => !hasJevNumber(j.jevNo)),
    ];
  }, [data, period, origin, status]);

  const waiting = useMemo(() => awaitingPosting(rows), [rows]);

  const columns: Column<JournalEntryVoucher>[] = [
    {
      key: 'jevNo',
      header: 'JEV No.',
      width: '11rem',
      value: (j) => (hasJevNumber(j.jevNo) ? j.jevNo : ''),
      cell: (j) =>
        hasJevNumber(j.jevNo) ? (
          <span className="font-mono text-xs text-navy-900">{j.jevNo}</span>
        ) : (
          // An entry takes its number from the journal series when it is
          // posted, so an unposted one has none yet. Showing a blank cell
          // reads as a fault; this says what it is.
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
      key: 'origin',
      header: 'Raised by',
      width: '12rem',
      value: (j) => JEV_SOURCE_LABELS[j.sourceType] ?? j.sourceType,
      cell: (j) => (
        <div className="text-xs">
          <span className="text-slate-600">
            {JEV_SOURCE_LABELS[j.sourceType] ?? j.sourceType}
          </span>
          {j.referenceNo && (
            <span className="block font-mono text-navy-800">{j.referenceNo}</span>
          )}
        </div>
      ),
    },
    {
      key: 'book',
      header: 'Book',
      width: '10rem',
      value: (j) => BOOK_LABELS[j.book] ?? j.book,
      cell: (j) => <span className="text-xs text-slate-600">{BOOK_LABELS[j.book] ?? j.book}</span>,
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
        title="Journal Entries Register"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${
          period ? `, ${monthName(period)}` : ''
        } - ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}${
          waiting.length
            ? `, of which ${waiting.length} not yet posted (${formatPeso(
                totalAwaitingPosting(waiting),
              )})`
            : ''
        }`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Journal Entries Register' }]}
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(j) => j.id}
        loading={loading}
        error={error}
        onRowClick={(j) => open(`/accounting/journal-entries/${j.id}`)}
        searchPlaceholder="JEV number, reference or particulars"
        emptyTitle="No journal entries"
        emptyMessage="No journal entry has been raised for this fund and year yet. An entry appears here as soon as it is prepared - from a voucher, from a treasury report, or written in General Transactions - and carries its number once it is posted."
        filters={
          <>
            <Select
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Filter by origin"
            >
              {ORIGINS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Filter by status"
            >
              <option value={NOT_CANCELLED}>All statuses but cancelled</option>
              <option value="">All statuses</option>
              {JEV_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </>
        }
        exportMeta={{
          title: 'Journal Entries Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: period
            ? `For the month of ${monthName(period)} ${fiscalYear}`
            : `For the fiscal year ${fiscalYear}`,
        }}
      />
    </div>
  );
}
