import { useMemo, useState } from 'react';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, DateInput, AmountInput, TextInput, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker, EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDeposits, useRcds, useUndepositedCollections } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import type { Deposit } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TABS, COLLECTION_CRUMBS } from './sections';

/**
 * Deposits.
 *
 * A recorded deposit sits "in transit" until bank reconciliation matches it to
 * a credit on the statement. That intermediate state is what makes
 * deposits-in-transit a real, derived figure on the reconciliation statement
 * rather than a number somebody types into an adjustment box.
 */
export default function Deposits() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [recording, setRecording] = useState<Deposit | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useDeposits(bankAccountId ?? undefined, status || undefined);
  const undeposited = useUndepositedCollections(fundCode);

  const rows = useMemo(
    () => data.filter((d) => d.fiscalYear === fiscalYear && d.fundCode === fundCode),
    [data, fiscalYear, fundCode],
  );

  const inTransit = rows.filter((d) => d.status === 'IN_TRANSIT').reduce((s, d) => s + d.amount, 0);
  const undepositedTotal = undeposited.data.reduce((s, c) => s + c.totalAmount, 0);

  const canPost = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'MUNICIPAL_ACCOUNTANT');

  const columns: Column<Deposit>[] = [
    {
      key: 'slip',
      header: 'Deposit slip',
      width: '10rem',
      value: (d) => d.depositSlipNo,
      cell: (d) => <span className="font-mono text-xs text-navy-900">{d.depositSlipNo}</span>,
    },
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (d) => d.depositDate,
      cell: (d) => <span className="text-xs">{formatShortDate(d.depositDate)}</span>,
    },
    {
      key: 'bank',
      header: 'Bank',
      value: (d) => d.bankName,
      cell: (d) => (
        <div className="text-xs">
          <span className="text-navy-900">{d.bankName}</span>
          <span className="block text-slate-500">****{d.bankAccountNumber?.slice(-4)}</span>
        </div>
      ),
    },
    {
      key: 'rcd',
      header: 'RCD',
      width: '9rem',
      value: (d) => d.rcdNo ?? '',
      cell: (d) => <span className="font-mono text-xs text-slate-500">{d.rcdNo ?? '-'}</span>,
    },
    {
      key: 'officer',
      header: 'Collecting officer',
      value: (d) => d.collectingOfficerName ?? '',
      cell: (d) => <span className="text-xs text-slate-600">{d.collectingOfficerName ?? '-'}</span>,
      optional: true,
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (d) => d.amount,
      cell: (d) => formatPeso(d.amount, { symbol: false }),
    },
    {
      key: 'credited',
      header: 'Credited',
      value: (d) => d.creditedDate ?? '',
      cell: (d) => (
        <span className="text-xs">
          {d.creditedDate ? formatShortDate(d.creditedDate) : <span className="text-slate-400">Not yet</span>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '11rem',
      value: (d) => d.status,
      fixed: true,
      sortable: false,
      cell: (d) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={d.status} />
          {canPost && d.status === 'RECORDED' && !d.jevId && (
            <Button size="sm" variant="primary" onClick={() => setRecording(d)}>
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
        title="Collections and Deposits"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - ${formatPeso(inTransit)} in transit`}
        breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Deposits' }]}
        actions={
          can('treasury', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              Record deposit
            </Button>
          )
        }
      />

      <SectionTabs tabs={COLLECTION_TABS} />

      {undepositedTotal > 0 && (
        <Alert tone="warning" className="mb-4" title="Collections awaiting deposit">
          {undeposited.data.length} collection{undeposited.data.length === 1 ? '' : 's'} totalling{' '}
          {formatPeso(undepositedTotal)} have been receipted but not deposited. Collections should
          be deposited intact and daily.
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(d) => d.id}
        loading={loading}
        error={error}
        searchPlaceholder="Deposit slip, bank or RCD"
        emptyTitle="No deposits recorded"
        emptyMessage="Record each bank deposit so it can be matched against the bank statement."
        filters={
          <>
            <div className="min-w-[16rem]">
              <BankAccountPicker value={bankAccountId} fundCode={fundCode} onChange={setBankAccountId} />
            </div>
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="RECORDED">Recorded</option>
              <option value="IN_TRANSIT">In transit</option>
              <option value="CREDITED">Credited</option>
            </Select>
          </>
        }
        exportMeta={{
          title: 'Deposit Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <DepositForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Deposit recorded', 'Post it to move the cash from the collecting officer to the bank in the books.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(recording)}
        onCancel={() => setRecording(null)}
        onConfirm={() => {
          if (!recording) return;
          setBusy(true);
          void engine
            .recordDeposit({ depositId: recording.id })
            .then(() => {
              toast.success('Deposit posted', 'It is in transit until the bank statement shows the credit.');
              setRecording(null);
            })
            .catch((err) => toast.error('The deposit was not posted', err.message))
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title="Post deposit"
        confirmLabel="Post"
        variant="primary"
        message={
          recording && (
            <p>
              Debits Cash in Bank and credits Cash - Collecting Officers for{' '}
              {formatPeso(recording.amount)}. The deposit stays in transit until reconciliation
              matches it to the bank credit.
            </p>
          )
        }
      />
    </div>
  );
}

function DepositForm({
  fiscalYear,
  fundCode,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();
  const rcds = useRcds(fiscalYear, fundCode);

  const [depositDate, setDepositDate] = useState(todayPh());
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [depositSlipNo, setDepositSlipNo] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [rcdId, setRcdId] = useState('');
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [officerName, setOfficerName] = useState('');
  const [saving, setSaving] = useState(false);

  const rcd = rcds.data.find((r) => r.id === rcdId);

  const save = async () => {
    if (!bankAccountId || !depositSlipNo.trim() || !amount || !user) {
      toast.error('Incomplete', 'Bank account, deposit slip number and amount are required.');
      return;
    }
    setSaving(true);
    try {
      await createDraft(
        COL.deposits,
        {
          fiscalYear,
          period: Number(depositDate.slice(5, 7)),
          fundCode,
          depositDate,
          bankAccountId,
          bankName: '',
          bankAccountNumber: '',
          depositSlipNo: depositSlipNo.trim(),
          referenceNo: referenceNo.trim() || null,
          amount,
          rcdId: rcdId || null,
          rcdNo: rcd?.rcdNo ?? null,
          collectingOfficerId: officerId ?? rcd?.collectingOfficerId ?? null,
          collectingOfficerName: officerName || rcd?.collectingOfficerName || null,
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
      toast.error('Could not record the deposit', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a deposit"
      size="md"
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
        <Field label="Deposit date" required htmlFor="depDate">
          <DateInput id="depDate" value={depositDate} onChange={setDepositDate} />
        </Field>

        <Field label="Bank account" required htmlFor="depBank">
          <BankAccountPicker id="depBank" value={bankAccountId} fundCode={fundCode} onChange={setBankAccountId} />
        </Field>

        <Field label="Deposit slip number" required htmlFor="slip">
          <TextInput
            id="slip"
            value={depositSlipNo}
            onChange={(e) => setDepositSlipNo(e.target.value)}
            className="font-mono"
          />
        </Field>

        <Field
          label="Bank reference"
          htmlFor="ref"
          hint="Matched against the statement during reconciliation."
        >
          <TextInput id="ref" value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} className="font-mono" />
        </Field>

        <Field label="Amount" required htmlFor="depAmount">
          <AmountInput id="depAmount" value={amount} onChange={setAmount} />
        </Field>

        <Field label="Report of collections" htmlFor="rcd" hint="Optional, but it links the deposit to its receipts.">
          <Select
            id="rcd"
            value={rcdId}
            onChange={(e) => {
              setRcdId(e.target.value);
              const chosen = rcds.data.find((r) => r.id === e.target.value);
              if (chosen && !amount) setAmount(chosen.undepositedAmount);
            }}
          >
            <option value="">Not linked to an RCD</option>
            {rcds.data
              .filter((r) => r.undepositedAmount > 0)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.rcdNo} - {r.collectingOfficerName} - {formatPeso(r.undepositedAmount)} undeposited
                </option>
              ))}
          </Select>
        </Field>

        {!rcdId && (
          <Field label="Collecting officer" htmlFor="depOfficer" className="sm:col-span-2">
            <EmployeePicker
              id="depOfficer"
              value={officerId}
              onChange={(v, emp) => {
                setOfficerId(v);
                setOfficerName(emp?.name ?? '');
              }}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
