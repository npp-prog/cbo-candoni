import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Spinner, Alert } from '@/components/ui/Layout';
import { Field, Select, DateInput } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useCollections, useDeposits, useRcds, useUndepositedCollections } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate, monthName, todayPh } from '@/lib/dates';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';

type ReportId = 'daily' | 'monthly' | 'cashbook' | 'deposits' | 'revenue' | 'undeposited';

const REPORTS: Array<{ id: ReportId; label: string }> = [
  { id: 'daily', label: 'Daily Collection Report' },
  { id: 'monthly', label: 'Monthly Collection Report' },
  { id: 'cashbook', label: 'Cashbook' },
  { id: 'deposits', label: 'Deposit Register' },
  { id: 'revenue', label: 'Revenue Collection Report' },
  { id: 'undeposited', label: 'Undeposited Collection Report' },
];

/**
 * Treasury reports.
 *
 * All six are views of the same collection and deposit records, cut the way
 * the Municipal Treasurer's Office needs them. The cashbook in particular is
 * the one an accountable officer signs: collections received, deposits made
 * and the balance still in their hands, day by day.
 */
export default function TreasuryReports() {
  const { fiscalYear, fundCode, period } = useFilters();
  const [report, setReport] = useState<ReportId>('monthly');
  const [date, setDate] = useState(todayPh());
  const [selectedPeriod, setSelectedPeriod] = useState<number>(period ?? Number(todayPh().slice(5, 7)));

  const collections = useCollections(fiscalYear, fundCode);
  const deposits = useDeposits();
  const rcds = useRcds(fiscalYear, fundCode);
  const undeposited = useUndepositedCollections(fundCode);

  const title = REPORTS.find((r) => r.id === report)!.label;
  const periodLabel =
    report === 'daily'
      ? `For ${formatShortDate(date)}`
      : report === 'undeposited'
        ? `As at ${formatShortDate(todayPh())}`
        : `For the month of ${monthName(selectedPeriod)} ${fiscalYear}`;

  return (
    <ReportShell
      meta={{
        title,
        fundLabel: fundLabel(fundCode),
        periodLabel,
        preparedBy: 'Municipal Treasurer',
        certifiedBy: 'Municipal Treasurer',
      }}
      breadcrumbs={[{ label: 'Treasury', to: '/treasury' }, { label: 'Collection Reports and Cashbook' }]}
      filters={
        <>
          <Field label="Report" className="min-w-[20rem]">
            <Select value={report} onChange={(e) => setReport(e.target.value as ReportId)}>
              {REPORTS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          {report === 'daily' ? (
            <Field label="Date">
              <DateInput value={date} onChange={setDate} />
            </Field>
          ) : report !== 'undeposited' ? (
            <Field label="Month">
              <Select value={selectedPeriod} onChange={(e) => setSelectedPeriod(Number(e.target.value))}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {monthName(m)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </>
      }
    >
      {collections.loading ? (
        <Spinner label="Loading treasury records" />
      ) : report === 'daily' ? (
        <CollectionListing
          rows={collections.data.filter((c) => c.orDate === date && c.status !== 'CANCELLED')}
          emptyMessage={`No collections were recorded on ${formatShortDate(date)}.`}
        />
      ) : report === 'monthly' || report === 'revenue' ? (
        <RevenueSummary
          rows={collections.data.filter(
            (c) => Number(c.orDate?.slice(5, 7)) === selectedPeriod && c.status !== 'CANCELLED',
          )}
          bySource={report === 'revenue'}
        />
      ) : report === 'cashbook' ? (
        <Cashbook
          collections={collections.data.filter(
            (c) => Number(c.orDate?.slice(5, 7)) === selectedPeriod && c.status !== 'CANCELLED',
          )}
          deposits={deposits.data.filter(
            (d) => d.fundCode === fundCode && Number(d.depositDate?.slice(5, 7)) === selectedPeriod,
          )}
        />
      ) : report === 'deposits' ? (
        <DepositRegister
          rows={deposits.data.filter(
            (d) =>
              d.fundCode === fundCode &&
              d.fiscalYear === fiscalYear &&
              Number(d.depositDate?.slice(5, 7)) === selectedPeriod,
          )}
        />
      ) : (
        <CollectionListing
          rows={undeposited.data}
          emptyMessage="Every collection has been deposited."
          warning="These collections have been receipted but not yet deposited. Collections should be deposited intact and daily."
        />
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

function CollectionListing({
  rows,
  emptyMessage,
  warning,
}: {
  rows: Array<{
    id: string;
    orNumber: string;
    orDate: string;
    payorName: string;
    collectingOfficerName: string;
    totalAmount: Centavos;
    revenueSource: string;
  }>;
  emptyMessage: string;
  warning?: string;
}) {
  const total = rows.reduce((s, r) => s + r.totalAmount, 0);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">{emptyMessage}</p>;
  }

  return (
    <>
      {warning && (
        <Alert tone="warning" className="mb-4">
          {warning}
        </Alert>
      )}
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="cbo-th w-28">OR No.</th>
            <th className="cbo-th w-24">Date</th>
            <th className="cbo-th">Payor</th>
            <th className="cbo-th">Collecting officer</th>
            <th className="cbo-th">Revenue source</th>
            <th className="cbo-th w-36 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="cbo-td font-mono text-xs">{r.orNumber}</td>
              <td className="cbo-td text-xs">{formatShortDate(r.orDate)}</td>
              <td className="cbo-td text-sm">{r.payorName}</td>
              <td className="cbo-td text-xs text-slate-600">{r.collectingOfficerName}</td>
              <td className="cbo-td text-xs text-slate-600">{r.revenueSource.replace(/_/g, ' ')}</td>
              <td className="cbo-td cbo-amount">{formatPeso(r.totalAmount, { symbol: false })}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy-800 font-semibold">
            <td className="cbo-td border-b-0" colSpan={5}>
              Total - {rows.length} receipts
            </td>
            <td className="cbo-td cbo-amount border-b-0">{formatPeso(total, { symbol: false })}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function RevenueSummary({
  rows,
  bySource,
}: {
  rows: Array<{
    revenueSource: string;
    totalAmount: Centavos;
    lines: Array<{ accountCode: string; accountName: string; amount: Centavos }>;
  }>;
  bySource: boolean;
}) {
  const summary = useMemo(() => {
    const map = new Map<string, { label: string; sublabel?: string; amount: Centavos; count: number }>();

    for (const c of rows) {
      if (bySource) {
        const key = c.revenueSource;
        const entry = map.get(key) ?? { label: key.replace(/_/g, ' '), amount: 0, count: 0 };
        entry.amount += c.totalAmount;
        entry.count++;
        map.set(key, entry);
      } else {
        for (const line of c.lines ?? []) {
          const entry = map.get(line.accountCode) ?? {
            label: line.accountName,
            sublabel: line.accountCode,
            amount: 0,
            count: 0,
          };
          entry.amount += line.amount;
          entry.count++;
          map.set(line.accountCode, entry);
        }
      }
    }

    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [rows, bySource]);

  const total = summary.reduce((s, r) => s + r.amount, 0);

  if (summary.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">No collections in this month.</p>;
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className="cbo-th">{bySource ? 'Revenue source' : 'Revenue account'}</th>
          <th className="cbo-th w-28 text-right">Receipts</th>
          <th className="cbo-th w-40 text-right">Amount</th>
          <th className="cbo-th w-24 text-right">Share</th>
        </tr>
      </thead>
      <tbody>
        {summary.map((r, i) => (
          <tr key={i}>
            <td className="cbo-td">
              {r.sublabel && <span className="font-mono text-xs text-slate-500">{r.sublabel} </span>}
              <span className="text-sm">{r.label}</span>
            </td>
            <td className="cbo-td text-right font-mono text-sm tabular">{r.count}</td>
            <td className="cbo-td cbo-amount">{formatPeso(r.amount, { symbol: false })}</td>
            <td className="cbo-td text-right font-mono text-sm tabular text-slate-600">
              {total > 0 ? `${((r.amount / total) * 100).toFixed(1)}%` : '-'}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-navy-800 font-semibold">
          <td className="cbo-td border-b-0" colSpan={2}>
            Total collections
          </td>
          <td className="cbo-td cbo-amount border-b-0">{formatPeso(total, { symbol: false })}</td>
          <td className="cbo-td border-b-0 text-right font-mono text-sm">100.0%</td>
        </tr>
      </tfoot>
    </table>
  );
}

function Cashbook({
  collections,
  deposits,
}: {
  collections: Array<{ orDate: string; totalAmount: Centavos }>;
  deposits: Array<{ depositDate: string; amount: Centavos }>;
}) {
  const days = useMemo(() => {
    const map = new Map<string, { date: string; collected: Centavos; deposited: Centavos }>();

    for (const c of collections) {
      const entry = map.get(c.orDate) ?? { date: c.orDate, collected: 0, deposited: 0 };
      entry.collected += c.totalAmount;
      map.set(c.orDate, entry);
    }
    for (const d of deposits) {
      const entry = map.get(d.depositDate) ?? { date: d.depositDate, collected: 0, deposited: 0 };
      entry.deposited += d.amount;
      map.set(d.depositDate, entry);
    }

    let balance = 0;
    return [...map.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => {
        balance += day.collected - day.deposited;
        return { ...day, balance };
      });
  }, [collections, deposits]);

  if (days.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">No activity in this month.</p>;
  }

  const totals = days.reduce(
    (acc, d) => ({ collected: acc.collected + d.collected, deposited: acc.deposited + d.deposited }),
    { collected: 0, deposited: 0 },
  );

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className="cbo-th w-32">Date</th>
          <th className="cbo-th text-right">Collections received</th>
          <th className="cbo-th text-right">Deposits made</th>
          <th className="cbo-th text-right">Balance in hand</th>
        </tr>
      </thead>
      <tbody>
        {days.map((d) => (
          <tr key={d.date}>
            <td className="cbo-td text-sm">{formatShortDate(d.date)}</td>
            <td className="cbo-td cbo-amount">{formatPeso(d.collected, { symbol: false, dash: true })}</td>
            <td className="cbo-td cbo-amount">{formatPeso(d.deposited, { symbol: false, dash: true })}</td>
            <td className={`cbo-td cbo-amount font-medium ${d.balance > 0 ? 'text-amber-700' : ''}`}>
              {formatPeso(d.balance, { symbol: false })}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-navy-800 font-semibold">
          <td className="cbo-td border-b-0">Total for the month</td>
          <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.collected, { symbol: false })}</td>
          <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.deposited, { symbol: false })}</td>
          <td className="cbo-td cbo-amount border-b-0">
            {formatPeso(totals.collected - totals.deposited, { symbol: false })}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function DepositRegister({
  rows,
}: {
  rows: Array<{
    id: string;
    depositDate: string;
    depositSlipNo: string;
    bankName: string;
    rcdNo?: string | null;
    amount: Centavos;
    status: string;
  }>;
}) {
  const total = rows.reduce((s, r) => s + r.amount, 0);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">No deposits in this month.</p>;
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className="cbo-th w-24">Date</th>
          <th className="cbo-th w-32">Deposit slip</th>
          <th className="cbo-th">Bank</th>
          <th className="cbo-th w-32">RCD</th>
          <th className="cbo-th w-28">Status</th>
          <th className="cbo-th w-36 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="cbo-td text-xs">{formatShortDate(r.depositDate)}</td>
            <td className="cbo-td font-mono text-xs">{r.depositSlipNo}</td>
            <td className="cbo-td text-sm">{r.bankName}</td>
            <td className="cbo-td font-mono text-xs text-slate-500">{r.rcdNo ?? '-'}</td>
            <td className="cbo-td text-xs">{r.status.replace(/_/g, ' ').toLowerCase()}</td>
            <td className="cbo-td cbo-amount">{formatPeso(r.amount, { symbol: false })}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-navy-800 font-semibold">
          <td className="cbo-td border-b-0" colSpan={5}>
            Total - {rows.length} deposits
          </td>
          <td className="cbo-td cbo-amount border-b-0">{formatPeso(total, { symbol: false })}</td>
        </tr>
      </tfoot>
    </table>
  );
}
