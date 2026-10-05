import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, Select, TextArea, DateInput, AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { EmployeePicker, BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { usePrimaryReports, useRcds, useBankAccounts } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import {
  PRIMARY_REPORT_TYPE_HINTS,
  PRIMARY_REPORT_TYPE_LABELS,
  PRIMARY_REPORT_TYPES,
  reconcileDeposit,
  type PrimaryReport,
  type PrimaryReportType,
} from '@/types/primaryReports';
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TABS, COLLECTION_CRUMBS } from './sections';

/**
 * Primary reports - the Liquidating Officer's and the Treasurer's layer.
 *
 * Six collectors file six reports; the municipality has one cash position.
 * This screen is where those six become one: a primary gathers the
 * collectors' reports, or banks what they gathered, and closing it is the
 * signature that freezes the lot.
 *
 * Two things on this screen are refusals rather than features, and they are
 * the reason it exists. A collector's report cannot be gathered into two
 * primaries, and a day's collections cannot be banked twice. Both are checked
 * by the server against every other report for the fund, so both hold even if
 * two officers are working at the same moment on different machines.
 */
export default function PrimaryReports() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data: primaries, loading, error } = usePrimaryReports(fiscalYear, fundCode);
  const { data: rcds } = useRcds(fiscalYear, fundCode);

  const [editing, setEditing] = useState<PrimaryReport | 'new' | null>(null);
  const [closing, setClosing] = useState<PrimaryReport | null>(null);
  const [reopening, setReopening] = useState<PrimaryReport | null>(null);
  const [cancelling, setCancelling] = useState<PrimaryReport | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can('treasury', 'create');
  const canClose = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER');

  const reopenedTotal = primaries.reduce((s, p) => s + (p.reopenedCount ?? 0), 0);

  const columns: Column<PrimaryReport>[] = [
    {
      key: 'primaryNo',
      header: 'Primary No.',
      width: '10rem',
      value: (p) => p.primaryNo ?? '',
      cell: (p) =>
        p.primaryNo ? (
          <span className="font-mono text-xs">{p.primaryNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Open</span>
        ),
    },
    {
      key: 'reportDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (p) => p.reportDate,
      cell: (p) => formatShortDate(p.reportDate),
    },
    {
      key: 'reportType',
      header: 'Type',
      width: '11rem',
      value: (p) => PRIMARY_REPORT_TYPE_LABELS[p.reportType],
      cell: (p) => (
        <Badge tone={p.reportType === 'DEPOSIT' ? 'violet' : 'blue'}>
          {PRIMARY_REPORT_TYPE_LABELS[p.reportType]}
        </Badge>
      ),
    },
    {
      key: 'officer',
      header: 'Accountable officer',
      value: (p) => p.accountableOfficerName,
      cell: (p) => <span className="text-xs">{p.accountableOfficerName}</span>,
    },
    {
      key: 'covering',
      header: 'Covering',
      value: (p) => (p.reportType === 'DEPOSIT' ? p.coveredPrimaryIds.length : p.rcdIds.length),
      cell: (p) => {
        const n = p.reportType === 'DEPOSIT' ? p.coveredPrimaryIds.length : p.rcdIds.length;
        return (
          <span className="text-xs text-slate-600">
            {n} {p.reportType === 'DEPOSIT' ? 'collection report' : 'report'}
            {n === 1 ? '' : 's'}
          </span>
        );
      },
    },
    {
      key: 'totalAmount',
      header: 'Amount',
      kind: 'amount',
      width: '9rem',
      value: (p) => p.totalAmount,
      cell: (p) => formatPeso(p.totalAmount),
    },
    {
      key: 'status',
      header: 'Status',
      fixed: true,
      width: '16rem',
      cell: (p) => (
        <div className="flex items-center justify-end gap-1.5">
          {(p.reopenedCount ?? 0) > 0 && (
            <Badge tone="violet">reopened {p.reopenedCount}&times;</Badge>
          )}
          <StatusBadge status={p.status} />
          <Link
            to={`/treasury/collections/primary/${p.id}/form`}
            className="rounded px-1.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
          >
            Form
          </Link>
          {p.status === 'OPEN' && canCreate && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
              Edit
            </Button>
          )}
          {p.status === 'OPEN' && canClose && (
            <Button size="sm" variant="primary" onClick={() => setClosing(p)}>
              Close
            </Button>
          )}
          {p.status === 'CLOSED' && canClose && (
            <Button size="sm" variant="secondary" onClick={() => setReopening(p)}>
              Reopen
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Primary Reports"
        subtitle={`${fundLabel(fundCode)} — fiscal year ${fiscalYear}`}
        breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Primary Reports' }]}
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              New primary report
            </Button>
          ) : null
        }
      />

      <SectionTabs tabs={COLLECTION_TABS} />

      {reopenedTotal > 0 && (
        <Alert tone="warning" title="Closed reports have been reopened" className="mb-4">
          Reports in this fund and year have been reopened {reopenedTotal} time
          {reopenedTotal === 1 ? '' : 's'}. Each reopening keeps its original number, is recorded in
          the audit trail with its reason, and is visible to COA.
        </Alert>
      )}

      <Alert tone="info" title="How the two levels fit together" className="mb-5">
        A collector&rsquo;s own Report of Collections and Deposits is the{' '}
        <strong>secondary</strong>. A primary gathers several of them, or banks what they gathered.
        Closing a primary draws its number and freezes the secondaries it covers &mdash; after that
        they cannot be altered from under it.
      </Alert>

      <DataTable
        rows={primaries}
        columns={columns}
        rowKey={(p) => p.id}
        loading={loading}
        error={error}
        searchPlaceholder="Primary number, officer or type"
        emptyTitle="No primary reports yet"
        emptyMessage="Gather the day's collectors' reports into one, or record a deposit."
        emptyAction={
          canCreate ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              Create the first one
            </Button>
          ) : undefined
        }
        exportMeta={{
          title: 'Register of Primary Reports',
          fundLabel: fundLabel(fundCode),
          periodLabel: `Fiscal year ${fiscalYear}`,
        }}
      />

      {editing && (
        <PrimaryForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          existing={editing === 'new' ? null : editing}
          rcds={rcds}
          primaries={primaries}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('Primary report saved');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(closing)}
        onCancel={() => setClosing(null)}
        title="Close the primary report"
        confirmLabel="Close the report"
        loading={busy}
        message={
          <>
            <p>
              This draws the report number and closes it at{' '}
              <strong>{formatPeso(closing?.totalAmount ?? 0)}</strong>.
            </p>
            <p className="mt-2">
              The {closing?.rcdIds.length ?? 0} report
              {(closing?.rcdIds.length ?? 0) === 1 ? '' : 's'} it covers are frozen to this one and
              cannot be altered afterwards. Reopening is possible but is recorded with a reason and
              counted on the face of the report.
            </p>
          </>
        }
        onConfirm={async () => {
          if (!closing) return;
          setBusy(true);
          try {
            const r = await engine.closePrimaryReport({ primaryId: closing.id });
            toast.success(`Primary ${r.primaryNo} closed`);
            setClosing(null);
          } catch (err) {
            toast.error('The report was not closed', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(reopening)}
        onCancel={() => setReopening(null)}
        title={`Reopen primary ${reopening?.primaryNo ?? ''}`}
        confirmLabel="Reopen"
        variant="danger"
        requireReason
        minReasonLength={15}
        reasonLabel="Why this closed report must be reopened"
        reasonHint="Recorded as a critical audit event and counted on the report from now on."
        loading={busy}
        message="The report keeps its number - a reopened report that came back with a new one would leave a hole in the series nobody could explain. The reports it covered are released while it is open."
        onConfirm={async (reason) => {
          if (!reopening) return;
          setBusy(true);
          try {
            await engine.reopenPrimaryReport({ primaryId: reopening.id, reason: reason ?? '' });
            toast.success('Report reopened');
            setReopening(null);
          } catch (err) {
            toast.error('The report was not reopened', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(cancelling)}
        onCancel={() => setCancelling(null)}
        title={`Cancel primary ${cancelling?.primaryNo ?? '(open)'}`}
        confirmLabel="Cancel the report"
        variant="danger"
        requireReason
        loading={busy}
        message="The report is kept with a status of Cancelled and its number is not reused. The reports it covered are released."
        onConfirm={async (reason) => {
          if (!cancelling) return;
          setBusy(true);
          try {
            await engine.cancelPrimaryReport({ primaryId: cancelling.id, reason: reason ?? '' });
            toast.success('Report cancelled');
            setCancelling(null);
          } catch (err) {
            toast.error('Could not cancel the report', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function PrimaryForm({
  fiscalYear,
  fundCode,
  existing,
  rcds,
  primaries,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  existing: PrimaryReport | null;
  rcds: Array<{ id: string; rcdNo: string; rcdDate: string; collectingOfficerName: string; totalCollections: number; status: string; primaryReportId?: string | null }>;
  primaries: PrimaryReport[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { data: bankAccounts } = useBankAccounts(fundCode);

  const [reportType, setReportType] = useState<PrimaryReportType>(existing?.reportType ?? 'COLLECTION');
  const [reportDate, setReportDate] = useState(existing?.reportDate ?? todayPh());
  const [officerId, setOfficerId] = useState<string | null>(existing?.accountableOfficerId ?? null);
  const [officerName, setOfficerName] = useState(existing?.accountableOfficerName ?? '');
  const [chosenRcds, setChosenRcds] = useState<string[]>(existing?.rcdIds ?? []);
  const [coveredIds, setCoveredIds] = useState<string[]>(existing?.coveredPrimaryIds ?? []);
  const [remarks, setRemarks] = useState(existing?.remarks ?? '');
  const [busy, setBusy] = useState(false);

  // Deposit tender
  const [bankAccountId, setBankAccountId] = useState<string | null>(existing?.deposit?.bankAccountId ?? null);
  const [cash, setCash] = useState<number | null>(existing?.deposit?.cash ?? 0);
  const [checks, setChecks] = useState(existing?.deposit?.checks ?? []);
  const [online, setOnline] = useState(existing?.deposit?.online ?? []);

  const isDeposit = reportType === 'DEPOSIT';

  /** Only reports not already gathered elsewhere are offered. */
  const availableRcds = useMemo(
    () =>
      rcds
        .filter(
          (r) =>
            r.status !== 'CANCELLED' &&
            (!r.primaryReportId || existing?.rcdIds.includes(r.id)),
        )
        .sort((a, b) => b.rcdDate.localeCompare(a.rcdDate)),
    [rcds, existing],
  );

  /** A deposit can only liquidate a CLOSED collection primary. */
  const availablePrimaries = useMemo(() => {
    const claimed = new Set(
      primaries
        .filter((p) => p.reportType === 'DEPOSIT' && p.id !== existing?.id && p.status !== 'CANCELLED')
        .flatMap((p) => p.coveredPrimaryIds),
    );
    return primaries
      .filter(
        (p) =>
          p.reportType !== 'DEPOSIT' &&
          p.status === 'CLOSED' &&
          (!claimed.has(p.id) || existing?.coveredPrimaryIds.includes(p.id)),
      )
      .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  }, [primaries, existing]);

  const depositTotal =
    (cash ?? 0) +
    checks.reduce((s, c) => s + (c.amount || 0), 0) +
    online.reduce((s, o) => s + (o.amount || 0), 0);

  const coveredTotal = availablePrimaries
    .filter((p) => coveredIds.includes(p.id))
    .reduce((s, p) => s + p.totalAmount, 0);

  const collectionTotal = availableRcds
    .filter((r) => chosenRcds.includes(r.id))
    .reduce((s, r) => s + r.totalCollections, 0);

  const recon = reconcileDeposit(depositTotal, coveredTotal);

  const save = async () => {
    if (!officerId || !officerName) return toast.error('Incomplete', 'Choose the accountable officer.');
    if (!isDeposit && chosenRcds.length === 0) {
      return toast.error('Nothing chosen', 'Choose at least one report of collections to gather.');
    }
    if (isDeposit && !bankAccountId) {
      return toast.error('Incomplete', 'Choose the bank account the money was deposited to.');
    }

    setBusy(true);
    try {
      const bank = bankAccounts.find((b) => b.id === bankAccountId);
      await engine.savePrimaryReport({
        primaryId: existing?.id,
        fiscalYear,
        fundCode,
        reportDate,
        reportType,
        accountableOfficerId: officerId,
        accountableOfficerName: officerName,
        rcdIds: isDeposit ? [] : chosenRcds,
        coveredPrimaryIds: isDeposit ? coveredIds : [],
        deposit: isDeposit
          ? {
              bankAccountId: bankAccountId as string,
              bankName: bank?.bankName ?? '',
              bankAccountNumber: bank?.accountNumber ?? '',
              cash: cash ?? 0,
              checks,
              online,
            }
          : null,
        remarks: remarks.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      toast.error('The report was not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={existing ? 'Edit the primary report' : 'New primary report'}
      description="Gathers the collectors' own reports, or banks what they gathered."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" required hint={PRIMARY_REPORT_TYPE_HINTS[reportType]} className="sm:col-span-2">
          <Select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as PrimaryReportType)}
            disabled={Boolean(existing)}
          >
            {PRIMARY_REPORT_TYPES.map((t) => (
              <option key={t} value={t}>
                {PRIMARY_REPORT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Report date" required>
          <DateInput value={reportDate} onChange={setReportDate} />
        </Field>

        <Field
          label="Accountable officer"
          required
          hint={isDeposit ? 'The Treasurer, on a deposit.' : 'The Liquidating Officer receiving the remittances.'}
        >
          <EmployeePicker
            value={officerId}
            onChange={(id, emp) => {
              setOfficerId(id);
              setOfficerName(emp?.name ?? '');
            }}
          />
        </Field>
      </div>

      {!isDeposit ? (
        <Card
          title="Reports of collections to gather"
          subtitle={`${chosenRcds.length} chosen — ${formatPeso(collectionTotal)}`}
          className="mt-4"
          bodyClassName="max-h-72 overflow-y-auto p-0"
        >
          {availableRcds.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-500">
              Every report in this fund and year is already gathered into a primary.
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {availableRcds.map((r) => (
                <label key={r.id} className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={chosenRcds.includes(r.id)}
                    onChange={(e) =>
                      setChosenRcds((s) =>
                        e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id),
                      )
                    }
                    className="h-4 w-4 rounded border-slate-300 text-brand-600"
                  />
                  <span className="w-28 shrink-0 font-mono text-xs">{r.rcdNo}</span>
                  <span className="w-24 shrink-0 text-xs text-slate-500">
                    {formatShortDate(r.rcdDate)}
                  </span>
                  <span className="flex-1 truncate text-xs">{r.collectingOfficerName}</span>
                  <span className="shrink-0 text-xs font-medium tabular-nums">
                    {formatPeso(r.totalCollections)}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Bank account" required className="sm:col-span-2">
              <BankAccountPicker value={bankAccountId} onChange={setBankAccountId} fundCode={fundCode} />
            </Field>
            <Field label="Cash" hint="Notes and coin banked.">
              <AmountInput value={cash} onChange={setCash} />
            </Field>
          </div>

          <TenderList
            title="Checks"
            addLabel="Add a check"
            rows={checks.map((c) => ({ a: c.checkNo, b: c.payor, amount: c.amount }))}
            labels={{ a: 'Check no.', b: 'Payor' }}
            onChange={(rows) =>
              setChecks(rows.map((r) => ({ checkNo: r.a, payor: r.b, amount: r.amount })))
            }
          />

          <TenderList
            title="Online receipts"
            addLabel="Add an online receipt"
            rows={online.map((o) => ({ a: o.referenceNo, b: o.particulars, amount: o.amount }))}
            labels={{ a: 'Reference no.', b: 'Particulars' }}
            onChange={(rows) =>
              setOnline(rows.map((r) => ({ referenceNo: r.a, particulars: r.b, amount: r.amount })))
            }
          />

          <Card
            title="Collection reports this deposit liquidates"
            subtitle={`${coveredIds.length} chosen — ${formatPeso(coveredTotal)}`}
            className="mt-4"
            bodyClassName="max-h-56 overflow-y-auto p-0"
          >
            {availablePrimaries.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-slate-500">
                No closed collection report is waiting to be banked.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {availablePrimaries.map((p) => (
                  <label key={p.id} className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={coveredIds.includes(p.id)}
                      onChange={(e) =>
                        setCoveredIds((s) =>
                          e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id),
                        )
                      }
                      className="h-4 w-4 rounded border-slate-300 text-brand-600"
                    />
                    <span className="w-28 shrink-0 font-mono text-xs">{p.primaryNo}</span>
                    <span className="w-24 shrink-0 text-xs text-slate-500">
                      {formatShortDate(p.reportDate)}
                    </span>
                    <span className="flex-1 truncate text-xs">{p.accountableOfficerName}</span>
                    <span className="shrink-0 text-xs font-medium tabular-nums">
                      {formatPeso(p.totalAmount)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Card>

          <div
            className={`mt-3 rounded-md border px-3 py-2.5 text-xs ${
              recon.verdict === 'RECONCILED'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : recon.verdict === 'EMPTY'
                  ? 'border-slate-200 bg-slate-50 text-slate-600'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            <p className="font-medium">
              Deposit {formatPeso(depositTotal)} &middot; reports covered {formatPeso(coveredTotal)}
              {recon.verdict === 'OVER' && ` — over by ${formatPeso(recon.difference)}`}
              {recon.verdict === 'SHORT' && ` — short by ${formatPeso(-recon.difference)}`}
            </p>
            <p className="mt-0.5">{recon.message}</p>
          </div>
        </>
      )}

      <Field label="Remarks" className="mt-4">
        <TextArea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

interface TenderRow {
  a: string;
  b: string;
  amount: number;
}

/** A repeatable two-text-and-an-amount list, used for checks and transfers. */
function TenderList({
  title,
  addLabel,
  rows,
  labels,
  onChange,
}: {
  title: string;
  addLabel: string;
  rows: TenderRow[];
  labels: { a: string; b: string };
  onChange: (rows: TenderRow[]) => void;
}) {
  const set = (i: number, patch: Partial<TenderRow>) =>
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  return (
    <Card
      title={title}
      className="mt-4"
      bodyClassName="p-3"
      actions={
        <Button size="sm" variant="secondary" onClick={() => onChange([...rows, { a: '', b: '', amount: 0 }])}>
          {addLabel}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="py-2 text-center text-xs text-slate-400">None</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <TextInput
                className="col-span-3"
                placeholder={labels.a}
                value={r.a}
                onChange={(e) => set(i, { a: e.target.value })}
              />
              <TextInput
                className="col-span-5"
                placeholder={labels.b}
                value={r.b}
                onChange={(e) => set(i, { b: e.target.value })}
              />
              <div className="col-span-3">
                <AmountInput value={r.amount} onChange={(v) => set(i, { amount: v ?? 0 })} />
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="col-span-1"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                &times;
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
