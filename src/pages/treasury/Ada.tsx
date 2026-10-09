import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { newestFirst } from '@/lib/registerOrder';
import { PageHeader, Tabs, Alert } from '@/components/ui/Layout';
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
import { useAda, useEmployees, usePayees } from '@/data/queries';
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
          <StatusBadge status={a.status} label={adaStatusLabel(a.status)} />
          {canManage &&
            a.status === 'PREPARED' &&
            /*
              Offered only once the advice is on a certified RADAI - the
              engine refuses it otherwise; saying why here is better than a
              button that fails when it is pressed.
            */
            (() => {
              const gate = canSubmitAda(a);
              return gate.ok ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSubmitting(a);
                  }}
                >
                  Posted online
                </Button>
              ) : (
                <span className="text-2xs text-amber-700" title={gate.message}>
                  Not on a certified RADAI
                </span>
              );
            })()}
          {(a.notPostedAmount ?? 0) > 0 && (
            <span className="text-2xs text-amber-700">
              {formatPeso(a.notPostedAmount ?? 0, { symbol: false })} not posted
            </span>
          )}
          {/*
            Patch 143: the ADA Form is in the advice's own window (click the
            line), not on the line - the row was crowded.
          */}
          {canManage && can('accounting', 'cancel') && !['DEBITED', 'CANCELLED'].includes(a.status) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setCancelling(a);
              }}
            >
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
        <PostedOnlineDialog
          ada={submitting}
          busy={busy}
          onClose={() => setSubmitting(null)}
          onSubmit={({ reference, date, notPostedLineNos }) => {
            setBusy(true);
            void engine
              .postAdaOnline({
                adaId: submitting.id,
                postedDate: date,
                bankReferenceNo: reference || undefined,
                notPostedLineNos,
              })
              .then((r) => {
                toast.success(
                  `ADA ${submitting.adaNo} posted online`,
                  r.notPostedAmount > 0
                    ? `${formatPeso(r.notPostedAmount)} not posted - an adjusting entry to Trust Liabilities is waiting in General Transactions for the Accountant to post. Repay by a new voucher of the Trust liability kind.`
                    : 'Every credit was posted.',
                );
                setSubmitting(null);
              })
              .catch((err) => toast.error('Could not record the posting', err.message))
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

/** Patch 143: an ADA's SUBMITTED reads "Posted online" on this screen. */
export function adaStatusLabel(status: string): string | undefined {
  return status === 'SUBMITTED' ? 'Posted online' : undefined;
}

/**
 * "Posted online" - patch 143 (it was "Submit to bank").
 *
 * Lists every credit of the advice - each payee of a group advice, or the one
 * payee - with the ATM number and the amount, ticked as posted. The Treasury
 * unticks any the bank did not post. Those become trust liabilities: the
 * engine raises a draft adjusting entry (Dr Cash in Bank, Cr Trust
 * Liabilities per payee) for the Accountant, and each is repaid by a new
 * voucher.
 */
function PostedOnlineDialog({
  ada,
  busy,
  onClose,
  onSubmit,
}: {
  ada: AdaRecord;
  busy: boolean;
  onClose: () => void;
  onSubmit: (v: { reference: string; date: string; notPostedLineNos: number[] }) => void;
}) {
  const payees = usePayees();
  const employees = useEmployees();
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayPh());

  const rows = useMemo(() => {
    if (ada.payees && ada.payees.length > 0) {
      return ada.payees.map((p, i) => ({ ...p, lineNo: p.lineNo ?? i + 1 }));
    }
    const payee = payees.data.find((p) => p.id === ada.payeeId);
    const employee = payee?.employeeId
      ? employees.data.find((e) => e.id === payee.employeeId)
      : undefined;
    return [
      {
        lineNo: 1,
        payeeId: ada.payeeId,
        payeeName: ada.payeeName,
        accountNumber: employee?.bankAccountNumber || payee?.bankAccountNumber || '',
        amount: ada.amount,
      },
    ];
  }, [ada, payees.data, employees.data]);

  const [notPosted, setNotPosted] = useState<Set<number>>(new Set());
  const toggle = (n: number) =>
    setNotPosted((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const notPostedAmount = rows
    .filter((r) => notPosted.has(r.lineNo))
    .reduce((t, r) => t + r.amount, 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={`ADA ${ada.adaNo} - posted online`}
      description={`${formatPeso(ada.amount)} - ${ada.payeeName} - untick any credit the bank did NOT post.`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              onSubmit({ reference: reference.trim(), date, notPostedLineNos: [...notPosted] })
            }
          >
            {notPosted.size > 0 ? 'Record posting and trust liabilities' : 'Record posting'}
          </Button>
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-600">
            <tr>
              <th className="w-20 px-2 py-1.5 font-medium">Posted</th>
              <th className="px-2 py-1.5 font-medium">ATM / account no.</th>
              <th className="px-2 py-1.5 font-medium">Payee</th>
              <th className="px-2 py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const off = notPosted.has(r.lineNo);
              return (
                <tr key={r.lineNo} className={off ? 'bg-amber-50' : undefined}>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() => toggle(r.lineNo)}
                      aria-label={`Posted to ${r.payeeName}`}
                    />
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs">{r.accountNumber || '-'}</td>
                  <td className="px-2 py-1.5">
                    {r.payeeName}
                    {off && (
                      <span className="ml-2 text-2xs font-semibold text-amber-800">
                        NOT POSTED - trust liability
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {formatPeso(r.amount, { symbol: false })}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-navy-800 text-sm font-semibold">
            <tr>
              <td className="px-2 py-1.5" colSpan={3}>
                Posted
              </td>
              <td className="px-2 py-1.5 text-right font-mono">
                {formatPeso(ada.amount - notPostedAmount, { symbol: false })}
              </td>
            </tr>
            {notPostedAmount > 0 && (
              <tr className="text-amber-800">
                <td className="px-2 py-1.5" colSpan={3}>
                  Not posted - to Trust Liabilities
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {formatPeso(notPostedAmount, { symbol: false })}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {notPostedAmount > 0 && (
        <Alert tone="warning" className="mt-3" title="What happens to the credits not posted">
          An adjusting entry is prepared for the Accountant - Dr Cash in Bank, Cr Trust Liabilities
          for each payee not posted - and waits in General Transactions to be posted. Each payee is
          then repaid by a new disbursement voucher of the &quot;Trust liability&quot; kind.
        </Alert>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Date posted online" required htmlFor="postedDate">
          <DateInput id="postedDate" value={date} onChange={setDate} />
        </Field>
        <Field
          label="Bank reference number"
          htmlFor="bankRef"
          hint="The reference of the bank's online posting. Reconciliation matches on this."
        >
          <TextInput
            id="bankRef"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}
