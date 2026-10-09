import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { BackButton, ReturnLink, keepReturn } from '@/components/ui/BackButton';
import { isDirectEntry } from '@/lib/jevSources';
import { UNNUMBERED_JEV, hasJevNumber } from '@/lib/jevNumbers';
import { PageHeader, Card, Alert, Spinner, DetailField, Tabs } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextArea, TextInput, DateInput, Select } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { JournalEntryGrid, type GridLine } from '@/components/journal/JournalEntryGrid';
import { SignedTotalNote } from '@/components/SignedTotalNote';
import { WorkflowTimeline } from '@/components/WorkflowTimeline';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { attachmentTypesFor } from '@/lib/attachmentTypes';
import { useAttachments } from '@/data/queries';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatInstant, formatLongDate, formatShortDate, monthName, todayPh } from '@/lib/dates';
import { checkDoubleEntry } from '@/lib/accounting-rules';
import type { JournalEntryVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/**
 * The Journal Entry Voucher.
 *
 * Posting is the moment a transaction enters the General Ledger, and it is
 * the one act in CFMS that cannot be undone. Everything about this screen
 * follows from that: a posted entry is read-only, the posting button is
 * restricted to the Municipal Accountant, and the only route to a correction
 * is a reversing entry that leaves both the error and the fix visible.
 */

const MANUAL_SOURCE_TYPES = [
  { value: 'MANUAL', label: 'Manual entry' },
  { value: 'ADJUSTING', label: 'Adjusting entry' },
  { value: 'CLOSING', label: 'Closing entry' },
  { value: 'PRIOR_PERIOD', label: 'Prior period adjustment' },
] as const;

export default function JevDetail() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { fiscalYear, fundCode } = useFilters();
  const { user, profile, can, hasRole } = useAuth();

  const { data: existing, loading } = useDocument<JournalEntryVoucher>(isNew ? null : COL.jevs, id);

  const [tab, setTab] = useState<'details' | 'entry' | 'attachments' | 'history'>('details');
  const attachments = useAttachments(COL.jevs, isNew ? null : (id ?? null));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'post' | 'reverse' | 'correct' | 'amend'>(null);
  /** Editing a posted entry in place, rather than only reading it. */
  const [amending, setAmending] = useState(false);

  const [jevDate, setJevDate] = useState(todayPh());
  const [sourceType, setSourceType] = useState<string>('MANUAL');
  const [particulars, setParticulars] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [lines, setLines] = useState<GridLine[]>([
    { lineNo: 1, accountCode: '', accountName: '', debit: 0, credit: 0 },
    { lineNo: 2, accountCode: '', accountName: '', debit: 0, credit: 0 },
  ]);

  useEffect(() => {
    if (!existing) return;
    setJevDate(existing.jevDate);
    setSourceType(existing.sourceType);
    setParticulars(existing.particulars);
    setReferenceNo(existing.referenceNo ?? '');
    setLines(
      (existing.lines ?? []).map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        accountName: l.accountName,
        fppCode: l.fppCode ?? undefined,
        fppName: l.fppName ?? undefined,
        debit: l.debit,
        credit: l.credit,
        particulars: l.particulars ?? undefined,
        // Patch 145: the subsidiary's type and id, not only its name - without
        // them the picker showed "None" and saving dropped the subsidiary.
        subsidiaryType: l.subsidiaryType ?? undefined,
        subsidiaryId: l.subsidiaryId ?? undefined,
        subsidiaryName: l.subsidiaryName ?? undefined,
      })),
    );
  }, [existing]);

  const status = existing?.status ?? 'DRAFT';
  const isPosted = status === 'POSTED';
  /*
   * An entry is editable until the ledger takes it.
   *
   * APPROVED is in the list. The voucher behind it may be approved and even
   * paid - none of that has written the books, and until the Accountant posts,
   * the entry is still a proposal. Taking the right to correct it away at
   * approval only meant the correction was made later, as a reversing entry
   * against a figure that should never have been in the ledger at all.
   *
   * But an APPROVED entry is the Accountant's: an encoder may not reopen a
   * figure the Accountant has already passed. The security rules say the same,
   * so a button offered here is a write the server will accept.
   */
  const editable = isNew || ['DRAFT', 'FOR_REVIEW', 'APPROVED'].includes(status);
  const isAccountant = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');
  const mayEditAtThisStage = status !== 'APPROVED' || isAccountant;
  const canEdit =
    can('accounting', 'edit') &&
    editable &&
    mayEditAtThisStage &&
    (isNew || existing?.sourceType !== 'DV');
  const canPost = !isNew && ['DRAFT', 'FOR_REVIEW', 'REVIEWED', 'APPROVED'].includes(status) && hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');
  const canReverse = isPosted && isAccountant && !existing?.reversedByJevId;
  /** Reverse it AND open a corrected copy - one act instead of three. */
  const canCorrect = canReverse;

  /*
   * Correcting a POSTED entry in place, while its month is still open.
   *
   * The screen offers it; the server decides. It is the server that knows
   * whether the period and the fiscal year are open, and a browser that
   * guessed would either hide the button on an open month or offer it on a
   * closed one. So the button is shown to the Accountant on any posted entry
   * and a closed month comes back as a refusal naming the month.
   */
  const canAmend = isPosted && isAccountant && !existing?.reversedByJevId;


  const check = useMemo(
    () =>
      checkDoubleEntry(
        lines.map((l) => ({
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
        })),
      ),
    [lines],
  );

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);

  /**
   * The amount the source document was signed for.
   *
   * ---------------------------------------------------------------------------
   * IT USED TO BE A LOCK, AND IS NOW A BASELINE
   * ---------------------------------------------------------------------------
   * On an entry raised by a voucher or a certified treasury report, the total
   * is a figure another officer signed, and CFMS used to refuse a correction
   * that changed it. The Municipal Accountant asked for the amount to be
   * correctable like everything else, so it is - and what takes the refusal's
   * place is that the disagreement is recorded on the entry, shown on the
   * document, and written to the audit trail as a CRITICAL event until the
   * entry is brought back.
   *
   * `signedTotal` is written by the engine the FIRST time an entry diverges
   * and is never overwritten, so a second correction is still measured against
   * the paper rather than against the first correction.
   */
  const signedTotal =
    existing && !isDirectEntry(existing.sourceType)
      ? (existing.signedTotal ?? existing.totalDebit ?? 0)
      : null;
  /** Diverging as a result of what is on screen right now. */
  const totalWillDiverge = signedTotal !== null && amending && totalDebit !== signedTotal;
  /** Diverging as the books stand, with nothing being edited. */
  const totalHasDiverged =
    !amending && existing != null && (existing.signedTotal ?? null) !== null;

  const save = async () => {
    if (!particulars.trim()) {
      toast.error('Incomplete', 'Describe what this entry records.');
      return;
    }
    if (!check.ok) {
      toast.error('The entry does not balance', check.violations[0].message);
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

      const payload = {
        jevDate,
        fiscalYear,
        period: Number(jevDate.slice(5, 7)),
        fundCode,
        book: 'GENERAL_JOURNAL',
        sourceType,
        referenceNo: referenceNo.trim() || null,
        particulars: particulars.trim(),
        lines: lines.map((l, i) => ({
          lineNo: i + 1,
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
        totalDebit,
        totalCredit: totalDebit,
        status: 'DRAFT' as const,
      };

      if (isNew) {
        // A manual JEV has no number until it is posted; the number is drawn
        // in the posting transaction so a discarded draft never consumes one.
        // The engine gives the entry its number when it is posted; the rules
        // forbid the browser to touch `jevNo` at all, which is what keeps that
        // true. The placeholder is the agreed word for "none yet".
        const newId = await createDraft(COL.jevs, { ...payload, jevNo: UNNUMBERED_JEV }, actor);
        toast.success('Journal entry saved as a draft');
        navigate(keepReturn(`/accounting/general-transactions/${newId}`, location.search), { replace: true });
      } else {
        await updateDraft(COL.jevs, id!, payload, actor);
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

  if (loading) return <Spinner label="Loading journal entry" />;

  return (
    <div>
      <PageHeader
        title={hasJevNumber(existing?.jevNo) ? `JEV ${existing?.jevNo}` : 'Journal entry (not yet posted)'}
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[
          { label: 'Accounting' },
          // An entry raised by a voucher or a treasury report is not an "other
          // transaction", and sending the reader back there from one would be
          // sending them to a screen that no longer lists it.
          existing && !isDirectEntry(existing.sourceType)
            ? { label: 'Journal Entries Register', to: '/accounting/journal-entries' }
            : { label: 'General Transactions', to: '/accounting/general-transactions' },
          { label: hasJevNumber(existing?.jevNo) ? (existing?.jevNo as string) : 'New' },
        ]}
        actions={
          <>
            {/*
              Back to the table it was opened from. Patch 114. Its own list is
              the one the breadcrumb names: the register for an entry raised
              by a voucher or a report, General Transactions for one typed.
            */}
            <BackButton
              list={
                existing && !isDirectEntry(existing.sourceType)
                  ? { to: '/accounting/journal-entries', label: 'Journal Entries Register' }
                  : { to: '/accounting/general-transactions', label: 'General Transactions' }
              }
            />
            <StatusBadge status={status} className="mr-1" />
            {canEdit && (
              <Button loading={saving} onClick={() => void save()}>
                Save draft
              </Button>
            )}
            {canPost && (
              <Button variant="primary" onClick={() => setConfirm('post')} disabled={!check.ok}>
                Post to General Ledger
              </Button>
            )}
            {/* Offered only once the entry is in the books. A printed voucher
                for an entry that is not posted says the municipality recorded
                something it has not recorded. */}
            {!isNew && isPosted && (
              <Button variant="secondary" onClick={() => navigate(`/accounting/jev/${id}/print`)}>
                Print JEV
              </Button>
            )}
            {canAmend && !amending && (
              <Button variant="primary" onClick={() => setAmending(true)}>
                Correct this entry
              </Button>
            )}
            {amending && (
              <>
                <Button
                  variant="primary"
                  onClick={() => setConfirm('amend')}
                  disabled={!check.ok}
                >
                  Save the correction
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAmending(false);
                    // Put back what is in the books, so an abandoned
                    // correction leaves nothing half-typed on screen.
                    if (existing) {
                      setJevDate(existing.jevDate);
                      setParticulars(existing.particulars);
                      setReferenceNo(existing.referenceNo ?? '');
                      setLines(
                        existing.lines.map((l) => ({
                          lineNo: l.lineNo,
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
                    }
                  }}
                >
                  Cancel
                </Button>
              </>
            )}
            {canCorrect && !amending && (
              <Button variant="secondary" onClick={() => setConfirm('correct')}>
                Reverse and copy
              </Button>
            )}
            {canReverse && (
              <Button variant="danger" onClick={() => setConfirm('reverse')}>
                Reverse
              </Button>
            )}
          </>
        }
      />

      {amending && (
        <Alert tone="warning" title="Correcting an entry that is in the books" className="mb-4">
          <p>
            Saving this rewrites the ledger lines for JEV {existing?.jevNo} in place - what the
            General Ledger, the Trial Balance and the financial statements show for this entry
            changes with it. No reversing entry is made.
          </p>
          <p className="mt-2">
            CFMS allows this only while {existing?.period ? monthName(existing.period) : 'the month'}{' '}
            is still open. Once the month is closed the only correction is a reversing entry, and
            the server will say so.
          </p>
          {signedTotal !== null && (
            <p className="mt-2">
              This entry was raised by{' '}
              {existing?.referenceNo ? `${existing.sourceType} ${existing.referenceNo}` : 'a document'},
              which another officer signed for <strong>{formatPeso(signedTotal)}</strong>. You may
              change the amount; if you do, the entry and that document will no longer agree, and
              both will say so until one of them is put right.
            </p>
          )}
          <p className="mt-2">
            What cannot change is which document this entry came from. Its date, particulars,
            accounts and amounts are all yours.
          </p>
        </Alert>
      )}

      {totalWillDiverge && (
        <Alert tone="warning" title="This will leave the entry disagreeing with its document" className="mb-4">
          <p>
            {existing?.referenceNo ? `${existing.sourceType} ${existing.referenceNo}` : 'The document behind this entry'}{' '}
            was signed for <strong>{formatPeso(signedTotal ?? 0)}</strong>. Saving puts{' '}
            <strong>{formatPeso(totalDebit)}</strong> in the books.
          </p>
          <p className="mt-2">
            CFMS will not stop you, and it will not keep it quiet either: the entry and the
            document both carry a standing note while they disagree, and the correction goes to
            the audit trail as a critical event naming both figures. It clears the moment the
            entry is brought back to {formatPeso(signedTotal ?? 0)}.
          </p>
          <p className="mt-2">
            The other way round is still open to you - undo the approval on the document, correct
            it, approve it again - and nothing disagrees with anything.
          </p>
        </Alert>
      )}

      {totalHasDiverged && <SignedTotalNote jev={existing} from="entry" />}

      {!amending && (existing?.corrections?.length ?? 0) > 0 && (
        <Alert
          tone="warning"
          title={`Corrected ${existing?.corrections?.length === 1 ? 'once' : `${existing?.corrections?.length} times`} after posting`}
          className="mb-4"
        >
          <ul className="space-y-1.5">
            {existing?.corrections?.map((c, i) => (
              <li key={i}>
                <span className="font-medium">{c.by?.name ?? 'Someone'}</span> on{' '}
                {formatInstant(c.at)} - {c.reason}
                <span className="block text-xs opacity-80">
                  was dated {formatShortDate(c.previous?.jevDate ?? '')}, for{' '}
                  {formatPeso(c.previous?.totalDebit ?? 0)} across {c.previous?.lineCount ?? 0}{' '}
                  {c.previous?.lineCount === 1 ? 'line' : 'lines'}
                </span>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {isPosted && !amending && (
        <Alert tone="success" title="Posted to the General Ledger" className="mb-4">
          Posted by {existing?.postedBy?.name} on {formatInstant(existing?.postedAt)}. A posted
          entry is never edited or deleted - the ledger is evidence of what was posted, and an
          entry that could be rewritten afterwards would not be.{' '}
          {canCorrect
            ? 'Correct this entry reverses it and opens an editable copy, so the books carry the mistake, the reversal and the correction.'
            : 'It is corrected by reversing it and posting a replacement.'}
        </Alert>
      )}

      {status === 'APPROVED' && !isPosted && (
        <Alert tone="warning" title="Approved, and not yet in the General Ledger" className="mb-4">
          {isAccountant
            ? 'It can still be corrected from here. Once it is posted it cannot, because the ledger will have taken it.'
            : 'Only the Municipal Accountant may change it at this stage.'}
        </Alert>
      )}

      {existing?.reversedByJevId && (
        <Alert tone="warning" title="This entry has been reversed" className="mb-4">
          {existing.remarks}
        </Alert>
      )}

      {existing?.reversesJevId && (
        <Alert tone="info" className="mb-4">
          This is a reversing entry. It mirrors{' '}
          <ReturnLink to={`/accounting/general-transactions/${existing.reversesJevId}`} className="font-medium underline">
            the original journal entry
          </ReturnLink>
          .
        </Alert>
      )}

      {existing?.sourceType === 'DV' && existing.sourceId && (
        <Alert tone="info" className="mb-4">
          Generated from{' '}
          <ReturnLink to={`/accounting/disbursements/${existing.sourceId}`} className="font-medium underline">
            DV {existing.referenceNo}
          </ReturnLink>
          . Its lines follow the voucher and are not edited here.
        </Alert>
      )}

      {/*
        The voucher's four tabs, so an accountant moving between a
        disbursement voucher and a journal entry does not have to learn two
        screens: the document, the entry, the papers behind it, and who did
        what.
      */}
      <Tabs
        tabs={[
          { id: 'details', label: 'General transaction' },
          { id: 'entry', label: 'Accounting entry' },
          {
            id: 'attachments',
            label: 'Supporting documents',
            /*
             * Counted from the attachments themselves, not from a counter on
             * the entry. A posted entry cannot be written by the browser at
             * all - that is the rule that makes the ledger evidence - so a
             * stored count would stop moving the moment the entry was posted
             * and the tab would quietly show the wrong number for ever.
             */
            count: attachments.data.length,
          },
          { id: 'history', label: 'Approval history' },
        ]}
        active={tab}
        onChange={(t) => setTab(t as typeof tab)}
      />

      <div className="mt-4 space-y-4">
        {tab === 'details' && (
          <>
            <Card title="Journal entry voucher">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Date" required htmlFor="jevDate">
                  <DateInput
                    id="jevDate"
                    value={jevDate}
                    onChange={setJevDate}
                    disabled={!canEdit && !amending}
                  />
                </Field>

                <Field label="Type" htmlFor="sourceType">
                  {canEdit && isNew ? (
                    <Select id="sourceType" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                      {MANUAL_SOURCE_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p className="pt-2 text-sm text-navy-900">
                      {MANUAL_SOURCE_TYPES.find((t) => t.value === sourceType)?.label ?? sourceType}
                    </p>
                  )}
                </Field>

                {/*
                  The office's OWN reference, not the JEV number.
                  
                  An adjusting entry usually answers to a piece of paper that
                  CFMS never saw - the JV number in the Accountant's book, a
                  memorandum, a bank debit advice. Writing it here is what lets
                  somebody holding that paper find the entry, and somebody
                  reading the entry find the paper. The JEV number is a
                  different thing: it is the entry's place in the journal, and
                  it is drawn from the series when the entry is posted.
                */}
                <Field label="Reference" htmlFor="referenceNo" hint="Your own JV or memo number.">
                  {canEdit ? (
                    <TextInput
                      id="referenceNo"
                      value={referenceNo}
                      onChange={(e) => setReferenceNo(e.target.value)}
                      placeholder="Optional"
                      className="font-mono"
                    />
                  ) : (
                    <p className="pt-2 font-mono text-sm text-navy-900">
                      {existing?.referenceNo || '-'}
                    </p>
                  )}
                </Field>

                <DetailField label="Total">{formatPeso(totalDebit)}</DetailField>

                <Field label="Particulars" required htmlFor="particulars" className="sm:col-span-2 lg:col-span-4">
                  <TextArea
                    id="particulars"
                    rows={2}
                    value={particulars}
                    onChange={(e) => setParticulars(e.target.value)}
                    disabled={!canEdit && !amending}
                  />
                </Field>
              </div>
            </Card>

            {(existing?.createdBy || existing?.postedBy) && (
              <Card title="Certification">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <DetailField label="Prepared by">
                    {existing?.createdBy?.name}
                    {existing?.createdBy?.at && (
                      <span className="block text-xs text-slate-500">
                        {formatLongDate(existing.createdBy.at.slice(0, 10))}
                      </span>
                    )}
                  </DetailField>
                  <DetailField label="Reviewed by">{existing?.reviewedBy?.name ?? '-'}</DetailField>
                  <DetailField label="Posted by">
                    {existing?.postedBy?.name ?? '-'}
                    {existing?.postedAt && (
                      <span className="block text-xs text-slate-500">{formatInstant(existing.postedAt)}</span>
                    )}
                  </DetailField>
                </dl>
              </Card>
            )}
          </>
        )}

        {tab === 'entry' && (
          <Card title="Accounting entry">
            <JournalEntryGrid
              lines={lines}
              onChange={setLines}
              fundCode={fundCode}
              readOnly={!canEdit && !amending}
            />
          </Card>
        )}

        {tab === 'attachments' && (
          <Card title="Supporting documents">
            {isNew ? (
              <p className="py-6 text-center text-sm text-slate-500">
                Save the entry first. Attachments are filed against a saved record.
              </p>
            ) : (
              <>
                <p className="mb-4 text-xs text-slate-500">
                  Not required. An adjusting entry often has nothing behind it but the Accountant's
                  judgement, and a box demanding a file would only produce empty ones. Where there
                  IS a paper - a memorandum, a bank debit advice, the office's own journal voucher
                  - this is where it belongs.
                </p>
                <AttachmentsPanel
                  entityType={COL.jevs}
                  allowedTypes={attachmentTypesFor(COL.jevs)}
                  entityId={id ?? null}
                  entityRef={
                    hasJevNumber(existing?.jevNo) ? `JEV ${existing?.jevNo}` : 'Journal entry'
                  }
                  fiscalYear={fiscalYear}
                  fundCode={fundCode}
                  storageDocType="JEV"
                  storageDocId={hasJevNumber(existing?.jevNo) ? (existing?.jevNo as string) : (id ?? 'draft')}
                  readOnly={!can('accounting', 'edit')}
                />
              </>
            )}
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Approval history">
            <WorkflowTimeline entityType={COL.jevs} entityId={id ?? null} />
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'post'}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          void run(async () => {
            const result = await engine.postJev({ jevId: id! });
            toast.success(
              `Posted as JEV ${result.jevNo}`,
              `${result.ledgerEntryCount} ledger entries written. This entry can no longer be edited.`,
            );
          }, 'The entry was not posted')
        }
        loading={busy}
        title="Post to the General Ledger"
        confirmLabel="Post"
        variant="primary"
        message={
          <>
            <p>
              Posting writes {lines.length} entries totalling{' '}
              <strong>{formatPeso(totalDebit)}</strong> to the General Ledger for{' '}
              {fundLabel(fundCode)}.
            </p>
            <p className="mt-2">
              This cannot be undone. A posted entry is immutable; correcting it later means
              creating a reversing entry, and both will remain visible in the books.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The balance and the state of the accounting period are re-checked on the server
              before anything is written.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'reverse'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) =>
          void run(async () => {
            const result = await engine.reverseJev({ jevId: id!, reason: reason! });
            toast.success(
              `Reversed by JEV ${result.reversingJevNo}`,
              'A mirror-image entry has been posted. Both entries remain in the General Ledger.',
            );
          }, 'The entry was not reversed')
        }
        loading={busy}
        title={`Reverse JEV ${existing?.jevNo ?? ''}`}
        confirmLabel="Reverse"
        variant="danger"
        requireReason
        minReasonLength={15}
        reasonLabel="Reason for the reversal"
        reasonHint="Printed on the face of the reversing entry, recorded as a critical audit event, and visible to COA."
        message={
          <>
            <p>
              A new journal entry will be created with the debits and credits of this one
              exchanged, and posted immediately - dated today, so a closed month stays closed.
            </p>
            <p className="mt-2">
              The original entry is not deleted or altered. Both remain in the General Ledger, so
              the books show what happened and how it was corrected.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'amend'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) =>
          void run(async () => {
            const result = await engine.amendPostedJev({
              jevId: id!,
              jevDate,
              particulars: particulars.trim(),
              lines: lines.map((l, i) => ({
                lineNo: i + 1,
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
              reason: reason!,
            });
            setAmending(false);
            toast.success(
              `JEV ${result.jevNo} corrected`,
              `${result.replaced} ledger ${result.replaced === 1 ? 'line' : 'lines'} replaced with ${result.ledgerEntryCount}. The General Ledger now shows the corrected entry.`,
            );
          }, 'The entry was not corrected')
        }
        loading={busy}
        title={`Correct JEV ${existing?.jevNo ?? ''}`}
        confirmLabel="Rewrite the ledger"
        variant="danger"
        requireReason
        minReasonLength={15}
        reasonLabel="What was wrong with it"
        reasonHint="Recorded against the entry, shown on this screen afterwards, and recorded as a critical audit event."
        message={
          <>
            <p>
              The ledger lines for this entry are replaced with what is on screen. The General
              Ledger, the Trial Balance and every report drawn from them change with it, and no
              reversing entry is made.
            </p>
            <p className="mt-2">
              This is allowed because{' '}
              {existing?.period ? monthName(existing.period) : 'the month'} is still open. The
              correction and what the entry said before it are kept on the entry itself, so an
              auditor reading this voucher can see that it was changed, by whom, and why.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              If the server finds the month closed it will refuse and say so. From that point the
              correction is a reversing entry.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'correct'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) =>
          void run(async () => {
            const result = await engine.correctJev({ jevId: id!, reason: reason! });
            toast.success(
              `Reversed by JEV ${result.reversingJevNo}`,
              'A copy has been opened for correcting. Post it when the figures are right.',
            );
            navigate(keepReturn(`/accounting/journal-entries/${result.correctedJevId}`, location.search));
          }, 'The entry was not corrected')
        }
        loading={busy}
        title={`Correct JEV ${existing?.jevNo ?? ''}`}
        confirmLabel="Reverse and open a copy"
        variant="danger"
        requireReason
        minReasonLength={15}
        reasonLabel="What is wrong with it"
        reasonHint="Printed on the face of the reversing entry, recorded as a critical audit event, and visible to COA."
        message={
          <>
            <p>Three things happen, in one act:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              <li>This entry is reversed in the General Ledger, dated today.</li>
              <li>It is marked Reversed and points at the entry that reversed it.</li>
              <li>A draft copy of it opens, with the same lines, for you to correct and post.</li>
            </ol>
            <p className="mt-2">
              The books end up carrying the mistake, the reversal and the corrected entry. That is
              what the standard asks for, and what an auditor expects to find - a ledger that can
              be quietly rewritten is not evidence of anything.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The correction is dated today and refused if this month is closed. Posting it into a
              month that has been reported on is a deliberate act of its own.
            </p>
          </>
        }
      />
    </div>
  );
}
