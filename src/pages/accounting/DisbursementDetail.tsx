import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, Alert, Spinner, DetailField, Tabs } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, TextArea, DateInput, AmountInput, Select } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/Badge';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { JournalEntryGrid, type GridLine } from '@/components/journal/JournalEntryGrid';
import {
  AccountPicker,
  BankAccountPicker,
  ObligationPicker,
  OfficePicker,
  PayeePicker,
} from '@/components/pickers';
import { WorkflowTimeline } from '@/components/WorkflowTimeline';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useTaxCodes, useDisbursementVouchers, useAdaNumbers } from '@/data/queries';
import { COL } from '@/lib/collections';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { engine } from '@/lib/engine';
import { formatPeso, amountInWords } from '@/lib/money';
import { clearingObjection, CLEARING_OVERRIDE_MIN_LENGTH } from '@/lib/clearing';
import { formatLongDate, todayPh } from '@/lib/dates';
import { checkDvMath, findProbableDuplicates } from '@/lib/accounting-rules';
import {
  proposeDvEntry,
  computeDeduction,
  type DeductionLite,
  type ObligationLineLite,
} from './proposeEntry';
import type { DisbursementVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/**
 * The Disbursement Voucher.
 *
 * The central transaction record. Four things happen here that are worth
 * calling out:
 *
 *  - Choosing an obligation fills in the payee, the office, the particulars
 *    and the accounting distribution. Re-keying data the OBR already carries
 *    is how numbers diverge between documents.
 *
 *  - Deductions are computed from tax codes, against the base the tax code
 *    itself defines. Net = gross - deductions, and the arithmetic is checked
 *    by the same function the server uses.
 *
 *  - The journal entry is proposed, not demanded. The encoder sees it, can
 *    adjust it, and watches it balance.
 *
 *  - Approval, payment and posting are all server calls. Nothing on this
 *    screen decides whether the obligation has room for the voucher.
 */
export default function DisbursementDetail() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const toast = useToast();
  const { fiscalYear, fundCode } = useFilters();
  const { user, profile, can, hasRole, officeScope } = useAuth();

  const { data: existing, loading } = useDocument<DisbursementVoucher>(
    isNew ? null : COL.disbursementVouchers,
    id,
  );
  const taxCodes = useTaxCodes();
  const allVouchers = useDisbursementVouchers(fiscalYear, fundCode);

  const [tab, setTab] = useState<'details' | 'entry' | 'attachments' | 'history'>('details');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    null | 'submit' | 'approve' | 'return' | 'cancel' | 'check' | 'ada'
  >(null);

  /**
   * A reserved ADA number chosen for this voucher.
   *
   * Empty means draw the next one. Choosing a reservation is what stops it
   * being left behind as a hole in the series that somebody has to explain.
   */
  const [adaReservationId, setAdaReservationId] = useState('');
  const adaNumbers = useAdaNumbers(fiscalYear, fundCode);
  const reservedAdaNumbers = useMemo(
    () => adaNumbers.data.filter((r) => r.state === 'RESERVED'),
    [adaNumbers.data],
  );

  // --- Form state ----------------------------------------------------------

  const [dvDate, setDvDate] = useState(todayPh());
  const [obligationId, setObligationId] = useState<string | null>(null);
  const [obrNo, setObrNo] = useState<string | null>(null);
  const [obligationLines, setObligationLines] = useState<ObligationLineLite[]>([]);
  const [payeeId, setPayeeId] = useState<string | null>(null);
  const [payeeName, setPayeeName] = useState('');
  const [payeeTin, setPayeeTin] = useState('');
  const [payeeAddress, setPayeeAddress] = useState('');
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [particulars, setParticulars] = useState('');
  const [grossAmount, setGrossAmount] = useState<number | null>(null);
  const [deductions, setDeductions] = useState<DeductionLite[]>([]);
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [entryLines, setEntryLines] = useState<GridLine[]>([]);
  const [entryTouched, setEntryTouched] = useState(false);

  useEffect(() => {
    if (!existing) return;
    setDvDate(existing.dvDate);
    setObligationId(existing.obligationId ?? null);
    setObrNo(existing.obrNo ?? null);
    setPayeeId(existing.payeeId);
    setPayeeName(existing.payeeName);
    setPayeeTin(existing.payeeTin ?? '');
    setPayeeAddress(existing.payeeAddress ?? '');
    setOfficeId(existing.officeId);
    setOfficeName(existing.officeName);
    setParticulars(existing.particulars);
    setGrossAmount(existing.grossAmount);
    setDeductions(
      (existing.deductions ?? []).map((d) => ({
        code: d.code,
        description: d.description,
        accountCode: d.accountCode,
        accountName: d.accountName,
        amount: d.amount,
      })),
    );
    setBankAccountId(existing.bankAccountId ?? null);
    setEntryLines(
      (existing.accountLines ?? []).map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        particulars: l.particulars,
      })),
    );
    setEntryTouched(true);
  }, [existing]);

  const totalDeductions = useMemo(() => deductions.reduce((s, d) => s + d.amount, 0), [deductions]);
  const netAmount = (grossAmount ?? 0) - totalDeductions;

  // Re-propose the entry whenever its inputs change, until the encoder edits
  // it themselves - at which point their version is kept.
  useEffect(() => {
    if (entryTouched) return;
    if (!grossAmount) return;
    setEntryLines(
      proposeDvEntry({
        grossAmount,
        deductions,
        netAmount,
        obligationLines,
        // Always Accounts Payable, whatever the payment method. The voucher
        // recognises the liability; the check or ADA credits cash and clears it.
        // See the note at the top of proposeEntry.ts.
        particulars: particulars || undefined,
      }),
    );
  }, [grossAmount, deductions, netAmount, obligationLines, particulars, entryTouched]);

  const status = existing?.status ?? 'DRAFT';
  const editable = isNew || ['DRAFT', 'RETURNED'].includes(status);
  const canEdit = can('accounting', 'edit') && editable;
  const canSubmit = !isNew && editable && can('accounting', 'create');
  const canReview = !isNew && status === 'SUBMITTED' && hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT', 'ACCOUNTING_REVIEWER');
  const canApprove = !isNew && ['REVIEWED', 'SUBMITTED'].includes(status) && hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');
  const canPay = !isNew && ['APPROVED', 'PAID'].includes(status) && hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF', 'MUNICIPAL_ACCOUNTANT');

  // --- Validation ----------------------------------------------------------

  const math = useMemo(
    () =>
      checkDvMath({
        grossAmount: grossAmount ?? 0,
        deductions,
        netAmount,
        accountLines: entryLines.map((l) => ({
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
        })),
      }),
    [grossAmount, deductions, netAmount, entryLines],
  );

  /**
   * Duplicate warning. Not a block - two genuine payments of the same amount
   * to the same supplier in the same month do happen - but paying the same
   * invoice twice is the failure mode that actually loses public money, so it
   * is surfaced prominently while there is still time to check.
   */
  const duplicates = useMemo(() => {
    if (!payeeId || !grossAmount) return [];
    return findProbableDuplicates(
      { id: id ?? 'new', ref: 'this voucher', payeeId, amount: grossAmount, date: dvDate },
      allVouchers.data
        .filter((d) => d.status !== 'CANCELLED')
        .map((d) => ({
          id: d.id,
          ref: d.dvNo ?? d.id,
          payeeId: d.payeeId,
          amount: d.grossAmount,
          date: d.dvDate,
        })),
    );
  }, [payeeId, grossAmount, dvDate, allVouchers.data, id]);

  // --- Actions -------------------------------------------------------------

  const buildPayload = () => ({
    dvDate,
    fiscalYear,
    period: Number(dvDate.slice(5, 7)),
    fundCode,
    obligationId: obligationId ?? null,
    obrNo: obrNo ?? null,
    officeId: officeId!,
    officeName,
    payeeId: payeeId!,
    payeeName,
    payeeTin: payeeTin || null,
    payeeAddress: payeeAddress || null,
    particulars: particulars.trim(),
    grossAmount: grossAmount ?? 0,
    deductions: deductions.map((d, i) => ({ ...d, lineNo: i + 1 })),
    totalDeductions,
    netAmount,
    accountLines: entryLines.map((l, i) => ({
      lineNo: i + 1,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.debit,
      credit: l.credit,
      officeId: officeId ?? null,
      particulars: l.particulars ?? null,
    })),
    bankAccountId: bankAccountId ?? null,
    status: 'DRAFT' as const,
    attachmentCount: existing?.attachmentCount ?? 0,
  });

  const save = async () => {
    if (!payeeId || !officeId || !grossAmount || !particulars.trim()) {
      toast.error('The voucher is incomplete', 'Payee, office, particulars and gross amount are all required.');
      return;
    }
    if (!user) return;

    setSaving(true);
    try {
      const actor = actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      });
      if (isNew) {
        const newId = await createDraft(COL.disbursementVouchers, buildPayload(), actor);
        toast.success('Voucher saved as a draft', 'Attach the supporting documents before submitting it.');
        navigate(`/accounting/disbursements/${newId}`, { replace: true });
      } else {
        await updateDraft(COL.disbursementVouchers, id!, buildPayload(), actor);
        toast.success('Draft saved');
      }
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const run = async (fn: () => Promise<void>, failureTitle: string) => {
    setBusy(true);
    try {
      await fn();
      setConfirm(null);
    } catch (err) {
      toast.error(failureTitle, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading voucher" />;

  return (
    <div>
      <PageHeader
        title={existing?.dvNo ? `DV ${existing.dvNo}` : isNew ? 'New disbursement voucher' : 'Disbursement voucher (draft)'}
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Disbursement', to: '/accounting/disbursements' },
          { label: existing?.dvNo ?? 'New' },
        ]}
        actions={
          <>
            <StatusBadge status={status} className="mr-1" />
            {canEdit && (
              <Button loading={saving} onClick={() => void save()}>
                Save draft
              </Button>
            )}
            {canSubmit && (
              <Button variant="primary" onClick={() => setConfirm('submit')}>
                Submit
              </Button>
            )}
            {canReview && (
              <>
                <Button onClick={() => setConfirm('return')}>Return</Button>
                <Button
                  variant="primary"
                  onClick={() =>
                    void run(
                      async () => {
                        await engine.reviewDv({ dvId: id!, decision: 'REVIEWED' });
                        toast.success('Reviewed', 'The voucher is now with the Municipal Accountant for approval.');
                      },
                      'Could not review',
                    )
                  }
                >
                  Mark reviewed
                </Button>
              </>
            )}
            {canApprove && (
              <Button variant="primary" onClick={() => setConfirm('approve')}>
                Approve
              </Button>
            )}
            {/*
              Both are offered, to Treasury, once the voucher is approved and
              nothing has been paid against it yet. Neither is offered on the
              strength of a choice made earlier on the voucher, because that
              choice is no longer made.

              The ordinary way a payment gets recorded is the upload: the
              Treasurer's RCI or RADAI arrives as a file and CBO raises the
              checks and advices from it. These two are for the payment that is
              not on any file - one check drawn on its own, ahead of the report.
            */}
            {canPay && !existing?.checkId && !existing?.adaId && (
              <>
                <Button variant="success" onClick={() => setConfirm('check')}>
                  Issue check
                </Button>
                <Button variant="success" onClick={() => setConfirm('ada')}>
                  Prepare ADA
                </Button>
              </>
            )}
            {!isNew && can('accounting', 'cancel') && status !== 'CANCELLED' && (
              <Button variant="danger" onClick={() => setConfirm('cancel')}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      {status === 'RETURNED' && (
        <Alert tone="warning" title="Returned for correction" className="mb-4">
          {existing?.returnedReason ?? 'See the approval history for the reason.'}
        </Alert>
      )}

      {existing?.jevNo && (
        <Alert tone="info" className="mb-4">
          Journal entry{' '}
          <Link to={`/accounting/others/${existing.jevId}`} className="font-medium underline">
            JEV {existing.jevNo}
          </Link>{' '}
          was generated from this voucher.
          {status !== 'PAID' && ' It must be posted by the Municipal Accountant before it reaches the General Ledger.'}
        </Alert>
      )}

      {duplicates.length > 0 && editable && (
        <Alert tone="warning" title="Possible duplicate payment" className="mb-4">
          {duplicates.length} voucher{duplicates.length === 1 ? '' : 's'} to the same payee for the
          same amount within the last two months:{' '}
          {duplicates.map((d) => d.ref).join(', ')}. Check the invoice number before submitting.
        </Alert>
      )}

      <Tabs
        tabs={[
          { id: 'details', label: 'Voucher' },
          { id: 'entry', label: 'Accounting entry' },
          { id: 'attachments', label: 'Supporting documents', count: existing?.attachmentCount ?? 0 },
          { id: 'history', label: 'Approval history' },
        ]}
        active={tab}
        onChange={(t) => setTab(t as typeof tab)}
      />

      <div className="mt-4 space-y-4">
        {tab === 'details' && (
          <>
            <Card title="Voucher">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="DV date" required htmlFor="dvDate">
                  <DateInput id="dvDate" value={dvDate} onChange={setDvDate} disabled={!canEdit} />
                </Field>

                <Field
                  label="Obligation (OBR)"
                  htmlFor="obr"
                  className="lg:col-span-3"
                  hint="Selecting an obligation fills in the payee, office, particulars and the accounting distribution."
                >
                  <ObligationPicker
                    id="obr"
                    value={obligationId}
                    fiscalYear={fiscalYear}
                    fundCode={fundCode}
                    disabled={!canEdit}
                    onChange={(v, obr) => {
                      setObligationId(v);
                      setObrNo(obr?.obrNo ?? null);
                      setObligationLines(obr?.lines ?? []);
                      if (obr) {
                        setPayeeId(obr.payeeId);
                        setPayeeName(obr.payeeName);
                        setOfficeId(obr.officeId);
                        setOfficeName(obr.officeName);
                        if (!particulars) setParticulars(obr.particulars);
                        if (!grossAmount) setGrossAmount(obr.unpaidAmount);
                        setEntryTouched(false);
                      }
                    }}
                  />
                </Field>

                <Field label="Payee" required htmlFor="payee" className="lg:col-span-2">
                  <PayeePicker
                    id="payee"
                    value={payeeId}
                    disabled={!canEdit}
                    onChange={(v, p) => {
                      setPayeeId(v);
                      setPayeeName(p?.name ?? '');
                      setPayeeTin(p?.tin ?? '');
                      setPayeeAddress(p?.address ?? '');
                    }}
                  />
                </Field>

                <Field label="TIN" htmlFor="tin">
                  <TextInput id="tin" value={payeeTin} onChange={(e) => setPayeeTin(e.target.value)} disabled={!canEdit} />
                </Field>

                <Field label="Office" required htmlFor="office">
                  <OfficePicker
                    id="office"
                    value={officeId}
                    disabled={!canEdit}
                    restrictTo={officeScope.length ? officeScope : undefined}
                    onChange={(v, o) => {
                      setOfficeId(v);
                      setOfficeName(o?.name ?? '');
                    }}
                  />
                </Field>

                <Field label="Address" htmlFor="address" className="sm:col-span-2 lg:col-span-2">
                  <TextInput
                    id="address"
                    value={payeeAddress}
                    onChange={(e) => setPayeeAddress(e.target.value)}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Particulars" required htmlFor="particulars" className="sm:col-span-2 lg:col-span-4">
                  <TextArea
                    id="particulars"
                    rows={2}
                    value={particulars}
                    onChange={(e) => setParticulars(e.target.value)}
                    disabled={!canEdit}
                    placeholder="What is being paid for, and against which contract, purchase order or invoice."
                  />
                </Field>
              </div>
            </Card>

            <Card
              title="Amounts"
              subtitle="Gross less withholding taxes and other deductions gives the net payable."
            >
              <div className="grid gap-4 lg:grid-cols-3">
                <div>
                  <Field label="Gross amount" required htmlFor="gross">
                    <AmountInput
                      id="gross"
                      value={grossAmount}
                      onChange={(v) => {
                        setGrossAmount(v);
                        setEntryTouched(false);
                      }}
                      disabled={!canEdit}
                    />
                  </Field>

                  <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <Row label="Gross amount" value={grossAmount ?? 0} />
                    <Row label="Less: deductions" value={-totalDeductions} />
                    <div className="my-1.5 border-t border-slate-300" />
                    <Row label="Net amount payable" value={netAmount} bold />
                    {netAmount > 0 && (
                      <p className="mt-2 text-2xs uppercase leading-relaxed text-slate-500">
                        {amountInWords(netAmount)}
                      </p>
                    )}
                  </div>
                </div>

                <div className="lg:col-span-2">
                  <DeductionsEditor
                    deductions={deductions}
                    grossAmount={grossAmount ?? 0}
                    taxCodes={taxCodes.data}
                    disabled={!canEdit}
                    onChange={(d) => {
                      setDeductions(d);
                      setEntryTouched(false);
                    }}
                  />
                </div>
              </div>
            </Card>

            {/*
              How the voucher is paid is not asked here.

              It used to be: Accounting chose "check" or "ADA" on the voucher,
              and the choice drove which button appeared and which journal the
              entry went to. But Accounting does not know. The voucher is
              approved and passed to the Treasurer, and it is the Treasurer who
              decides whether it goes out as a check or in the next batch of
              advices to the bank - sometimes days later, and sometimes not the
              way Accounting had assumed.

              So the voucher now records only that a payable is owed. Which way
              the money left is established by the report it turns up on: the
              RCI for a check, the RADAI for an ADA. That is also the document
              that credits cash, which means the answer is recorded once, by the
              office that knows it, rather than guessed early and corrected
              later.
            */}
            <Card title="Payment">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Bank account" htmlFor="bank" className="sm:col-span-2">
                  <BankAccountPicker
                    id="bank"
                    value={bankAccountId}
                    fundCode={fundCode}
                    disabled={!canEdit}
                    onChange={setBankAccountId}
                  />
                </Field>
              </div>

              {existing && (existing.checkNo || existing.adaNo) && (
                <dl className="mt-4 grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-3">
                  <DetailField label={existing.checkNo ? 'Check number' : 'ADA number'} mono>
                    {existing.checkNo ?? existing.adaNo}
                  </DetailField>
                  <DetailField label="Status">
                    <StatusBadge status={existing.status} />
                  </DetailField>
                  <DetailField label="Journal entry" mono>
                    {existing.jevNo ?? 'Not yet generated'}
                  </DetailField>
                </dl>
              )}
            </Card>
          </>
        )}

        {tab === 'entry' && (
          <Card
            title="Accounting entry"
            subtitle={
              entryTouched
                ? 'Edited manually. It will no longer follow changes to the amounts above.'
                : 'Proposed from the obligation, the deductions and the payment method. Edit any line to take control of it.'
            }
            actions={
              canEdit && entryTouched ? (
                <Button size="sm" onClick={() => setEntryTouched(false)}>
                  Re-propose from the voucher
                </Button>
              ) : undefined
            }
          >
            <JournalEntryGrid
              lines={entryLines}
              readOnly={!canEdit}
              onChange={(l) => {
                setEntryLines(l);
                setEntryTouched(true);
              }}
            />

            {!math.ok && (
              <Alert tone="error" className="mt-4" title="The voucher does not balance">
                <ul className="list-inside list-disc space-y-0.5">
                  {math.violations.map((v, i) => (
                    <li key={i}>{v.message}</li>
                  ))}
                </ul>
              </Alert>
            )}
          </Card>
        )}

        {tab === 'attachments' && (
          <Card title="Supporting documents">
            <AttachmentsPanel
              entityType={COL.disbursementVouchers}
              entityId={id ?? null}
              entityRef={existing?.dvNo ?? 'Voucher draft'}
              fiscalYear={fiscalYear}
              fundCode={fundCode}
              storageDocType="DV"
              storageDocId={existing?.dvNo ?? id ?? 'draft'}
              readOnly={!canEdit}
            />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Approval history">
            <WorkflowTimeline entityType={COL.disbursementVouchers} entityId={id ?? null} />
          </Card>
        )}
      </div>

      {/* --- Dialogs --------------------------------------------------- */}

      <ConfirmDialog
        open={confirm === 'submit'}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          void run(async () => {
            await engine.submitDv({ dvId: id! });
            toast.success('Submitted for review');
          }, 'The voucher was not submitted')
        }
        loading={busy}
        title="Submit for review"
        confirmLabel="Submit"
        variant="primary"
        message={
          <>
            <p>
              The voucher goes to the Accounting Reviewer. Its arithmetic, the balance of its
              accounting entry and the presence of supporting documents are all checked on the
              server before it is accepted.
            </p>
            {(existing?.attachmentCount ?? 0) === 0 && (
              <p className="mt-2 text-rose-700">
                No supporting documents are attached. The submission will be refused.
              </p>
            )}
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'return'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) =>
          void run(async () => {
            await engine.reviewDv({ dvId: id!, decision: 'RETURNED', remarks: reason });
            toast.success('Returned to the originating office');
          }, 'Could not return the voucher')
        }
        loading={busy}
        title="Return for correction"
        confirmLabel="Return"
        variant="danger"
        requireReason
        reasonLabel="What needs correcting"
        reasonHint="This is shown to the originating office and recorded in the approval history."
        message={<p>The voucher goes back to the office that raised it, with your remarks.</p>}
      />

      <ConfirmDialog
        open={confirm === 'approve'}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          void run(async () => {
            const result = await engine.approveDv({ dvId: id! });
            toast.success(
              `Approved as DV ${result.dvNo}`,
              `Journal entry ${result.jevNo} has been prepared and is waiting to be posted to the General Ledger.`,
            );
          }, 'The voucher was not approved')
        }
        loading={busy}
        title="Approve for payment"
        confirmLabel="Approve"
        variant="primary"
        message={
          <>
            <p>
              Approving assigns the DV number, draws {formatPeso(grossAmount ?? 0)} against{' '}
              {obrNo ? `OBR ${obrNo}` : 'the budget'}, and prepares the journal entry.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The unpaid balance of the obligation and the state of the accounting period are
              re-checked on the server. Posting to the General Ledger is a separate act by the
              Municipal Accountant.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'cancel'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) =>
          void run(async () => {
            await engine.cancelDv({ dvId: id!, reason: reason! });
            toast.success('Voucher cancelled');
          }, 'Could not cancel the voucher')
        }
        loading={busy}
        title={`Cancel DV ${existing?.dvNo ?? ''}`}
        confirmLabel="Cancel voucher"
        variant="danger"
        requireReason
        message={
          <p>
            The voucher is kept with a status of Cancelled; it is never deleted. If its journal
            entry has already been posted, the entry must be reversed first.
          </p>
        }
      />

      {confirm === 'check' && (
        <IssueCheckDialog
          dvId={id!}
          fundCode={fundCode}
          netAmount={netAmount}
          payeeName={existing?.payeeName ?? ''}
          defaultBankAccountId={bankAccountId}
          onClose={() => setConfirm(null)}
          onIssued={(checkNo) => {
            setConfirm(null);
            toast.success(`Check ${checkNo} issued`, 'It is now in the check register, ready for signature.');
          }}
        />
      )}

      <ConfirmDialog
        open={confirm === 'ada'}
        onCancel={() => {
          setConfirm(null);
          setAdaReservationId('');
        }}
        onConfirm={() =>
          void run(async () => {
            if (!bankAccountId) throw new Error('Select the bank account the ADA is drawn on.');
            const result = await engine.issueAda({
              dvId: id!,
              bankAccountId,
              adaDate: todayPh(),
              reservationId: adaReservationId || undefined,
            });
            setAdaReservationId('');
            toast.success(`ADA ${result.adaNo} prepared`, 'Submit it to the bank to have the account debited.');
          }, 'Could not prepare the ADA')
        }
        loading={busy}
        title="Prepare Advice to Debit Account"
        confirmLabel="Prepare ADA"
        variant="success"
        message={
          <>
            <p>
              An ADA for {formatPeso(netAmount)} in favour of {payeeName} will be prepared against
              the selected bank account.
            </p>
            {reservedAdaNumbers.length > 0 && (
              <Field
                label="Use a reserved number"
                className="mt-3"
                hint="Leave this as the next number unless the office reserved one for this batch. Using a reservation is the only thing that stops it becoming a gap to explain later."
              >
                <Select
                  value={adaReservationId}
                  onChange={(e) => setAdaReservationId(e.target.value)}
                >
                  <option value="">Draw the next number</option>
                  {reservedAdaNumbers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.adaNo}
                      {r.note ? ` — ${r.note}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className={`text-xs ${bold ? 'font-medium text-navy-900' : 'text-slate-600'}`}>{label}</span>
      <span className={`font-mono text-sm tabular ${bold ? 'font-semibold text-navy-900' : 'text-navy-800'}`}>
        {formatPeso(value, { symbol: false, parens: true })}
      </span>
    </div>
  );
}

function DeductionsEditor({
  deductions,
  grossAmount,
  taxCodes,
  disabled,
  onChange,
}: {
  deductions: DeductionLite[];
  grossAmount: number;
  taxCodes: Array<{
    id: string;
    code: string;
    description: string;
    rate: number;
    base: 'GROSS' | 'NET_OF_VAT';
    accountCode: string;
  }>;
  disabled?: boolean;
  onChange: (deductions: DeductionLite[]) => void;
}) {
  const [selectedTaxCode, setSelectedTaxCode] = useState('');

  const addTaxCode = () => {
    const tc = taxCodes.find((t) => t.id === selectedTaxCode);
    if (!tc || !grossAmount) return;
    const computed = computeDeduction(tc, tc.description, grossAmount);
    onChange([...deductions, computed]);
    setSelectedTaxCode('');
  };

  const addManual = () => {
    onChange([
      ...deductions,
      { code: 'OTHER', description: '', accountCode: '', accountName: '', amount: 0 },
    ]);
  };

  return (
    <div>
      <p className="cbo-label">Deductions</p>

      {deductions.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
          No deductions. Add a withholding tax or another deduction below.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="cbo-th">Deduction</th>
              <th className="cbo-th min-w-[13rem]">Account</th>
              <th className="cbo-th w-32 text-right">Amount</th>
              {!disabled && <th className="cbo-th w-8" />}
            </tr>
          </thead>
          <tbody>
            {deductions.map((d, i) => (
              <tr key={i}>
                <td className="cbo-td">
                  {disabled ? (
                    <span className="text-sm">{d.description}</span>
                  ) : (
                    <TextInput
                      value={d.description}
                      onChange={(e) =>
                        onChange(deductions.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                      }
                      className="py-1.5 text-xs"
                      placeholder="Description"
                    />
                  )}
                </td>
                <td className="cbo-td">
                  {disabled ? (
                    <span className="text-xs">
                      <span className="font-mono text-slate-500">{d.accountCode}</span> {d.accountName}
                    </span>
                  ) : (
                    <AccountPicker
                      value={d.accountCode || null}
                      onChange={(code, account) =>
                        onChange(
                          deductions.map((x, j) =>
                            j === i ? { ...x, accountCode: code ?? '', accountName: account?.name ?? '' } : x,
                          ),
                        )
                      }
                    />
                  )}
                </td>
                <td className="cbo-td">
                  {disabled ? (
                    <span className="cbo-amount block">{formatPeso(d.amount, { symbol: false })}</span>
                  ) : (
                    <AmountInput
                      value={d.amount}
                      onChange={(v) => onChange(deductions.map((x, j) => (j === i ? { ...x, amount: v ?? 0 } : x)))}
                      className="py-1.5"
                    />
                  )}
                </td>
                {!disabled && (
                  <td className="cbo-td text-center">
                    <button
                      onClick={() => onChange(deductions.filter((_, j) => j !== i))}
                      className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      aria-label="Remove deduction"
                    >
                      &times;
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!disabled && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <Select
              value={selectedTaxCode}
              onChange={(e) => setSelectedTaxCode(e.target.value)}
              className="py-1.5 text-sm"
              aria-label="Tax code"
            >
              <option value="">Add a withholding tax...</option>
              {taxCodes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} - {t.description} ({(t.rate * 100).toFixed(t.rate < 0.01 ? 2 : 0)}% of{' '}
                  {t.base === 'NET_OF_VAT' ? 'net of VAT' : 'gross'})
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" onClick={addTaxCode} disabled={!selectedTaxCode || !grossAmount}>
            Add tax
          </Button>
          <Button size="sm" onClick={addManual}>
            Add other deduction
          </Button>
        </div>
      )}
    </div>
  );
}

function IssueCheckDialog({
  dvId,
  fundCode,
  netAmount,
  payeeName,
  defaultBankAccountId,
  onClose,
  onIssued,
}: {
  dvId: string;
  fundCode: string;
  netAmount: number;
  payeeName: string;
  defaultBankAccountId: string | null;
  onClose: () => void;
  onIssued: (checkNo: string) => void;
}) {
  const toast = useToast();
  const [bankAccountId, setBankAccountId] = useState(defaultBankAccountId);
  const [checkNo, setCheckNo] = useState('');
  const [checkDate, setCheckDate] = useState(todayPh());
  const [acknowledgement, setAcknowledgement] = useState('');
  const [busy, setBusy] = useState(false);

  // The same rule the server decides with, so the warning and the refusal
  // cannot disagree. See src/lib/clearing.ts.
  const objection = clearingObjection(payeeName);
  const acknowledged = acknowledgement.trim().length >= CLEARING_OVERRIDE_MIN_LENGTH;

  const issue = async () => {
    if (!bankAccountId || !checkNo.trim()) {
      toast.error('Incomplete', 'A bank account and check number are required.');
      return;
    }
    if (objection && !acknowledged) {
      toast.error(
        'The bank will return this check',
        'Say in writing why the office is drawing it anyway.',
      );
      return;
    }
    setBusy(true);
    try {
      const result = await engine.issueCheck({
        dvId,
        bankAccountId,
        checkNo: checkNo.trim(),
        checkDate,
        payeeAcknowledgement: objection ? acknowledgement.trim() : undefined,
      });
      onIssued(result.checkNo);
    } catch (err) {
      // The uniqueness constraint lives in the database, so a clash is
      // reported from the server rather than guessed at here.
      toast.error('The check was not issued', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Issue a check"
      description={`For ${formatPeso(netAmount)}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={objection ? 'danger' : 'success'}
            loading={busy}
            disabled={Boolean(objection) && !acknowledged}
            onClick={() => void issue()}
          >
            {objection ? 'Issue anyway' : 'Issue check'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {objection && (
          <Alert tone="error" title="The clearing house will refuse this payee">
            <p>
              The payee is <strong>{payeeName}</strong>. {objection.message}
            </p>
            <Field
              label="Why the office is drawing it anyway"
              className="mt-3"
              hint="At least fifteen characters. Recorded against the check as a critical audit event."
            >
              <TextInput
                value={acknowledgement}
                onChange={(e) => setAcknowledgement(e.target.value)}
                placeholder="Approved by the Treasurer for petty cash replenishment"
              />
            </Field>
          </Alert>
        )}

        <Field label="Bank account" required htmlFor="checkBank">
          <BankAccountPicker id="checkBank" value={bankAccountId} fundCode={fundCode} onChange={setBankAccountId} />
        </Field>

        <Field
          label="Check number"
          required
          htmlFor="checkNo"
          hint="Must be unique within the bank account. The database enforces this, so a duplicate is refused outright."
        >
          <TextInput
            id="checkNo"
            value={checkNo}
            onChange={(e) => setCheckNo(e.target.value)}
            placeholder="0001234"
            className="font-mono"
          />
        </Field>

        <Field label="Check date" required htmlFor="checkDate">
          <DateInput id="checkDate" value={checkDate} onChange={setCheckDate} />
        </Field>
      </div>
    </Modal>
  );
}
