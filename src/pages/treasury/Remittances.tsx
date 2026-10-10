import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, DateInput, AmountInput, TextInput, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useCollections, useRemittances } from '@/data/queries';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import {
  allocateRemittances,
  describeAllocation,
  isRemittable,
  officerKeyOf,
  seriesOrder,
} from '@/lib/remittances';
import type { CollectionRemittance } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from './sections';

/**
 * Patch 160 - REMITTANCES: the collector hands the money to the Liquidating
 * Officer (for Collection).
 *
 * A remittance is usually the exact amount collected, and sometimes short.
 * It is applied to the collector's cash receipts in accountable-form series
 * order (src/lib/remittances.ts), so the screen can say exactly which
 * receipts are remitted, which one is partly remitted, and which are still
 * with the collector. e-Collections never pass through the collector's
 * hands and are not here.
 *
 * A remittance books nothing: the cash stays in Cash - Local Treasury until
 * the RCD that reports it and the deposit that banks it.
 */
export default function Remittances() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, user, profile } = useAuth();
  const toast = useToast();
  const collections = useCollections(fiscalYear, fundCode);
  const remittances = useRemittances(fiscalYear, fundCode);

  const [showForm, setShowForm] = useState(false);
  const [cancelling, setCancelling] = useState<CollectionRemittance | null>(null);
  const [busy, setBusy] = useState(false);
  const [officer, setOfficer] = useState('');

  const alloc = useMemo(
    () => allocateRemittances(collections.data as never, remittances.data as never),
    [collections.data, remittances.data],
  );
  const totals = useMemo(
    () => new Map(collections.data.map((c) => [c.id, c.totalAmount])),
    [collections.data],
  );

  /** The receipts still (wholly or partly) with the collector. */
  const outstanding = useMemo(
    () =>
      collections.data
        .filter((c) => isRemittable(c as never))
        .filter((c) => !officer || officerKeyOf(c) === officer)
        .filter((c) => (alloc.byReceipt.get(c.id)?.unremitted ?? 0) > 0)
        .sort((a, b) => seriesOrder(a as never, b as never)),
    [collections.data, alloc, officer],
  );

  const rows = useMemo(
    () => remittances.data.filter((m) => !officer || officerKeyOf(m) === officer),
    [remittances.data, officer],
  );

  const columns: Column<CollectionRemittance>[] = [
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (m) => m.remittanceDate,
      cell: (m) => formatShortDate(m.remittanceDate),
    },
    {
      key: 'collector',
      header: 'Collecting officer',
      value: (m) => m.collectingOfficerName,
      cell: (m) => m.collectingOfficerName,
    },
    {
      key: 'lo',
      header: 'Received by',
      value: (m) => m.liquidatingOfficerName,
      cell: (m) => m.liquidatingOfficerName,
    },
    {
      key: 'ref',
      header: 'Reference',
      value: (m) => m.referenceNo ?? '',
      cell: (m) => m.referenceNo ?? '',
    },
    {
      key: 'covers',
      header: 'Receipts covered (AF series)',
      value: (m) => describeAllocation(alloc.byRemittance.get(m.id) ?? [], totals),
      cell: (m) =>
        m.status === 'CANCELLED' ? (
          <span className="text-slate-400">-</span>
        ) : (
          <span className="font-mono text-xs">
            {describeAllocation(alloc.byRemittance.get(m.id) ?? [], totals) || '-'}
          </span>
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (m) => m.amount,
      cell: (m) => formatPeso(m.amount, { symbol: false }),
    },
    {
      key: 'status',
      header: '',
      fixed: true,
      sortable: false,
      width: '10rem',
      value: (m) => m.status,
      cell: (m) => (
        <div className="flex items-center justify-end gap-1.5">
          <StatusBadge status={m.status} />
          {m.status === 'RECORDED' && can('treasury', 'create') && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setCancelling(m);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      ),
    },
  ];

  const officers = alloc.officers.filter((o) => o.collected > 0 || o.remitted > 0);

  return (
    <div>
      <PageHeader
        title="Collections and Deposits"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - remittances to the Liquidating Officer`}
        breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Remittances' }]}
        actions={
          can('treasury', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              Record remittance
            </Button>
          )
        }
      />

      <GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />

      <Card
        className="mb-4"
        title="By collecting officer"
        subtitle="Cash collections only. A remittance is applied to the officer's receipts in accountable-form series order."
        bodyClassName="p-0"
      >
        {officers.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">No cash collections this year.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-3 py-2">Collecting officer</th>
                <th className="px-3 py-2 text-right">Collected</th>
                <th className="px-3 py-2 text-right">Remitted</th>
                <th className="px-3 py-2 text-right">Not yet remitted</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {officers.map((o) => (
                <tr
                  key={o.key}
                  onClick={() => setOfficer(officer === o.key ? '' : o.key)}
                  className={`cursor-pointer border-b border-slate-100 hover:bg-brand-50/50 ${
                    officer === o.key ? 'bg-brand-50' : ''
                  }`}
                >
                  <td className="px-3 py-2">{o.name || '-'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPeso(o.collected, { symbol: false })}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPeso(o.remitted, { symbol: false })}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatPeso(o.unremitted, { symbol: false })}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {o.excess > 0 && (
                      <Badge tone="amber">Over by {formatPeso(o.excess, { symbol: false })}</Badge>
                    )}
                    {o.unremitted === 0 && o.excess === 0 && <Badge tone="emerald">Remitted</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        loading={remittances.loading}
        error={remittances.error}
        searchPlaceholder="Collecting officer or reference"
        emptyTitle="No remittances recorded"
        emptyMessage="Record each turnover of collections from a collecting officer to the Liquidating Officer."
        filters={
          <Select
            aria-label="Collecting officer"
            value={officer}
            onChange={(e) => setOfficer(e.target.value)}
            className="w-auto min-w-[14rem] py-1.5 text-sm"
          >
            <option value="">All collecting officers</option>
            {officers.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name || o.key}
              </option>
            ))}
          </Select>
        }
        printLayout="landscape"
        exportMeta={{
          title: 'Remittances of Collections',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      <Card
        className="mt-4"
        title="Receipts not yet remitted"
        subtitle={
          officer
            ? 'This collecting officer, in accountable-form series order.'
            : 'All collecting officers, in accountable-form series order. Choose an officer above to narrow it.'
        }
        bodyClassName="p-0"
      >
        {outstanding.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">Every cash receipt has been remitted.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-3 py-2">OR No.</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Collecting officer</th>
                <th className="px-3 py-2">Payor</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Not yet remitted</th>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((c) => {
                const a = alloc.byReceipt.get(c.id);
                return (
                  <tr key={c.id} className="border-b border-slate-100">
                    <td className="px-3 py-1.5 font-mono text-xs">{c.orNumber}</td>
                    <td className="px-3 py-1.5 text-xs">{formatShortDate(c.orDate)}</td>
                    <td className="px-3 py-1.5">{c.collectingOfficerName}</td>
                    <td className="px-3 py-1.5 text-xs">{c.payorName}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatPeso(c.totalAmount, { symbol: false })}
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                      {formatPeso(a?.unremitted ?? 0, { symbol: false })}
                      {a?.state === 'PARTIAL' && (
                        <span className="ml-1 font-sans text-2xs font-normal text-amber-700">
                          part
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {showForm && (
        <RemittanceForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          unremittedOf={(key) => alloc.officers.find((o) => o.key === key)?.unremitted ?? 0}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Remittance recorded', 'Applied to the receipts in AF series order.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(cancelling)}
        onCancel={() => setCancelling(null)}
        onConfirm={(reason) => {
          if (!cancelling || !user) return;
          setBusy(true);
          void updateDraft(
            COL.collectionRemittances,
            cancelling.id,
            { status: 'CANCELLED', cancelReason: reason ?? null },
            actorStamp({
              uid: user.uid,
              name: profile?.displayName ?? user.email ?? user.uid,
              position: profile?.position,
            }),
          )
            .then(() => {
              toast.success(
                'Remittance cancelled',
                'The receipts it covered are unremitted again.',
              );
              setCancelling(null);
            })
            .catch((err) => toast.error('Could not cancel', err.message))
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title="Cancel this remittance"
        confirmLabel="Cancel remittance"
        variant="danger"
        requireReason
        minReasonLength={5}
        message={
          <p>
            The receipts it covered go back to not remitted, and later remittances of the same
            officer move up the series.
          </p>
        }
      />
    </div>
  );
}

function RemittanceForm({
  fiscalYear,
  fundCode,
  unremittedOf,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  unremittedOf: (officerKey: string) => number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();
  const [date, setDate] = useState(todayPh());
  const [collectorId, setCollectorId] = useState<string | null>(null);
  const [collectorName, setCollectorName] = useState('');
  const [loId, setLoId] = useState<string | null>(null);
  const [loName, setLoName] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [referenceNo, setReferenceNo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);

  const due = collectorId ? unremittedOf(collectorId) : 0;

  const save = async () => {
    if (!user) return;
    if (!collectorId || !loId || !amount || amount <= 0) {
      toast.error(
        'Incomplete',
        'The collecting officer, the Liquidating Officer who received it, and the amount are required.',
      );
      return;
    }
    setSaving(true);
    try {
      await createDraft(
        COL.collectionRemittances,
        {
          fiscalYear,
          fundCode,
          remittanceDate: date,
          collectingOfficerId: collectorId,
          collectingOfficerName: collectorName,
          liquidatingOfficerId: loId,
          liquidatingOfficerName: loName,
          amount,
          referenceNo: referenceNo.trim() || null,
          remarks: remarks.trim() || null,
          status: 'RECORDED',
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
      );
      onSaved();
    } catch (err) {
      toast.error(
        'Could not record the remittance',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a remittance"
      description="Collections handed by a collecting officer to the Liquidating Officer (for Collection)."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" required htmlFor="remDate">
          <DateInput id="remDate" value={date} onChange={setDate} />
        </Field>
        <Field
          label="Reference"
          htmlFor="remRef"
          hint="The acknowledgement or turnover slip, if any."
        >
          <TextInput
            id="remRef"
            value={referenceNo}
            onChange={(e) => setReferenceNo(e.target.value)}
          />
        </Field>
        <Field label="Collecting officer" required htmlFor="remCollector">
          <EmployeePicker
            id="remCollector"
            value={collectorId}
            onChange={(v, emp) => {
              setCollectorId(v);
              setCollectorName(emp?.name ?? '');
            }}
          />
        </Field>
        <Field label="Received by (Liquidating Officer)" required htmlFor="remLo">
          <EmployeePicker
            id="remLo"
            value={loId}
            onChange={(v, emp) => {
              setLoId(v);
              setLoName(emp?.name ?? '');
            }}
          />
        </Field>
        <Field
          label="Amount remitted"
          required
          htmlFor="remAmount"
          hint={collectorId ? `Not yet remitted by this officer: ${formatPeso(due)}.` : undefined}
        >
          <div className="flex gap-2">
            <AmountInput id="remAmount" value={amount} onChange={setAmount} />
            {collectorId && due > 0 && amount !== due && (
              <Button size="sm" onClick={() => setAmount(due)}>
                All of it
              </Button>
            )}
          </div>
        </Field>
        <Field label="Remarks" htmlFor="remRemarks">
          <TextInput id="remRemarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
      </div>
      {collectorId && amount !== null && amount > 0 && amount !== due && (
        <Alert tone={amount < due ? 'warning' : 'info'} className="mt-4">
          {amount < due
            ? `Short by ${formatPeso(due - amount)}. It is applied to the receipts in AF series order; the receipts after the point it runs out stay unremitted.`
            : `More than the ${formatPeso(due)} on file by ${formatPeso(amount - due)} - it will show as an overage until the receipts it covers are recorded.`}
        </Alert>
      )}
    </Modal>
  );
}
