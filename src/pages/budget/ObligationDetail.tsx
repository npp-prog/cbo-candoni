import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { BackButton, keepReturn } from '@/components/ui/BackButton';
import clsx from 'clsx';
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
import { withEtAl, withoutEtAl } from '@/lib/accounting-rules';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, OfficePicker, PayeePicker } from '@/components/pickers';
import { BudgetLinePicker } from '@/components/pickers/BudgetLinePicker';
import { WorkflowTimeline } from '@/components/WorkflowTimeline';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { attachmentTypesFor, attachmentsLocked } from '@/lib/attachmentTypes';
import { obligationForm, isTrustFund } from '@/lib/obligationForm';
import { checkFursAgainstProgram } from '@/lib/trustPrograms';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useTrustPrograms, useBudgetBalances, useAttachments } from '@/data/queries';
import { COL } from '@/lib/collections';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { engine, EngineError } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatLongDate, todayPh } from '@/lib/dates';
import { checkObligationAgainstAllotment } from '@/lib/accounting-rules';
import {
  budgetKeyId,
  type Obligation,
  type ObligationLine,
  type TrustProgram,
} from '@/types/budget';
import type { Centavos } from '@/types/common';
import { fundLabel } from './Obligations';

/**
 * The Obligation Request and Status form.
 *
 * The thing worth understanding about this screen is what the running
 * "available allotment" figure beside each line is *for*. It is a courtesy. It
 * comes from `budgetBalances`, read live, and it tells the user in advance
 * whether their obligation will fit - which is genuinely useful, because
 * discovering a shortfall after filling in eight lines is infuriating.
 *
 * But it decides nothing. When Certify is pressed, `certifyObligation` reads
 * those same balances again, server-side, inside the transaction that commits
 * the certification, and makes its own determination. If the figure on screen
 * was four minutes stale, or was edited in a console, the server's answer is
 * what happens. The preview and the decision run the same invariant function -
 * `checkObligationAgainstAllotment` - so they agree in practice while only one
 * of them is trusted.
 */
export default function ObligationDetail() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const location = useLocation();
  /** Patch 136: the FURS is opened from Accounting > Trust Accounts as well. */
  const base = location.pathname.startsWith('/accounting/furs')
    ? '/accounting/furs'
    : '/budget/obligations';
  const toast = useToast();
  const { data: existing, loading } = useDocument<Obligation>(isNew ? null : COL.obligations, id);
  // Patch 180: an existing obligation keeps ITS year and fund (see DV detail).
  const filters = useFilters();
  const fiscalYear = existing?.fiscalYear ?? filters.fiscalYear;
  const fundCode = existing?.fundCode ?? filters.fundCode;
  // OBR in the General and Special Education Funds; FURS in the Trust Fund,
  // where the money is held for somebody else and is not the municipality's
  // own appropriation to obligate.
  const form = obligationForm(fundCode);
  /*
   * The Trust Fund has no appropriation and no allotment, so a utilisation is
   * charged to the programme the money was received under. Everything below
   * that reads "budget line" reads "trust programme" in that fund.
   */
  const trust = isTrustFund(fundCode);
  const { user, profile, can, hasRole, officeScope } = useAuth();

  const balances = useBudgetBalances(fiscalYear, fundCode);
  const trustPrograms = useTrustPrograms(true);

  const [tab, setTab] = useState<'details' | 'attachments' | 'history'>('details');
  const [saving, setSaving] = useState(false);
  const [certifying, setCertifying] = useState(false);
  const [confirmCertify, setConfirmCertify] = useState(false);
  const [confirmUncertify, setConfirmUncertify] = useState(false);
  /**
   * The number the Budget Office assigns, typed in before certifying.
   *
   * CFMS does not generate it. The number on the paper the Head of Office
   * signed is the number this record must carry, and a system that issued its
   * own would quietly keep a second series that disagrees with the office's.
   */
  /**
   * The number the Budget Office assigns, typed in by the staff who encode the
   * draft, following the COA guidelines the office works to.
   *
   * CFMS does not generate it. The number on the paper the Head of Office
   * signs is the number this record must carry, and a system that issued its
   * own would quietly keep a second series that disagrees with the office's.
   *
   * It sits on the DRAFT, not in the certification dialog, because assigning
   * it is the staff's work and certifying is the Budget Officer's. Asking for
   * it at the moment of certification put one officer's job inside the other's
   * dialog box.
   *
   * It is provisional until certified: uniqueness is enforced on the server
   * when the Budget Officer certifies, which is the moment the number is
   * actually spent.
   */
  const [obrNo, setObrNo] = useState('');
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // --- Form state ----------------------------------------------------------

  const [obrDate, setObrDate] = useState(todayPh());
  const [payeeId, setPayeeId] = useState<string | null>(null);
  const [payeeName, setPayeeName] = useState('');
  /**
   * Patch 138: a group request - "Juan Dela Cruz, et al." The obligation is
   * one request against the budget; the list of payees, their accounts and
   * shares is kept on the voucher that pays them.
   */
  const [severalPayees, setSeveralPayees] = useState(false);
  const [payeeTin, setPayeeTin] = useState('');
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [particulars, setParticulars] = useState('');
  const [lines, setLines] = useState<Array<Partial<ObligationLine>>>([
    { lineNo: 1, amount: 0 },
  ]);

  /*
   * Patch 180: copied into the form when the document's CONTENT changes - not
   * when only its attachment count does. Attaching a scan to a draft updated
   * the count, re-ran this copy and threw away everything typed since the
   * last save.
   */
  const syncKey = existing
    ? JSON.stringify({ ...existing, attachmentCount: null, updatedAt: null })
    : '';
  useEffect(() => {
    if (!existing) return;
    setObrDate(existing.obrDate);
    setObrNo(existing.obrNo ?? '');
    setPayeeId(existing.payeeId);
    setPayeeName(existing.payeeName);
    setSeveralPayees(Boolean(existing.severalPayees));
    setPayeeTin(existing.payeeTin ?? '');
    setOfficeId(existing.officeId);
    setOfficeName(existing.officeName);
    setParticulars(existing.particulars);
    setLines(existing.lines?.length ? existing.lines : [{ lineNo: 1, amount: 0 }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  const editable = isNew || ['DRAFT', 'RETURNED'].includes(existing?.status ?? '');
  const canEdit = can('budget', 'edit') && editable;
  const canCertify = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER') && !isNew &&
    ['DRAFT', 'SUBMITTED', 'BUDGET_REVIEWED', 'RETURNED'].includes(existing?.status ?? '');

  /**
   * The Budget Officer may take the certification back so the staff can
   * correct a line, as long as nothing has been committed on it.
   *
   * Offered only while the obligation is OBLIGATED. Once a voucher is approved
   * against it the status moves to WITH DV, which is the server's refusal
   * showing on the screen before anybody presses anything.
   */
  const canUncertify =
    hasRole('SUPER_ADMIN', 'BUDGET_OFFICER') && !isNew && existing?.status === 'OBLIGATED';

  /**
   * Whether anything is attached.
   *
   * Patch 177: no longer a condition of certifying. Read from the documents
   * themselves as well as the counter, because the counter on the obligation
   * cannot be updated by a browser once the obligation has left Draft.
   */
  const attachedDocs = useAttachments(COL.obligations, id ?? null);
  const hasSupportingDocument =
    attachedDocs.data.length > 0 || (existing?.attachmentCount ?? 0) > 0;

  const totalAmount = useMemo(() => lines.reduce((s, l) => s + (l.amount ?? 0), 0), [lines]);

  // --- Live budget availability -------------------------------------------

  /**
   * The budget line an obligation line draws on.
   *
   * Keyed on the FPP, not on the account code. A third of the FY2025 ordinance
   * was appropriated by project with no object of expenditure named, so the
   * account code on THIS line - which the JEV will need - is frequently not
   * the account code the appropriation carries. Matching on it would find no
   * balance for exactly the project lines that have one.
   */
  const balanceFor = (line: Partial<ObligationLine>) => {
    if (!line.officeId || !line.fppCode) return null;
    const key = budgetKeyId({
      fiscalYear,
      fundCode,
      officeId: line.officeId,
      responsibilityCenterId: line.responsibilityCenterId,
      programId: line.programId,
      projectId: line.projectId,
      activityId: line.activityId,
      fppCode: line.fppCode,
      // The appropriated line's own object code, which is empty on a project
      // line - never this obligation line's account code.
      accountCode: line.appropriatedAccountCode ?? '',
    });
    return balances.data.find((b) => b.id === key) ?? null;
  };

  /** Trust Fund: what this FURS already asks of each programme, summed. */
  const trustRequestedByProgram = useMemo(() => {
    const out = new Map<string, number>();
    if (!trust) return out;
    for (const l of lines) {
      if (!l.trustProgramId) continue;
      out.set(l.trustProgramId, (out.get(l.trustProgramId) ?? 0) + (l.amount ?? 0));
    }
    return out;
  }, [trust, lines]);

  const lineChecks = useMemo(
    () =>
      lines.map((line) => {
        if (trust) {
          const program = trustPrograms.data.find((p) => p.id === line.trustProgramId) ?? null;
          if (!program || !line.amount) {
            return { balance: null, program, shortfall: 0, ok: true };
          }

          // Already counted where this FURS is being edited after certification.
          const alreadyCounted =
            existing?.status === 'OBLIGATED'
              ? (existing.lines ?? [])
                  .filter((l) => l.trustProgramId === program.id)
                  .reduce((s, l) => s + l.amount, 0)
              : 0;

          // Every line on this programme, not just this one: two lines that
          // each fit alone can together pass the ceiling, and the server sums
          // them before it reads.
          const requested = trustRequestedByProgram.get(program.id) ?? 0;

          const result = checkFursAgainstProgram({
            programmed: program.programmed,
            alreadyUtilised: program.utilised - alreadyCounted,
            requestedUtilisation: requested,
            status: program.status,
          });

          const details = result.violations[0]?.details as { excess?: number } | undefined;
          return {
            balance: null,
            program,
            shortfall: details?.excess ?? 0,
            ok: result.ok,
          };
        }

        const balance = balanceFor(line);
        if (!balance || !line.amount) return { balance, program: null, shortfall: 0, ok: true };

        // When editing an already-certified obligation the amount is already
        // counted in `obligated`, so it must not be double-counted here.
        const alreadyCounted =
          existing?.status === 'OBLIGATED'
            ? (existing.lines?.find((l) => l.lineNo === line.lineNo)?.amount ?? 0)
            : 0;

        const result = checkObligationAgainstAllotment({
          allotmentReleased: balance.allotmentReleased,
          alreadyObligated: balance.obligated - alreadyCounted,
          requestedObligation: line.amount,
        });

        const details = result.violations[0]?.details as { excess?: number } | undefined;
        return { balance, program: null, shortfall: details?.excess ?? 0, ok: result.ok };
      }),
    [lines, balances.data, existing, trust, trustPrograms.data, trustRequestedByProgram],
  );

  /*
   * A trust shortfall belongs to the PROGRAMME, not to the line.
   *
   * Every line on an over-committed programme reports the same figure, so
   * adding them would tell the officer the FURS is short by three times what
   * it is actually short by.
   */
  const totalShortfall = useMemo(() => {
    if (!trust) return lineChecks.reduce((s, c) => s + c.shortfall, 0);
    const seen = new Map<string, number>();
    for (const c of lineChecks) {
      if (c.program && c.shortfall > 0) seen.set(c.program.id, c.shortfall);
    }
    return [...seen.values()].reduce((s, v) => s + v, 0);
  }, [trust, lineChecks]);
  const hasShortfall = totalShortfall > 0;

  const validationProblems = useMemo(() => {
    const problems: string[] = [];
    if (!payeeId) problems.push('Select a payee.');
    if (!officeId) problems.push('Select the requesting office.');
    if (!particulars.trim()) problems.push('Describe what is being obligated.');
    if (totalAmount <= 0) problems.push('The obligation must be greater than zero.');
    lines.forEach((l, i) => {
      if (!l.accountCode) problems.push(`Line ${i + 1}: select an account.`);
      if (!l.officeId) problems.push(`Line ${i + 1}: select an office.`);
      if (!l.amount || l.amount <= 0) problems.push(`Line ${i + 1}: enter an amount.`);
      if (trust && !l.trustProgramId) {
        problems.push(`Line ${i + 1}: choose the trust programme this utilises.`);
      }
      if (!trust && !l.fppCode) problems.push(`Line ${i + 1}: choose the budget line.`);
    });
    return problems;
  }, [payeeId, officeId, particulars, totalAmount, lines, trust]);

  // --- Actions -------------------------------------------------------------

  const buildPayload = () => ({
    obrDate,
    obrNo: obrNo.trim(),
    fiscalYear,
    fundCode,
    payeeId: payeeId!,
    payeeName: severalPayees ? withEtAl(payeeName) : withoutEtAl(payeeName),
    severalPayees,
    payeeTin: payeeTin || null,
    officeId: officeId!,
    officeName,
    particulars: particulars.trim(),
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      fiscalYear,
      fundCode,
      officeId: l.officeId!,
      officeName: l.officeName ?? officeName,
      responsibilityCenterId: l.responsibilityCenterId ?? null,
      programId: l.programId ?? null,
      projectId: l.projectId ?? null,
      activityId: l.activityId ?? null,
      // Empty in the Trust Fund: there is no appropriated budget line, and an
      // FPP invented to fill the column would put trust spending into the
      // comparison of budget against actual.
      fppCode: l.fppCode ?? '',
      fppName: l.fppName ?? '',
      trustProgramId: l.trustProgramId ?? null,
      trustProgramName: l.trustProgramName ?? null,
      sector: l.sector ?? null,
      serviceSector: l.serviceSector ?? null,
      appropriatedAccountCode: l.appropriatedAccountCode ?? '',
      accountCode: l.accountCode!,
      accountName: l.accountName!,
      expenseClass: l.expenseClass ?? 'MOOE',
      amount: l.amount!,
      particulars: l.particulars ?? null,
    })),
    totalAmount,
    status: 'DRAFT' as const,
    disbursedAmount: 0,
    unpaidAmount: totalAmount,
    attachmentCount: existing?.attachmentCount ?? 0,
  });

  const save = async () => {
    if (validationProblems.length) {
      toast.error('The obligation is incomplete', validationProblems[0]);
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
        const newId = await createDraft(COL.obligations, buildPayload(), actor);
        toast.success('Obligation saved as a draft', `It has no ${form.short} number until it is certified.`);
        navigate(keepReturn(`${base}/${newId}`, location.search), { replace: true });
      } else {
        await updateDraft(COL.obligations, id!, buildPayload(), actor);
        toast.success('Draft saved');
      }
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const uncertify = async (reason: string) => {
    if (!id) return;
    setCertifying(true);
    try {
      const result = await engine.uncertifyObligation({ obligationId: id, reason });
      toast.success(
        `${form.short} ${result.obrNo ?? ''} is a draft again`.trim(),
        result.vouchersDrawingOnIt.length > 0
          ? `The allotment has been released. ${result.vouchersDrawingOnIt.join(', ')} already draws on this obligation - check it still agrees after you correct the lines.`
          : 'The allotment has been released back to the budget line. Correct the lines and certify again.',
      );
      setConfirmUncertify(false);
    } catch (err) {
      toast.error(
        'The certification was not taken back',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setCertifying(false);
    }
  };

  const certify = async (overrideReason?: string) => {
    if (!id) return;
    const assigned = obrNo.trim();
    if (!assigned) {
      toast.error(
        `A ${form.short} number is required`,
        `Assign it on the ${form.short} from the Budget Office book, save the draft, then certify.`,
      );
      return;
    }
    setCertifying(true);
    try {
      const result = await engine.certifyObligation({
        obligationId: id,
        obrNo: assigned,
        ...(overrideReason ? { override: { reason: overrideReason } } : {}),
      });
      toast.success(
        `Certified as ${form.short} ${result.obrNo}`,
        'The allotment has been committed and the obligation can now be drawn against by a disbursement voucher.',
      );
      setConfirmCertify(false);
      setConfirmOverride(false);
    } catch (err) {
      const e = err as EngineError;
      // The engine's message names the line and the shortfall; showing it
      // verbatim is more useful than any paraphrase.
      toast.error('The obligation was not certified', e.message);
      setConfirmCertify(false);
    } finally {
      setCertifying(false);
    }
  };

  const cancel = async (reason?: string) => {
    if (!id || !reason) return;
    try {
      const res = await engine.cancelObligation({ obligationId: id, reason });
      const also = res.cancelledVouchers ?? [];
      toast.success(
        'Obligation cancelled',
        `The committed allotment has been released back to the budget line.${
          also.length
            ? ` ${also.length === 1 ? 'The unfinished voucher' : `${also.length} unfinished vouchers`} drawn on it ${also.length === 1 ? 'was' : 'were'} cancelled with it: ${also.join(', ')}.`
            : ''
        }`,
      );
      setConfirmCancel(false);
    } catch (err) {
      toast.error('Could not cancel', err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <Spinner label="Loading obligation" />;

  const status = existing?.status ?? 'DRAFT';

  return (
    <div>
      <PageHeader
        title={
          existing?.obrNo
            ? `${form.short} ${existing.obrNo}`
            : isNew
              ? `New ${form.short}`
              : `${form.short} (draft)`
        }
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={
          base === '/accounting/furs'
            ? [
                { label: 'Accounting' },
                { label: 'Trust Accounts', to: base },
                { label: existing?.obrNo ?? 'New' },
              ]
            : [
                { label: 'Budget' },
                { label: 'Obligations', to: base },
                { label: existing?.obrNo ?? 'New' },
              ]
        }
        actions={
          <>
            {/* Back to the table it was opened from. Patch 114. */}
            <BackButton
              list={{ to: base, label: base === '/accounting/furs' ? 'FURS' : 'Obligations' }}
            />
            <StatusBadge status={status} className="mr-1" />
            {canEdit && (
              <Button variant="secondary" loading={saving} onClick={() => void save()}>
                Save draft
              </Button>
            )}
            {canCertify && (
              <Button
                variant="primary"
                title={
                  hasSupportingDocument
                    ? undefined
                    : `Nothing is attached yet. It can be certified; attach the approved ${form.short} afterwards.`
                }
                onClick={() => (hasShortfall ? setConfirmOverride(true) : setConfirmCertify(true))}
              >
                Certify
              </Button>
            )}
            {canUncertify && (
              <Button variant="secondary" onClick={() => setConfirmUncertify(true)}>
                Undo certification
              </Button>
            )}
            {!isNew && can('budget', 'cancel') && status !== 'CANCELLED' && (
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                Cancel {form.short}
              </Button>
            )}
          </>
        }
      />

      {existing?.override && (
        <Alert tone="error" title="Certified beyond the available allotment" className="mb-4">
          {formatPeso(existing.override.amountExceeded)} over the allotment available at the time.
          Certified by {existing.override.by.name} on {formatLongDate(existing.override.by.at.slice(0, 10))}.
          <br />
          <span className="italic">&ldquo;{existing.override.reason}&rdquo;</span>
        </Alert>
      )}

      {existing?.status === 'RETURNED' && (
        <Alert tone="warning" title="Returned for correction" className="mb-4">
          {existing.remarks ?? 'Check the approval history for the reason.'}
        </Alert>
      )}

      <Tabs
        tabs={[
          { id: 'details', label: 'Details' },
          { id: 'attachments', label: 'Supporting documents', count: existing?.attachmentCount ?? 0 },
          { id: 'history', label: 'Approval history' },
        ]}
        active={tab}
        onChange={(t) => setTab(t as typeof tab)}
      />

      <div className="mt-4">
        {tab === 'details' && (
          <div className="space-y-4">
            <Card title="Obligation request">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field
                  label={`${form.short} number`}
                  required
                  htmlFor="obrNo"
                  hint="Assigned from the Budget Office book, following the COA guidelines. Checked for a duplicate when the Budget Officer certifies."
                >
                  <TextInput
                    id="obrNo"
                    value={obrNo}
                    onChange={(e) => setObrNo(e.target.value)}
                    disabled={!canEdit}
                    placeholder="100-26-10-0001"
                    className="font-mono"
                  />
                </Field>

                <Field label={`${form.short} date`} required htmlFor="obrDate">
                  <DateInput id="obrDate" value={obrDate} onChange={setObrDate} disabled={!canEdit} />
                </Field>

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
                    }}
                  />
                  <div className="mt-1.5">
                    <Checkbox
                      checked={severalPayees}
                      disabled={!canEdit}
                      onChange={setSeveralPayees}
                      label="Several payees (et al.) - the payees are listed on the voucher"
                    />
                  </div>
                  {severalPayees && payeeName && (
                    <p className="mt-1 text-2xs text-slate-500">
                      Recorded as <strong>{withEtAl(payeeName)}</strong>.
                    </p>
                  )}
                </Field>

                <Field label="TIN" htmlFor="tin">
                  <TextInput
                    id="tin"
                    value={payeeTin}
                    onChange={(e) => setPayeeTin(e.target.value)}
                    disabled={!canEdit}
                    placeholder="000-000-000-000"
                  />
                </Field>

                <Field label="Requesting office" required htmlFor="office" className="lg:col-span-2">
                  <OfficePicker
                    id="office"
                    value={officeId}
                    disabled={!canEdit}
                    restrictTo={officeScope.length ? officeScope : undefined}
                    onChange={(v, o) => {
                      setOfficeId(v);
                      setOfficeName(o?.name ?? '');
                      // Lines usually belong to the requesting office; seed
                      // them so the common case needs no extra typing.
                      setLines((ls) =>
                        ls.map((l) => (l.officeId ? l : { ...l, officeId: v ?? undefined, officeName: o?.name })),
                      );
                    }}
                  />
                </Field>

                <Field label="Particulars" required htmlFor="particulars" className="sm:col-span-2 lg:col-span-4">
                  <TextArea
                    id="particulars"
                    value={particulars}
                    onChange={(e) => setParticulars(e.target.value)}
                    disabled={!canEdit}
                    rows={2}
                    placeholder="What is being obligated, and under what authority."
                  />
                </Field>
              </div>
            </Card>

            <Card
              title={trust ? 'Utilisations of trust programmes' : 'Charges against the budget'}
              subtitle={
                trust
                  ? 'Each line utilises one trust programme. The available figure is what remains of the programmed amount, read live from the register.'
                  : 'Each line is charged against one budget line. The available allotment shown is read live from the budget registry.'
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="cbo-th w-10">#</th>
                      {/*
                        The three pickers each truncate with an ellipsis and
                        show the whole value when opened, so they can give room
                        up. The amount cannot: a figure cut off mid-way is not
                        a smaller figure, it is a wrong one. These minimums are
                        set so the amount and the availability beside it are
                        both whole on an ordinary laptop screen.
                      */}
                      <th className="cbo-th min-w-[11rem]">Office</th>
                      <th className="cbo-th min-w-[15rem]">
                        {trust ? 'Trust programme' : 'Budget line (FPP)'}
                      </th>
                      <th className="cbo-th min-w-[13rem]">Object of expenditure</th>
                      <th className="cbo-th cbo-amount-col">Amount</th>
                      <th className="cbo-th w-44 min-w-[11rem] text-right">
                        {trust ? 'Available to utilise' : 'Available allotment'}
                      </th>
                      {canEdit && <th className="cbo-th w-10" />}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const check = lineChecks[index];
                      return (
                        <tr key={index}>
                          <td className="cbo-td text-center font-mono text-xs text-slate-400">{index + 1}</td>

                          <td className="cbo-td">
                            <OfficePicker
                              value={line.officeId ?? null}
                              disabled={!canEdit}
                              restrictTo={officeScope.length ? officeScope : undefined}
                              onChange={(v, o) =>
                                setLines((ls) =>
                                  ls.map((l, i) =>
                                    i === index ? { ...l, officeId: v ?? undefined, officeName: o?.name } : l,
                                  ),
                                )
                              }
                            />
                          </td>

                          <td className="cbo-td">
                            {trust ? (
                              <Select
                                value={line.trustProgramId ?? ''}
                                disabled={!canEdit}
                                onChange={(e) => {
                                  const chosen = trustPrograms.data.find(
                                    (p) => p.id === e.target.value,
                                  );
                                  setLines((ls) =>
                                    ls.map((l, i) =>
                                      i === index
                                        ? {
                                            ...l,
                                            trustProgramId: chosen?.id,
                                            trustProgramName: chosen?.programName,
                                          }
                                        : l,
                                    ),
                                  );
                                }}
                              >
                                <option value="">Choose a programme&hellip;</option>
                                {trustPrograms.data.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.programCode} — {p.programName}
                                  </option>
                                ))}
                              </Select>
                            ) : (
                            <BudgetLinePicker
                              balances={balances.data}
                              officeId={line.officeId ?? null}
                              disabled={!canEdit}
                              value={
                                balances.data.find(
                                  (b) =>
                                    b.officeId === line.officeId &&
                                    b.fppCode === line.fppCode &&
                                    (b.accountCode || '') === (line.appropriatedAccountCode || ''),
                                )?.id ?? null
                              }
                              onChange={(_, chosen) =>
                                setLines((ls) =>
                                  ls.map((l, i) =>
                                    i === index
                                      ? {
                                          ...l,
                                          fppCode: chosen?.fppCode,
                                          fppName: chosen?.fppName,
                                          sector: chosen?.sector,
                                          serviceSector: chosen?.serviceSector,
                                          appropriatedAccountCode: chosen?.accountCode ?? '',
                                          expenseClass: chosen?.expenseClass ?? l.expenseClass,
                                          // Where the ordinance named the object
                                          // itself, it is also the object being
                                          // committed - so it is filled in, and
                                          // can still be changed.
                                          accountCode: chosen?.accountCode || l.accountCode,
                                          accountName: chosen?.accountCode
                                            ? chosen.accountName
                                            : l.accountName,
                                        }
                                      : l,
                                  ),
                                )
                              }
                            />
                            )}
                          </td>

                          <td className="cbo-td">
                            <AccountPicker
                              value={line.accountCode ?? null}
                              disabled={!canEdit}
                              budgetChargeable
                              onChange={(code, account) =>
                                setLines((ls) =>
                                  ls.map((l, i) =>
                                    i === index
                                      ? { ...l, accountCode: code ?? undefined, accountName: account?.name }
                                      : l,
                                  ),
                                )
                              }
                            />
                          </td>

                          <td className="cbo-td">
                            <AmountInput
                              value={line.amount ?? null}
                              disabled={!canEdit}
                              onChange={(v) =>
                                setLines((ls) => ls.map((l, i) => (i === index ? { ...l, amount: v ?? 0 } : l)))
                              }
                              invalid={!check.ok}
                            />
                          </td>

                          <td className="cbo-td text-right">
                            {trust ? (
                              <TrustAvailabilityCell
                                program={check.program}
                                shortfall={check.shortfall}
                              />
                            ) : (
                              <AvailabilityCell
                                balance={check.balance}
                                shortfall={check.shortfall}
                                ready={Boolean(line.officeId && line.fppCode)}
                              />
                            )}
                          </td>

                          {canEdit && (
                            <td className="cbo-td text-center">
                              <button
                                onClick={() => setLines((ls) => ls.filter((_, i) => i !== index))}
                                disabled={lines.length <= 1}
                                className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30"
                                aria-label={`Remove line ${index + 1}`}
                              >
                                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                  <path
                                    fillRule="evenodd"
                                    d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50">
                      {/*
                        Four, not three: #, Office, Budget line AND Object of
                        expenditure. At three the total was printed in the
                        Object column - one place left of the figures it adds
                        up - and a total that does not sit under its own column
                        is read as belonging to the wrong one.
                      */}
                      <td className="cbo-td font-medium" colSpan={4}>
                        Total obligation
                      </td>
                      <td className="cbo-td cbo-amount font-semibold text-navy-900">
                        {formatPeso(totalAmount, { symbol: false })}
                      </td>
                      <td className="cbo-td" colSpan={canEdit ? 2 : 1} />
                    </tr>
                  </tfoot>
                </table>
              </div>

              {canEdit && (
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() =>
                    setLines((ls) => [
                      ...ls,
                      { lineNo: ls.length + 1, amount: 0, officeId: officeId ?? undefined, officeName },
                    ])
                  }
                >
                  Add line
                </Button>
              )}

              {hasShortfall && (
                <Alert tone="error" className="mt-4" title="Insufficient allotment">
                  This obligation exceeds the available allotment by{' '}
                  <span className="font-mono">{formatPeso(totalShortfall)}</span> across{' '}
                  {lineChecks.filter((c) => c.shortfall > 0).length} line(s). Release additional
                  allotment, realign the budget, or reduce the obligation. Certifying it anyway
                  requires an authorised override with a recorded reason.
                </Alert>
              )}
            </Card>

            {existing && (
              <Card title="Consumption">
                <dl className="grid gap-4 sm:grid-cols-5">
                  <DetailField label="Obligated" mono>
                    {formatPeso(existing.totalAmount)}
                  </DetailField>
                  <DetailField label="With DV" mono>
                    {formatPeso(existing.disbursedAmount ?? 0)}
                  </DetailField>
                  <DetailField label="Paid (check or ADA)" mono>
                    {formatPeso(existing.paidAmount ?? 0)}
                  </DetailField>
                  <DetailField label="Unpaid balance" mono>
                    {formatPeso(existing.totalAmount - (existing.paidAmount ?? 0))}
                  </DetailField>
                  <DetailField label="Certified by">
                    {existing.certifiedBy ? (
                      <>
                        {existing.certifiedBy.name}
                        <span className="block text-xs text-slate-500">
                          {formatLongDate(existing.certifiedAt?.slice(0, 10) ?? '')}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-400">Not yet certified</span>
                    )}
                  </DetailField>
                </dl>
              </Card>
            )}
          </div>
        )}

        {tab === 'attachments' && (
          <Card title="Supporting documents">
            <Alert
              tone={hasSupportingDocument ? 'success' : 'warning'}
              title={`The approved ${form.long} (${form.short})`}
              className="mb-3"
            >
              {hasSupportingDocument
                ? `The ${form.short} is on file.`
                : `Nothing is attached yet. The ${form.short} can be certified without it; attach ` +
                  `the signed and approved ${form.short} here when it is ready. Certifying closes ` +
                  `the papers only when something is attached, so this record stays open for it.`}
            </Alert>
            <AttachmentsPanel
              entityType={COL.obligations}
              allowedTypes={attachmentTypesFor(COL.obligations)}
              entityId={id ?? null}
              entityRef={existing?.obrNo ?? 'Obligation draft'}
              fiscalYear={fiscalYear}
              fundCode={fundCode}
              storageDocType={form.short}
              storageDocId={existing?.obrNo ?? id ?? 'draft'}
              /*
                NOT `!canEdit`. The rest of the form is frozen at submission,
                and the attachments deliberately are not: the commonest reason
                to replace a scan is that Budget found it unreadable while
                reviewing, which is after submission. They are fixed when the
                Budget Officer certifies, because the certificate says the
                officer saw those papers.
              */
              readOnly={!can('budget', 'edit')}
              lockedAt={
                existing?.attachmentsLockedAt ??
                // An obligation certified before patch 78 carries no lock
                // field, and its status is the only record that the papers
                // were seen. Read it the old way as well, so nothing that was
                // closed quietly comes back open.
                // Patch 177: only when something is attached - an obligation may
                // now be certified with nothing on file, and that one is open.
                (attachmentsLocked(existing?.status) && hasSupportingDocument
                  ? (existing?.certifiedAt ?? null)
                  : null)
              }
              lockedByName={
                existing?.attachmentsLockedBy?.name ?? existing?.certifiedBy?.name ?? null
              }
            />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Approval history">
            <WorkflowTimeline entityType={COL.obligations} entityId={id ?? null} />
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirmUncertify}
        onCancel={() => setConfirmUncertify(false)}
        onConfirm={(reason) => {
          if (reason) void uncertify(reason);
        }}
        loading={certifying}
        title={`Undo the certification of ${form.short} ${existing?.obrNo ?? ''}`.trim()}
        confirmLabel="Undo certification"
        variant="danger"
        requireReason
        message={
          <>
            <p>
              <strong>{formatPeso(totalAmount)}</strong> of allotment goes back to the budget
              line and the {form.short} becomes a draft again, so the lines can be corrected and
              certified afresh.
            </p>
            <p className="mt-2">
              It keeps its number, <strong className="font-mono">{existing?.obrNo}</strong>, and
              keeps it reserved - the Budget Office wrote that number in its book against this
              request, and letting another obligation take it while this one is corrected would
              leave the book and CFMS disagreeing about whose it is.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Recorded as a critical audit event, because it reverses a budget control. The server
              will refuse it if the Municipal Accountant has already approved a disbursement
              voucher against this obligation.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirmCertify}
        onCancel={() => setConfirmCertify(false)}
        onConfirm={() => void certify()}
        loading={certifying}
        title="Certify as to availability of allotment"
        confirmLabel="Certify"
        variant="primary"
        message={
          <>
            <p>
              Certifying commits <strong>{formatPeso(totalAmount)}</strong> of allotment to{' '}
              {payeeName} and makes this obligation available for a disbursement voucher.
            </p>
            <p className="mt-2">
              It will be certified as <strong className="font-mono">{obrNo.trim()}</strong>. CFMS
              will refuse that number if it has already been used this year on this fund.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The available allotment will be re-read and re-checked on the server before the
              certification is committed.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirmOverride}
        onCancel={() => setConfirmOverride(false)}
        onConfirm={(reason) => void certify(reason)}
        loading={certifying}
        title="Obligate beyond the available allotment"
        confirmLabel="Override and certify"
        variant="danger"
        requireReason
        minReasonLength={20}
        reasonLabel="Reason for exceeding the available allotment"
        reasonHint={`This is written on the face of the ${form.short}, recorded as a critical audit event, and notified to the Municipal Accountant.`}
        message={
          <>
            <p>
              This obligation exceeds the available allotment by{' '}
              <strong className="font-mono">{formatPeso(totalShortfall)}</strong>.
            </p>
            <p className="mt-2">
              Overriding the budget control is permitted only for an authorised officer and is
              visible to the Commission on Audit. Consider whether a supplemental allotment or a
              realignment is the correct instrument instead.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirmCancel}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={(reason) => void cancel(reason)}
        title={`Cancel ${form.short} ${existing?.obrNo ?? ''}`}
        confirmLabel="Cancel obligation"
        variant="danger"
        requireReason
        message={
          <>
            <p>
              Cancelling releases {formatPeso(existing?.totalAmount ?? 0)} of committed allotment
              back to the budget lines. The obligation is kept with a status of Cancelled; it is
              never deleted.
            </p>
            <p className="mt-2">
              Any disbursement voucher drawn on it that is still a draft, submitted or reviewed is
              cancelled with it, and named afterwards. Nothing has been committed on one of those -
              but a voucher left pointing at a cancelled obligation fails at approval days later,
              with no obvious cause.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The server refuses this once the Municipal Accountant has approved a voucher against
              it. Undo that approval first.
            </p>
          </>
        }
      />
    </div>
  );
}

function AvailabilityCell({
  balance,
  shortfall,
  ready,
}: {
  balance: { allotmentReleased: Centavos; obligated: Centavos; availableAllotment: Centavos } | null;
  shortfall: Centavos;
  ready: boolean;
}) {
  if (!ready) {
    return <span className="text-xs text-slate-400">Select an office and account</span>;
  }
  if (!balance) {
    return (
      <span className="text-xs text-amber-700">
        No allotment released for this line
      </span>
    );
  }

  return (
    <div>
      <span
        className={clsx(
          'block font-mono text-sm tabular',
          shortfall > 0 ? 'text-rose-700' : 'text-navy-900',
        )}
      >
        {formatPeso(balance.availableAllotment, { symbol: false })}
      </span>
      {shortfall > 0 && (
        <span className="block text-2xs text-rose-600">
          short by {formatPeso(shortfall, { symbol: false })}
        </span>
      )}
      <Badge tone="slate" className="mt-0.5">
        released {formatPeso(balance.allotmentReleased, { symbol: false })}
      </Badge>
    </div>
  );
}

/**
 * What remains of a trust programme.
 *
 * The figure shown is the PROGRAMME's, not the line's, and the shortfall is
 * the programme's too - every line charged to an over-committed programme
 * shows the same one. That is deliberate: the ceiling belongs to the
 * programme, and showing a share of it per line would invite somebody to fix
 * one line and think the FURS now fits.
 */
function TrustAvailabilityCell({
  program,
  shortfall,
}: {
  program: TrustProgram | null;
  shortfall: Centavos;
}) {
  if (!program) {
    return <span className="text-xs text-slate-400">Choose a programme</span>;
  }

  if (program.status === 'CLOSED') {
    return <span className="text-xs text-rose-700">This programme is closed</span>;
  }

  return (
    <div>
      <span
        className={clsx(
          'block font-mono text-sm tabular',
          shortfall > 0 ? 'text-rose-700' : 'text-navy-900',
        )}
      >
        {formatPeso(program.availableToUtilise, { symbol: false })}
      </span>
      {shortfall > 0 && (
        <span className="block text-2xs text-rose-600">
          the programme is short by {formatPeso(shortfall, { symbol: false })}
        </span>
      )}
      <Badge tone="slate" className="mt-0.5">
        {formatPeso(program.programmed, { symbol: false })} programmed
      </Badge>
      {program.received < program.utilised && (
        <span className="mt-0.5 block text-2xs text-amber-700">
          utilised beyond what has been received
        </span>
      )}
    </div>
  );
}
