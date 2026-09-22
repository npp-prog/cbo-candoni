import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

/** The JEV register. */
export default function Jevs() {
  const { fiscalYear, fundCode, period } = useFilters();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');

  const { data, loading, error } = useJevs(fiscalYear, fundCode, status || undefined);

  const rows = useMemo(
    () => (period ? data.filter((j) => j.period === period) : data),
    [data, period],
  );

  const unposted = rows.filter((j) => !['POSTED', 'CANCELLED', 'REVERSED'].includes(j.status));

  const columns: Column<JournalEntryVoucher>[] = [
    {
      key: 'jevNo',
      header: 'JEV No.',
      width: '10rem',
      value: (j) => j.jevNo,
      cell: (j) => <span className="font-mono text-xs text-navy-900">{j.jevNo}</span>,
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
        title="Other journal entries"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${period ? `, ${monthName(period)}` : ''}${
          unposted.length ? ` - ${unposted.length} awaiting posting` : ''
        }`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Others' }]}
        actions={
          can('accounting', 'create') && (
            <Button variant="primary" size="sm" onClick={() => navigate('/accounting/others/new')}>
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
        onRowClick={(j) => navigate(`/accounting/others/${j.id}`)}
        searchPlaceholder="JEV number, reference or particulars"
        emptyTitle="No journal entries"
        emptyMessage="Journal entries are generated when vouchers and collection reports are approved, and can also be raised manually for adjusting and closing entries."
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
