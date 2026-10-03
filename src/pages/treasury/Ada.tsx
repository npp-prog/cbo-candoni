import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, DateInput } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAda } from '@/data/queries';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { ADA_STATUSES, STATUS_LABELS } from '@/types/enums';
import type { Ada as AdaRecord } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { PAYMENT_TABS } from './sections';

/**
 * Advice to Debit Account.
 *
 * The electronic counterpart of a check. The lifecycle that matters for
 * reconciliation is prepared, submitted to the bank, debited: an ADA that has
 * been submitted but not yet debited is the electronic equivalent of an
 * outstanding check, and the bank reference number recorded on submission is
 * what the automatic matcher looks for in the statement.
 */
export default function Ada() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole, can } = useAuth();
  const toast = useToast();

  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState<AdaRecord | null>(null);
  const [cancelling, setCancelling] = useState<AdaRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useAda(bankAccountId ?? undefined, status || undefined);
  const rows = useMemo(() => data.filter((a) => a.fiscalYear === fiscalYear), [data, fiscalYear]);

  const inTransit = rows
    .filter((a) => ['PREPARED', 'SUBMITTED'].includes(a.status))
    .reduce((s, a) => s + a.amount, 0);

  const canManage = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF', 'MUNICIPAL_ACCOUNTANT');

  const columns: Column<AdaRecord>[] = [
    {
      key: 'adaNo',
      header: 'ADA No.',
      width: '10rem',
      value: (a) => a.adaNo,
      cell: (a) => <span className="font-mono text-xs text-navy-900">{a.adaNo}</span>,
    },
    {
      key: 'adaDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (a) => a.adaDate,
      cell: (a) => <span className="text-xs">{formatShortDate(a.adaDate)}</span>,
    },
    {
      key: 'bank',
      header: 'Bank',
      value: (a) => a.bankName,
      cell: (a) => <span className="text-xs text-slate-600">{a.bankName}</span>,
      optional: true,
    },
    {
      key: 'dvNo',
      header: 'DV No.',
      width: '9rem',
      value: (a) => a.dvNo,
      cell: (a) => <span className="font-mono text-xs text-slate-500">{a.dvNo}</span>,
    },
    {
      key: 'payee',
      header: 'Payee',
      value: (a) => a.payeeName,
      cell: (a) => <span className="text-sm">{a.payeeName}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (a) => a.amount,
      cell: (a) => formatPeso(a.amount, { symbol: false }),
    },
    {
      key: 'bankRef',
      header: 'Bank reference',
      value: (a) => a.bankReferenceNo ?? '',
      cell: (a) => (
        <div className="text-xs">
          {a.bankReferenceNo ? (
            <span className="font-mono">{a.bankReferenceNo}</span>
          ) : (
            <span className="text-slate-400">-</span>
          )}
          {a.dateDebited && (
            <span className="block text-slate-500">debited {formatShortDate(a.dateDebited)}</span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '13rem',
      value: (a) => a.status,
      sortable: false,
      fixed: true,
      cell: (a) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={a.status} />
          {canManage && a.status === 'PREPARED' && (
            <Button size="sm" variant="primary" onClick={() => setSubmitting(a)}>
              Submit to bank
            </Button>
          )}
          {canManage && can('accounting', 'cancel') && !['DEBITED', 'CANCELLED'].includes(a.status) && (
            <Button size="sm" variant="ghost" onClick={() => setCancelling(a)}>
              Cancel
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Advice to Debit Account"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - ${formatPeso(inTransit)} awaiting debit`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'ADA' }]}
      />

      <SectionTabs tabs={PAYMENT_TABS} />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(a) => a.id}
        loading={loading}
        error={error}
        searchPlaceholder="ADA number, payee or DV number"
        emptyTitle="No ADA prepared"
        emptyMessage="An ADA is prepared against an approved disbursement voucher whose payment method is ADA."
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
              {ADA_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </>
        }
        exportMeta={{
          title: 'ADA Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {submitting && (
        <SubmitDialog
          ada={submitting}
          busy={busy}
          onClose={() => setSubmitting(null)}
          onSubmit={(reference, date) => {
            setBusy(true);
            void updateDoc(doc(db, COL.ada, submitting.id), {
              status: 'SUBMITTED',
              dateSubmittedToBank: date,
              bankReferenceNo: reference,
            })
              .then(() => {
                toast.success(
                  `ADA ${submitting.adaNo} submitted`,
                  'The bank reference will be matched against the statement during reconciliation.',
                );
                setSubmitting(null);
              })
              .catch((err) => toast.error('Could not update the ADA', err.message))
              .finally(() => setBusy(false));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(cancelling)}
        onCancel={() => setCancelling(null)}
        onConfirm={(reason) => {
          if (!cancelling || !reason) return;
          setBusy(true);
          void engine
            .cancelAda({ adaId: cancelling.id, reason })
            .then(() => {
              toast.success(`ADA ${cancelling.adaNo} cancelled`);
              setCancelling(null);
            })
            .catch((err) => toast.error('Could not cancel the ADA', err.message))
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title={`Cancel ADA ${cancelling?.adaNo ?? ''}`}
        confirmLabel="Cancel ADA"
        variant="danger"
        requireReason
        message={
          <p>
            An ADA that the bank has already debited cannot be cancelled - record the refund and
            an adjusting entry instead.
          </p>
        }
      />
    </div>
  );
}

function SubmitDialog({
  ada,
  busy,
  onClose,
  onSubmit,
}: {
  ada: AdaRecord;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reference: string, date: string) => void;
}) {
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayPh());

  return (
    <Modal
      open
      onClose={onClose}
      title={`Submit ADA ${ada.adaNo} to the bank`}
      description={`${formatPeso(ada.amount)} to ${ada.payeeName}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => onSubmit(reference.trim(), date)}>
            Record submission
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Bank reference number"
          htmlFor="bankRef"
          hint="The reference the bank gives on acknowledgement. Automatic reconciliation matches on this."
        >
          <TextInput
            id="bankRef"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="Date submitted" required htmlFor="submitDate">
          <DateInput id="submitDate" value={date} onChange={setDate} />
        </Field>
      </div>
    </Modal>
  );
}
