import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { isDirectEntry } from '@/lib/jevSources';
import { UNNUMBERED_JEV, hasJevNumber } from '@/lib/jevNumbers';
import { PageHeader, Card, Alert, Spinner, DetailField, Tabs } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextArea, DateInput, Select } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { JournalEntryGrid, type GridLine } from '@/components/journal/JournalEntryGrid';
import { WorkflowTimeline } from '@/components/WorkflowTimeline';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatInstant, formatLongDate, todayPh } from '@/lib/dates';
import { checkDoubleEntry } from '@/lib/accounting-rules';
import type { JournalEntryVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { useFppOptions } from '@/data/useFppOptions';

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
  const toast = useToast();
  const { fiscalYear, fundCode } = useFilters();
  // The budget lines this entry may be charged to, and which accounts are
  // expenses and therefore need one.
  const { fppOptions, expenseCodes } = useFppOptions(fiscalYear, fundCode);
  const { user, profile, can, hasRole } = useAuth();

  const { data: existing, loading } = useDocument<JournalEntryVoucher>(isNew ? null : COL.jevs, id);

  const [tab, setTab] = useState<'entry' | 'history'>('entry');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'post' | 'reverse'>(null);

  const [jevDate, setJevDate] = useState(todayPh());
  const [sourceType, setSourceType] = useState<string>('MANUAL');
  const [particulars, setParticulars] = useState('');
  const [lines, setLines] = useState<GridLine[]>([
    { lineNo: 1, accountCode: '', accountName: '', debit: 0, credit: 0 },
    { lineNo: 2, accountCode: '', accountName: '', debit: 0, credit: 0 },
  ]);

  useEffect(() => {
    if (!existing) return;
    setJevDate(existing.jevDate);
    setSourceType(existing.sourceType);
    setParticulars(existing.particulars);
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
        subsidiaryName: l.subsidiaryName ?? undefined,
      })),
    );
  }, [existing]);

  const status = existing?.status ?? 'DRAFT';
  const isPosted = status === 'POSTED';
  const editable = isNew || ['DRAFT', 'FOR_REVIEW'].includes(status);
  const canEdit = can('accounting', 'edit') && editable && (isNew || existing?.sourceType !== 'DV');
  const canPost = !isNew && ['DRAFT', 'FOR_REVIEW', 'REVIEWED', 'APPROVED'].includes(status) && hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');
  const canReverse = isPosted && hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT') && !existing?.reversedByJevId;

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
        navigate(`/accounting/others/${newId}`, { replace: true });
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
            : { label: 'Other Transactions', to: '/accounting/others' },
          { label: hasJevNumber(existing?.jevNo) ? (existing?.jevNo as string) : 'New' },
        ]}
        actions={
          <>
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
            {canReverse && (
              <Button variant="danger" onClick={() => setConfirm('reverse')}>
                Reverse
              </Button>
            )}
          </>
        }
      />

      {isPosted && (
        <Alert tone="success" title="Posted to the General Ledger" className="mb-4">
          Posted by {existing?.postedBy?.name} on {formatInstant(existing?.postedAt)}. A posted
          entry cannot be edited or deleted. To correct it, create a reversing entry - both the
          original and the reversal remain in the ledger.
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
          <Link to={`/accounting/others/${existing.reversesJevId}`} className="font-medium underline">
            the original journal entry
          </Link>
          .
        </Alert>
      )}

      {existing?.sourceType === 'DV' && existing.sourceId && (
        <Alert tone="info" className="mb-4">
          Generated from{' '}
          <Link to={`/accounting/disbursements/${existing.sourceId}`} className="font-medium underline">
            DV {existing.referenceNo}
          </Link>
          . Its lines follow the voucher and are not edited here.
        </Alert>
      )}

      <Tabs
        tabs={[
          { id: 'entry', label: 'Entry' },
          { id: 'history', label: 'History' },
        ]}
        active={tab}
        onChange={(t) => setTab(t as typeof tab)}
      />

      <div className="mt-4 space-y-4">
        {tab === 'entry' && (
          <>
            <Card title="Journal entry voucher">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Date" required htmlFor="jevDate">
                  <DateInput id="jevDate" value={jevDate} onChange={setJevDate} disabled={!canEdit} />
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

                <DetailField label="Reference" mono>
                  {existing?.referenceNo ?? '-'}
                </DetailField>

                <DetailField label="Total">{formatPeso(totalDebit)}</DetailField>

                <Field label="Particulars" required htmlFor="particulars" className="sm:col-span-2 lg:col-span-4">
                  <TextArea
                    id="particulars"
                    rows={2}
                    value={particulars}
                    onChange={(e) => setParticulars(e.target.value)}
                    disabled={!canEdit}
                  />
                </Field>
              </div>
            </Card>

            <Card title="Entry">
              <JournalEntryGrid
                lines={lines}
                onChange={setLines}
                fppOptions={fppOptions}
                expenseCodes={expenseCodes}
                readOnly={!canEdit}
              />
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

        {tab === 'history' && (
          <Card title="History">
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
    </div>
  );
}
