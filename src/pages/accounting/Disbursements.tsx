import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDisbursementVouchers } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate, monthName } from '@/lib/dates';
import { DV_STATUSES, STATUS_LABELS } from '@/types/enums';
import type { DisbursementVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/** The DV register. */
export default function Disbursements() {
  const { fiscalYear, fundCode, period } = useFilters();
  const { can, roles } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [queue, setQueue] = useState<'all' | 'mine'>('all');

  const { data, loading, error } = useDisbursementVouchers(fiscalYear, fundCode, status || undefined);

  /**
   * "Awaiting me" is the view most people actually want when they open this
   * screen: the vouchers sitting at their own stage of the workflow.
   */
  const myStages = useMemo(() => {
    const stages: string[] = [];
    if (roles.includes('ACCOUNTING_REVIEWER')) stages.push('SUBMITTED');
    if (roles.includes('MUNICIPAL_ACCOUNTANT') || roles.includes('SUPER_ADMIN')) {
      stages.push('SUBMITTED', 'REVIEWED');
    }
    if (roles.includes('MUNICIPAL_TREASURER') || roles.includes('TREASURY_STAFF')) {
      stages.push('APPROVED');
    }
    if (roles.includes('ACCOUNTING_ENCODER') || roles.includes('DEPARTMENT_USER')) {
      stages.push('DRAFT', 'RETURNED');
    }
    return stages;
  }, [roles]);

  const rows = useMemo(() => {
    let out = data;
    if (period) out = out.filter((d) => Number(d.dvDate?.slice(5, 7)) === period);
    if (queue === 'mine' && myStages.length) out = out.filter((d) => myStages.includes(d.status));
    return out;
  }, [data, period, queue, myStages]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, d) => {
          if (d.status === 'CANCELLED') return acc;
          acc.gross += d.grossAmount ?? 0;
          acc.deductions += d.totalDeductions ?? 0;
          acc.net += d.netAmount ?? 0;
          return acc;
        },
        { gross: 0, deductions: 0, net: 0 },
      ),
    [rows],
  );

  const columns: Column<DisbursementVoucher>[] = [
    {
      key: 'dvNo',
      header: 'DV No.',
      width: '10rem',
      value: (d) => d.dvNo ?? '',
      cell: (d) =>
        d.dvNo ? (
          <span className="font-mono text-xs text-navy-900">{d.dvNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Unnumbered draft</span>
        ),
    },
    {
      key: 'dvDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (d) => d.dvDate,
      cell: (d) => <span className="text-xs">{formatShortDate(d.dvDate)}</span>,
    },
    {
      key: 'obrNo',
      header: 'OBR No.',
      width: '9rem',
      value: (d) => d.obrNo ?? '',
      cell: (d) => <span className="font-mono text-xs text-slate-500">{d.obrNo ?? '-'}</span>,
      optional: true,
    },
    {
      key: 'payee',
      header: 'Payee',
      value: (d) => d.payeeName,
      cell: (d) => <span className="text-sm">{d.payeeName}</span>,
    },
    {
      key: 'particulars',
      header: 'Particulars',
      value: (d) => d.particulars,
      cell: (d) => (
        <span className="line-clamp-2 text-xs text-slate-600" title={d.particulars}>
          {d.particulars}
        </span>
      ),
    },
    {
      key: 'gross',
      header: 'Gross',
      kind: 'amount',
      value: (d) => d.grossAmount,
      cell: (d) => formatPeso(d.grossAmount, { symbol: false }),
      optional: true,
    },
    {
      key: 'deductions',
      header: 'Deductions',
      kind: 'amount',
      value: (d) => d.totalDeductions,
      cell: (d) => formatPeso(d.totalDeductions, { symbol: false, dash: true }),
      optional: true,
    },
    {
      key: 'net',
      header: 'Net',
      kind: 'amount',
      value: (d) => d.netAmount,
      cell: (d) => formatPeso(d.netAmount, { symbol: false }),
    },
    {
      key: 'payment',
      header: 'Payment',
      width: '9rem',
      value: (d) => d.checkNo ?? d.adaNo ?? '',
      cell: (d) => (
        <div className="text-xs">
          <span className="text-slate-500">Not yet paid</span>
          {(d.checkNo || d.adaNo) && (
            <span className="block font-mono text-navy-800">{d.checkNo ?? d.adaNo}</span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '9rem',
      value: (d) => d.status,
      cell: (d) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={d.status} />
          {(d.attachmentCount ?? 0) === 0 && d.status === 'DRAFT' && (
            <Badge tone="amber">No attachments</Badge>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Disbursement Vouchers"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${period ? `, ${monthName(period)}` : ''}`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Disbursement' }]}
        actions={
          can('accounting', 'create') && (
            <Button variant="primary" size="sm" onClick={() => navigate('/accounting/disbursements/new')}>
              New voucher
            </Button>
          )
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(d) => d.id}
        loading={loading}
        error={error}
        onRowClick={(d) => navigate(`/accounting/disbursements/${d.id}`)}
        searchPlaceholder="DV number, payee, OBR or particulars"
        emptyTitle="No disbursement vouchers"
        emptyMessage={`Nothing has been disbursed from the ${fundLabel(fundCode)} for fiscal year ${fiscalYear}.`}
        filters={
          <>
            <Select
              value={queue}
              onChange={(e) => setQueue(e.target.value as 'all' | 'mine')}
              className="w-auto py-1.5 text-sm"
              aria-label="Queue"
            >
              <option value="all">All vouchers</option>
              <option value="mine">Awaiting my action</option>
            </Select>
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {DV_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </>
        }
        exportMeta={{
          title: 'Disbursement Voucher Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: period
            ? `For the month of ${monthName(period)} ${fiscalYear}`
            : `For the fiscal year ${fiscalYear}`,
        }}
        footer={
          <tr>
            <td className="cbo-td font-medium" colSpan={4}>
              Total ({rows.filter((d) => d.status !== 'CANCELLED').length} vouchers)
            </td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(totals.net, { symbol: false })}</td>
            <td className="cbo-td" colSpan={2} />
          </tr>
        }
      />
    </div>
  );
}
