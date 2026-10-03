import { useMemo, useState } from 'react';
import { newestFirst } from '@/lib/registerOrder';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { obligationForm } from '@/lib/obligationForm';
import { useAuth } from '@/auth/AuthProvider';
import { useObligations } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate, monthName } from '@/lib/dates';
import { OBLIGATION_STATUSES, STATUS_LABELS } from '@/types/enums';
import type { Obligation } from '@/types/budget';

/**
 * The obligation register.
 *
 * Doubles as the electronic Registry of Appropriations, Allotments and
 * Obligations when exported: the columns are the RAAO columns, and the export
 * carries the official heading.
 */
export default function Obligations() {
  const { fiscalYear, fundCode, period } = useFilters();
  const form = obligationForm(fundCode);
  const { can } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>('');

  const { data, loading, error } = useObligations(fiscalYear, fundCode, status || undefined);

  const rows = useMemo(() => {
    const inPeriod = period
      ? data.filter((o) => Number(o.obrDate?.slice(5, 7)) === period)
      : data;
    return newestFirst(inPeriod, (o) => ({ ref: o.obrNo, date: o.obrDate }));
  }, [data, period]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, o) => {
          if (o.status === 'CANCELLED') return acc;
          acc.obligated += o.totalAmount ?? 0;
          acc.disbursed += o.disbursedAmount ?? 0;
          acc.unpaid += o.unpaidAmount ?? 0;
          return acc;
        },
        { obligated: 0, disbursed: 0, unpaid: 0 },
      ),
    [rows],
  );

  const columns: Column<Obligation>[] = [
    {
      key: 'obrNo',
      header: `${form.short} No.`,
      width: '10rem',
      value: (o) => o.obrNo ?? '',
      cell: (o) =>
        o.obrNo ? (
          <span className="font-mono text-xs text-navy-900">{o.obrNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Unnumbered draft</span>
        ),
    },
    {
      key: 'obrDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (o) => o.obrDate,
      cell: (o) => <span className="text-xs">{formatShortDate(o.obrDate)}</span>,
    },
    {
      key: 'payee',
      header: 'Payee',
      value: (o) => o.payeeName,
      cell: (o) => <span className="text-sm">{o.payeeName}</span>,
    },
    {
      key: 'office',
      header: 'Office',
      value: (o) => o.officeName,
      cell: (o) => <span className="text-xs text-slate-600">{o.officeName}</span>,
      optional: true,
    },
    {
      key: 'particulars',
      header: 'Particulars',
      value: (o) => o.particulars,
      cell: (o) => (
        <span className="line-clamp-2 text-xs text-slate-600" title={o.particulars}>
          {o.particulars}
        </span>
      ),
    },
    {
      key: 'totalAmount',
      header: 'Obligated',
      kind: 'amount',
      value: (o) => o.totalAmount,
      cell: (o) => formatPeso(o.totalAmount, { symbol: false }),
    },
    {
      key: 'disbursedAmount',
      header: 'Disbursed',
      kind: 'amount',
      value: (o) => o.disbursedAmount ?? 0,
      cell: (o) => formatPeso(o.disbursedAmount ?? 0, { symbol: false, dash: true }),
    },
    {
      key: 'unpaidAmount',
      header: 'Unpaid',
      kind: 'amount',
      value: (o) => o.unpaidAmount ?? 0,
      cell: (o) => formatPeso(o.unpaidAmount ?? 0, { symbol: false, dash: true }),
    },
    {
      key: 'status',
      header: 'Status',
      width: '9rem',
      value: (o) => o.status,
      cell: (o) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={o.status} />
          {o.override && (
            <Badge tone="rose" className="whitespace-nowrap">
              Over allotment
            </Badge>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Obligations"
        subtitle={`Obligation Requests and Status - ${fundCode}, fiscal year ${fiscalYear}${period ? `, ${monthName(period)}` : ''}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Obligations' }]}
        actions={
          <>
            <Link to="/budget/registry">
              <Button size="sm">Registry (RAAO)</Button>
            </Link>
            {can('budget', 'create') && (
              <Button variant="primary" size="sm" onClick={() => navigate('/budget/obligations/new')}>
                New obligation
              </Button>
            )}
          </>
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(o) => o.id}
        loading={loading}
        error={error}
        onRowClick={(o) => navigate(`/budget/obligations/${o.id}`)}
        searchPlaceholder={`${form.short} number, payee or particulars`}
        emptyTitle="No obligations recorded"
        emptyMessage={`Nothing has been obligated against the ${fundCode} fund for fiscal year ${fiscalYear} yet.`}
        emptyAction={
          can('budget', 'create') ? (
            <Button variant="primary" onClick={() => navigate('/budget/obligations/new')}>
              Record the first obligation
            </Button>
          ) : undefined
        }
        filters={
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-auto py-1.5 text-sm"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {OBLIGATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        }
        exportMeta={{
          title: 'Registry of Appropriations, Allotments and Obligations',
          fundLabel: fundLabel(fundCode),
          periodLabel: period
            ? `For the month of ${monthName(period)} ${fiscalYear}`
            : `For the fiscal year ${fiscalYear}`,
        }}
        footer={
          <tr>
            <td className="cbo-td font-medium" colSpan={5}>
              Total ({rows.filter((o) => o.status !== 'CANCELLED').length} obligations)
            </td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(totals.obligated, { symbol: false })}</td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(totals.disbursed, { symbol: false })}</td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(totals.unpaid, { symbol: false })}</td>
            <td className="cbo-td" />
          </tr>
        }
      />
    </div>
  );
}

export function fundLabel(code: string): string {
  switch (code) {
    case 'GF':
      return 'General Fund';
    case 'SEF':
      return 'Special Education Fund';
    case 'TF':
      return 'Trust Fund';
    default:
      return code;
  }
}
