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
  useEstimatedReceipts,
  useFundingSources,
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
import type { Appropriation, AugmentationDraft, FundingSource, Ordinance } from '@/types/budget';
import { ACT_KINDS, fundingBasis, sectionsFinancing } from '@/lib/budgetActs';
import { AppropriationForm } from './Appropriations';
import { fundLabel } from './Obligations';
import { STAGE_LABELS, actReadiness, isSetAct, slugReference, summariseOrdinance } from './ordinanceModel';
import { FundingSourceDialog, FundingSourceList } from './FundingSourceDialog';
import { buildAugmentationSheet, type AugmentationSheet } from './augmentationForm';
import { AugmentationFormSheet, usePrintAugmentation } from './AugmentationFormSheet';
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
 * (An augmentation's is not: it is not part of a supplemental budget - p126.)
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
  /* Patch 123: what finances it. */
  const sources = useFundingSources(fy, fund);
  const estimated = useEstimatedReceipts(fy, fund);

  const summary = useMemo(
    () => (ordinance ? summariseOrdinance(ordinance, appropriations.data, sets.data) : null),
    [ordinance, appropriations.data, sets.data],
  );

  const [tab, setTab] = useState<'lines' | 'sources' | 'attachments'>('lines');
  const [sourceEditing, setSourceEditing] = useState<FundingSource | 'new' | null>(null);
  const [augSheet, setAugSheet] = useState<AugmentationSheet | null>(null);
  const clearAug = useCallback(() => setAugSheet(null), []);
  usePrintAugmentation(augSheet, clearAug);
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

  const realign = isSetAct(ordinance.kind);
  const isAug = ordinance.kind === 'AUGMENTATION';
  const actMeta = ACT_KINDS.find((k) => k.value === ordinance.kind);
  const kindLabel = actMeta?.label ?? ordinance.kind;
  const setWord = isAug ? 'augmentation' : 'realignment';
  const basis = fundingBasis(ordinance.kind);
  const ownSources = sources.data.filter((x) => x.actId === ordinance.id);
  const openSources = sources.data.filter(
    (x) => !x.actId && sectionsFinancing(ordinance.kind).includes(x.section),
  );
  const readiness = actReadiness({
    summary,
    attachmentCount: attachments.data.length,
    appropriations: appropriations.data,
    sources: sources.data.map((x) => ({ section: x.section, amount: x.amount, actId: x.actId ?? null })),
    estimatedRevenue: estimated.data.reduce((t, r) => t + (r.annual ?? 0), 0),
  });
  const notReady = readiness.problems.join(' ');
  const takenLines = [
    ...summary.lines.filter((l) => l.amount < 0 && l.status !== 'CANCELLED'),
    ...summary.sets.flatMap((x) => (x.lines ?? []).filter((l) => l.amount < 0)),
  ];
  const drafts = summary.lines.filter((l) => l.status === 'DRAFT');
  const waitingSet = summary.sets.find((s) => augmentationDraftEditable(s)) ?? null;

  /** An augmentation prints on the Augmentation Form (patch 116), not LBP Form No. 2. */
  const printAugmentation = () =>
    setAugSheet(
      buildAugmentationSheet({
        fiscalYear: fy,
        lgu: entity.headingLines[1] ?? '',
        headingLines: entity.headingLines,
        ordinanceNo: ordinance.reference,
        authorityDate: ordinance.date,
        lines: [...summary.lines, ...summary.sets.flatMap((x) => x.lines ?? [])],
        prepared: summary.stage !== 'APPROVED',
        preparedBy: summary.sets[0]?.createdBy?.name ?? null,
      }),
    );

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
        isAug ? 'Augmentation posted' : 'Realignment posted',
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
      toast.success(`Prepared ${setWord} discarded`, 'Nothing had been posted from it.');
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
      <div className={sheet || augSheet ? 'no-print' : undefined}>
        <PageHeader
          title={`${kindLabel} - ${ordinance.reference}`}
          subtitle={`${ordinance.title ? `${ordinance.title} - ` : ''}${fundLabel(fund)} - fiscal year ${fy} - dated ${formatLongDate(ordinance.date)}`}
          breadcrumbs={[
            { label: 'Budget' },
            { label: 'Authorities', to: '/budget/appropriations/ordinances' },
            { label: ordinance.reference },
          ]}
          actions={
            <>
              <BackButton list={{ to: '/budget/appropriations/ordinances', label: 'Authorities' }} />
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
                onClick={isAug ? printAugmentation : print}
                disabled={summary.lines.length + summary.sets.length === 0}
              >
                {isAug ? 'Print the Augmentation Form' : 'Print LBP Form No. 2'}
              </Button>
              {!realign && canApprove && drafts.length > 0 && (
                <Button
                  variant="primary"
                  disabled={!readiness.ready}
                  title={readiness.ready ? undefined : notReady}
                  onClick={() => setConfirm('approve')}
                >
                  Approve all {drafts.length}
                </Button>
              )}
              {realign && canApprove && waitingSet && (
                <Button
                  variant="primary"
                  disabled={!readiness.ready}
                  title={readiness.ready ? undefined : notReady}
                  onClick={() => setConfirm('approveSet')}
                >
                  Approve and post
                </Button>
              )}
            </>
          }
        />

        {summary.stage !== 'APPROVED' && summary.stage !== 'EMPTY' && (
          <ReadinessCard
            documented={readiness.documented}
            fundedText={
              basis === 'OWN_LINES'
                ? `Finances itself: ${formatPeso(readiness.takenFrom)} taken from the lines it gives up${isAug ? ' - its savings' : ' (LBP Form No. 8, 4.0 Realignment)'}.`
                : readiness.cover
                  ? `${formatPeso(readiness.cover.needed)} to finance; ${formatPeso(readiness.cover.available)} available from ${basis === 'ESTIMATED_REVENUE' ? 'the Estimated Revenue' : 'its sources'}.`
                  : ''
            }
            funded={basis === 'OWN_LINES' || Boolean(readiness.cover?.ok)}
            problems={readiness.problems}
            onGo={(t) => setTab(t)}
          />
        )}

        <Tabs
          tabs={[
            { id: 'lines', label: 'Lines', count: summary.approvedCount + summary.waitingCount },
            {
              id: 'sources',
              label: 'Sources',
              count: basis === 'ENCODED' ? ownSources.length : undefined,
            },
            { id: 'attachments', label: 'Supporting documents', count: attachments.data.length },
          ]}
          active={tab}
          onChange={(t) => setTab(t as typeof tab)}
        />

        {tab === 'lines' && (
          <div className="mt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-600">
                {isAug
                  ? 'An augmentation is prepared as one set that comes to zero, within one expense class, printed on the Augmentation Form for the Mayor to sign, and posted whole. The savings it takes are its source. It is not part of a supplemental budget and is not on LBP Form No. 8.'
                  : realign
                    ? 'A realignment is prepared as one set that comes to zero, printed on LBP Form No. 2 for signature, and posted whole. What it takes away is its source - LBP Form No. 8, 4.0.'
                    : 'Record the lines here, one at a time or from the annex, encode its sources, attach the signed copy, print LBP Form No. 2 for signature, then approve them all.'}
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
                          Prepare the {setWord}
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

            {/* Patch 125: the form is part of the Lines tab, in place of what it edits - not a window over the page. */}
            {(adding || editing || editingSet) && (
              <AppropriationForm
                key={editing?.id ?? editingSet?.id ?? 'new'}
                fiscalYear={fy}
                fundCode={fund}
                ordinance={ordinance}
                existing={editing}
                draft={editingSet}
                actor={actor}
                inline
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
                    realign ? `${isAug ? 'Augmentation' : 'Realignment'} prepared` : editing ? 'Line corrected' : 'Line recorded',
                    realign
                      ? 'Print it for signature, then approve and post it.'
                      : 'Still a draft. Approve the ordinance when all its lines are in.',
                  );
                }}
              />
            )}

            {realign && waitingSet && !editingSet && (
              <Card className="mb-4 border-amber-300 bg-amber-50/40" bodyClassName="p-0">
                <div className="px-4 py-3">
                  <p className="text-sm font-semibold text-navy-900">
                    Prepared - not yet posted
                  </p>
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
                    ? `Nothing posted yet. Prepare the ${setWord} above.`
                    : 'No lines yet. Add them one at a time, or upload the annex.'
                }
              />
            </Card>
          </div>
        )}

        {tab === 'sources' && (
          <div className="mt-4 space-y-4">
            {basis === 'ESTIMATED_REVENUE' && (
              <Card title="Estimated Revenue" subtitle="The original budget may not exceed it. Recorded on Budget > Sources of Financing > Schedule.">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <Figure label="Estimated revenue" value={readiness.cover?.available ?? 0} />
                  <Figure label="Original budget, with this ordinance" value={readiness.cover?.needed ?? 0} />
                  <Figure
                    label="Left"
                    value={(readiness.cover?.available ?? 0) - (readiness.cover?.needed ?? 0)}
                  />
                </dl>
                <div className="mt-3">
                  <Button size="sm" variant="secondary" onClick={() => open('/budget/estimated-receipts')}>
                    Open Sources of Financing
                  </Button>
                </div>
              </Card>
            )}

            {basis === 'ENCODED' && (
              <>
                <Card
                  title={ordinance.kind === 'SUPPLEMENTAL' ? 'Sources encoded in this ordinance - 1.0, 2.0 and 3.0' : 'Continuing sources encoded here'}
                  subtitle={
                    readiness.cover
                      ? `Needed ${formatPeso(readiness.cover.needed)} - own ${formatPeso(readiness.cover.own)} - open on the Sources tab ${formatPeso(readiness.cover.open)}.`
                      : undefined
                  }
                  bodyClassName="p-0"
                  actions={
                    can('budget', 'create') && (
                      <Button size="sm" variant="primary" onClick={() => setSourceEditing('new')}>
                        Encode a source
                      </Button>
                    )
                  }
                >
                  <FundingSourceList
                    sources={ownSources}
                    canEdit={can('budget', 'create')}
                    onEdit={setSourceEditing}
                    empty="Nothing encoded in this act. Encode its sources here, or on Budget > Sources of Financing > Funding Sources."
                  />
                </Card>
                {openSources.length > 0 && (
                  <Card
                    title="Open on the Sources tab"
                    subtitle="Encoded without an act. Any act of this kind draws on them for what its own sources do not cover, in the order they are approved."
                    bodyClassName="p-0"
                  >
                    <FundingSourceList sources={openSources} canEdit={false} onEdit={() => undefined} empty="" />
                  </Card>
                )}
              </>
            )}

            {basis === 'OWN_LINES' && (
              <Card
                title={isAug ? 'Savings - what this augmentation takes from' : '4.0 Realignment - what this realignment takes from'}
                subtitle="Its own source. The set must come to zero, so what it gives is exactly what it takes."
                bodyClassName="p-0"
              >
                <LinesTable
                  columns={lineColumns}
                  rows={takenLines.map((l, i) => ({
                    key: `t-${i}`,
                    officeName: l.officeName,
                    line: l.accountCode ? `${l.accountCode} ${l.accountName}` : `${l.fppCode} ${l.fppName}`,
                    expenseClass: l.expenseClass,
                    sector: l.sector,
                    amount: l.amount,
                    status: 'status' in l ? (l as Appropriation).status : 'PREPARED',
                  }))}
                  total={-readiness.takenFrom}
                  empty={`Nothing yet. Prepare the ${setWord} on Lines.`}
                />
              </Card>
            )}
          </div>
        )}

        {sourceEditing && (
          <FundingSourceDialog
            fiscalYear={fy}
            fundCode={fund}
            act={ordinance}
            existing={sourceEditing === 'new' ? null : sourceEditing}
            sections={sectionsFinancing(ordinance.kind)}
            onClose={() => setSourceEditing(null)}
          />
        )}

        {tab === 'attachments' && (
          <div className="mt-4">
            <Alert tone="info" className="mb-4">
              Attach the signed {actMeta?.document ?? 'document'} here. It cannot be approved without
              it, and every line approved under this number can be traced to it.
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
      {augSheet && <AugmentationFormSheet sheet={augSheet} />}
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

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm ${value < 0 ? 'text-rose-700' : 'text-navy-900'}`}>
        {formatPeso(value)}
      </dd>
    </div>
  );
}

/**
 * Before approval: what the engine will want, ticked off. Patch 123.
 */
function ReadinessCard({
  documented,
  funded,
  fundedText,
  problems,
  onGo,
}: {
  documented: boolean;
  funded: boolean;
  fundedText: string;
  problems: string[];
  onGo: (tab: 'sources' | 'attachments') => void;
}) {
  const Item = ({ ok, label, tab, detail }: { ok: boolean; label: string; tab: 'sources' | 'attachments'; detail?: string }) => (
    <li className="flex items-start gap-2">
      <span
        className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-bold ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}
      >
        {ok ? '\u2713' : '!'}
      </span>
      <span className="text-xs">
        <button type="button" className="font-semibold text-navy-900 hover:underline" onClick={() => onGo(tab)}>
          {label}
        </button>
        {detail && <span className="text-slate-600"> - {detail}</span>}
      </span>
    </li>
  );
  return (
    <Card className={`mb-4 ${problems.length ? 'border-amber-300 bg-amber-50/40' : 'border-emerald-200 bg-emerald-50/40'}`}>
      <p className="text-sm font-semibold text-navy-900">
        {problems.length ? 'Before it can be approved' : 'Ready to approve'}
      </p>
      <ul className="mt-2 space-y-1.5">
        <Item ok={documented} label="Signed copy attached" tab="attachments" detail={documented ? undefined : 'attach it on Supporting documents'} />
        <Item ok={funded} label="Sources" tab="sources" detail={fundedText} />
      </ul>
      {problems.length > 0 && <p className="mt-2 text-2xs text-slate-600">{problems.join(' ')}</p>}
    </Card>
  );
}
