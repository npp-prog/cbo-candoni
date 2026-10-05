import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { newestFirst } from '@/lib/registerOrder';
import { PageHeader } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useLiquidations } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { Liquidation as LiquidationRecord } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/**
 * Liquidation reports.
 *
 * The control here is specific and easy to get wrong: the total liquidated
 * plus refunded may not exceed the advance, unless the excess is explicitly
 * claimed as a reimbursement - which is a separate payable to the officer,
 * not a liquidation of the advance. Without that distinction an
 * over-liquidation quietly creates a credit balance in the advances account
 * that nobody notices until year end.
 */
export default function Liquidation() {
  const { fiscalYear, fundCode } = useFilters();
  const { can } = useAuth();
  const navigate = useNavigate();

  const { data, loading, error } = useLiquidations(fiscalYear);


  const rows = useMemo(
    () =>
      newestFirst(
        data.filter((l) => l.fundCode === fundCode),
        (l) => ({ ref: l.liquidationNo, date: l.liquidationDate }),
      ),
    [data, fundCode],
  );

  const columns: Column<LiquidationRecord>[] = [
    {
      key: 'no',
      header: 'Report No.',
      width: '10rem',
      value: (l) => l.liquidationNo ?? '',
      cell: (l) =>
        l.liquidationNo && l.liquidationNo !== '(unnumbered)' ? (
          <span className="font-mono text-xs">{l.liquidationNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Draft</span>
        ),
    },
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (l) => l.liquidationDate,
      cell: (l) => <span className="text-xs">{formatShortDate(l.liquidationDate)}</span>,
    },
    {
      key: 'officer',
      header: 'Accountable officer',
      value: (l) => l.accountableOfficerName,
      cell: (l) => (
        <div>
          <span className="text-sm">{l.accountableOfficerName}</span>
          <span className="block text-2xs text-slate-500">{l.officeName}</span>
        </div>
      ),
    },
    {
      key: 'dvNo',
      header: 'Cash advance',
      width: '10rem',
      value: (l) => l.dvNo,
      cell: (l) => <span className="font-mono text-xs text-slate-500">{l.dvNo}</span>,
    },
    {
      key: 'granted',
      header: 'Granted',
      kind: 'amount',
      value: (l) => l.amountGranted,
      cell: (l) => formatPeso(l.amountGranted, { symbol: false }),
    },
    {
      key: 'liquidated',
      header: 'Liquidated',
      kind: 'amount',
      value: (l) => l.amountLiquidated,
      cell: (l) => formatPeso(l.amountLiquidated, { symbol: false }),
    },
    {
      key: 'refund',
      header: 'Refund',
      kind: 'amount',
      value: (l) => l.refundAmount,
      cell: (l) => formatPeso(l.refundAmount, { symbol: false, dash: true }),
    },
    {
      key: 'reimbursement',
      header: 'Reimbursement',
      kind: 'amount',
      value: (l) => l.reimbursementAmount,
      cell: (l) => formatPeso(l.reimbursementAmount, { symbol: false, dash: true }),
      optional: true,
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      kind: 'amount',
      value: (l) => l.outstandingBalance,
      cell: (l) => formatPeso(l.outstandingBalance, { symbol: false, dash: true }),
    },
    {
      key: 'status',
      header: 'Status',
      width: '10rem',
      value: (l) => l.status,
      fixed: true,
      sortable: false,
      cell: (l) => (
        /*
          Post used to be a button here. It is on the report's own page now,
          beside the expenses it covers, the entry it will make and the signed
          report attached to it - which are the things somebody should have
          read before posting to the books.
        */
        <div className="flex items-center gap-1.5">
          <StatusBadge status={l.status} />
          <Button size="sm" variant="ghost" onClick={() => navigate(`/accounting/liquidation/${l.id}`)}>
            Open
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Liquidation Report"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Liquidation Report' }]}
        actions={
          can('accounting', 'create') && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate('/accounting/liquidation/new')}
            >
              New liquidation report
            </Button>
          )
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(l) => l.id}
        loading={loading}
        error={error}
        searchPlaceholder="Officer, report number or cash advance"
        emptyTitle="No liquidation reports"
        emptyMessage="A liquidation report settles a cash advance against the expenses actually incurred."
        exportMeta={{
          title: 'Liquidation Monitoring Report',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

    </div>
  );
}
