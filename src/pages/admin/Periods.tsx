import { useMemo, useState } from 'react';
import { where } from 'firebase/firestore';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useCollection } from '@/hooks/useFirestore';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatInstant, monthName } from '@/lib/dates';
import type { AccountingPeriod } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { useFiscalYearRecords } from '@/data/queries';
import { BASE_FISCAL_YEARS, fiscalYearList, nextFiscalYear } from '@/lib/fiscalYears';

/**
 * Accounting period control.
 *
 * Closing a month converts "the books so far" into "the books": after a close
 * nothing new can be posted into it, so a report run in March for January
 * returns what it returned in February.
 *
 * Reopening is deliberately awkward. It needs a written reason of at least
 * fifteen characters, it is logged as a critical audit event, it notifies the
 * administrators, and the count of reopenings is displayed here permanently.
 * Reopening a closed month is sometimes genuinely necessary; it should never
 * become routine, and the record should make it obvious if it has.
 */
export default function Periods() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const [action, setAction] = useState<{
    kind: 'close' | 'reopen' | 'lock' | 'unlock';
    period: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const { data } = useCollection<AccountingPeriod & { reopenCount?: number }>(
    COL.accountingPeriods,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode)],
    ['periods', fiscalYear, fundCode],
  );

  const canControl = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const periods = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const p = i + 1;
        const record = data.find((d) => d.period === p);
        return {
          period: p,
          status: record?.status ?? 'OPEN',
          closedAt: record?.closedAt,
          closedBy: record?.closedBy?.name,
          reopenedAt: record?.reopenedAt,
          reopenReason: record?.reopenReason,
          reopenCount: record?.reopenCount ?? 0,
        };
      }),
    [data],
  );

  const run = async (fn: () => Promise<void>, failureTitle: string) => {
    setBusy(true);
    try {
      await fn();
      setAction(null);
    } catch (err) {
      toast.error(failureTitle, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reopenings = periods.reduce((s, p) => s + p.reopenCount, 0);

  /* Patch 171: the fiscal years CFMS offers, and adding the next one. */
  const fyRecords = useFiscalYearRecords();
  const added = fyRecords.data.map((r) => Number(r.year ?? r.id));
  const years = fiscalYearList(added);
  const next = nextFiscalYear(added);
  const isAdmin = hasRole('SUPER_ADMIN');
  const [addingYear, setAddingYear] = useState(false);

  return (
    <div>
      <PageHeader
        title="Accounting Periods"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Accounting Periods' }]}
      />

      <Card className="mb-4" bodyClassName="py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-navy-900">Fiscal years</p>
            <p className="mt-0.5 text-xs text-slate-500">
              The years in the FY list at the top of every screen. CFMS starts in{' '}
              {BASE_FISCAL_YEARS[1]}; {BASE_FISCAL_YEARS[0]} is kept for the comparative column of
              the {BASE_FISCAL_YEARS[1]} statements. Add the next year when the office is ready to
              work in it - one year at a time.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {years.map((y) => {
                const r = fyRecords.data.find((d) => Number(d.year ?? d.id) === y);
                return (
                  <Badge key={y} tone={r?.status === 'CLOSED' ? 'slate' : 'blue'}>
                    FY {y}
                    {r?.status === 'CLOSED' ? ' - closed' : ''}
                  </Badge>
                );
              })}
            </div>
          </div>
          {isAdmin && (
            <Button size="sm" variant="primary" onClick={() => setAddingYear(true)}>
              Add FY {next}
            </Button>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={addingYear}
        onCancel={() => setAddingYear(false)}
        onConfirm={() =>
          void run(async () => {
            await engine.addFiscalYear({ year: next });
            setAddingYear(false);
            toast.success(`FY ${next} added`, 'It is now in the FY list at the top of the screen.');
          }, 'Could not add the year')
        }
        loading={busy}
        title={`Add fiscal year ${next}`}
        confirmLabel={`Add FY ${next}`}
        message={
          <p>
            FY {next} will appear in the fiscal year list of every user. A year once added stays in
            the list - it is recorded in the audit trail.
          </p>
        }
      />

      {!canControl && (
        <Alert tone="info" className="mb-4">
          Only the Municipal Accountant and administrators may close or reopen an accounting period.
          You can see the state of each month here.
        </Alert>
      )}

      {reopenings > 0 && (
        <Alert tone="warning" className="mb-4" title="Periods have been reopened">
          Closed periods in this fund and year have been reopened {reopenings} time
          {reopenings === 1 ? '' : 's'}. Each reopening is recorded in the audit trail with its
          reason and is visible to COA.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {periods.map((p) => (
          <Card key={p.period} bodyClassName="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-navy-900">
                  {monthName(p.period)} {fiscalYear}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={p.status} />
                  {p.reopenCount > 0 && (
                    <Badge tone="violet">reopened {p.reopenCount}&times;</Badge>
                  )}
                </div>
              </div>

              {canControl && (
                <div className="flex shrink-0 flex-col gap-1.5">
                  {p.status === 'CLOSED' ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setAction({ kind: 'reopen', period: p.period })}
                    >
                      Reopen
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setAction({ kind: 'close', period: p.period })}
                      >
                        Close
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          setAction({
                            kind: p.status === 'TEMPORARILY_LOCKED' ? 'unlock' : 'lock',
                            period: p.period,
                          })
                        }
                      >
                        {p.status === 'TEMPORARILY_LOCKED' ? 'Unlock' : 'Lock'}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            {(p.closedAt || p.reopenedAt) && (
              <dl className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-2xs text-slate-500">
                {p.closedAt && (
                  <div>
                    Closed {formatInstant(p.closedAt)}
                    {p.closedBy && ` by ${p.closedBy}`}
                  </div>
                )}
                {p.reopenedAt && (
                  <div className="text-amber-700">
                    Reopened {formatInstant(p.reopenedAt)}
                    {p.reopenReason && (
                      <span className="block italic">&ldquo;{p.reopenReason}&rdquo;</span>
                    )}
                  </div>
                )}
              </dl>
            )}
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={action?.kind === 'close'}
        onCancel={() => setAction(null)}
        onConfirm={() =>
          void run(async () => {
            await engine.closePeriod({ fiscalYear, period: action!.period, fundCode });
            toast.success(
              `${monthName(action!.period)} ${fiscalYear} closed`,
              'Nothing further can be posted into this month unless it is reopened.',
            );
          }, 'The period was not closed')
        }
        loading={busy}
        title={`Close ${action ? monthName(action.period) : ''} ${fiscalYear}`}
        confirmLabel="Close the period"
        variant="primary"
        message={
          <>
            <p>
              After closing, no journal entry can be posted into this month for the{' '}
              {fundLabel(fundCode)}.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Before closing, the server proves the trial balance foots and refuses if any voucher
              or journal entry for the month is still in review or unposted - those would have
              nowhere to go afterwards.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={action?.kind === 'reopen'}
        onCancel={() => setAction(null)}
        onConfirm={(reason) =>
          void run(async () => {
            await engine.reopenPeriod({
              fiscalYear,
              period: action!.period,
              fundCode,
              reason: reason!,
            });
            toast.success(`${monthName(action!.period)} ${fiscalYear} reopened`);
          }, 'The period was not reopened')
        }
        loading={busy}
        title={`Reopen ${action ? monthName(action.period) : ''} ${fiscalYear}`}
        confirmLabel="Reopen the period"
        variant="danger"
        requireReason
        minReasonLength={15}
        reasonLabel="Why this closed period must be reopened"
        reasonHint="Recorded permanently as a critical audit event, notified to the administrators, and shown on this screen thereafter."
        message={
          <>
            <p>
              Reopening allows new postings into a month whose figures have already been reported.
              Anything posted after reopening changes reports that may already have been submitted.
            </p>
            <p className="mt-2">
              Consider whether a prior period adjustment in the current month would serve instead -
              it usually does, and it leaves the reported figures intact.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={action?.kind === 'lock' || action?.kind === 'unlock'}
        onCancel={() => setAction(null)}
        onConfirm={() =>
          void run(async () => {
            const locked = action!.kind === 'lock';
            await engine.lockPeriod({ fiscalYear, period: action!.period, fundCode, locked });
            toast.success(
              `${monthName(action!.period)} ${fiscalYear} ${locked ? 'locked' : 'unlocked'}`,
              locked
                ? 'Postings into this month are paused while it is reviewed.'
                : 'Postings into this month are permitted again.',
            );
          }, 'Could not change the lock')
        }
        loading={busy}
        title={`${action?.kind === 'lock' ? 'Lock' : 'Unlock'} ${action ? monthName(action.period) : ''}`}
        confirmLabel={action?.kind === 'lock' ? 'Lock' : 'Unlock'}
        message={
          <p>
            A temporary lock stops new postings while the month is reviewed, without closing it. It
            can be lifted at any time by the Municipal Accountant.
          </p>
        }
      />
    </div>
  );
}
