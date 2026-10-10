import { useMemo, useState } from 'react';
import { PageHeader, Alert, DetailField } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, DateInput, AmountInput, TextInput, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker, EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useCollections, useDeposits, useUndepositedCollections } from '@/data/queries';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import type { Deposit } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from './sections';

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
  const { can } = useAuth();
  const toast = useToast();

  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  /*
   * The slip being read, and the one being corrected.
   *
   * A deposit is correctable while it is still RECORDED - before the bank has
   * credited it and before reconciliation has matched it to a statement line.
   * After that the record is answering to something outside CFMS and is left
   * alone; the security rules say the same.
   */
  const [viewing, setViewing] = useState<Deposit | null>(null);
  const [editing, setEditing] = useState<Deposit | null>(null);

  const { data, loading, error } = useDeposits(bankAccountId ?? undefined, status || undefined);
  const undeposited = useUndepositedCollections(fundCode);

  const rows = useMemo(
    () => data.filter((d) => d.fiscalYear === fiscalYear && d.fundCode === fundCode),
    [data, fiscalYear, fundCode],
  );

  const inTransit = rows.filter((d) => d.status === 'IN_TRANSIT').reduce((s, d) => s + d.amount, 0);
  const undepositedTotal = undeposited.data.reduce((s, c) => s + c.totalAmount, 0);


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
      key: 'receipts',
      header: 'Receipts banked',
      width: '11rem',
      value: (d) => String(d.collectionIds?.length ?? 0),
      cell: (d) => {
        const n = d.collectionIds?.length ?? 0;
        if (n > 0) {
          return (
            <span className="text-xs text-slate-600">
              {n} receipt{n === 1 ? '' : 's'}
            </span>
          );
        }
        /*
         * A deposit recorded before the link moved from the RCD to the
         * receipts still shows what it had. Printing a dash over an older
         * record would say "nothing" where the answer is "an RCD".
         */
        if (d.rcdNo) {
          return <span className="font-mono text-xs text-slate-500">{d.rcdNo}</span>;
        }
        return <span className="text-xs text-slate-400">None attached</span>;
      },
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
          {/* Patch 159: no Post button - the RCD that reports it books it. */}
          {d.status === 'RECORDED' && !d.jevId && (
            <span className="text-2xs text-slate-500">
              {d.treasuryReportNo ? `On RCD ${d.treasuryReportNo}` : 'To be reported on an RCD'}
            </span>
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

      <GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />

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
        onRowClick={(d) => setViewing(d)}
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
        printLayout="landscape"
        exportMeta={{
          title: 'Deposit Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {viewing && (
        <DepositDetail
          deposit={viewing}
          canEdit={can('treasury', 'create') && viewing.status === 'RECORDED'}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
          onClose={() => setViewing(null)}
        />
      )}

      {editing && (
        <DepositForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {showForm && (
        <DepositForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success(
              'Deposit recorded',
              'Report it on an RCD (Deposits to report). The RCD\'s entry books it: Dr Cash in Bank / Cr Cash - Local Treasury.',
            );
          }}
        />
      )}

    </div>
  );
}

/**
 * One deposit slip, opened from its row.
 *
 * It says which receipts the slip banked, which is the question the register
 * could not answer at all until patch 96 - a deposit pointed at an RCD, and
 * that list had been empty since the RCD became a treasury report.
 */
function DepositDetail({
  deposit,
  canEdit,
  onEdit,
  onClose,
}: {
  deposit: Deposit;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const banked = deposit.collectionIds?.length ?? 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Deposit slip ${deposit.depositSlipNo}`}
      description={`${formatPeso(deposit.amount)} on ${formatShortDate(deposit.depositDate)}`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {canEdit && (
            <Button variant="primary" onClick={onEdit}>
              Correct this slip
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <DetailField label="Bank">
          {deposit.bankName || <span className="text-slate-400">Not recorded</span>}{' '}
          <span className="font-mono text-xs text-slate-500">{deposit.bankAccountNumber}</span>
        </DetailField>
        <DetailField label="Status">
          <StatusBadge status={deposit.status} />
        </DetailField>
        <DetailField label="Bank reference">
          {deposit.referenceNo ?? <span className="text-slate-400">&mdash;</span>}
        </DetailField>
        <DetailField label="Credited by the bank">
          {deposit.creditedDate ? (
            formatShortDate(deposit.creditedDate)
          ) : (
            <span className="text-slate-500">Not yet</span>
          )}
        </DetailField>
        <DetailField label="Collecting officer" className="sm:col-span-2">
          {deposit.collectingOfficerName ?? <span className="text-slate-400">&mdash;</span>}
        </DetailField>
        <DetailField label="Receipts banked" className="sm:col-span-2">
          {banked > 0 ? (
            `${banked} receipt${banked === 1 ? '' : 's'}`
          ) : deposit.rcdNo ? (
            /* A slip recorded before the link moved from the RCD to the
               receipts. It still says what it had. */
            <>
              RCD <span className="font-mono">{deposit.rcdNo}</span>
            </>
          ) : (
            <span className="text-slate-500">None attached</span>
          )}
        </DetailField>
      </div>

      {deposit.status !== 'RECORDED' && (
        <p className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <span className="font-semibold">This slip can no longer be corrected.</span> It is{' '}
          {deposit.status.toLowerCase().replace('_', ' ')} - the record is answering to a bank
          statement now, and a slip that could be edited afterwards would break the match that
          reconciliation relies on.
        </p>
      )}
    </Modal>
  );
}

function DepositForm({
  fiscalYear,
  fundCode,
  existing,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  /**
   * The slip being corrected, where one is.
   *
   * The receipts it banks can be changed too, and that is the part worth
   * getting right: the ones taken OFF go back to awaiting deposit and the ones
   * added are marked banked, so the undeposited figure stays true however the
   * correction goes.
   */
  existing?: Deposit | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();
  /*
   * Every receipt of the year, filtered here rather than by the query.
   *
   * The undeposited-only query cannot serve a CORRECTION: the receipts this
   * slip already banked are DEPOSITED, so they would be missing from the list
   * and would silently un-tick themselves the moment the officer opened the
   * form. The list is "awaiting deposit, plus the ones this slip already
   * has" - which is exactly what a person correcting it expects to see.
   */
  const allCollections = useCollections(fiscalYear, fundCode);
  const mine = useMemo(() => new Set(existing?.collectionIds ?? []), [existing?.collectionIds]);
  const undeposited = useMemo(
    () => ({
      data: allCollections.data.filter(
        (c) =>
          // Patch 156: e-collections are deposited already - credited to the bank.
          (c.status !== 'CANCELLED' && !c.depositId && !c.eCollectionKind) || mine.has(c.id),
      ),
    }),
    [allCollections.data, mine],
  );

  const [depositDate, setDepositDate] = useState(existing?.depositDate ?? todayPh());
  const [bankAccountId, setBankAccountId] = useState<string | null>(
    existing?.bankAccountId ?? null,
  );
  const [depositSlipNo, setDepositSlipNo] = useState(existing?.depositSlipNo ?? '');
  const [referenceNo, setReferenceNo] = useState(existing?.referenceNo ?? '');
  const [amount, setAmount] = useState<number | null>(existing?.amount ?? null);
  /*
   * WHICH RECEIPTS THIS DEPOSIT BANKS.
   *
   * The form used to offer a list of RCDs from the old `rcds` collection,
   * which has been empty since the Report of Collections and Deposits became a
   * treasury report - so every deposit was recorded "Not linked to an RCD" and
   * nothing ever connected a deposit to the money it banked.
   *
   * It asks for the RECEIPTS now, which is what "deposited intact" means and
   * what the office actually has in front of it: the morning's collections and
   * a deposit slip. The Annex E and F summaries already work the undeposited
   * balance out from exactly this link.
   */
  const [picked, setPicked] = useState<Set<string>>(
    new Set(existing?.collectionIds ?? []),
  );
  const [officerId, setOfficerId] = useState<string | null>(
    existing?.collectingOfficerId ?? null,
  );
  const [officerName, setOfficerName] = useState('');
  const [saving, setSaving] = useState(false);

  const banked = useMemo(
    () => undeposited.data.filter((c) => picked.has(c.id)),
    [undeposited.data, picked],
  );
  const bankedTotal = banked.reduce((sum, c) => sum + c.totalAmount, 0);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (!bankAccountId || !depositSlipNo.trim() || !amount || !user) {
      toast.error('Incomplete', 'Bank account, deposit slip number and amount are required.');
      return;
    }
    /*
     * The slip must equal the receipts it banks.
     *
     * Not a warning. Collections are deposited INTACT - the whole of what was
     * receipted, nothing held back - so a slip that does not equal the
     * receipts attached to it is either the wrong receipts or a short deposit,
     * and both are things to settle before the record is written rather than
     * at reconciliation three weeks later.
     *
     * A deposit that banks no particular receipt is still allowed; what is
     * refused is claiming receipts and then recording a different figure.
     */
    if (banked.length > 0 && amount !== bankedTotal) {
      toast.error(
        'The slip does not equal the receipts',
        `${banked.length} receipt${banked.length === 1 ? '' : 's'} totalling ${formatPeso(bankedTotal)} ` +
          `${banked.length === 1 ? 'is' : 'are'} selected, but the slip says ${formatPeso(amount)}. ` +
          'Collections are deposited intact, so the two have to agree.',
      );
      return;
    }

    setSaving(true);
    try {
      const payload = {
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
          /* The receipts this slip banks. */
          collectionIds: banked.map((c) => c.id),
          collectingOfficerId: officerId ?? banked[0]?.collectingOfficerId ?? null,
          collectingOfficerName: officerName || banked[0]?.collectingOfficerName || null,
      };

      const stamp = actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      });

      let depositId: string;
      if (existing) {
        await updateDraft(COL.deposits, existing.id, payload, stamp);
        depositId = existing.id;
      } else {
        depositId = await createDraft(COL.deposits, { ...payload, status: 'RECORDED' }, stamp);
      }

      /*
       * Then stamp the receipts, so each one knows it has been banked.
       *
       * After the deposit exists, not before: a receipt pointing at a deposit
       * that was never written would read as banked money that is nowhere.
       * The other way round - a deposit written and a stamp that failed -
       * shows as a receipt still awaiting deposit, which is visible on the
       * screen and can be put right by recording it again.
       *
       * ON A CORRECTION, THE ONES TAKEN OFF GO BACK. A receipt dropped from
       * the slip and left marked DEPOSITED would be money the register says is
       * banked and no slip claims - invisible, and short in the undeposited
       * figure for good.
       */
      const nowBanked = new Set(banked.map((c) => c.id));
      for (const id of existing?.collectionIds ?? []) {
        if (nowBanked.has(id)) continue;
        await updateDraft(COL.collections, id, { depositId: null, status: 'ISSUED' }, stamp);
      }
      for (const c of banked) {
        await updateDraft(COL.collections, c.id, { depositId, status: 'DEPOSITED' }, stamp);
      }

      toast.success(
        existing ? 'Deposit corrected' : 'Deposit recorded',
        banked.length > 0
          ? `${formatPeso(amount)} against ${banked.length} receipt${banked.length === 1 ? '' : 's'}.`
          : `${formatPeso(amount)} recorded. No receipts were attached to it.`,
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
      title={existing ? `Correct slip ${existing.depositSlipNo}` : 'Record a deposit'}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {existing ? 'Save the correction' : 'Record'}
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

        {banked.length === 0 && (
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

      {/* ---- the receipts this slip banks ------------------------------- */}
      <div className="mt-5">
        <div className="mb-2 flex items-end justify-between">
          <p className="cbo-label">Receipts banked by this slip</p>
          <p className="text-xs text-slate-600">
            {banked.length} selected,{' '}
            <span className="cbo-amount font-semibold text-navy-900">
              {formatPeso(bankedTotal)}
            </span>
          </p>
        </div>

        {undeposited.data.length === 0 ? (
          <p className="rounded border border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
            Nothing is awaiting deposit in this fund. A deposit can still be recorded on its own -
            a refund returned, say - and no receipt will be marked banked.
          </p>
        ) : (
          <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
            {undeposited.data.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={() => {
                      toggle(c.id);
                      /*
                       * The slip follows the receipts unless somebody has
                       * typed over it. Nine times in ten the deposit IS the
                       * selected receipts, and typing the total again is a
                       * chance to mistype it.
                       */
                      setAmount((current) => {
                        const next = picked.has(c.id)
                          ? bankedTotal - c.totalAmount
                          : bankedTotal + c.totalAmount;
                        return current === null || current === bankedTotal ? next : current;
                      });
                    }}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="w-24 shrink-0 font-mono text-xs text-navy-900">{c.orNumber}</span>
                  <span className="w-20 shrink-0 text-xs text-slate-500">
                    {formatShortDate(c.orDate)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{c.payorName}</span>
                  {c.eCollectionKind && (
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-2xs text-slate-600">
                      {c.eCollectionKind}
                    </span>
                  )}
                  <span className="cbo-amount shrink-0 text-xs">
                    {formatPeso(c.totalAmount, { symbol: false })}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
