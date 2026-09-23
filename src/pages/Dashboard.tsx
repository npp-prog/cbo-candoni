import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { PageHeader, Card, Alert, Spinner } from '@/components/ui/Layout';
import { StatusBadge } from '@/components/ui/Badge';
import { TrendChart, ComparisonChart, AgingChart, UtilizationMeter } from '@/components/charts/Charts';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useBudgetSummary,
  useBudgetAlerts,
  useDisbursementVouchers,
  useJevs,
  useObligations,
  useCollections,
  useCashAdvances,
  useUndepositedCollections,
  useBudgetBalances,
  useOffices,
  useLedgerEntries,
} from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { agingBucket, AGING_LABELS, monthName, todayPh, formatShortDate } from '@/lib/dates';
import type { Centavos } from '@/types/common';

/**
 * The executive dashboard.
 *
 * Organised by the question a reader arrives with, not by the module the data
 * came from: how much authority is left, what is waiting for someone, and
 * where is the money. Alerts come first, because a dashboard whose warnings
 * are below the fold is decoration.
 */
export default function Dashboard() {
  const { fiscalYear, fundCode } = useFilters();
  const { profile } = useAuth();

  const summary = useBudgetSummary(fiscalYear, fundCode);
  const alerts = useBudgetAlerts(fiscalYear, fundCode);
  const balances = useBudgetBalances(fiscalYear, fundCode);
  const offices = useOffices();
  const dvs = useDisbursementVouchers(fiscalYear, fundCode);
  const jevs = useJevs(fiscalYear, fundCode);
  const obligations = useObligations(fiscalYear, fundCode);
  const collections = useCollections(fiscalYear, fundCode);
  const advances = useCashAdvances(fiscalYear);
  const undeposited = useUndepositedCollections(fundCode);
  const ledger = useLedgerEntries(fiscalYear, fundCode);

  const budget = summary.data[0];
  const today = todayPh();
  const currentMonth = Number(today.slice(5, 7));

  // --- Monthly series ------------------------------------------------------

  const monthly = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      label: monthName(i + 1).slice(0, 3),
      period: i + 1,
      obligated: 0,
      disbursed: 0,
      collected: 0,
    }));

    for (const o of obligations.data) {
      if (o.status === 'CANCELLED') continue;
      const p = Number(o.obrDate?.slice(5, 7) ?? 0);
      if (p >= 1 && p <= 12) months[p - 1].obligated += o.totalAmount ?? 0;
    }
    for (const dv of dvs.data) {
      if (dv.status === 'CANCELLED') continue;
      const p = Number(dv.dvDate?.slice(5, 7) ?? 0);
      if (p >= 1 && p <= 12) months[p - 1].disbursed += dv.grossAmount ?? 0;
    }
    for (const c of collections.data) {
      if (c.status === 'CANCELLED') continue;
      const p = Number(c.orDate?.slice(5, 7) ?? 0);
      if (p >= 1 && p <= 12) months[p - 1].collected += c.totalAmount ?? 0;
    }

    return months;
  }, [obligations.data, dvs.data, collections.data]);

  // --- Obligations by office ----------------------------------------------

  const byOffice = useMemo(() => {
    const map = new Map<string, { label: string; obligated: Centavos; allotment: Centavos }>();
    for (const b of balances.data) {
      const key = b.officeId;
      const row = map.get(key) ?? { label: b.officeName ?? key, obligated: 0, allotment: 0 };
      row.obligated += b.obligated ?? 0;
      row.allotment += b.allotmentReleased ?? 0;
      map.set(key, row);
    }
    return [...map.values()]
      .filter((r) => r.allotment > 0 || r.obligated > 0)
      .sort((a, b) => b.obligated - a.obligated)
      .slice(0, 8);
  }, [balances.data]);

  // --- Cash advance aging --------------------------------------------------

  const aging = useMemo(() => {
    const buckets: Record<string, Centavos> = {
      CURRENT: 0,
      D1_30: 0,
      D31_60: 0,
      D61_90: 0,
      OVER_90: 0,
    };
    for (const ca of advances.data) {
      if (!ca.dueDate) continue;
      buckets[agingBucket(ca.dueDate, today)] += ca.outstandingBalance ?? 0;
    }
    return (Object.keys(buckets) as Array<keyof typeof AGING_LABELS>).map((k) => ({
      label: AGING_LABELS[k],
      amount: buckets[k],
    }));
  }, [advances.data, today]);

  const overdueAdvances = advances.data.filter((ca) => ca.dueDate && ca.dueDate < today);
  const overdueTotal = overdueAdvances.reduce((s, ca) => s + (ca.outstandingBalance ?? 0), 0);

  // --- Cash and ledger-derived figures -------------------------------------

  const cashInBank = useMemo(() => {
    // Derived from the ledger rather than stored, because the General Ledger
    // is the source of truth for every balance in the system.
    return ledger.data
      .filter((e) => e.accountCode?.startsWith('10102'))
      .reduce((s, e) => s + (e.signedAmount ?? 0), 0);
  }, [ledger.data]);

  const undepositedTotal = undeposited.data.reduce((s, c) => s + (c.totalAmount ?? 0), 0);
  const collectionsThisMonth = monthly[currentMonth - 1]?.collected ?? 0;
  const collectionsToday = collections.data
    .filter((c) => c.orDate === today && c.status !== 'CANCELLED')
    .reduce((s, c) => s + (c.totalAmount ?? 0), 0);

  // --- Work in flight ------------------------------------------------------

  const pending = {
    obligations: obligations.data.filter((o) => ['DRAFT', 'SUBMITTED', 'BUDGET_REVIEWED'].includes(o.status)).length,
    vouchers: dvs.data.filter((d) => ['SUBMITTED', 'REVIEWED'].includes(d.status)).length,
    jevs: jevs.data.filter((j) => ['DRAFT', 'FOR_REVIEW', 'REVIEWED'].includes(j.status)).length,
    // Approved and not yet paid, either way. The voucher no longer says
    // which it will be, so there is one number here rather than two.
    checks: dvs.data.filter((d) => d.status === 'APPROVED' && !d.checkId && !d.adaId).length,
    ada: 0,
    missingAttachments: dvs.data.filter((d) => d.status === 'DRAFT' && (d.attachmentCount ?? 0) === 0).length,
  };

  const loading = summary.loading && balances.loading && dvs.loading;

  return (
    <div>
      <PageHeader
        title={`Dashboard`}
        subtitle={`${fundCode} - Fiscal Year ${fiscalYear}${profile?.displayName ? ` - ${profile.displayName}` : ''}`}
      />

      {loading ? (
        <Spinner label="Loading the municipality's position" />
      ) : (
        <div className="space-y-5">
          {/* Alerts first. */}
          <AlertStrip
            negativeLines={alerts.data.length}
            overdueAdvances={overdueAdvances.length}
            overdueTotal={overdueTotal}
            undeposited={undeposited.data.length}
            undepositedTotal={undepositedTotal}
            missingAttachments={pending.missingAttachments}
            fiscalYear={fiscalYear}
          />

          {/* Budget */}
          <section>
            <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Budget
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Total Appropriation"
                value={budget?.appropriationRevised ?? 0}
                to="/budget/appropriations"
              />
              <Stat
                label="Total Allotment"
                value={budget?.allotmentReleased ?? 0}
                to="/budget/allotments"
              />
              <Stat label="Total Obligations" value={budget?.obligated ?? 0} to="/budget/obligations" />
              <Stat
                label="Available Allotment"
                value={(budget?.allotmentReleased ?? 0) - (budget?.obligated ?? 0)}
                to="/budget/registry"
                tone={(budget?.allotmentReleased ?? 0) - (budget?.obligated ?? 0) < 0 ? 'negative' : 'default'}
              />
            </div>

            <Card className="mt-3" title="Budget utilisation">
              <UtilizationMeter
                used={budget?.obligated ?? 0}
                total={budget?.appropriationRevised ?? 0}
                label="Obligations against revised appropriation"
              />
            </Card>
          </section>

          {/* Accounting and treasury */}
          <div className="grid gap-5 lg:grid-cols-2">
            <section>
              <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Accounting
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat
                  label="Total Disbursements"
                  value={budget?.disbursed ?? 0}
                  to="/accounting/disbursements"
                />
                <Stat
                  label="Unpaid Obligations"
                  value={(budget?.obligated ?? 0) - (budget?.disbursed ?? 0)}
                  to="/budget/registry"
                />
                <Stat
                  label="Cash Advances Outstanding"
                  value={advances.data.reduce((s, a) => s + (a.outstandingBalance ?? 0), 0)}
                  to="/accounting/cash-advances"
                />
                <Stat
                  label="Unliquidated, Overdue"
                  value={overdueTotal}
                  to="/accounting/liquidation"
                  tone={overdueTotal > 0 ? 'warning' : 'default'}
                />
              </div>
            </section>

            <section>
              <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Treasury
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="Collections Today" value={collectionsToday} to="/treasury/collections" />
                <Stat label="Collections This Month" value={collectionsThisMonth} to="/treasury/collections" />
                <Stat label="Cash in Bank (per books)" value={cashInBank} to="/treasury/cash-position" />
                <Stat
                  label="Undeposited Collections"
                  value={undepositedTotal}
                  to="/treasury/collections/deposits"
                  tone={undepositedTotal > 0 ? 'warning' : 'default'}
                />
              </div>
            </section>
          </div>

          {/* Work in flight */}
          <section>
            <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Awaiting action
            </h2>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <CountTile label="Obligations" count={pending.obligations} to="/budget/obligations" />
              <CountTile label="Disbursement Vouchers" count={pending.vouchers} to="/accounting/disbursements" />
              <CountTile label="Journal Entries to post" count={pending.jevs} to="/accounting/others" />
              <CountTile label="Checks to prepare" count={pending.checks} to="/accounting/checks" />
              <CountTile label="ADA to prepare" count={pending.ada} to="/accounting/ada" />
            </div>
          </section>

          {/* Charts */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title="Obligations and disbursements by month"
              subtitle={`${fundCode}, fiscal year ${fiscalYear}`}
            >
              <TrendChart
                data={monthly}
                series={[
                  { key: 'obligated', label: 'Obligated' },
                  { key: 'disbursed', label: 'Disbursed' },
                ]}
              />
            </Card>

            <Card title="Collections by month" subtitle={`${fundCode}, fiscal year ${fiscalYear}`}>
              <TrendChart data={monthly} series={[{ key: 'collected', label: 'Collections' }]} />
            </Card>

            <Card
              title="Allotment and obligations by office"
              subtitle="Eight offices with the largest obligations"
            >
              {byOffice.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  No allotments have been released for this fund and year yet.
                </p>
              ) : (
                <ComparisonChart
                  horizontal
                  height={Math.max(200, byOffice.length * 38)}
                  data={byOffice}
                  series={[
                    { key: 'allotment', label: 'Allotment released' },
                    { key: 'obligated', label: 'Obligated' },
                  ]}
                />
              )}
            </Card>

            <Card
              title="Unliquidated cash advances by age"
              subtitle={overdueTotal > 0 ? `${formatPeso(overdueTotal)} past due` : 'None past due'}
            >
              <AgingChart data={aging} />
            </Card>
          </div>

          {/* Recent activity */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title="Recent disbursement vouchers"
              actions={
                <Link to="/accounting/disbursements" className="text-xs text-brand-700 hover:underline">
                  View all
                </Link>
              }
              bodyClassName="p-0"
            >
              <RecentList
                rows={dvs.data.slice(0, 6).map((d) => ({
                  id: d.id,
                  primary: d.dvNo ?? 'Unnumbered draft',
                  secondary: `${d.payeeName} - ${formatShortDate(d.dvDate)}`,
                  amount: d.netAmount,
                  status: d.status,
                  to: `/accounting/disbursements/${d.id}`,
                }))}
                emptyMessage="No vouchers recorded for this fund and year."
              />
            </Card>

            <Card
              title="Journal entries awaiting posting"
              actions={
                <Link to="/accounting/others" className="text-xs text-brand-700 hover:underline">
                  View all
                </Link>
              }
              bodyClassName="p-0"
            >
              <RecentList
                rows={jevs.data
                  .filter((j) => j.status !== 'POSTED' && j.status !== 'CANCELLED')
                  .slice(0, 6)
                  .map((j) => ({
                    id: j.id,
                    primary: j.jevNo,
                    secondary: `${j.particulars?.slice(0, 60) ?? ''} - ${formatShortDate(j.jevDate)}`,
                    amount: j.totalDebit,
                    status: j.status,
                    to: `/accounting/others/${j.id}`,
                  }))}
                emptyMessage="Nothing is waiting to be posted."
              />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  to,
  tone = 'default',
}: {
  label: string;
  value: Centavos;
  to?: string;
  tone?: 'default' | 'warning' | 'negative';
}) {
  const body = (
    <div
      className={clsx(
        'cbo-card px-4 py-3 transition-colors',
        to && 'hover:border-brand-300 hover:bg-brand-50/30',
      )}
    >
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={clsx(
          'mt-1 font-mono text-lg font-semibold tabular',
          tone === 'negative' ? 'text-rose-700' : tone === 'warning' ? 'text-amber-700' : 'text-navy-900',
        )}
      >
        {formatPeso(value)}
      </p>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function CountTile({ label, count, to }: { label: string; count: number; to: string }) {
  return (
    <Link
      to={to}
      className={clsx(
        'cbo-card flex items-center gap-3 px-4 py-3 transition-colors hover:border-brand-300 hover:bg-brand-50/30',
      )}
    >
      <span
        className={clsx(
          'font-mono text-xl font-semibold tabular',
          count > 0 ? 'text-brand-700' : 'text-slate-300',
        )}
      >
        {count}
      </span>
      <span className="text-xs leading-tight text-slate-600">{label}</span>
    </Link>
  );
}

function RecentList({
  rows,
  emptyMessage,
}: {
  rows: Array<{
    id: string;
    primary: string;
    secondary: string;
    amount?: Centavos;
    status: string;
    to: string;
  }>;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-slate-500">{emptyMessage}</p>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((row) => (
        <li key={row.id}>
          <Link to={row.to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-brand-50/40">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-navy-900">{row.primary}</p>
              <p className="truncate text-xs text-slate-500">{row.secondary}</p>
            </div>
            {row.amount !== undefined && (
              <span className="cbo-amount text-navy-800">{formatPeso(row.amount)}</span>
            )}
            <StatusBadge status={row.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AlertStrip({
  negativeLines,
  overdueAdvances,
  overdueTotal,
  undeposited,
  undepositedTotal,
  missingAttachments,
  fiscalYear,
}: {
  negativeLines: number;
  overdueAdvances: number;
  overdueTotal: Centavos;
  undeposited: number;
  undepositedTotal: Centavos;
  missingAttachments: number;
  fiscalYear: number;
}) {
  const items: Array<{ tone: 'error' | 'warning'; text: string; to: string }> = [];

  if (negativeLines > 0) {
    items.push({
      tone: 'error',
      text: `${negativeLines} budget line${negativeLines === 1 ? '' : 's'} obligated beyond the allotment released.`,
      to: '/budget/registry',
    });
  }
  if (overdueAdvances > 0) {
    items.push({
      tone: 'warning',
      text: `${overdueAdvances} cash advance${overdueAdvances === 1 ? '' : 's'} past the liquidation deadline, ${formatPeso(overdueTotal)} outstanding.`,
      to: '/accounting/liquidation',
    });
  }
  if (undeposited > 0) {
    items.push({
      tone: 'warning',
      text: `${undeposited} collection${undeposited === 1 ? '' : 's'} not yet deposited, ${formatPeso(undepositedTotal)}.`,
      to: '/treasury/collections/deposits',
    });
  }
  if (missingAttachments > 0) {
    items.push({
      tone: 'warning',
      text: `${missingAttachments} draft voucher${missingAttachments === 1 ? '' : 's'} with no supporting documents attached.`,
      to: '/accounting/disbursements',
    });
  }

  if (items.length === 0) {
    return (
      <Alert tone="success" title={`No outstanding control exceptions for fiscal year ${fiscalYear}`}>
        Budget lines are within their allotments, cash advances are within their liquidation
        deadlines, and collections are deposited.
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <Alert
          key={i}
          tone={item.tone}
          action={
            <Link to={item.to} className="shrink-0 text-xs font-medium underline">
              Review
            </Link>
          }
        >
          {item.text}
        </Alert>
      ))}
    </div>
  );
}
