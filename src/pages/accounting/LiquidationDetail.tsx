import { useMemo, useState } from 'react';
import { JevLink } from '@/components/JevLink';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { BackButton, ReturnLink, keepReturn } from '@/components/ui/BackButton';
import { PageHeader, Card, Alert, DetailField, Spinner, Tabs } from '@/components/ui/Layout';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { WorkflowTimeline } from '@/components/WorkflowTimeline';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useAccounts, useAttachments } from '@/data/queries';
import { DUE_TO_OFFICERS_AND_EMPLOYEES } from '@/lib/chartOfAccounts';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { attachmentTypesFor } from '@/lib/attachmentTypes';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { Liquidation } from '@/types/accounting';
import { useFilters } from '@/context/FilterContext';
import { useAdvances } from '@/data/useAdvances';
import { LiquidationForm } from './liquidationForm';
import { fundLabel } from '../budget/Obligations';

/**
 * One liquidation report, on a page of its own.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A PAGE
 * ---------------------------------------------------------------------------
 * There was no way to look at a liquidation report at all. It was built in a
 * pop-up, listed in a register, and posted from a button on the row - so the
 * expenses an officer rendered against a cash advance could be read only in
 * the few columns the register had room for, and the signed report had
 * nowhere to live.
 *
 * That last part is the point. A liquidation report is the document an
 * accountable officer signs to account for public money they were given. CFMS
 * held an encoding of it and could not hold the thing itself.
 *
 * The four tabs are the voucher's, deliberately. An accountant moving between
 * a voucher and a liquidation report should not have to learn two screens: the
 * document, the entry it will post, the papers behind it, and who did what.
 */
export default function LiquidationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  /** The report being raised, rather than one being read. */
  const isNew = !id || id === 'new';
  // Patch 177: required to approve and post; counted from the documents.
  const attachedDocs = useAttachments(COL.liquidations, isNew ? null : (id ?? null));
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data: liq, loading } = useDocument<Liquidation>(
    COL.liquidations,
    isNew ? null : id,
  );
  const { fiscalYear, fundCode } = useFilters();
  const advances = useAdvances(fiscalYear, fundCode);
  /* The advance tells the entry which account to relieve. */
  const { data: advance } = useDocument<{ glAccountCode?: string }>(
    COL.cashAdvances,
    liq && liq.advanceSource !== 'LEDGER' ? liq.cashAdvanceId : null,
  );

  const accounts = useAccounts();
  const accountTitle = useMemo(() => {
    const byCode = new Map(accounts.data.map((a) => [a.code, a.name]));
    return (code: string) => byCode.get(code) ?? null;
  }, [accounts.data]);

  const [tab, setTab] = useState<'report' | 'entry' | 'attachments' | 'history'>('report');
  const [confirm, setConfirm] = useState(false);
  /** Patch 135: a saved report is corrected in place until the Accountant approves it. */
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const canPost = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  /**
   * The entry this report will post, as the engine will build it.
   *
   * Shown rather than computed into the posting, because an accountant should
   * see what a document is going to do to the books before doing it. The
   * engine builds its own from the stored figures; this is the same shape.
   */
  const entry = useMemo(() => {
    if (!liq) return [];
    const rows: Array<{ code: string; name: string; debit: number; credit: number }> = [];

    for (const line of liq.lines ?? []) {
      rows.push({ code: line.accountCode, name: line.accountName, debit: line.amount, credit: 0 });
    }

    // Patch 135: no line for a refund - the Treasury posts it with its collections.

    if (liq.reimbursementAmount > 0) {
      rows.push({
        code: DUE_TO_OFFICERS_AND_EMPLOYEES.code,
        name:
          accountTitle(DUE_TO_OFFICERS_AND_EMPLOYEES.code) ?? DUE_TO_OFFICERS_AND_EMPLOYEES.name,
        debit: 0,
        credit: liq.reimbursementAmount,
      });
    }

    /*
     * What the advance is relieved of: what the officer accounted for, plus
     * anything handed back, less anything they are owed. The code comes from
     * the cash advance record, so the title is looked up rather than written
     * out - the same rule the engine follows when it posts this.
     */
    const advanceCode = liq.advanceAccountCode ?? advance?.glAccountCode ?? '';
    rows.push({
      code: advanceCode,
      name: accountTitle(advanceCode) ?? 'the cash advance account',
      debit: 0,
      credit: liq.amountLiquidated - liq.reimbursementAmount,
    });

    return rows;
  }, [liq, advance, accountTitle]);

  if (isNew) {
    return (
      <div>
        <PageHeader
          title="New liquidation report"
          subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
          breadcrumbs={[
            { label: 'Accounting' },
            { label: 'Liquidation Report', to: '/accounting/liquidation' },
            { label: 'New' },
          ]}
          actions={<BackButton list={{ to: '/accounting/liquidation', label: 'Liquidation Reports' }} />}
        />

        {/*
          The four tabs from the start, not after saving.

          The other three cannot do anything yet and say so, which is more
          use than hiding them: the officer filling this in can see that the
          signed report is wanted and where it will go.
        */}
        <Tabs
          tabs={[
            { id: 'report', label: 'Liquidation' },
            { id: 'entry', label: 'Accounting entry' },
            { id: 'attachments', label: 'Supporting documents' },
            { id: 'history', label: 'Approval history' },
          ]}
          active={tab}
          onChange={(t) => setTab(t as typeof tab)}
        />

        <div className="mt-4">
          {tab === 'report' && (
            <LiquidationForm
              fiscalYear={fiscalYear}
              fundCode={fundCode}
              advances={advances.data}
              unassignedCount={advances.unassigned.length}
              onCancel={() => navigate('/accounting/liquidation')}
              onSaved={(newId) =>
                navigate(keepReturn(`/accounting/liquidation/${newId}`, location.search), {
                  replace: true,
                })
              }
            />
          )}

          {tab !== 'report' && (
            <Card>
              <p className="py-8 text-center text-sm text-slate-500">
                {tab === 'entry'
                  ? 'The entry is built from the expense lines. Fill in the report and save it, and this shows what posting will do to the books.'
                  : tab === 'attachments'
                    ? 'Save the report first. The signed liquidation report is filed against a saved record.'
                    : 'Nothing has happened to this report yet.'}
              </p>
            </Card>
          )}
        </div>
      </div>
    );
  }

  if (loading) return <Spinner label="Loading the liquidation report" />;

  if (!liq) {
    return (
      <Alert tone="error" title="Report not found">
        That liquidation report does not exist, or it has been deleted.
      </Alert>
    );
  }

  const posted = liq.status === 'POSTED';
  const editable = ['DRAFT', 'RETURNED'].includes(liq.status) && can('accounting', 'edit');
  const attachmentCount = Math.max(attachedDocs.data.length, liq.attachmentCount ?? 0);

  const post = async () => {
    setBusy(true);
    try {
      const res = await engine.postLiquidation({ liquidationId: liq.id });
      toast.success(
        'Liquidation approved and posted',
        `JEV ${res.jevNo ?? ''} - the expenses are in the General Ledger and the advance is credited. Outstanding balance ${formatPeso(res.outstandingBalance)}.`,
      );
      setConfirm(false);
    } catch (err) {
      toast.error('The report was not posted', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={
          hasDocumentNumber(liq.liquidationNo)
            ? `Liquidation ${liq.liquidationNo}`
            : 'Liquidation report (draft)'
        }
        subtitle={`${liq.accountableOfficerName} - ${fundLabel(liq.fundCode)}, fiscal year ${liq.fiscalYear}`}
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Liquidation Report', to: '/accounting/liquidation' },
          { label: liq.liquidationNo ?? 'Draft' },
        ]}
        actions={
          <>
            {/* Back to the table it was opened from. Patch 114. */}
            <BackButton list={{ to: '/accounting/liquidation', label: 'Liquidation Reports' }} />
            <StatusBadge status={liq.status} className="mr-1" />
            {editable && !editing && (
              <Button
                variant="secondary"
                onClick={() => {
                  setTab('report');
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
            {!posted && canPost && !editing && (
              <Button
                variant="primary"
                disabled={attachmentCount === 0}
                title={
                  attachmentCount === 0
                    ? 'Attach the signed liquidation report first. It is not approved and posted without it.'
                    : undefined
                }
                onClick={() => setConfirm(true)}
              >
                Approve and post
              </Button>
            )}
          </>
        }
      />

      {!posted && liq.jevNo && (
        <Alert tone="info" className="mb-4">
          JEV <JevLink jevId={liq.jevId} jevNo={liq.jevNo} className="font-mono" /> - given when
          the report was saved.
          The entry is posted under this number when the Accountant approves the report.
        </Alert>
      )}

      {!posted && attachmentCount === 0 && (
        <Alert tone="warning" className="mb-4" title="The signed report is not attached">
          A liquidation report is the document an accountable officer signs to account for public
          money they were given. What CFMS holds is an encoding of it; the signed copy is the
          evidence that the encoding is true. It cannot be approved and posted until the signed
          copy is attached.
        </Alert>
      )}

      {posted && (
        <Alert tone="success" className="mb-4">
          Posted to the General Ledger
          {liq.jevId ? (
            <>
              {' '}as{' '}
              <ReturnLink
                to={`/accounting/journal-entries/${liq.jevId}`}
                className="font-medium underline"
              >
                JEV {liq.jevNo ?? 'the entry raised from it'}
              </ReturnLink>
            </>
          ) : null}
          . A posted entry is never edited - while the month is open it can be corrected on the
          entry itself, and after that by a reversing entry.
        </Alert>
      )}

      <Tabs
        tabs={[
          { id: 'report', label: 'Liquidation' },
          { id: 'entry', label: 'Accounting entry' },
          { id: 'attachments', label: 'Supporting documents', count: attachmentCount },
          { id: 'history', label: 'Approval history' },
        ]}
        active={tab}
        onChange={(t) => setTab(t as typeof tab)}
      />

      <div className="mt-4 space-y-4">
        {tab === 'report' && editing && (
          <LiquidationForm
            fiscalYear={liq.fiscalYear}
            fundCode={liq.fundCode}
            advances={advances.data}
            existing={liq}
            onCancel={() => setEditing(false)}
            onSaved={() => setEditing(false)}
          />
        )}

        {tab === 'report' && !editing && (
          <>
            <Card title="The advance being accounted for">
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <DetailField label="Accountable officer">{liq.accountableOfficerName}</DetailField>
                <DetailField label="Office">{liq.officeName}</DetailField>
                <DetailField
                  label={liq.advanceSource === 'LEDGER' ? 'Granted by' : 'Cash advance voucher'}
                  mono
                >
                  {liq.dvNo}
                </DetailField>
                {liq.advanceAccountCode && (
                  <DetailField label="Advance account">
                    <span className="font-mono text-xs">{liq.advanceAccountCode}</span>{' '}
                    {liq.advanceAccountName ?? accountTitle(liq.advanceAccountCode) ?? ''}
                  </DetailField>
                )}
                <DetailField label="Granted">
                  <span className="cbo-amount">{formatPeso(liq.amountGranted)}</span>
                </DetailField>
                <DetailField label="Date granted">{formatShortDate(liq.dateGranted)}</DetailField>
                <DetailField label="Report date">
                  {formatShortDate(liq.liquidationDate)}
                </DetailField>
                <DetailField label="Purpose" className="sm:col-span-2">
                  {liq.purpose}
                </DetailField>
              </dl>
            </Card>

            <Card title={`Expenses rendered (${(liq.lines ?? []).length})`}>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="cbo-th w-10">#</th>
                    <th className="cbo-th w-28">Date</th>
                    <th className="cbo-th">Particulars</th>
                    <th className="cbo-th min-w-[14rem]">Account</th>
                    <th className="cbo-th w-28">OR No.</th>
                    <th className="cbo-th cbo-amount-col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(liq.lines ?? []).map((line) => (
                    <tr key={line.lineNo}>
                      <td className="cbo-td text-center font-mono text-xs text-slate-400">
                        {line.lineNo}
                      </td>
                      <td className="cbo-td text-xs">{formatShortDate(line.date)}</td>
                      <td className="cbo-td">
                        {line.particulars}
                        {line.supplierName && (
                          <span className="block text-xs text-slate-500">{line.supplierName}</span>
                        )}
                      </td>
                      <td className="cbo-td">
                        <span className="font-mono text-xs text-slate-500">{line.accountCode}</span>{' '}
                        <span className="text-xs">{line.accountName}</span>
                      </td>
                      <td className="cbo-td font-mono text-xs">{line.orNumber ?? ''}</td>
                      <td className="cbo-td cbo-amount">
                        {formatPeso(line.amount, { symbol: false })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                    <td className="cbo-td" colSpan={5}>
                      Total liquidated
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(liq.amountLiquidated, { symbol: false })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </Card>

            <Card title="How it settles">
              <dl className="grid gap-4 sm:grid-cols-4">
                <DetailField label="Granted">
                  <span className="cbo-amount">{formatPeso(liq.amountGranted)}</span>
                </DetailField>
                <DetailField label="Liquidated">
                  <span className="cbo-amount">{formatPeso(liq.amountLiquidated)}</span>
                </DetailField>
                <DetailField label={liq.refundAmount > 0 ? 'Refunded by the officer' : 'Refund'}>
                  <span className="cbo-amount">{formatPeso(liq.refundAmount)}</span>
                  {liq.refundAmount > 0 && (
                    <span className="block text-2xs text-slate-500">
                      Posted by the Treasury with its collections, not by this report.
                    </span>
                  )}
                </DetailField>
                <DetailField
                  label={
                    liq.reimbursementAmount > 0 ? 'Owed back to the officer' : 'Reimbursement'
                  }
                >
                  <span className="cbo-amount">{formatPeso(liq.reimbursementAmount)}</span>
                </DetailField>
              </dl>
              {liq.outstandingBalance > 0 && (
                <Alert tone="warning" className="mt-4">
                  {formatPeso(liq.outstandingBalance)} of this advance is still unliquidated. The
                  officer remains accountable for it, and it appears in the ageing of unliquidated
                  cash advances.
                </Alert>
              )}
            </Card>
          </>
        )}

        {tab === 'entry' && (
          <Card
            title={
              posted
                ? `The entry this report posted${liq.jevNo ? ` - JEV ${liq.jevNo}` : ''}`
                : `The entry this report will post${liq.jevNo ? ` - JEV ${liq.jevNo}` : ''}`
            }
          >
            <p className="mb-3 text-xs text-slate-500">
              Each expense is charged to its own account and the advance is credited with what the
              officer accounted for. A cash refund has no line here: the officer pays it to the
              Treasury, and it reaches the books with the Treasury&apos;s collections. The entry is
              given its JEV number when the report is saved, and posted under that number when the
              Accountant approves the report.
            </p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="cbo-th min-w-[18rem]">Account</th>
                  <th className="cbo-th cbo-amount-col">Debit</th>
                  <th className="cbo-th cbo-amount-col">Credit</th>
                </tr>
              </thead>
              <tbody>
                {entry.map((row, i) => (
                  <tr key={i}>
                    <td className="cbo-td">
                      <span className="font-mono text-xs text-slate-500">{row.code}</span>{' '}
                      <span>{row.name}</span>
                    </td>
                    <td className="cbo-td cbo-amount">
                      {row.debit ? formatPeso(row.debit, { symbol: false }) : ''}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {row.credit ? formatPeso(row.credit, { symbol: false }) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {posted && liq.jevId && (
              <p className="mt-3 text-sm">
                <ReturnLink
                  to={`/accounting/journal-entries/${liq.jevId}`}
                  className="font-medium text-brand-700 underline"
                >
                  Open the journal entry as it was posted
                </ReturnLink>
              </p>
            )}
          </Card>
        )}

        {tab === 'attachments' && (
          <Card title="Supporting documents">
            <AttachmentsPanel
              entityType={COL.liquidations}
              allowedTypes={attachmentTypesFor(COL.liquidations)}
              entityId={liq.id}
              entityRef={`Liquidation ${liq.liquidationNo ?? 'draft'}`}
              fiscalYear={liq.fiscalYear}
              fundCode={liq.fundCode}
              storageDocType="LIQUIDATION"
              storageDocId={liq.liquidationNo ?? liq.id}
              readOnly={!can('accounting', 'edit')}
              lockedAt={liq.attachmentsLockedAt ?? null}
              lockedByName={liq.attachmentsLockedBy?.name ?? null}
            />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Approval history">
            <WorkflowTimeline entityType={COL.liquidations} entityId={liq.id} />
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void post()}
        loading={busy}
        title="Approve the liquidation and post it"
        confirmLabel="Approve and post"
        variant="success"
        message={
          <>
            <p>
              Recognises {formatPeso(liq.amountLiquidated)} of expenses
              {liq.reimbursementAmount > 0 &&
                `, and a reimbursement of ${formatPeso(liq.reimbursementAmount)} due to the officer`}
              , and credits the cash advance
              {liq.jevNo ? ` - posted as JEV ${liq.jevNo}, the number it was given on saving.` : '.'}
              {liq.refundAmount > 0 &&
                ` The refund of ${formatPeso(liq.refundAmount)} is not posted here - it reaches the books with the Treasury's collections.`}
            </p>
            {attachmentCount === 0 && (
              <p className="mt-2">
                <strong>Nothing is attached to this report.</strong> The signed liquidation report
                is the evidence behind these figures, and posting is refused without it.
              </p>
            )}
            <p className="mt-2 text-xs text-slate-500">
              A posted entry is never deleted. While the month is open it can be corrected on the
              entry itself; after that, by a reversing entry.
            </p>
          </>
        }
      />
    </div>
  );
}
