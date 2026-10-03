import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, Alert, Spinner, DetailField, Tabs } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, TextArea, DateInput, AmountInput, Select } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
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
import { attachmentTypesFor } from '@/lib/attachmentTypes';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useTaxCodes, useDisbursementVouchers } from '@/data/queries';
import { COL } from '@/lib/collections';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { engine } from '@/lib/engine';
import { formatPeso, amountInWords } from '@/lib/money';
import { formatLongDate, todayPh } from '@/lib/dates';
import { checkDvCategory, checkDvMath, findProbableDuplicates } from '@/lib/accounting-rules';
import {
  proposeDvEntry,
  computeDeduction,
  type DeductionLite,
  type ObligationLineLite,
} from './proposeEntry';
import type { DisbursementVoucher } from '@/types/accounting';
import {
  DV_CATEGORIES,
  DV_CATEGORY_HINTS,
  DV_CATEGORY_LABELS,
  type DvCategory,
} from '@/types/enums';
import { fundLabel } from '../budget/Obligations';
import { isTrustFund, obligationForm } from '@/lib/obligationForm';
import { useFppOptions } from '@/data/useFppOptions';

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
  // The budget lines this entry may be charged to, and which accounts are
  // expenses and therefore need one.
  const { fppOptions, expenseCodes } = useFppOptions(fiscalYear, fundCode);
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
    null | 'submit' | 'approve' | 'unapprove' | 'post' | 'return' | 'cancel' | 'check' | 'ada'
  >(null);

  // --- Form state ----------------------------------------------------------

  /**
   * The number accounting staff assign from the office's own book.
   *
   * CFMS does not generate it, for the same reason it does not generate the
   * OBR number: the number on the paper that is signed is the number this
   * record must carry. Uniqueness is enforced on the server when the
   * Accountant approves, which is the moment the number is actually spent.
   */
  const [dvNo, setDvNo] = useState('');
  const [dvDate, setDvDate] = useState(todayPh());
  /*
   * What kind of voucher this is, chosen before anything else because it
   * decides whether an Obligation Request is required at all.
   *
   * A voucher raised before the category existed has none stored. It is shown
   * as unset rather than guessed from whether it happens to carry an
   * obligation: guessing would quietly relabel a voucher whose OBR somebody
   * forgot as a deliberate trust settlement, which is the one mistake this
   * field exists to catch.
   */
  const [dvCategory, setDvCategory] = useState<DvCategory | ''>('OBLIGATED');
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
    setDvNo(existing.dvNo ?? '');
    setDvDate(existing.dvDate);
    setDvCategory(existing.dvCategory ?? '');
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
        fppCode: l.fppCode,
        fppName: l.fppName,
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

  /**
   * The entry this voucher raised, still waiting to be posted.
   *
   * PAID counts. Posting the books and paying the supplier are two officers'
   * acts and neither waits for the other: a voucher paid by check this morning
   * may still be posted this afternoon, and refusing it here would leave the
   * entry unposted with no way to post it.
   *
   * `jevPostedAt` is the voucher's own record of having been posted, written
   * by the engine in the posting transaction.
   */
  const canPost =
    !isNew &&
    (status === 'APPROVED' || status === 'PAID') &&
    Boolean(existing?.jevId) &&
    !existing?.jevPostedAt &&
    hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  /**
   * Taking the approval back. Offered only before anything irreversible: the
   * server refuses once a check or advice exists, or once the entry is posted,
   * and the button goes with the voucher's status rather than guessing.
   */
  const canUnapprove =
    !isNew &&
    status === 'APPROVED' &&
    !existing?.checkId &&
    !existing?.adaId &&
    hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

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
   * The same category rule the server will run.
   *
   * Shown while the voucher is being built rather than at submission, because
   * the fix for "a trust liability may not debit an expense" is to change the
   * accounting distribution, and that is what the encoder is looking at.
   */
  const category = useMemo(
    () =>
      checkDvCategory(
        {
          category: dvCategory,
          hasObligation: Boolean(obligationId),
          lines: entryLines.map((l) => ({
            lineNo: l.lineNo,
            accountCode: l.accountCode,
            debit: l.debit,
            credit: l.credit,
            fppCode: l.fppCode ?? null,
          })),
        },
        (code) => expenseCodes.has(code),
      ),
    [dvCategory, obligationId, entryLines, expenseCodes],
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
    dvNo: dvNo.trim(),
    dvDate,
    fiscalYear,
    period: Number(dvDate.slice(5, 7)),
    fundCode,
    dvCategory: dvCategory || null,
    // A trust liability never carries an obligation, so switching to it drops
    // one that had been chosen rather than leaving it in the document for the
    // server to refuse.
    obligationId: dvCategory === 'TRUST_LIABILITY' ? null : obligationId ?? null,
    obrNo: dvCategory === 'TRUST_LIABILITY' ? null : obrNo ?? null,
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
      fppCode: l.fppCode ?? null,
      fppName: l.fppName ?? null,
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
              <Button
                variant="primary"
                disabled={!category.ok}
                title={category.ok ? undefined : category.violations[0].message}
                onClick={() => setConfirm('submit')}
              >
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
            {canPost && (
              /*
                Posting is done HERE, on the voucher, not on a separate screen
                called Other Transactions. The entry belongs to this voucher
                and the Accountant is already looking at it; sending them
                somewhere else to post it is how entries sat unposted for days
                while the ledger looked empty.
              */
              <Button variant="success" onClick={() => setConfirm('post')}>
                Post to General Ledger
              </Button>
            )}
            {canUnapprove && (
              <Button variant="secondary" onClick={() => setConfirm('unapprove')}>
                Undo approval
              </Button>
            )}
            {/*
              Issue check and Prepare ADA were here, and are not any more.

              The Accountant approves a voucher; the Treasurer pays it. Two
              officers, two acts, and the second is the one that moves money
              out of the municipality. Offering the button on this screen made
              drawing a check something done by whoever had the voucher open,
              which is where that separation stopped being visible.

              The voucher now appears on TREASURY > DISBURSEMENTS FOR PAYMENT
              as soon as it is approved, and is paid from there.
            */}
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

      {existing?.jevId && existing.jevNo && (
        <Alert tone="success" className="mb-4">
          In the General Ledger as{' '}
          <Link
            to={`/accounting/journal-entries/${existing.jevId}`}
            className="font-medium underline"
          >
            JEV {existing.jevNo}
          </Link>
          . A posted entry is never edited - a correction is a reversing entry.
        </Alert>
      )}

      {existing?.jevId && !existing.jevNo && (
        <Alert tone="warning" className="mb-4">
          A journal entry is prepared from this voucher and is{' '}
          <strong>not yet in the General Ledger</strong>. It takes its JEV number from the journal
          series when the Municipal Accountant posts it, which is done from this screen.
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
                <Field
                  label="DV number"
                  required
                  htmlFor="dvNo"
                  hint="Assigned from the accounting book. Checked for a duplicate when the Accountant approves."
                >
                  <TextInput
                    id="dvNo"
                    value={dvNo}
                    onChange={(e) => setDvNo(e.target.value)}
                    disabled={!canEdit}
                    placeholder="100-26-10-0001"
                    className="font-mono"
                  />
                </Field>

                <Field label="DV date" required htmlFor="dvDate">
                  <DateInput id="dvDate" value={dvDate} onChange={setDvDate} disabled={!canEdit} />
                </Field>

                <Field
                  label="Kind of voucher"
                  required
                  htmlFor="dvCategory"
                  hint={dvCategory ? DV_CATEGORY_HINTS[dvCategory] : undefined}
                >
                  <Select
                    id="dvCategory"
                    value={dvCategory}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const next = e.target.value as DvCategory | '';
                      setDvCategory(next);
                      // Switching to a trust liability clears the obligation
                      // here as well as in the payload, so the screen shows
                      // what will actually be saved.
                      if (next === 'TRUST_LIABILITY') {
                        setObligationId(null);
                        setObrNo(null);
                        setObligationLines([]);
                      }
                    }}
                  >
                    <option value="">Choose&hellip;</option>
                    {DV_CATEGORIES.filter(
                      // In the Trust Fund every voucher utilises a programme,
                      // so every voucher carries a FURS. The trust-liability
                      // kind belongs to the appropriated funds, where it
                      // settles money held inside them.
                      (c) => !(isTrustFund(fundCode) && c === 'TRUST_LIABILITY'),
                    ).map((c) => (
                      <option key={c} value={c}>
                        {DV_CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </Select>
                </Field>

                {dvCategory === 'TRUST_LIABILITY' ? (
                  <div className="lg:col-span-2">
                    <Alert tone="info">
                      A trust liability settles money the municipality is holding for somebody
                      else &mdash; retention, a bidder&rsquo;s bond, premiums or tax withheld and
                      now remitted. It needs no Obligation Request, and no expense account may be
                      debited: an expense here would be spending with no obligation and no
                      allotment behind it.
                    </Alert>
                  </div>
                ) : (
                  <Field
                    label={`Obligation (${obligationForm(fundCode).short})`}
                    required
                    htmlFor="obr"
                    className="lg:col-span-2"
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
                )}

                <Field label="Payee" required htmlFor="payee" className="lg:col-span-2">
                  <PayeePicker
                    id="payee"
                    value={payeeId}
                    disabled={!canEdit}
                    allowAdd
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
                    {existing.jevNo ?? 'Not yet posted'}
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
              fppOptions={fppOptions}
              expenseCodes={expenseCodes}
              fundCode={fundCode}
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

            {!category.ok && (
              <Alert
                tone="error"
                className="mt-4"
                title={
                  dvCategory === 'TRUST_LIABILITY'
                    ? 'This is not a trust liability'
                    : 'This voucher cannot be submitted yet'
                }
              >
                <ul className="list-inside list-disc space-y-0.5">
                  {category.violations.map((v, i) => (
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
              allowedTypes={attachmentTypesFor(COL.disbursementVouchers)}
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
        open={confirm === 'post'}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          void run(async () => {
            const result = await engine.postJev({ jevId: existing!.jevId! });
            toast.success(
              `Posted as JEV ${result.jevNo}`,
              `${result.ledgerEntryCount} ledger entries written. The General Ledger, the Trial Balance and the financial statements now carry this voucher.`,
            );
          }, 'The entry was not posted')
        }
        loading={busy}
        title="Post to the General Ledger"
        confirmLabel="Post"
        variant="success"
        message={
          <>
            <p>
              The journal entry prepared from this voucher is written to the General Ledger. From
              that moment it is in the Trial Balance, the financial statements and every report
              drawn from the ledger.
            </p>
            <p className="mt-2">
              It takes its JEV number now, from the journal series. An entry that has not been
              posted has not been made, so it does not hold a number in the series.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              A posted entry is never edited or deleted. Correcting it means a reversing entry.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'unapprove'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) => {
          if (!reason) return;
          void run(async () => {
            const result = await engine.unapproveDv({ dvId: id!, reason });
            toast.success(
              `DV ${result.dvNo ?? ''} is a draft again`.trim(),
              result.cancelledJevNo
                ? `The obligation has its balance back and journal entry ${result.cancelledJevNo} has been cancelled.`
                : 'The obligation has its balance back.',
            );
          }, 'The approval was not taken back');
        }}
        loading={busy}
        title={`Undo the approval of DV ${existing?.dvNo ?? ''}`.trim()}
        confirmLabel="Undo approval"
        variant="danger"
        requireReason
        message={
          <>
            <p>
              The voucher becomes a draft again so the figures can be corrected.{' '}
              {existing?.obrNo ? `OBR ${existing.obrNo}` : 'The obligation'} gets its unpaid
              balance back, and the journal entry prepared from it is cancelled. It never reached
              the books and it holds no journal number, so nothing is left out of the series.
            </p>
            <p className="mt-2">
              It keeps its number, <strong className="font-mono">{existing?.dvNo}</strong>, and
              keeps it reserved, so nobody else can take it while this one is corrected.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Recorded as a critical audit event. The server refuses it once a check or an advice
              has been drawn, or once the entry has been posted.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'approve'}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          void run(async () => {
            const result = await engine.approveDv({ dvId: id! });
            toast.success(
              `Approved as DV ${result.dvNo}`,
              'Its journal entry is prepared. Post it from this screen to put it in the General Ledger - it takes its JEV number then.',
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
              Approving confirms DV {dvNo.trim()}, {formatPeso(grossAmount ?? 0)}
              {dvCategory === 'TRUST_LIABILITY'
                ? ' against the trust liability it settles'
                : ` against OBR ${obrNo ?? ''}`}
              , and prepares the journal entry.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {dvCategory === 'TRUST_LIABILITY'
                ? 'No allotment is consumed: a trust liability settles money the municipality is holding, not an expenditure. That it debits no expense is re-checked on the server.'
                : 'The unpaid balance of the obligation and the state of the accounting period are re-checked on the server.'}{' '}
              Posting to the General Ledger is a separate act by the Municipal Accountant.
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
              <th className="cbo-th cbo-amount-col">Amount</th>
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
