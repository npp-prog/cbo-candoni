import { useMemo, useState } from 'react';
import { newestFirst } from '@/lib/registerOrder';
import { Link } from 'react-router-dom';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, DateInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useRcds, useCollections } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import type { Rcd as RcdRecord } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';

/**
 * Report of Collections and Deposits.
 *
 * The RCD is the bridge between individual receipts and the books: it gathers
 * a collecting officer's receipts for a day, summarises them by revenue
 * account, and posts the journal entry that recognises the collections.
 *
 * Posting verifies, server-side, that every receipt listed exists, belongs to
 * this fund, and has not already been reported in another RCD. Double-counted
 * collections are the classic way a cash shortage is concealed.
 */
export default function Rcd() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data, loading, error } = useRcds(fiscalYear, fundCode);
  const collections = useCollections(fiscalYear, fundCode);

  const rows = useMemo(
    () => newestFirst(data, (r) => ({ ref: r.rcdNo, date: r.rcdDate })),
    [data],
  );

  const [showForm, setShowForm] = useState(false);
  const [posting, setPosting] = useState<RcdRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const canPost = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'MUNICIPAL_ACCOUNTANT');

  const columns: Column<RcdRecord>[] = [
    {
      key: 'rcdNo',
      header: 'RCD No.',
      width: '10rem',
      value: (r) => r.rcdNo ?? '',
      cell: (r) =>
        r.rcdNo && r.rcdNo !== '(unnumbered)' ? (
          <span className="font-mono text-xs">{r.rcdNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Draft</span>
        ),
    },
    {
      key: 'rcdDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (r) => r.rcdDate,
      cell: (r) => <span className="text-xs">{formatShortDate(r.rcdDate)}</span>,
    },
    {
      key: 'officer',
      header: 'Collecting officer',
      value: (r) => r.collectingOfficerName,
      cell: (r) => <span className="text-sm">{r.collectingOfficerName}</span>,
    },
    {
      key: 'orRange',
      header: 'OR numbers',
      value: (r) => r.orNumberFrom,
      cell: (r) => (
        <span className="font-mono text-xs text-slate-600">
          {r.orNumberFrom} to {r.orNumberTo}
        </span>
      ),
    },
    {
      key: 'receipts',
      header: 'Receipts',
      align: 'right',
      kind: 'number',
      value: (r) => r.collectionIds?.length ?? 0,
      cell: (r) => <span className="font-mono text-sm tabular">{r.collectionIds?.length ?? 0}</span>,
    },
    {
      key: 'collections',
      header: 'Collections',
      kind: 'amount',
      value: (r) => r.totalCollections,
      cell: (r) => formatPeso(r.totalCollections, { symbol: false }),
    },
    {
      key: 'deposits',
      header: 'Deposits',
      kind: 'amount',
      value: (r) => r.totalDeposits,
      cell: (r) => formatPeso(r.totalDeposits, { symbol: false, dash: true }),
    },
    {
      key: 'undeposited',
      header: 'Undeposited',
      kind: 'amount',
      value: (r) => r.undepositedAmount,
      cell: (r) => (
        <span className={r.undepositedAmount > 0 ? 'text-amber-700' : undefined}>
          {formatPeso(r.undepositedAmount, { symbol: false, dash: true })}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '13rem',
      value: (r) => r.status,
      fixed: true,
      sortable: false,
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <StatusBadge status={r.status} />
          {/* The register is how the office works; Appendix 34 is what it
              signs. Both read the same record. */}
          <Link
            to={`/treasury/collections/rcd/${r.id}/form`}
            className="rounded px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
          >
            Appendix 34
          </Link>
          {canPost && ['DRAFT', 'SUBMITTED', 'VERIFIED'].includes(r.status) && (
            <Button size="sm" variant="primary" onClick={() => setPosting(r)}>
              Post
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Report of Collections and Deposits"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'RCD' }]}
        actions={
          can('treasury', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              New RCD
            </Button>
          )
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        searchPlaceholder="RCD number or collecting officer"
        emptyTitle="No reports of collections"
        emptyMessage="An RCD gathers a collecting officer's receipts and recognises them in the books."
        printLayout="landscape"
        exportMeta={{
          title: 'Report of Collections and Deposits',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <RcdForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          collections={collections.data.filter((c) => c.status === 'ISSUED')}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('RCD saved as a draft', 'Post it to recognise the collections in the General Ledger.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(posting)}
        onCancel={() => setPosting(null)}
        onConfirm={() => {
          if (!posting) return;
          setBusy(true);
          void engine
            .postRcd({ rcdId: posting.id })
            .then((result) => {
              toast.success(
                `Posted as RCD ${result.rcdNo}`,
                'The collections are now recognised against Cash - Collecting Officers.',
              );
              setPosting(null);
            })
            .catch((err) => toast.error('The RCD was not posted', err.message))
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title="Post report of collections"
        confirmLabel="Post"
        variant="primary"
        message={
          posting && (
            <>
              <p>
                Recognises {formatPeso(posting.totalCollections)} of collections by{' '}
                {posting.collectingOfficerName} against the revenue accounts summarised on the
                report.
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Every receipt listed is verified server-side to exist, belong to this fund, and not
                already appear in another RCD.
              </p>
            </>
          )
        }
      />
    </div>
  );
}

function RcdForm({
  fiscalYear,
  fundCode,
  collections,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  collections: Array<{
    id: string;
    orNumber: string;
    orDate: string;
    payorName: string;
    totalAmount: number;
    collectingOfficerId: string;
    collectingOfficerName: string;
    lines: Array<{ accountCode: string; accountName: string; amount: number }>;
  }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const [rcdNo, setRcdNo] = useState('');
  const [rcdDate, setRcdDate] = useState(todayPh());
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [officerName, setOfficerName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const eligible = useMemo(
    () => collections.filter((c) => !officerId || c.collectingOfficerId === officerId),
    [collections, officerId],
  );

  const chosen = useMemo(() => eligible.filter((c) => selected.has(c.id)), [eligible, selected]);

  const summary = useMemo(() => {
    const map = new Map<string, { accountCode: string; accountName: string; amount: number }>();
    for (const c of chosen) {
      for (const line of c.lines ?? []) {
        const entry = map.get(line.accountCode) ?? {
          accountCode: line.accountCode,
          accountName: line.accountName,
          amount: 0,
        };
        entry.amount += line.amount;
        map.set(line.accountCode, entry);
      }
    }
    return [...map.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }, [chosen]);

  const total = chosen.reduce((s, c) => s + c.totalAmount, 0);
  const orNumbers = chosen.map((c) => c.orNumber).sort();

  const save = async () => {
    if (!officerId || chosen.length === 0 || !user) {
      toast.error('Incomplete', 'Select a collecting officer and at least one receipt.');
      return;
    }
    if (!rcdNo.trim()) {
      toast.error('The RCD number is missing', 'Assign it from the office book before saving.');
      return;
    }
    setSaving(true);
    try {
      await createDraft(
        COL.rcds,
        {
          rcdNo: rcdNo.trim(),
          rcdDate,
          fiscalYear,
          period: Number(rcdDate.slice(5, 7)),
          fundCode,
          collectingOfficerId: officerId,
          collectingOfficerName: officerName,
          orNumberFrom: orNumbers[0] ?? '',
          orNumberTo: orNumbers[orNumbers.length - 1] ?? '',
          collectionIds: chosen.map((c) => c.id),
          accountSummary: summary,
          totalCollections: total,
          totalDeposits: 0,
          undepositedAmount: total,
          depositIds: [],
          status: 'DRAFT',
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
      );
      onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New report of collections and deposits"
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="RCD number"
          required
          htmlFor="rcdNo"
          hint="From the collecting officer's own book."
        >
          <TextInput
            id="rcdNo"
            value={rcdNo}
            onChange={(e) => setRcdNo(e.target.value)}
            placeholder="100-26-10-0001"
            className="font-mono"
          />
        </Field>
        <Field label="Report date" required htmlFor="rcdDate">
          <DateInput id="rcdDate" value={rcdDate} onChange={setRcdDate} />
        </Field>
        <Field label="Collecting officer" required htmlFor="officer">
          <EmployeePicker
            id="officer"
            value={officerId}
            onChange={(v, emp) => {
              setOfficerId(v);
              setOfficerName(emp?.name ?? '');
              setSelected(new Set());
            }}
          />
        </Field>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <p className="cbo-label">
            Receipts to include{officerId ? '' : ' (choose a collecting officer first)'}
          </p>
          <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
            {eligible.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500">
                No unreported receipts for this officer.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {eligible.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs text-navy-900">{c.orNumber}</p>
                        <p className="truncate text-xs text-slate-500">
                          {c.payorName} - {formatShortDate(c.orDate)}
                        </p>
                      </div>
                      <span className="cbo-amount text-navy-800">{formatPeso(c.totalAmount)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div>
          <p className="cbo-label">Summary by revenue account</p>
          {summary.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 px-3 py-8 text-center text-sm text-slate-500">
              Select receipts to build the summary.
            </p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="cbo-th">Account</th>
                  <th className="cbo-th text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.accountCode}>
                    <td className="cbo-td">
                      <span className="font-mono text-xs text-slate-500">{s.accountCode}</span>{' '}
                      <span className="text-sm">{s.accountName}</span>
                    </td>
                    <td className="cbo-td cbo-amount">{formatPeso(s.amount, { symbol: false })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 font-semibold">
                  <td className="cbo-td">Total collections</td>
                  <td className="cbo-td cbo-amount">{formatPeso(total, { symbol: false })}</td>
                </tr>
              </tfoot>
            </table>
          )}

          {chosen.length > 0 && (
            <Alert tone="info" className="mt-4">
              Covers Official Receipts {orNumbers[0]} to {orNumbers[orNumbers.length - 1]},{' '}
              {chosen.length} receipt{chosen.length === 1 ? '' : 's'} in total.
            </Alert>
          )}
        </div>
      </div>
    </Modal>
  );
}
