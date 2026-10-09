import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { AgingChart } from '@/components/charts/Charts';
import { useFilters } from '@/context/FilterContext';
import { useAdvances } from '@/data/useAdvances';
import { formatPeso } from '@/lib/money';
import { AGING_LABELS, agingBucket, daysBetween, formatShortDate, todayPh } from '@/lib/dates';
import type { CashAdvance } from '@/types/accounting';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ACCOUNTING_MONITORING_TABS } from '@/layout/sections';

/**
 * Cash advance monitoring.
 *
 * Unliquidated cash advances are the most common audit finding in Philippine
 * LGUs, and they become findings because nobody watches them until year end.
 * This screen exists to make the ageing visible continuously, and a scheduled
 * job notifies the Accountant daily about advances past their deadline rather
 * than waiting for someone to open it.
 *
 * Since patch 133 the advances are read off the General Ledger: every debit
 * to an account marked "Advance subject to liquidation" in the Chart of
 * Accounts, with the officer as its subsidiary. (The engine-created register
 * this comment used to promise was never built, so this screen was empty.)
 */
export default function CashAdvances() {
  const { fiscalYear, fundCode } = useFilters();
  const [scope, setScope] = useState<'outstanding' | 'all'>('outstanding');

  // Patch 133: read off the General Ledger (src/lib/advances.ts), plus any old record.
  const { data, loading, error, unassigned } = useAdvances(
    fiscalYear,
    fundCode,
    scope === 'outstanding',
  );
  const today = todayPh();

  const rows = data;

  const aging = useMemo(() => {
    const buckets: Record<string, Centavos> = {
      CURRENT: 0,
      D1_30: 0,
      D31_60: 0,
      D61_90: 0,
      OVER_90: 0,
    };
    for (const ca of rows) {
      // No due date on an advance read off the ledger: aged from the day granted.
      const from = ca.dueDate || ca.dateGranted;
      if (!from) continue;
      buckets[agingBucket(from, today)] += ca.outstandingBalance ?? 0;
    }
    return (Object.keys(buckets) as Array<keyof typeof AGING_LABELS>).map((k) => ({
      label: AGING_LABELS[k],
      amount: buckets[k],
    }));
  }, [rows, today]);

  const totalOutstanding = rows.reduce((s, ca) => s + (ca.outstandingBalance ?? 0), 0);
  const overdue = rows.filter((ca) => ca.dueDate && ca.dueDate < today);
  const overdueTotal = overdue.reduce((s, ca) => s + (ca.outstandingBalance ?? 0), 0);

  const columns: Column<CashAdvance>[] = [
    {
      key: 'dvNo',
      header: 'Reference',
      width: '10rem',
      value: (ca) => ca.dvNo,
      cell: (ca) => <span className="font-mono text-xs">{ca.dvNo}</span>,
    },
    {
      key: 'officer',
      header: 'Accountable officer',
      value: (ca) => ca.accountableOfficerName,
      cell: (ca) => (
        <div>
          <span className="text-sm">{ca.accountableOfficerName}</span>
          <span className="block text-2xs text-slate-500">{ca.officeName}</span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Account / type',
      width: '9rem',
      value: (ca) => ca.glAccountName ?? ca.caType,
      cell: (ca) => (
        <span className="text-xs">{ca.glAccountName ?? ca.caType.replace(/_/g, ' ')}</span>
      ),
    },
    {
      key: 'purpose',
      header: 'Purpose',
      value: (ca) => ca.purpose,
      cell: (ca) => (
        <span className="line-clamp-2 text-xs text-slate-600" title={ca.purpose}>
          {ca.purpose}
        </span>
      ),
    },
    {
      key: 'dateGranted',
      header: 'Granted',
      kind: 'date',
      width: '7rem',
      value: (ca) => ca.dateGranted,
      cell: (ca) => <span className="text-xs">{formatShortDate(ca.dateGranted)}</span>,
    },
    {
      key: 'amountGranted',
      header: 'Granted',
      kind: 'amount',
      value: (ca) => ca.amountGranted,
      cell: (ca) => formatPeso(ca.amountGranted, { symbol: false }),
    },
    {
      key: 'liquidated',
      header: 'Liquidated',
      kind: 'amount',
      value: (ca) => ca.amountLiquidated ?? 0,
      cell: (ca) => formatPeso(ca.amountLiquidated ?? 0, { symbol: false, dash: true }),
    },
    {
      key: 'refunded',
      header: 'Refunded',
      kind: 'amount',
      value: (ca) => ca.amountRefunded ?? 0,
      cell: (ca) => formatPeso(ca.amountRefunded ?? 0, { symbol: false, dash: true }),
      optional: true,
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      kind: 'amount',
      value: (ca) => ca.outstandingBalance ?? 0,
      cell: (ca) => (
        <span className={ca.outstandingBalance > 0 ? 'font-medium text-navy-900' : 'text-slate-400'}>
          {formatPeso(ca.outstandingBalance ?? 0, { symbol: false, dash: true })}
        </span>
      ),
    },
    {
      key: 'aging',
      header: 'Age',
      width: '11rem',
      value: (ca) => (ca.dueDate ? daysBetween(ca.dueDate, today) : 0),
      cell: (ca) => {
        if (!ca.dueDate) {
          const age = ca.dateGranted ? daysBetween(ca.dateGranted, today) : 0;
          return <span className="text-2xs text-slate-500">{age} days since granted</span>;
        }
        const overdueDays = daysBetween(ca.dueDate, today);
        const bucket = agingBucket(ca.dueDate, today);
        return (
          <div className="flex flex-col gap-0.5">
            <Badge tone={bucket === 'CURRENT' ? 'emerald' : bucket === 'D1_30' ? 'amber' : 'rose'}>
              {AGING_LABELS[bucket]}
            </Badge>
            <span className="text-2xs text-slate-500">
              {overdueDays > 0
                ? `${overdueDays} days past due`
                : `due ${formatShortDate(ca.dueDate)}`}
            </span>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: '9rem',
      value: (ca) => ca.status,
      cell: (ca) => <StatusBadge status={ca.status} />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Cash Advances"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - ${formatPeso(totalOutstanding)} outstanding`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Cash Advances' }]}
      />

      <SectionTabs tabs={ACCOUNTING_MONITORING_TABS} />

      {overdue.length > 0 && (
        <Alert tone="error" title="Cash advances past their liquidation deadline" className="mb-4">
          {overdue.length} advance{overdue.length === 1 ? '' : 's'} totalling{' '}
          {formatPeso(overdueTotal)} are overdue. Unliquidated advances are a standing COA finding
          and, past a point, are withheld from the officer&rsquo;s salary.
        </Alert>
      )}

      {unassigned.length > 0 && (
        <Alert tone="warning" title="Advances with no accountable officer" className="mb-4">
          {unassigned.length} posting{unassigned.length === 1 ? '' : 's'} to an advance account
          name{unassigned.length === 1 ? 's' : ''} no officer as subsidiary (
          {unassigned
            .slice(0, 6)
            .map((e) => `JEV ${e.jevNo}`)
            .join(', ')}
          ). Nobody can liquidate {unassigned.length === 1 ? 'it' : 'them'} until the entry names
          one - correct the entry in the Journal Entries Register.
        </Alert>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title="Ageing" className="lg:col-span-1">
          <AgingChart data={aging} height={180} />
        </Card>

        <Card title="By accountable officer" className="lg:col-span-2" bodyClassName="p-0">
          <ByOfficer rows={rows} />
        </Card>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(ca) => ca.id}
        loading={loading}
        error={error}
        searchPlaceholder="Officer, DV number or purpose"
        emptyTitle="No cash advances"
        emptyMessage='An advance appears here once it is posted to an account marked "Advance subject to liquidation" in Master Data > Chart of Accounts, with the accountable officer as its subsidiary.'
        filters={
          <Select
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
            className="w-auto py-1.5 text-sm"
            aria-label="Scope"
          >
            <option value="outstanding">Outstanding only</option>
            <option value="all">All advances</option>
          </Select>
        }
        exportMeta={{
          title: 'Cash Advance Ageing Report',
          fundLabel: fundLabel(fundCode),
          periodLabel: `As at ${formatShortDate(today)}`,
        }}
      />
    </div>
  );
}

function ByOfficer({ rows }: { rows: CashAdvance[] }) {
  const today = todayPh();
  const byOfficer = useMemo(() => {
    const map = new Map<string, { name: string; office: string; count: number; total: Centavos; overdue: number }>();
    for (const ca of rows) {
      const entry = map.get(ca.accountableOfficerId) ?? {
        name: ca.accountableOfficerName,
        office: ca.officeName,
        count: 0,
        total: 0,
        overdue: 0,
      };
      entry.count++;
      entry.total += ca.outstandingBalance ?? 0;
      if (ca.dueDate && ca.dueDate < today) entry.overdue++;
      map.set(ca.accountableOfficerId, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total).slice(0, 8);
  }, [rows, today]);

  if (byOfficer.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-slate-500">No outstanding advances.</p>;
  }

  return (
    <ul className="divide-y divide-slate-100">
      {byOfficer.map((officer) => (
        <li key={officer.name} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-navy-900">{officer.name}</p>
            <p className="truncate text-xs text-slate-500">
              {officer.office} - {officer.count} advance{officer.count === 1 ? '' : 's'}
            </p>
          </div>
          {officer.overdue > 0 && <Badge tone="rose">{officer.overdue} overdue</Badge>}
          <span className="cbo-amount text-navy-800">{formatPeso(officer.total)}</span>
        </li>
      ))}
    </ul>
  );
}
