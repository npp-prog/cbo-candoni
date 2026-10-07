import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { newestFirst } from '@/lib/registerOrder';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
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
import { canSubmitAda, canUndoOutright } from '@/lib/releaseControl';
import type { Ada as AdaRecord } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { PAYMENT_TAB_GROUPS } from './sections';
import { AdaNumberSeries } from './AdaNumbers';
import { InstrumentDetail } from './InstrumentDetail';

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
  const navigate = useNavigate();
  /*
   * The row that is open, taken from the address rather than from state, so a
   * ada can be linked to. See InstrumentDetail.
   */
  const { id: openId } = useParams<{ id: string }>();
  const { hasRole, can } = useAuth();
  const toast = useToast();

  const [tab, setTab] = useState<'register' | 'numbers'>('register');
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState<AdaRecord | null>(null);
  const [cancelling, setCancelling] = useState<AdaRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useAda(bankAccountId ?? undefined, status || undefined);
  const rows = useMemo(
    () =>
      newestFirst(
        data.filter((a) => a.fiscalYear === fiscalYear),
        (a) => ({ ref: a.adaNo, date: a.adaDate }),
      ),
    [data, fiscalYear],
  );

  const inTransit = rows
    .filter((a) => ['PREPARED', 'SUBMITTED'].includes(a.status))
    .reduce((s, a) => s + a.amount, 0);

  const canManage = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF', 'MUNICIPAL_ACCOUNTANT');

  /*
   * Taken from the loaded records rather than fetched again: the register is a
   * live subscription, so this is the same record the row shows and the two
   * cannot disagree.
   *
   * From `data` and not `rows`, deliberately. `rows` is what the filters have
   * left on screen, so a link opened with a different bank account or status
   * selected would find nothing and show an empty page with no explanation.
   */
  const openAda = openId ? (data.find((r) => r.id === openId) ?? null) : null;

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
          {canManage &&
            a.status === 'PREPARED' &&
            /*
              Offered only once the advice is on a certified RADAI. The
              security rules refuse the submission otherwise; saying why here
              is better than a button that fails when it is pressed.
            */
            (() => {
              const gate = canSubmitAda(a);
              return gate.ok ? (
                <Button size="sm" variant="primary" onClick={() => setSubmitting(a)}>
                  Submit to bank
                </Button>
              ) : (
                <span className="text-2xs text-amber-700" title={gate.message}>
                  Not on a certified RADAI
                </span>
              );
            })()}
          {/*
            The ADA form itself. On the row rather than behind
            an Open button, because unlike a report there is no page to open:
            an advice is one line in this register and one sheet for the bank.
          */}
          <Link to={`/treasury/ada/${a.id}/form`} className="text-2xs font-medium underline">
            ADA Form
          </Link>
          {canManage && can('accounting', 'cancel') && !['DEBITED', 'CANCELLED'].includes(a.status) && (
            <Button size="sm" variant="ghost" onClick={() => setCancelling(a)}>
              {canUndoOutright(a) ? 'Undo' : 'Cancel'}
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

      <GroupedSectionTabs groups={PAYMENT_TAB_GROUPS} />

      {/*
        The register and the number series are one book read two ways, so they
        are two tabs on one screen rather than two screens. "What happened to
        0221" is asked while looking at the register.
      */}
      <Tabs
        tabs={[
          { id: 'register', label: 'Advices', count: rows.length },
          { id: 'numbers', label: 'Number series' },
        ]}
        active={tab}
        onChange={(id) => setTab(id as 'register' | 'numbers')}
      />

      {tab === 'numbers' && <div className="mt-4"><AdaNumberSeries /></div>}

      {tab === 'register' && (
      <DataTable
        rows={rows}
        columns={columns}
        onRowClick={(r) => navigate(`/treasury/ada/${r.id}`)}
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
      )}

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
        title={
          cancelling && canUndoOutright(cancelling)
            ? `Undo ADA ${cancelling.adaNo}`
            : `Cancel ADA ${cancelling?.adaNo ?? ''}`
        }
        confirmLabel={cancelling && canUndoOutright(cancelling) ? 'Undo' : 'Cancel ADA'}
        variant="danger"
        requireReason
        message={
          <>
            <p>
              THIS IS HOW AN ADVICE PREPARED BY MISTAKE IS PUT RIGHT. The voucher goes straight
              back on to Disbursements for Payment and can be paid again, by advice or by check.
            </p>
            <p className="mt-2">
              The advice is kept, marked Cancelled, with the reason on it, and its number is not
              returned to the pool. &ldquo;Prepared in error&rdquo; is a perfectly good reason to
              write.
            </p>
            <p className="mt-2">
              An ADA that the bank has already debited cannot be cancelled - record the refund and
              an adjusting entry instead.
            </p>
          </>
        }
      />
      {openAda && (
        <InstrumentDetail
          instrument={{ kind: 'ADA', ...openAda }}
          onClose={() => navigate('/treasury/ada')}
        />
      )}

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
