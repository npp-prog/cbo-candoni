import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader, Card, Alert, Tabs, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { BackButton, useOpenWithReturn } from '@/components/ui/BackButton';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import {
  useAppropriations,
  useAttachments,
  useAugmentationDrafts,
  useBudgetBalances,
  useObligations,
} from '@/data/queries';
import { useEntity } from '@/data/useEntity';
import { actorStamp, deleteDraft, deleteDrafts } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { attachmentTypesFor } from '@/lib/attachmentTypes';
import { appropriationEditable, augmentationDraftEditable } from '@/lib/budgetEditable';
import { formatPeso } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { Appropriation, AugmentationDraft, Ordinance } from '@/types/budget';
import { AppropriationForm } from './Appropriations';
import { fundLabel } from './Obligations';
import { ORDINANCE_KINDS, STAGE_LABELS, slugReference, summariseOrdinance } from './ordinanceModel';
import { buildLbpForm2, type Form2Sheet } from './lbpForm2';
import { LbpForm2Sheet, usePrintForm2 } from './LbpForm2Sheet';

/**
 * One ordinance, opened. Patch 119.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF THINGS
 * ---------------------------------------------------------------------------
 *   1. The ordinance is RECORDED - its kind, number and date.
 *   2. Its LINES are recorded inside it, typed one at a time or uploaded from
 *      the annex, and the scanned ordinance is attached under Supporting
 *      documents.
 *   3. It is PRINTED on LBP Form No. 2, one page per office, for signature.
 *   4. It is APPROVED, whole, and becomes authority available for allotment.
 *
 * A REALIGNMENT ordinance differs in step 2: its lines are prepared as one
 * set that must come to zero, and step 4 posts that set. Its positive side is
 * what LBP Form No. 2 shows; the side it took from is on LBP Form No. 8.
 */
export default function OrdinanceDetail() {
  const { id } = useParams<{ id: string }>();
  const { fiscalYear, fundCode } = useFilters();
  const { can, hasRole, user, profile } = useAuth();
  const toast = useToast();
  const entity = useEntity();
  const open = useOpenWithReturn();

  const ordinanceDoc = useDocument<Ordinance>(COL.ordinances, id ?? null);
  const ordinance = useMemo<Ordinance | null>(
    () => (ordinanceDoc.data && id ? { ...ordinanceDoc.data, id } : null),
    [ordinanceDoc.data, id],
  );
  /* The year and fund are the ORDINANCE's, whatever the header filters say. */
  const fy = ordinance?.fiscalYear ?? fiscalYear;
  const fund = ordinance?.fundCode ?? fundCode;

  const appropriations = useAppropriations(fy, fund);
  const sets = useAugmentationDrafts(fy, fund);
  const attachments = useAttachments(COL.ordinances, id ?? null);
  /* The two years before, for columns 3 to 6 of LBP Form No. 2. */
  const pastYear = useObligations(fy - 2, fund);
  const currentYear = useObligations(fy - 1, fund);
  const currentBalances = useBudgetBalances(fy - 1, fund);

  const summary = useMemo(
    () => (ordinance ? summariseOrdinance(ordinance, appropriations.data, sets.data) : null),
    [ordinance, appropriations.data, sets.data],
  );

  const [tab, setTab] = useState<'lines' | 'attachments'>('lines');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Appropriation | null>(null);
  const [editingSet, setEditingSet] = useState<AugmentationDraft | null>(null);
  const [confirm, setConfirm] = useState<
    'approve' | 'discard' | 'approveSet' | 'discardSet' | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<Form2Sheet | null>(null);
  const clearSheet = useCallback(() => setSheet(null), []);
  usePrintForm2(sheet, clearSheet);

  const actor = user
    ? actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      })
    : null;

  const canRecord = can('budget', 'create');
  const canApprove = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER');

  if (ordinanceDoc.loading) return <Spinner label="Loading the ordinance" />;
  if (!ordinance || !summary) {
    return (
      <div>
        <PageHeader
          title="Ordinance not found"
          breadcrumbs={[
            { label: 'Budget' },
            { label: 'Ordinances', to: '/budget/appropriations/ordinances' },
          ]}
        />
        <Alert tone="warning">
          There is no ordinance under this address. It may have been deleted.
        </Alert>
      </div>
    );
  }

  const realign = ordinance.kind === 'REALIGNMENT';
  const kindLabel =
    ORDINANCE_KINDS.find((k) => k.value === ordinance.kind)?.label.split(' - ')[0] ??
    ordinance.kind;
  const drafts = summary.lines.filter((l) => l.status === 'DRAFT');
  const waitingSet = summary.sets.find((s) => augmentationDraftEditable(s)) ?? null;

  /** LBP Form No. 2 from every line the ordinance has - approved, draft, or prepared. */
  const print = () => {
    const lines = [
      ...summary.lines.map((l) => ({
        officeId: l.officeId,
        officeName: l.officeName,
        accountCode: l.accountCode,
        accountName: l.accountName,
        fppCode: l.fppCode,
        fppName: l.fppName,
        sector: l.sector,
        expenseClass: l.expenseClass,
        amount: l.amount,
      })),
      ...summary.sets.flatMap((s) =>
        (s.lines ?? []).map((l) => ({
          officeId: l.officeId ?? l.officeName,
          officeName: l.officeName,
          accountCode: l.accountCode,
          accountName: l.accountName,
          fppCode: l.fppCode,
          fppName: l.fppName,
          sector: l.sector,
          expenseClass: l.expenseClass,
          amount: l.amount,
        })),
      ),
    ];
    setSheet(
      buildLbpForm2({
        budgetYear: fy,
        lgu: entity.headingLines[1] ?? '',
        headingLines: entity.headingLines,
        reference: ordinance.reference,
        kindLabel,
        prepared: summary.stage !== 'APPROVED',
        lines,
        pastYear: pastYear.data,
        currentYear: currentYear.data,
        currentBalances: currentBalances.data,
      }),
    );
  };

  const run = async (fn: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await fn();
      setConfirm(null);
    } catch (err) {
      toast.error(failure, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const approveAll = () =>
    run(async () => {
      const res = await engine.approveOrdinanceUpload({
        fiscalYear: fy,
        fundCode: fund,
        reference: ordinance.reference,
      });
      toast.success(
        `${ordinance.reference} approved`,
        `${res.approved} line${res.approved === 1 ? '' : 's'}, ${formatPeso(res.total)} of authority now available for allotment.`,
      );
    }, 'Nothing was approved');

  const discardDrafts = () =>
    run(async () => {
      await deleteDrafts(
        COL.appropriations,
        drafts.map((l) => l.id),
      );
      toast.success('Draft lines discarded', 'Nothing had been approved from them.');
    }, 'Could not discard the drafts');

  const approveSet = () =>
    run(async () => {
      if (!waitingSet) return;
      const res = await engine.approvePreparedSet({ draftId: waitingSet.id });
      toast.success(
        'Realignment posted',
        `${res.posted} line${res.posted === 1 ? '' : 's'}.` +
          (res.allotmentMoved
            ? ` ${formatPeso(res.allotmentMoved)} of allotment moved with it.`
            : ''),
      );
    }, 'Nothing was posted');

  const discardSet = () =>
    run(async () => {
      if (!waitingSet) return;
      await deleteDraft(COL.augmentationDrafts, waitingSet.id);
      toast.success('Prepared realignment discarded', 'Nothing had been posted from it.');
    }, 'Could not discard it');

  const lineColumns: Array<{ h: string; cls?: string }> = [
    { h: 'Office' },
    { h: 'Budget line' },
    { h: 'Class', cls: 'w-16' },
    { h: 'Sector' },
    { h: 'Amount', cls: 'text-right' },
    { h: 'Status', cls: 'w-28' },
    { h: '', cls: 'w-16' },
  ];

  return (
    <>
      <div className={sheet ? 'no-print' : undefined}>
        <PageHeader
          title={`${kindLabel} - ${ordinance.reference}`}
          subtitle={`${ordinance.title ? `${ordinance.title} - ` : ''}${fundLabel(fund)} - fiscal year ${fy} - enacted ${formatLongDate(ordinance.date)}`}
          breadcrumbs={[
            { label: 'Budget' },
            { label: 'Ordinances', to: '/budget/appropriations/ordinances' },
            { label: ordinance.reference },
          ]}
          actions={
            <>
              <BackButton list={{ to: '/budget/appropriations/ordinances', label: 'Ordinances' }} />
              <Badge
                tone={
                  summary.stage === 'APPROVED'
                    ? 'emerald'
                    : summary.stage === 'EMPTY'
                      ? 'slate'
                      : 'amber'
                }
              >
                {STAGE_LABELS[summary.stage]}
              </Badge>
              <Button
                variant="secondary"
                onClick={print}
                disabled={summary.lines.length + summary.sets.length === 0}
              >
                Print LBP Form No. 2
              </Button>
              {!realign && canApprove && drafts.length > 0 && (
                <Button variant="primary" onClick={() => setConfirm('approve')}>
                  Approve all {drafts.length}
                </Button>
              )}
              {realign && canApprove && waitingSet && (
                <Button variant="primary" onClick={() => setConfirm('approveSet')}>
                  Approve and post
                </Button>
              )}
            </>
          }
        />

        <Tabs
          tabs={[
            { id: 'lines', label: 'Lines', count: summary.approvedCount + summary.waitingCount },
            { id: 'attachments', label: 'Supporting documents', count: attachments.data.length },
          ]}
          active={tab}
          onChange={(t) => setTab(t as typeof tab)}
        />

        {tab === 'lines' && (
          <div className="mt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-600">
                {realign
                  ? 'A realignment is prepared as one set that comes to zero, printed on LBP Form No. 2 for signature, and posted whole. What it takes away is on LBP Form No. 8 under Sources of Financing.'
                  : 'Record the lines of the ordinance here, one at a time or from the annex, attach the signed ordinance, print LBP Form No. 2 for signature, then approve them all.'}
              </p>
              {canRecord && (
                <div className="flex flex-wrap gap-2">
                  {realign ? (
                    waitingSet ? (
                      <>
                        {augmentationDraftEditable(waitingSet) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setEditingSet(waitingSet)}
                          >
                            Edit the set
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setConfirm('discardSet')}>
                          Discard the set
                        </Button>
                      </>
                    ) : (
                      summary.approvedCount === 0 && (
                        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
                          Prepare the realignment
                        </Button>
                      )
                    )
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          open(`/budget/appropriations/upload?ordinance=${ordinance.id}`)
                        }
                      >
                        Upload lines from the annex
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
                        Add a line
                      </Button>
                      {drafts.length > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => setConfirm('discard')}>
                          Discard {drafts.length} draft{drafts.length === 1 ? '' : 's'}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {realign && waitingSet && (
              <Card className="mb-4 border-amber-300 bg-amber-50/40" bodyClassName="p-0">
                <div className="px-4 py-3">
                  <p className="text-sm font-semibold text-navy-900">Prepared - not yet posted</p>
                  <p className="text-xs text-slate-600">
                    {(waitingSet.lines ?? []).length} lines
                    {waitingSet.createdBy?.name
                      ? ` - prepared by ${waitingSet.createdBy.name}`
                      : ''}
                    . Approving posts the whole set and moves the allotment with it.
                  </p>
                </div>
                <LinesTable
                  columns={lineColumns}
                  rows={(waitingSet.lines ?? []).map((l, i) => ({
                    key: `${waitingSet.id}-${i}`,
                    officeName: l.officeName,
                    line: l.accountCode
                      ? `${l.accountCode} ${l.accountName}`
                      : `${l.fppCode} ${l.fppName}`,
                    expenseClass: l.expenseClass,
                    sector: l.sector,
                    amount: l.amount,
                    status: 'PREPARED',
                  }))}
                />
              </Card>
            )}

            <Card bodyClassName="p-0">
              <LinesTable
                columns={lineColumns}
                rows={summary.lines.map((l) => ({
                  key: l.id,
                  officeName: l.officeName,
                  line: l.accountCode
                    ? `${l.accountCode} ${l.accountName}`
                    : `${l.fppCode} ${l.fppName}`,
                  expenseClass: l.expenseClass,
                  sector: l.sector,
                  amount: l.amount,
                  status: l.status,
                  edit: canRecord && appropriationEditable(l) ? () => setEditing(l) : undefined,
                }))}
                total={
                  summary.approvedTotal +
                  (realign
                    ? 0
                    : summary.lines
                        .filter((l) => l.status === 'DRAFT')
                        .reduce((t, l) => t + l.amount, 0))
                }
                empty={
                  realign
                    ? 'Nothing posted yet. Prepare the realignment above.'
                    : 'No lines yet. Add them one at a time, or upload the annex.'
                }
              />
            </Card>
          </div>
        )}

        {tab === 'attachments' && (
          <div className="mt-4">
            <Alert tone="info" className="mb-4">
              Attach the signed and enacted ordinance here. It stays with the record, and every line
              approved under this number can be traced to it.
            </Alert>
            <AttachmentsPanel
              entityType={COL.ordinances}
              allowedTypes={attachmentTypesFor(COL.ordinances)}
              entityId={ordinance.id}
              entityRef={ordinance.reference}
              fiscalYear={fy}
              fundCode={fund}
              storageDocType="ORDINANCE"
              storageDocId={slugReference(ordinance.reference) || ordinance.id}
              readOnly={!can('budget', 'edit')}
            />
          </div>
        )}

        {(adding || editing || editingSet) && (
          <AppropriationForm
            key={editing?.id ?? editingSet?.id ?? 'new'}
            fiscalYear={fy}
            fundCode={fund}
            ordinance={ordinance}
            existing={editing}
            draft={editingSet}
            actor={actor}
            onClose={() => {
              setAdding(false);
              setEditing(null);
              setEditingSet(null);
            }}
            onSaved={() => {
              setAdding(false);
              setEditing(null);
              setEditingSet(null);
              toast.success(
                realign ? 'Realignment prepared' : editing ? 'Line corrected' : 'Line recorded',
                realign
                  ? 'Print it for signature, then approve and post it.'
                  : 'Still a draft. Approve the ordinance when all its lines are in.',
              );
            }}
          />
        )}

        <ConfirmDialog
          open={confirm === 'approve'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void approveAll()}
          loading={busy}
          title={`Approve ${ordinance.reference}`}
          confirmLabel="Approve all"
          variant="primary"
          message={
            <>
              <p>
                All {drafts.length} draft line{drafts.length === 1 ? '' : 's'} of{' '}
                <strong>{ordinance.reference}</strong> become authority available for allotment.
              </p>
              <p className="mt-2">
                Every line is checked first. If any one cannot be approved, NONE is, and every line
                that failed is named - an ordinance becomes authority whole or not at all.
              </p>
            </>
          }
        />
        <ConfirmDialog
          open={confirm === 'discard'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void discardDrafts()}
          loading={busy}
          title="Discard the draft lines"
          confirmLabel="Discard"
          variant="danger"
          message={
            <p>
              The {drafts.length} draft line{drafts.length === 1 ? '' : 's'} of{' '}
              {ordinance.reference} are deleted. Nothing had been approved from them. Lines already
              approved are untouched.
            </p>
          }
        />
        <ConfirmDialog
          open={confirm === 'approveSet'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void approveSet()}
          loading={busy}
          title="Post this realignment"
          confirmLabel="Approve and post"
          variant="primary"
          message={
            <p>
              This posts all {(waitingSet?.lines ?? []).length} lines of{' '}
              <strong>{ordinance.reference}</strong> together and moves the allotment with them. The
              checks run now: that the set comes to zero, that the savings exist, and that no line
              falls below the allotment already released. If any fails, nothing is posted.
            </p>
          }
        />
        <ConfirmDialog
          open={confirm === 'discardSet'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void discardSet()}
          loading={busy}
          title="Discard the prepared realignment"
          confirmLabel="Discard"
          variant="danger"
          message={<p>The prepared set is deleted. Nothing had been posted from it.</p>}
        />
      </div>

      {sheet && <LbpForm2Sheet sheet={sheet} />}
    </>
  );
}

interface LineRow {
  key: string;
  officeName: string;
  line: string;
  expenseClass: string;
  sector?: string | null;
  amount: number;
  status: string;
  edit?: () => void;
}

function LinesTable({
  columns,
  rows,
  total,
  empty,
}: {
  columns: Array<{ h: string; cls?: string }>;
  rows: LineRow[];
  total?: number;
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-slate-500">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-left text-slate-600">
          <tr>
            {columns.map((c) => (
              <th key={c.h} className={`px-3 py-2 font-medium ${c.cls ?? ''}`}>
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key} className="align-top">
              <td className="px-3 py-2 text-slate-700">{r.officeName}</td>
              <td className="px-3 py-2">{r.line}</td>
              <td
                className="px-3 py-2"
                title={EXPENSE_CLASS_LABELS[r.expenseClass as ExpenseClass]}
              >
                {r.expenseClass}
              </td>
              <td className="px-3 py-2 text-slate-600">{r.sector ?? ''}</td>
              <td
                className={`px-3 py-2 text-right font-mono ${r.amount < 0 ? 'text-rose-700' : ''}`}
              >
                {formatPeso(r.amount, { symbol: false, parens: true })}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={r.status} />
              </td>
              <td className="px-3 py-2 text-right">
                {r.edit && (
                  <Button size="sm" variant="secondary" onClick={r.edit}>
                    Edit
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        {total !== undefined && (
          <tfoot>
            <tr className="border-t-2 border-navy-800 bg-slate-50 font-semibold">
              <td className="px-3 py-2" colSpan={4}>
                Total
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {formatPeso(total, { symbol: false, parens: true })}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
