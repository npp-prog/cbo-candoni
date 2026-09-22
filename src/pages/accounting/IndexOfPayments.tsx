import { useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { PageHeader, Card } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Field, DateInput, AmountInput } from '@/components/ui/Field';
import { PayeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useDisbursementVouchers, usePayees } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { DisbursementVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/**
 * The Index of Payments.
 *
 * A COA-required register answering one question: everything the municipality
 * has paid a given payee. The filters are the ones an auditor actually
 * uses - payee, date range, amount range - and the amount filter matches on a
 * range rather than an exact figure, because an auditor working from a bank
 * statement rarely has the exact voucher amount to hand.
 */
export default function IndexOfPayments() {
  const { fiscalYear, fundCode } = useFilters();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const { data, loading, error } = useDisbursementVouchers(fiscalYear, fundCode);
  const payees = usePayees();

  const [payeeId, setPayeeId] = useState<string | null>(params.get('payee'));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minAmount, setMinAmount] = useState<number | null>(null);
  const [maxAmount, setMaxAmount] = useState<number | null>(null);

  const rows = useMemo(
    () =>
      data
        .filter((d) => d.status !== 'CANCELLED')
        .filter((d) => !payeeId || d.payeeId === payeeId)
        .filter((d) => !from || d.dvDate >= from)
        .filter((d) => !to || d.dvDate <= to)
        .filter((d) => minAmount === null || d.grossAmount >= minAmount)
        .filter((d) => maxAmount === null || d.grossAmount <= maxAmount),
    [data, payeeId, from, to, minAmount, maxAmount],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, d) => ({
          gross: acc.gross + d.grossAmount,
          deductions: acc.deductions + d.totalDeductions,
          net: acc.net + d.netAmount,
        }),
        { gross: 0, deductions: 0, net: 0 },
      ),
    [rows],
  );

  const payeeName = payees.data.find((p) => p.id === payeeId)?.name;

  const columns: Column<DisbursementVoucher>[] = [
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (d) => d.dvDate,
      cell: (d) => <span className="text-xs">{formatShortDate(d.dvDate)}</span>,
    },
    {
      key: 'payee',
      header: 'Payee',
      value: (d) => d.payeeName,
      cell: (d) => <span className="text-sm">{d.payeeName}</span>,
    },
    {
      key: 'dvNo',
      header: 'DV No.',
      width: '9rem',
      value: (d) => d.dvNo ?? '',
      cell: (d) => <span className="font-mono text-xs">{d.dvNo ?? '-'}</span>,
    },
    {
      key: 'obrNo',
      header: 'OBR No.',
      width: '9rem',
      value: (d) => d.obrNo ?? '',
      cell: (d) => <span className="font-mono text-xs text-slate-500">{d.obrNo ?? '-'}</span>,
    },
    {
      key: 'payment',
      header: 'Check / ADA',
      width: '9rem',
      value: (d) => d.checkNo ?? d.adaNo ?? '',
      cell: (d) => <span className="font-mono text-xs text-slate-500">{d.checkNo ?? d.adaNo ?? '-'}</span>,
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
      key: 'office',
      header: 'Office',
      value: (d) => d.officeName,
      cell: (d) => <span className="text-xs text-slate-600">{d.officeName}</span>,
      optional: true,
    },
    {
      key: 'gross',
      header: 'Gross',
      kind: 'amount',
      value: (d) => d.grossAmount,
      cell: (d) => formatPeso(d.grossAmount, { symbol: false }),
    },
    {
      key: 'deductions',
      header: 'Deductions',
      kind: 'amount',
      value: (d) => d.totalDeductions,
      cell: (d) => formatPeso(d.totalDeductions, { symbol: false, dash: true }),
    },
    {
      key: 'net',
      header: 'Net',
      kind: 'amount',
      value: (d) => d.netAmount,
      cell: (d) => formatPeso(d.netAmount, { symbol: false }),
    },
    {
      key: 'status',
      header: 'Status',
      width: '8rem',
      value: (d) => d.status,
      cell: (d) => <StatusBadge status={d.status} />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Index of Payments"
        subtitle={
          payeeName
            ? `${payeeName} - ${fundLabel(fundCode)}, fiscal year ${fiscalYear}`
            : `${fundLabel(fundCode)} - fiscal year ${fiscalYear}`
        }
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Index of Payments' }]}
      />

      <Card className="mb-4" bodyClassName="py-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Payee" className="lg:col-span-2">
            <PayeePicker
              value={payeeId}
              onChange={(v) => {
                setPayeeId(v);
                setParams(v ? { payee: v } : {});
              }}
            />
          </Field>
          <Field label="From date">
            <DateInput value={from || null} onChange={setFrom} />
          </Field>
          <Field label="To date">
            <DateInput value={to || null} onChange={setTo} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Min amount">
              <AmountInput value={minAmount} onChange={setMinAmount} />
            </Field>
            <Field label="Max amount">
              <AmountInput value={maxAmount} onChange={setMaxAmount} />
            </Field>
          </div>
        </div>
      </Card>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(d) => d.id}
        loading={loading}
        error={error}
        onRowClick={(d) => navigate(`/accounting/disbursements/${d.id}`)}
        searchPlaceholder="Payee, DV number, check number or particulars"
        emptyTitle="No payments match"
        emptyMessage="Adjust the filters, or select a different fiscal year and fund in the header."
        pageSize={50}
        exportMeta={{
          title: 'Index of Payments',
          fundLabel: fundLabel(fundCode),
          periodLabel: payeeName
            ? `${payeeName} - fiscal year ${fiscalYear}`
            : `For the fiscal year ${fiscalYear}`,
        }}
        footer={
          <tr>
            <td className="cbo-td font-medium" colSpan={6}>
              Total - {rows.length} payments
            </td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(totals.gross, { symbol: false })}</td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(totals.deductions, { symbol: false })}</td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(totals.net, { symbol: false })}</td>
            <td className="cbo-td" />
          </tr>
        }
      />
    </div>
  );
}
