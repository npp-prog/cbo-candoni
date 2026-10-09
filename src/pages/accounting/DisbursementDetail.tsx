import { useEffect, useMemo, useState } from 'react';
import { JevLink } from '@/components/JevLink';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { BackButton, ReturnLink, keepReturn } from '@/components/ui/BackButton';
import { PageHeader, Card, Alert, Spinner, DetailField, Tabs } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import {
  Field,
  TextInput,
  TextArea,
  DateInput,
  AmountInput,
  Select,
  Checkbox,
} from '@/components/ui/Field';
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
import { SignedTotalNote } from '@/components/SignedTotalNote';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { attachmentTypesFor } from '@/lib/attachmentTypes';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useTaxCodes, useDisbursementVouchers, usePayees, useAccounts } from '@/data/queries';
import { COL } from '@/lib/collections';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { engine } from '@/lib/engine';
import { namedAccountTitle } from '@/lib/chartOfAccounts';
import { formatPeso, amountInWords } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import {
  checkDoubleEntry,
  checkDvCategory,
  checkDvMath,
  findProbableDuplicates,
} from '@/lib/accounting-rules';
import {
  proposeDvEntry,
  computeDeduction,
  type DeductionLite,
  type ObligationLineLite,
} from './proposeEntry';
import type { DisbursementVoucher, JournalEntryVoucher } from '@/types/accounting';
import {
  DV_CATEGORIES,
  DV_CATEGORY_HINTS,
  DV_CATEGORY_LABELS,
  type DvCategory,
} from '@/types/enums';
import { fundLabel } from '../budget/Obligations';
import { isTrustFund, obligationForm } from '@/lib/obligationForm';
import { useFppOptions } from '@/data/useFppOptions';
import { DvPayeesCard, type DvPayeeRow } from './DvPayeesCard';
import { withEtAl, withoutEtAl } from '@/lib/accounting-rules';

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
  const location = useLocation();
  const toast = useToast();
  const { fiscalYear, fundCode } = useFilters();
  // The budget lines this entry may be charged to, and which accounts are
  // expenses and therefore need one.
  const { expenseCodes } = useFppOptions(fiscalYear, fundCode);
  const { user, profile, can, hasRole, officeScope } = useAuth();

  const { data: existing, loading } = useDocument<DisbursementVoucher>(
    isNew ? null : COL.disbursementVouchers,
    id,
  );
  /*
   * The entry this voucher raised, read only. It is here so the voucher can
   * say when the Accountant's correction has left the entry carrying a
   * different amount from the one on this paper - see SignedTotalNote.
   */
  const { data: jev } = useDocument<JournalEntryVoucher>(COL.jevs, existing?.jevId ?? undefined);
  const taxCodes = useTaxCodes();
  /*
   * The Chart of Accounts, read so a withholding line can be named by the
   * ACCOUNT it posts to rather than by the tax that produced it.
   */
  const accounts = useAccounts();
  const accountTitle = useMemo(() => {
    const byCode = new Map(accounts.data.map((a) => [a.code, a.name]));
    return (code: string) => byCode.get(String(code ?? '').trim()) ?? null;
  }, [accounts.data]);
  const allVouchers = useDisbursementVouchers(fiscalYear, fundCode);

  const [tab, setTab] = useState<'details' | 'entry' | 'attachments' | 'history'>('details');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    | null
    | 'submit'
    | 'approve'
    | 'unapprove'
    | 'post'
    | 'forward'
    | 'return'
    | 'cancel'
    | 'check'
    | 'ada'
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
  /** Patch 138: "Payee, et al." - several payees, one ADA. See dvPayees.ts. */
  const [severalPayees, setSeveralPayees] = useState(false);
  const [payeeRows, setPayeeRows] = useState<DvPayeeRow[]>([]);
  /*
   * Whether the TIN on this screen is the encoder's own typing.
   *
   * It stops the master data writing over a correction. Set when somebody
   * types in the box, and when an existing voucher is loaded - a saved
   * voucher shows the TIN it was SAVED with, because that is the number that
   * was on the paper, and a payee whose TIN was corrected in Master Data last
   * week must not silently restate a voucher signed the week before.
   */
  const [tinTouched, setTinTouched] = useState(false);
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [particulars, setParticulars] = useState('');
  const [grossAmount, setGrossAmount] = useState<number | null>(null);
  const [deductions, setDeductions] = useState<DeductionLite[]>([]);
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [entryLines, setEntryLines] = useState<GridLine[]>([]);
  const [entryTouched, setEntryTouched] = useState(false);
  /*
   * Patch 131. The entry as it waits to be posted, for the Accountant to
   * correct. Loaded from the journal entry itself (that is what postJev
   * posts), and written back through correctDvEntry.
   */
  const [unpostedLines, setUnpostedLines] = useState<GridLine[] | null>(null);
  const [unpostedDirty, setUnpostedDirty] = useState(false);
  const [savingEntry, setSavingEntry] = useState(false);

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
    setSeveralPayees(Boolean(existing.severalPayees));
    setPayeeRows(
      (existing.payees ?? []).map((p) => ({
        payeeId: p.payeeId,
        payeeName: p.payeeName,
        accountNumber: p.accountNumber,
        amount: p.amount,
      })),
    );
    setTinTouched(true);
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
        // Dropped here until patch 84, so a saved voucher came back with an
        // empty Subsidiary ledger column however carefully it had been filled.
        subsidiaryType: l.subsidiaryType,
        subsidiaryId: l.subsidiaryId,
        subsidiaryName: l.subsidiaryName,
        particulars: l.particulars,
      })),
    );
    setEntryTouched(true);
  }, [existing]);

  /*
   * The TIN and the address, from the payee's record in Master Data.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS AN EFFECT AND NOT PART OF THE PAYEE PICKER
   * ---------------------------------------------------------------------------
   * There are two ways a payee lands on a voucher: somebody picks one, or they
   * pick an OBLIGATION and the payee arrives with it. The picker filled the
   * TIN in; the obligation did not - so a voucher raised the normal way, from
   * its Obligation Request, came up with the TIN box empty and the number was
   * typed again on a voucher whose payee CFMS already knew.
   *
   * Keyed on the payee rather than on how the payee got here, so both routes
   * are answered by one piece of code and a third route added later is
   * answered by it too.
   */
  const payees = usePayees();
  useEffect(() => {
    if (tinTouched || !payeeId) return;
    const payee = payees.data.find((p) => p.id === payeeId);
    if (!payee) return;
    setPayeeTin(payee.tin ?? '');
    setPayeeAddress((current) => current || payee.address || '');
  }, [payeeId, payees.data, tinTouched]);

  const totalDeductions = useMemo(() => deductions.reduce((s, d) => s + d.amount, 0), [deductions]);
  const netAmount = (grossAmount ?? 0) - totalDeductions;

  /*
   * Patch 138. On a group voucher the header payee is the FIRST listed payee,
   * written "Name, et al." - what the office writes on the papers, and what
   * the ADA, the registers and the prints show.
   */
  useEffect(() => {
    if (!severalPayees) {
      setPayeeName((n) => withoutEtAl(n));
      return;
    }
    const first = payeeRows.find((r) => r.payeeId);
    if (first) {
      setPayeeId(first.payeeId);
      setPayeeName(withEtAl(first.payeeName));
    } else {
      setPayeeName((n) => (n ? withEtAl(n) : n));
    }
  }, [severalPayees, payeeRows]);

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
        payee: payeeId && payeeName ? { id: payeeId, name: payeeName } : null,
        // Patch 138: credited per payee on a group voucher.
        payees: severalPayees
          ? payeeRows
              .filter((r) => r.payeeId)
              .map((r) => ({ payeeId: r.payeeId as string, payeeName: r.payeeName, amount: r.amount }))
          : null,
        particulars: particulars || undefined,
      }),
    );
  }, [
    severalPayees,
    payeeRows,
    grossAmount,
    deductions,
    netAmount,
    obligationLines,
    particulars,
    payeeId,
    payeeName,
    entryTouched,
  ]);

  const status = existing?.status ?? 'DRAFT';
  const editable = isNew || ['DRAFT', 'RETURNED'].includes(status);
  const canEdit = can('accounting', 'edit') && editable;
  const canSubmit = !isNew && editable && can('accounting', 'create');
  const canReview = !isNew && status === 'SUBMITTED' && hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT', 'ACCOUNTING_REVIEWER');
  const canApprove = !isNew && ['REVIEWED', 'SUBMITTED'].includes(status) && hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  /**
   * The entry this voucher raised, still waiting to be posted.
   *
   * ---------------------------------------------------------------------------
   * THIS BUTTON IS NOW FOR OLD VOUCHERS ONLY
   * ---------------------------------------------------------------------------
   * Approval posts the entry from patch 85 onwards, so a voucher approved
   * since then arrives here already in the books and the button never appears.
   * It remains for the vouchers approved BEFORE that, whose entries are sitting
   * prepared and unposted. Removing it would leave those with no way to be
   * posted at all.
   *
   * PAID counts, for the same reason it always did: posting the books and
   * paying the supplier are two officers' acts and neither waits for the other.
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
   * Patch 131: "Allow edit of Accounting entry if not yet posted in Ledger."
   *
   * The same voucher the Post button is offered on, while its entry is still
   * a proposal. The engine keeps the total and refuses once it is posted.
   */
  const canCorrectEntry =
    canPost && Boolean(jev) && !['POSTED', 'REVERSED', 'CANCELLED'].includes(jev?.status ?? '');

  useEffect(() => {
    if (!canCorrectEntry || !jev || unpostedDirty) return;
    setUnpostedLines(
      (jev.lines ?? []).map((l, i) => ({
        lineNo: l.lineNo ?? i + 1,
        accountCode: l.accountCode,
        accountName: l.accountName,
        fppCode: l.fppCode ?? undefined,
        fppName: l.fppName ?? undefined,
        debit: l.debit,
        credit: l.credit,
        particulars: l.particulars ?? undefined,
        subsidiaryType: l.subsidiaryType ?? undefined,
        subsidiaryId: l.subsidiaryId ?? undefined,
        subsidiaryName: l.subsidiaryName ?? undefined,
      })),
    );
  }, [canCorrectEntry, jev, unpostedDirty]);

  const unpostedCheck = useMemo(
    () =>
      checkDoubleEntry(
        (unpostedLines ?? []).map((l) => ({
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
        })),
      ),
    [unpostedLines],
  );
  const unpostedTotal = (unpostedLines ?? []).reduce((t, l) => t + l.debit, 0);

  const saveUnpostedEntry = async () => {
    if (!unpostedLines) return;
    setSavingEntry(true);
    try {
      await engine.correctDvEntry({
        dvId: id!,
        lines: unpostedLines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          fppCode: l.fppCode ?? null,
          fppName: l.fppName ?? null,
          debit: l.debit,
          credit: l.credit,
          particulars: l.particulars ?? null,
          subsidiaryType: l.subsidiaryType ?? null,
          subsidiaryId: l.subsidiaryId ?? null,
          subsidiaryName: l.subsidiaryName ?? null,
        })),
      });
      setUnpostedDirty(false);
      toast.success('Entry corrected', 'It is still not posted. Post it to the General Ledger when ready.');
    } catch (err) {
      toast.error('The entry was not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEntry(false);
    }
  };

  /**
   * Sending it over to Treasury.
   *
   * The second half of what approval used to do in one step. A voucher is
   * approved and in the books the moment the Accountant says the claim is
   * proper; it becomes the Treasurer's to pay when somebody here sends it.
   *
   * Absent on a voucher approved before patch 85 - those went straight to
   * Treasury on approval and are already there.
   */
  const canForward =
    !isNew &&
    status === 'APPROVED' &&
    Boolean(existing?.awaitingTransferToTreasury) &&
    !existing?.checkId &&
    !existing?.adaId &&
    hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  /**
   * Taking the approval back. The server refuses once a check or an advice has
   * been drawn; the posted entry is reversed in the same act.
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
    severalPayees,
    payees: severalPayees
      ? payeeRows.map((r, i) => ({
          lineNo: i + 1,
          payeeId: r.payeeId ?? null,
          payeeName: r.payeeName || r.sheetName || '',
          accountNumber: r.accountNumber.trim(),
          amount: r.amount ?? 0,
        }))
      : [],
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
      // The engine carries these onto the journal entry; dropping them here
      // meant the subsidiary chosen on the screen never reached the ledger.
      subsidiaryType: l.subsidiaryType ?? null,
      subsidiaryId: l.subsidiaryId ?? null,
      subsidiaryName: l.subsidiaryName ?? null,
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
        navigate(keepReturn(`/accounting/disbursements/${newId}`, location.search), { replace: true });
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
            {/* Back to the table it was opened from. Patch 114. */}
            <BackButton list={{ to: '/accounting/disbursements', label: 'Disbursement Vouchers' }} />
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
                called General Transactions. The entry belongs to this voucher
                and the Accountant is already looking at it; sending them
                somewhere else to post it is how entries sat unposted for days
                while the ledger looked empty.
              */
              <Button
                variant="success"
                disabled={unpostedDirty}
                title={unpostedDirty ? 'Save the corrected entry first' : undefined}
                onClick={() => setConfirm('post')}
              >
                Post to General Ledger
              </Button>
            )}
            {canForward && (
              <Button variant="primary" onClick={() => setConfirm('forward')}>
                Send to Treasury
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

              The voucher appears on TREASURY > DISBURSEMENTS FOR PAYMENT once
              somebody here presses Send to Treasury, and is paid from there.
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
          <ReturnLink
            to={`/accounting/journal-entries/${existing.jevId}`}
            className="font-medium underline"
          >
            JEV {existing.jevNo}
          </ReturnLink>
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

      <SignedTotalNote jev={jev} from="document" />

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
                    hint={
                      canEdit
                        ? 'Selecting an obligation fills in the payee, office, particulars and the accounting distribution.'
                        : undefined
                    }
                  >
                    {/*
                      ----------------------------------------------------------
                      THE NUMBER IS READ FROM THE VOUCHER, NOT FROM THE PICKER
                      ----------------------------------------------------------
                      The picker offers obligations with an unpaid balance -
                      which is right for CHOOSING one, and wrong for showing the
                      one already chosen. An obligation fully drawn by this
                      voucher has no unpaid balance left, so it drops out of the
                      list, the picker finds nothing to display, and the screen
                      goes blank in the place where the OBR number was.

                      The voucher knows its own OBR number: `obrNo` is stored on
                      the record and has been since it was first saved. So a
                      saved voucher shows that, and the picker is offered only
                      while there is still a choice to make.

                      Same shape as the "Not yet paid" fault in patch 84 - the
                      record was right, the screen was reading from the wrong
                      place.
                    */}
                    {!canEdit && existing?.obrNo ? (
                      <div className="flex items-baseline gap-2 py-1.5">
                        <span className="font-mono text-sm text-navy-900">{existing.obrNo}</span>
                        {existing.obligationId && (
                          <ReturnLink
                            to={`/budget/obligations/${existing.obligationId}`}
                            className="text-xs font-medium underline"
                          >
                            Open it
                          </ReturnLink>
                        )}
                      </div>
                    ) : (
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
                          // Patch 138: a group request makes a group voucher.
                          if ((obr as { severalPayees?: boolean }).severalPayees) setSeveralPayees(true);
                          // Let the master data answer for the TIN again.
                          setTinTouched(false);
                          setOfficeId(obr.officeId);
                          setOfficeName(obr.officeName);
                          if (!particulars) setParticulars(obr.particulars);
                          if (!grossAmount) setGrossAmount(obr.unpaidAmount);
                          setEntryTouched(false);
                        }
                      }}
                    />
                    )}
                    {/*
                      While the voucher is still editable, the stored number is
                      shown under the picker as well. An encoder who has just
                      saved should see what was saved, not have to trust that
                      the box they are looking at is reading it back.
                    */}
                    {canEdit && existing?.obrNo && (
                      <p className="mt-1 text-2xs text-slate-500">
                        Saved against{' '}
                        <span className="font-mono text-slate-700">{existing.obrNo}</span>
                      </p>
                    )}
                  </Field>
                )}

                <Field label="Payee" required htmlFor="payee" className="lg:col-span-2">
                  <PayeePicker
                    id="payee"
                    value={payeeId}
                    disabled={!canEdit}
                    allowAdd
                    onChange={(v, p) => {
                      // The TIN and the address are filled by the effect above,
                      // which also covers the payee arriving with an obligation.
                      setPayeeId(v);
                      setPayeeName(severalPayees ? withEtAl(p?.name ?? '') : (p?.name ?? ''));
                      setTinTouched(false);
                      setPayeeAddress('');
                    }}
                  />
                  <div className="mt-1.5">
                    <Checkbox
                      checked={severalPayees}
                      disabled={!canEdit}
                      onChange={(c) => {
                        setSeveralPayees(c);
                        setEntryTouched(false);
                      }}
                      label="Several payees (et al.) - one ADA into each payee's own account"
                    />
                  </div>
                  {severalPayees && payeeName && (
                    <p className="mt-1 text-2xs text-slate-500">
                      Shown as <strong>{payeeName}</strong>. The payees are listed below the amounts.
                    </p>
                  )}
                </Field>

                <Field label="TIN" htmlFor="tin">
                  <TextInput
                    id="tin"
                    value={payeeTin}
                    onChange={(e) => {
                      setTinTouched(true);
                      setPayeeTin(e.target.value);
                    }}
                    disabled={!canEdit}
                    placeholder="000-000-000-000"
                  />
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
                    accountTitle={accountTitle}
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
                    {existing.jevNo ? (
                      <JevLink jevId={existing.jevId} jevNo={existing.jevNo} />
                    ) : (
                      'Not yet posted'
                    )}
                  </DetailField>
                </dl>
              )}
            </Card>

            {severalPayees && (
              <DvPayeesCard
                rows={payeeRows}
                onChange={(r) => {
                  setPayeeRows(r);
                  setEntryTouched(false);
                }}
                netAmount={netAmount}
                readOnly={!canEdit}
                dvId={isNew ? undefined : id}
                dvNo={dvNo}
              />
            )}
          </>
        )}

        {tab === 'entry' && canCorrectEntry && unpostedLines && (
          <Card
            title="Accounting entry"
            subtitle={`Not yet in the General Ledger. Until it is posted the Municipal Accountant may correct the accounts, the budget lines and the particulars. The total stays ${formatPeso(jev?.totalDebit ?? 0)}, the amount the voucher was approved for.`}
            actions={
              <div className="flex gap-2">
                {unpostedDirty && (
                  <Button size="sm" variant="ghost" onClick={() => setUnpostedDirty(false)}>
                    Discard changes
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  loading={savingEntry}
                  disabled={!unpostedDirty || !unpostedCheck.ok}
                  onClick={() => void saveUnpostedEntry()}
                >
                  Save the entry
                </Button>
              </div>
            }
          >
            <JournalEntryGrid
              lines={unpostedLines}
              fundCode={fundCode}
              onChange={(l) => {
                setUnpostedLines(l);
                setUnpostedDirty(true);
              }}
            />
            {!unpostedCheck.ok && (
              <Alert tone="error" className="mt-4" title="The entry does not balance">
                {unpostedCheck.violations[0].message}
              </Alert>
            )}
            {unpostedCheck.ok && unpostedTotal !== (jev?.totalDebit ?? 0) && (
              <Alert tone="warning" className="mt-4" title="The total has changed">
                This entry totals {formatPeso(unpostedTotal)}; the voucher was approved for{' '}
                {formatPeso(jev?.totalDebit ?? 0)}. The save will be refused. A different amount is
                corrected after posting, with Amend on the journal entry.
              </Alert>
            )}
            {unpostedDirty && (
              <p className="mt-3 text-xs text-amber-700">
                Not saved yet. Save the entry before posting it - posting takes the saved entry.
              </p>
            )}
          </Card>
        )}

        {tab === 'entry' && !(canCorrectEntry && unpostedLines) && (
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
              /*
                NOT `!canEdit`. The rest of the voucher is frozen once it is
                submitted; the attachments are not, because the commonest
                reason to replace a scan is that somebody reviewing it found
                it unreadable - which happens after submission. They close
                when an officer closes them.
              */
              readOnly={!can('accounting', 'edit')}
              lockedAt={existing?.attachmentsLockedAt ?? null}
              lockedByName={existing?.attachmentsLockedBy?.name ?? null}
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
              result.reversingJevNo
                ? `The obligation has its balance back, and JEV ${result.reversedJevNo} has been reversed by JEV ${result.reversingJevNo}.`
                : result.cancelledJevNo
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
              balance back.
            </p>
            {existing?.jevPostedAt ? (
              <p className="mt-2">
                <strong>A REVERSING ENTRY IS POSTED</strong>, dated today. JEV{' '}
                <strong className="font-mono">{existing?.jevNo}</strong> stays in the books and a
                second entry undoes it, so the General Ledger carries what was recorded and what
                undid it. Nothing is erased, which is why the journal series has no gap in it.
              </p>
            ) : (
              <p className="mt-2">
                The journal entry prepared from it is cancelled. It never reached the books and
                holds no journal number, so nothing is left out of the series.
              </p>
            )}
            <p className="mt-2">
              It keeps its number, <strong className="font-mono">{existing?.dvNo}</strong>, and
              keeps it reserved, so nobody else can take it while this one is corrected.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Recorded as a critical audit event. The server refuses it once a check or an advice
              has been drawn - undo the payment in Treasury first. The reversal must land in an
              open month, and the server will say so if it does not.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'forward'}
        onCancel={() => setConfirm(null)}
        onConfirm={(remarks) =>
          void run(async () => {
            const result = await engine.forwardDvToTreasury({ dvId: id!, remarks });
            toast.success(
              `DV ${result.dvNo ?? ''} sent to Treasury`.trim(),
              'It is now on Disbursements for Payment.',
            );
          }, 'The voucher was not sent')
        }
        loading={busy}
        title={`Send DV ${existing?.dvNo ?? ''} to Treasury`.trim()}
        confirmLabel="Send to Treasury"
        variant="primary"
        message={
          <>
            <p>
              The voucher appears on <strong>Treasury &gt; Disbursements for Payment</strong>, and
              the Treasurer can draw a check or prepare an advice against it.
            </p>
            <p className="mt-2">
              Nothing about the books changes. It is already recorded as JEV{' '}
              <strong className="font-mono">{existing?.jevNo}</strong>; this is the decision that
              the municipality is ready to pay it.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              A note here is optional and goes into the approval history - useful where the
              voucher has been held for a while and somebody will ask why.
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
              `In the General Ledger as JEV ${result.jevNo}. Send it to Treasury when it is to be paid.`,
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
              , and <strong>posts its journal entry to the General Ledger</strong>. The entry
              takes its JEV number now.
            </p>
            <p className="mt-2">
              It does NOT go to Treasury. The voucher stays here until somebody presses{' '}
              <strong>Send to Treasury</strong>, so a voucher held back for cash or for a
              supplier query can be held without withholding approval from it.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {dvCategory === 'TRUST_LIABILITY'
                ? 'No allotment is consumed: a trust liability settles money the municipality is holding, not an expenditure. That it debits no expense is re-checked on the server.'
                : 'The unpaid balance of the obligation and the state of the accounting period are re-checked on the server.'}{' '}
              The accounting period must be open, which is also re-checked there.
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
  accountTitle,
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
  /** The Chart of Accounts, so a line is named by the account not the tax. */
  accountTitle: (code: string) => string | null;
  disabled?: boolean;
  onChange: (deductions: DeductionLite[]) => void;
}) {
  const toast = useToast();
  const [selectedTaxCode, setSelectedTaxCode] = useState('');

  const addTaxCode = () => {
    const tc = taxCodes.find((t) => t.id === selectedTaxCode);
    if (!tc || !grossAmount) return;
    /*
     * The ACCOUNT's title, from the chart - not `tc.description`.
     *
     * It used to pass the tax code's own description, so a line posted to
     * 20201010 came out named "Expanded withholding tax on goods (1%)" and the
     * next one "Final VAT withholding on goods (5%)". Two titles, one code, in
     * the General Ledger - and neither of them the account's name. Which tax it
     * was travels as the SUBSIDIARY now; see proposeEntry.ts.
     *
     * `accountTitle` reads the loaded Chart of Accounts and falls back to the
     * named list, so an office that has renamed Due to BIR gets its own title
     * rather than ours.
     */
    const computed = computeDeduction(
      tc,
      accountTitle(tc.accountCode) ?? namedAccountTitle(tc.accountCode) ?? '',
      grossAmount,
    );
    if (!computed.accountName) {
      toast.error(
        `Account ${tc.accountCode} is not in the Chart of Accounts`,
        `The tax code "${tc.description}" posts to it. Add the account, or point the tax code at one that exists, before using it on a voucher.`,
      );
      return;
    }
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
