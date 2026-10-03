import { useMemo, useState } from 'react';
import { PageHeader, Alert } from '@/components/ui/Layout';
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
import { useChecks, useBankAccounts } from '@/data/queries';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, staleDate, todayPh } from '@/lib/dates';
import { CHECK_STATUSES, STATUS_LABELS } from '@/types/enums';
import type { Check } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { PAYMENT_TABS } from './sections';

/**
 * The check register.
 *
 * Checks move through a physical lifecycle - prepared, signed, released,
 * cleared - and the register exists so the Treasurer can see at a glance what
 * is sitting unsigned on a desk and what has been released but never
 * presented. An unpresented check is an outstanding item on every bank
 * reconciliation until it clears or goes stale, which is why the stale
 * warning is on this screen and not buried in a report.
 */
export default function Checks() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole, can } = useAuth();
  const toast = useToast();

  const banks = useBankAccounts(fundCode);
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [releasing, setReleasing] = useState<Check | null>(null);
  const [cancelling, setCancelling] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useChecks(bankAccountId ?? undefined, status || undefined);

  const rows = useMemo(() => data.filter((c) => c.fiscalYear === fiscalYear), [data, fiscalYear]);

  const today = todayPh();
  const nearStale = rows.filter(
    (c) => ['RELEASED', 'SIGNED', 'PREPARED'].includes(c.status) && staleDate(c.checkDate) < today,
  );

  const outstanding = rows
    .filter((c) => ['RELEASED', 'SIGNED', 'PREPARED'].includes(c.status))
    .reduce((s, c) => s + c.netAmount, 0);

  const canManage = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF', 'MUNICIPAL_ACCOUNTANT');

  const advance = async (check: Check, next: 'FOR_SIGNATURE' | 'SIGNED' | 'RELEASED', extra?: Record<string, unknown>) => {
    setBusy(true);
    try {
      await updateDoc(doc(db, COL.checks, check.id), { status: next, ...extra });
      toast.success(`Check ${check.checkNo} marked ${STATUS_LABELS[next].toLowerCase()}`);
      setReleasing(null);
    } catch (err) {
      toast.error('Could not update the check', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Check>[] = [
    {
      key: 'checkNo',
      header: 'Check No.',
      width: '8rem',
      value: (c) => c.checkNo,
      cell: (c) => <span className="font-mono text-xs text-navy-900">{c.checkNo}</span>,
    },
    {
      key: 'checkDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (c) => c.checkDate,
      cell: (c) => <span className="text-xs">{formatShortDate(c.checkDate)}</span>,
    },
    {
      key: 'bank',
      header: 'Bank',
      value: (c) => c.bankName,
      cell: (c) => <span className="text-xs text-slate-600">{c.bankName}</span>,
      optional: true,
    },
    {
      key: 'dvNo',
      header: 'DV No.',
      width: '9rem',
      value: (c) => c.dvNo,
      cell: (c) => <span className="font-mono text-xs text-slate-500">{c.dvNo}</span>,
    },
    {
      key: 'payee',
      header: 'Payee',
      value: (c) => c.payeeName,
      cell: (c) => <span className="text-sm">{c.payeeName}</span>,
    },
    {
      key: 'netAmount',
      header: 'Amount',
      kind: 'amount',
      value: (c) => c.netAmount,
      cell: (c) => formatPeso(c.netAmount, { symbol: false }),
    },
    {
      key: 'released',
      header: 'Released',
      value: (c) => c.dateReleased ?? '',
      cell: (c) => (
        <div className="text-xs">
          {c.dateReleased ? (
            <>
              <span>{formatShortDate(c.dateReleased)}</span>
              {c.releasedToName && <span className="block text-slate-500">to {c.releasedToName}</span>}
            </>
          ) : (
            <span className="text-slate-400">-</span>
          )}
        </div>
      ),
      optional: true,
    },
    {
      key: 'status',
      header: 'Status',
      width: '14rem',
      value: (c) => c.status,
      sortable: false,
      fixed: true,
      cell: (c) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge
            status={
              ['RELEASED', 'SIGNED', 'PREPARED'].includes(c.status) && staleDate(c.checkDate) < today
                ? 'STALE'
                : c.status
            }
          />
          {canManage && c.status === 'PREPARED' && (
            <Button size="sm" onClick={() => void advance(c, 'FOR_SIGNATURE')}>
              For signature
            </Button>
          )}
          {canManage && c.status === 'FOR_SIGNATURE' && (
            <Button size="sm" onClick={() => void advance(c, 'SIGNED')}>
              Signed
            </Button>
          )}
          {canManage && c.status === 'SIGNED' && (
            <Button size="sm" variant="primary" onClick={() => setReleasing(c)}>
              Release
            </Button>
          )}
          {canManage && can('accounting', 'cancel') && !['CLEARED', 'CANCELLED'].includes(c.status) && (
            <Button size="sm" variant="ghost" onClick={() => setCancelling(c)}>
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
        title="Checks"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - ${formatPeso(outstanding)} outstanding`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'Checks' }]}
      />

      <SectionTabs tabs={PAYMENT_TABS} />

      {nearStale.length > 0 && (
        <Alert tone="warning" title="Stale checks" className="mb-4">
          {nearStale.length} check{nearStale.length === 1 ? ' has' : 's have'} passed six months
          from their date without clearing. They should be cancelled and, where the payment is
          still owed, replaced - otherwise they stay in the outstanding-checks column of every
          bank reconciliation.
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        loading={loading}
        error={error}
        searchPlaceholder="Check number, payee or DV number"
        emptyTitle="No checks issued"
        emptyMessage="Checks are drawn against approved disbursement vouchers."
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
              {CHECK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </>
        }
        exportMeta={{
          title: 'Check Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {releasing && (
        <ReleaseDialog
          check={releasing}
          busy={busy}
          onClose={() => setReleasing(null)}
          onRelease={(name, position, date) =>
            void advance(releasing, 'RELEASED', {
              dateReleased: date,
              releasedToName: name,
              releasedToPosition: position,
            })
          }
        />
      )}

      <ConfirmDialog
        open={Boolean(cancelling)}
        onCancel={() => setCancelling(null)}
        onConfirm={(reason) => {
          if (!cancelling || !reason) return;
          setBusy(true);
          void engine
            .cancelCheck({ checkId: cancelling.id, reason })
            .then(() => {
              toast.success(`Check ${cancelling.checkNo} cancelled`, 'The voucher is free for a replacement check.');
              setCancelling(null);
            })
            .catch((err) => toast.error('Could not cancel the check', err.message))
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title={`Cancel check ${cancelling?.checkNo ?? ''}`}
        confirmLabel="Cancel check"
        variant="danger"
        requireReason
        message={
          <p>
            The check is kept with a status of Cancelled, and the disbursement voucher becomes
            available for a replacement check. A check that has already cleared the bank cannot be
            cancelled.
          </p>
        }
      />
    </div>
  );
}

function ReleaseDialog({
  check,
  busy,
  onClose,
  onRelease,
}: {
  check: Check;
  busy: boolean;
  onClose: () => void;
  onRelease: (name: string, position: string, date: string) => void;
}) {
  const [name, setName] = useState(check.payeeName);
  const [position, setPosition] = useState('');
  const [date, setDate] = useState(todayPh());

  return (
    <Modal
      open
      onClose={onClose}
      title={`Release check ${check.checkNo}`}
      description={`${formatPeso(check.netAmount)} to ${check.payeeName}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => onRelease(name, position, date)}>
            Record release
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Received by"
          required
          htmlFor="recipient"
          hint="The person who physically collected the check, which may not be the payee."
        >
          <TextInput id="recipient" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Position or relationship" htmlFor="position">
          <TextInput
            id="position"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder="Authorised representative"
          />
        </Field>
        <Field label="Date released" required htmlFor="releaseDate">
          <DateInput id="releaseDate" value={date} onChange={setDate} />
        </Field>
      </div>
    </Modal>
  );
}
