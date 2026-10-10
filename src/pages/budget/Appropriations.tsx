import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Alert, Card } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, Select, DateInput, AmountInput, TextArea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, OfficePicker } from '@/components/pickers';
import { Combobox } from '@/components/pickers/Combobox';
import { BudgetLinePicker } from '@/components/pickers/BudgetLinePicker';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useAppropriations,
  useAugmentationDrafts,
  useBudgetBalances,
  useOrdinances,
  usePrograms,
} from '@/data/queries';
import { createDraft, updateDraft, deleteDraft, deleteDrafts, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import {
  checkAugmentationExpenseClass,
  checkRealignmentSet,
  checkRealignableBalances,
  type RealignmentInstrument,
} from '@/lib/accounting-rules';
import { SECTORS, SERVICE_SECTORS, findSector } from '@/lib/sectors';
import {
  appropriationEditable,
  appropriationNotEditableBecause,
  augmentationDraftEditable,
} from '@/lib/budgetEditable';
import { appropriationLineLabel } from '@/lib/budgetLines';
import { formatShortDate, todayPh } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type {
  Appropriation,
  Ordinance,
  AppropriationKind,
  AugmentationDraft,
} from '@/types/budget';
import { AppropriationTabs } from './appropriationTabs';
import { uploadedDrafts, type UploadGroup } from './uploadedDrafts';
import { fundLabel } from './Obligations';
import { RecordOrdinanceDialog } from './RecordOrdinanceDialog';
import { ordinanceId } from './ordinanceModel';
import { ledgerRows, type LedgerRow } from './ledgerRows';
import { actKindOfInstrument, type ActKind } from '@/lib/budgetActs';
import { useEntity } from '@/data/useEntity';
import { buildAugmentationSheet, type AugmentationSheet } from './augmentationForm';
import { AugmentationFormSheet, usePrintAugmentation } from './AugmentationFormSheet';

/**
 * Appropriations.
 *
 * The appropriation is the only figure in the budget chain with no upstream
 * control - it comes from an ordinance of the Sangguniang Bayan and the system
 * records it. What the system does insist on is the authority reference, so
 * that every peso of spending authority can be traced back to the ordinance
 * that created it.
 */

/**
 * Every kind that can appear in the table, including the two that can no
 * longer be created.
 *
 * Kept separate from the list offered in the form on purpose: withdrawing a
 * choice must not turn the appropriations already recorded under it into rows
 * labelled with a raw code. History keeps its name.
 */
/** The act a prepared set is, in a word for the screen. */
const instrumentWord = (d: { instrument?: string }) =>
  d.instrument === 'REALIGNMENT' ? 'realignment' : 'augmentation';

const KIND_LABELS: Record<AppropriationKind, string> = {
  ORIGINAL: 'Original',
  SUPPLEMENTAL: 'Supplemental',
  CONTINUING: 'Continuing',
  REALIGNMENT: 'Realignment',
  TRANSFER: 'Transfer',
  ADJUSTMENT: 'Adjustment',
};

/**
 * What this screen offers.
 *
 * TRANSFER is gone: a movement of authority between offices is a realignment,
 * and two names for one act meant the SAOB had to add them together to answer
 * a simple question.
 *
 * REALIGNMENT is here, and it is the one type this form does not record a
 * single line of. Choosing it turns the form into a small table, because a
 * realignment IS a table: what the authority is taken from and what it goes
 * to, coming to zero. One line of it is not a smaller realignment, it is half
 * a budget act - and half of one sitting in the books until somebody remembers
 * the other half is exactly the state the rule exists to prevent.
 */
/**
 * What the form offers, which is not quite the list of stored kinds.
 *
 * Augmentation and Realignment are stored as one kind, REALIGNMENT, told apart
 * by the instrument. They were presented that way too - pick Realignment, then
 * pick an instrument - and that is not how the Budget Office thinks about
 * them. They are two different acts with two different approving authorities,
 * and asking for one then the other made the second question look like a
 * detail of the first.
 *
 * So the form asks once, in the office's own words, and works out what to
 * store. Nothing about the stored shape changed.
 */
type FormKind = AppropriationKind | 'AUGMENTATION';

const KINDS: Array<{ value: FormKind; label: string; hint: string }> = [
  { value: 'ORIGINAL', label: 'Original', hint: 'The annual budget as enacted.' },
  { value: 'SUPPLEMENTAL', label: 'Supplemental', hint: 'Additional authority enacted during the year, from new revenue.' },
  { value: 'CONTINUING', label: 'Continuing', hint: 'Prior-year authority carried forward.' },
  {
    value: 'AUGMENTATION',
    label: 'Augmentation',
    hint: 'Savings moved WITHIN one expense class - PS to PS, MOOE to MOOE, CO to CO. Signed by the Local Chief Executive, under the omnibus authority in the General Provisions.',
  },
  {
    value: 'REALIGNMENT',
    label: 'Realignment',
    hint: 'Authority moved ACROSS expense classes - PS to MOOE, and anything an augmentation may not reach. By ordinance of the Sanggunian.',
  },
  // ADJUSTMENT withdrawn in patch 129 (Neil: "I don't need adjustment").
  // Adjustments already recorded keep their label (KIND_LABELS) and approve.
];

/** What the chosen act is stored as. */
const storedKind = (k: FormKind): AppropriationKind =>
  k === 'AUGMENTATION' ? 'REALIGNMENT' : k;

/**
 * One row of a realignment being built on screen.
 *
 * The line is CHOSEN, not described. A realignment moves authority between
 * lines that already exist - it cannot take from a line that was never
 * appropriated, and it cannot give to one either without first creating it,
 * which is a supplemental appropriation and a different act.
 */
interface RealignLine {
  id: number;
  officeId: string | null;
  /** The office NAME is what is sent: the import resolves by code, name or short name. */
  officeName: string;
  /** The chosen budget line's balance document id. */
  lineId: string | null;
  fppCode: string;
  fppName: string;
  sector: string;
  serviceSector: string;
  accountCode: string;
  accountName: string;
  expenseClass: ExpenseClass;
  amount: number | null;
  particulars: string;
}

let nextLineId = 1;
const blankLine = (): RealignLine => ({
  id: nextLineId++,
  officeId: null,
  officeName: '',
  lineId: null,
  fppCode: '',
  fppName: '',
  sector: '',
  serviceSector: '',
  accountCode: '',
  accountName: '',
  expenseClass: 'MOOE',
  amount: null,
  particulars: '',
});

export default function Appropriations() {
  const { fiscalYear, fundCode } = useFilters();
  const navigate = useNavigate();
  const { can, user, profile } = useAuth();
  const toast = useToast();
  const { data, loading, error } = useAppropriations(fiscalYear, fundCode);

  /* Patch 119: the ordinance is recorded first, as a document of its own. */
  const [recordingOrdinance, setRecordingOrdinance] = useState<
    boolean | { kind: ActKind; reference: string; date: string }
  >(false);
  /* Patch 123: a prepared set is approved only under its recorded act. */
  const acts = useOrdinances(fiscalYear, fundCode);
  const [approving, setApproving] = useState<Appropriation | null>(null);
  const [editing, setEditing] = useState<Appropriation | null>(null);
  const [busy, setBusy] = useState(false);
  /* The augmentations prepared but not yet posted, and what is being done to one. */
  const drafts = useAugmentationDrafts(fiscalYear, fundCode);
  const [editingDraft, setEditingDraft] = useState<AugmentationDraft | null>(null);
  const [approvingDraft, setApprovingDraft] = useState<AugmentationDraft | null>(null);
  const [discardingDraft, setDiscardingDraft] = useState<AugmentationDraft | null>(null);
  /* And the line whose detail is open, from clicking a row. */
  const [viewing, setViewing] = useState<Appropriation | null>(null);

  /*
    ---------------------------------------------------------------------------
    THE AUGMENTATION FORM, LBE FORM NO. 2 (patch 116)
    ---------------------------------------------------------------------------
    An augmentation is recorded here, printed on the manual's form for the
    Budget Officer, the Accountant and the Local Chief Executive to sign, and
    then approved and posted. The form prints from the prepared set - with a
    band saying it is not yet posted - and, once posted, from the ledger lines
    that share its authority, so a signed copy can always be reprinted.
  */
  const entity = useEntity();
  const [formSheet, setFormSheet] = useState<AugmentationSheet | null>(null);
  const clearFormSheet = useCallback(() => setFormSheet(null), []);
  usePrintAugmentation(formSheet, clearFormSheet);
  const lgu = entity.headingLines[1] ?? '';

  const printPrepared = (d: AugmentationDraft) =>
    setFormSheet(
      buildAugmentationSheet({
        fiscalYear: d.fiscalYear,
        lgu,
        headingLines: entity.headingLines,
        ordinanceNo: d.authorityReference ?? '',
        authorityDate: d.authorityDate,
        lines: d.lines ?? [],
        prepared: true,
        preparedBy: d.createdBy?.name ?? null,
      }),
    );

  /** Every posted line of the augmentation this line belongs to. */
  const printPosted = (a: Appropriation) =>
    setFormSheet(
      buildAugmentationSheet({
        fiscalYear: a.fiscalYear,
        lgu,
        headingLines: entity.headingLines,
        ordinanceNo: a.authorityReference ?? '',
        authorityDate: a.authorityDate,
        lines: data.filter(
          (x) =>
            x.status === 'APPROVED' &&
            x.kind === 'REALIGNMENT' &&
            x.instrument === 'AUGMENTATION' &&
            (x.authorityReference ?? '') === (a.authorityReference ?? ''),
        ),
        prepared: false,
      }),
    );

  /*
    ---------------------------------------------------------------------------
    UPLOADED ORDINANCES, WAITING (patch 112)
    ---------------------------------------------------------------------------
    An ordinance file now lands its lines as drafts. They are in the ledger
    below, marked Draft, and each can be corrected or approved by itself - but
    an ordinance is approved as a whole, so the uploads are also gathered here
    with one button for the lot.
  */
  const uploads = useMemo(() => uploadedDrafts(data), [data]);
  const [approvingUpload, setApprovingUpload] = useState<UploadGroup | null>(null);
  const [discardingUpload, setDiscardingUpload] = useState<UploadGroup | null>(null);

  const approveUpload = async (u: UploadGroup) => {
    setBusy(true);
    try {
      const res = await engine.approveOrdinanceUpload({
        fiscalYear,
        fundCode,
        reference: u.reference,
      });
      toast.success(
        `${u.reference} approved`,
        `${res.approved} line${res.approved === 1 ? '' : 's'}, ${formatPeso(res.total)} of authority now available for allotment.`,
      );
      setApprovingUpload(null);
    } catch (err) {
      toast.error('Nothing was approved', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discardUpload = async (u: UploadGroup) => {
    setBusy(true);
    try {
      await deleteDrafts(COL.appropriations, u.ids);
      toast.success(`${u.reference} discarded`, 'Nothing had been approved from it. It can be uploaded again.');
      setDiscardingUpload(null);
    } catch (err) {
      toast.error('Could not discard it', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    const approved = data.filter((a) => a.status === 'APPROVED');
    return {
      original: approved.filter((a) => a.kind === 'ORIGINAL').reduce((s, a) => s + a.amount, 0),
      supplemental: approved.filter((a) => a.kind === 'SUPPLEMENTAL').reduce((s, a) => s + a.amount, 0),
      continuing: approved.filter((a) => a.kind === 'CONTINUING').reduce((s, a) => s + a.amount, 0),
      adjustments: approved
        .filter((a) => ['REALIGNMENT', 'TRANSFER', 'ADJUSTMENT'].includes(a.kind))
        .reduce((s, a) => s + a.amount, 0),
      revised: approved.reduce((s, a) => s + a.amount, 0),
    };
  }, [data]);

  const approve = async (appropriation: Appropriation) => {
    setBusy(true);
    try {
      await engine.approveAppropriation({ appropriationId: appropriation.id });
      toast.success(
        'Appropriation approved',
        `${formatPeso(appropriation.amount)} of authority is now available for allotment against ${appropriationLineLabel(appropriation)}.`,
      );
      setApproving(null);
    } catch (err) {
      toast.error('Could not approve', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * ---------------------------------------------------------------------------
   * POSTING A PREPARED AUGMENTATION OR REALIGNMENT
   * ---------------------------------------------------------------------------
   * The draft is a working paper, not a half-posted transaction. Nothing has
   * moved while it sat here: no appropriation, no allotment, nothing obligable.
   * Approving it posts it through the engine, which resolves every office and
   * account against master data, checks the authority, refuses a set that
   * does not come to zero (or, for an augmentation, crosses expense classes),
   * moves the allotment peso for peso, and writes the lot in one transaction.
   *
   * There is no POSTED status a browser could claim: once posted, the
   * Appropriation Ledger is the record and the engine deletes the draft.
   */
  const approveDraft = async (draft: AugmentationDraft) => {
    setBusy(true);
    try {
      /*
        Only the id goes. Until patch 112 the browser sent the set's lines and
        then deleted the prepared copy itself - so what was posted was whatever
        the browser sent. Now the engine reads the stored set, posts it, and
        deletes it in the same transaction: what is posted is what was
        prepared, and nothing is left behind to clear.
      */
      const res = await engine.approvePreparedSet({ draftId: draft.id });
      toast.success(
        `${draft.instrument === 'REALIGNMENT' ? 'Realignment' : 'Augmentation'} posted`,
        `${res.posted} line${res.posted === 1 ? '' : 's'}. The total appropriation of the fund is unchanged` +
          (res.allotmentMoved
            ? `, and ${formatPeso(res.allotmentMoved)} of allotment moved with it.`
            : '. No allotment had to move.'),
      );
      setApprovingDraft(null);
    } catch (err) {
      toast.error('Nothing was posted', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = async (draft: AugmentationDraft) => {
    setBusy(true);
    try {
      await deleteDraft(COL.augmentationDrafts, draft.id);
      toast.success(`Prepared ${instrumentWord(draft)} discarded`, 'Nothing had been posted from it.');
      setDiscardingDraft(null);
    } catch (err) {
      toast.error('Could not discard it', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /* Patch 128: a realignment or augmentation is one row per authority. */
  const rows = useMemo(() => ledgerRows(data), [data]);
  const openRow = (r: LedgerRow) => {
    if (!r.lump) return setViewing(r);
    const act = acts.data.find(
      (x) =>
        x.id ===
        ordinanceId({ fiscalYear, fundCode, kind: r.lump!.actKind, reference: r.authorityReference ?? '' }),
    );
    if (act) navigate(`/budget/appropriations/ordinances/${act.id}`);
    else setViewing(r.lump.lines[0]);
  };

  const columns: Column<LedgerRow>[] = [
    {
      key: 'kind',
      header: 'Type',
      width: '8rem',
      value: (a) => a.kind,
      cell: (a) => (
        <div>
          <span className="text-xs">{KIND_LABELS[a.kind] ?? a.kind}</span>
          {/* Which instrument a realignment was made under. Two acts that look
              identical in the books and are not the same in law, so the table
              says which one this was. */}
          {a.instrument && (
            <span className="block text-2xs text-slate-500">
              {a.instrument === 'AUGMENTATION'
                ? 'Augmentation (Sec. 336) - LCE'
                : 'Realignment (Sec. 321) - Sanggunian'}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'authority',
      header: 'Authority',
      value: (a) => a.authorityReference ?? '',
      cell: (a) => (
        <div>
          <span className="text-xs text-navy-900">{a.authorityReference ?? '-'}</span>
          {a.authorityDate && (
            <span className="block text-2xs text-slate-500">{formatShortDate(a.authorityDate)}</span>
          )}
        </div>
      ),
    },
    {
      key: 'office',
      header: 'Office',
      value: (a) => a.officeName,
      cell: (a) => <span className="text-xs text-slate-600">{a.officeName}</span>,
    },
    {
      key: 'account',
      header: 'Appropriated to',
      value: (a) => `${a.accountCode} ${a.accountName} ${a.fppCode} ${a.fppName}`,
      /*
       * A line appropriated by project has NO object code, and reading a blank
       * where every other row has a number says "something is missing here".
       * Nothing is: the ordinance named the project, and the object becomes
       * known when the obligation is raised. So the row shows what it was
       * actually appropriated to, and says which kind of line it is.
       */
      cell: (a) =>
        a.lump ? (
          <div>
            <span className="text-sm">
              {a.lump.lines.length} item{a.lump.lines.length === 1 ? '' : 's'} -{' '}
              {formatPeso(a.lump.moved, { symbol: false })} moved
            </span>
            <span className="block text-2xs text-slate-500">
              {a.lump.actKind === 'AUGMENTATION' ? 'Savings moved within one class' : 'Authority moved between items'}
              {' '}- no net effect. Open it for its lines.
            </span>
          </div>
        ) : a.accountCode ? (
          <div>
            <span className="font-mono text-xs text-slate-500">{a.accountCode}</span>{' '}
            <span className="text-sm">{a.accountName}</span>
          </div>
        ) : (
          <div>
            <span className="font-mono text-xs text-slate-500">{a.fppCode}</span>{' '}
            <span className="text-sm">{a.fppName}</span>
            <span className="block text-2xs uppercase tracking-wide text-brand-700">
              By programme
            </span>
          </div>
        ),
    },
    {
      key: 'expenseClass',
      header: 'Class',
      width: '5rem',
      value: (a) => a.expenseClass,
      cell: (a) => <span className="text-xs">{a.expenseClass}</span>,
      optional: true,
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (a) => a.amount,
      cell: (a) => (
        <span className={a.amount < 0 ? 'text-rose-700' : undefined}>
          {formatPeso(a.amount, { symbol: false, parens: true })}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '11rem',
      value: (a) => a.status,
      cell: (a) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={a.status} />
          {a.lump ? null : (
          <>
          {/*
            CORRECT, then APPROVE, in that order on the row because that is
            the order of the acts. Both are offered only while the line is
            still the office's own draft; `appropriationEditable` is the same
            test `firestore.rules` enforces on the update.
          */}
          {appropriationEditable(a) && can('budget', 'create') && (
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(a);
              }}
            >
              Edit
            </Button>
          )}
          {a.status === 'DRAFT' && can('budget', 'approve') && (
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => {
                e.stopPropagation();
                setApproving(a);
              }}
            >
              Approve
            </Button>
          )}
          </>
          )}
        </div>
      ),
      fixed: true,
      sortable: false,
    },
  ];

  return (
    <>
    {/* The screen steps aside while the form prints, so the form comes out alone. */}
    <div className={formSheet ? 'no-print' : undefined}>
      <PageHeader
        title="Appropriations"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Appropriations' }]}
        actions={
          can('budget', 'create') && (
            /*
              Patch 127: one way in. "Upload ordinance" and "Record
              appropriation" are gone from here - both are inside the act
              now (Upload lines from the annex, Add a line, Prepare the
              augmentation or realignment), which is where a line has to
              be recorded to be approved at all since patch 123.
            */
            <Button variant="primary" size="sm" onClick={() => setRecordingOrdinance(true)}>
              Record an authority
            </Button>
          )
        }
      />

      <AppropriationTabs active="appropriations" />

      <div className="my-4" />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryTile label="Original" amount={totals.original} />
        <SummaryTile label="Supplemental" amount={totals.supplemental} />
        <SummaryTile label="Continuing" amount={totals.continuing} />
        <SummaryTile label="Realignments" amount={totals.adjustments} />
        <SummaryTile label="Revised appropriation" amount={totals.revised} emphasis />
      </div>

      {uploads.length > 0 && (
        <Card className="mb-4 border-amber-300 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-navy-900">
            Ordinances - waiting for approval
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            The lines are in the ledger below, marked Draft. None of it is authority yet and none
            of it is in the totals. Open the ordinance to record more lines, attach the signed
            copy and print LBP Form No. 2 - then approve it whole once it has been read against
            the ordinance, or approve, correct or discard lines one at a time.
          </p>
          <ul className="mt-3 divide-y divide-amber-200/70">
            {uploads.map((u) => (
              <li key={u.reference} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-navy-900">
                    {u.reference}{' '}
                    <span className="text-xs font-normal text-slate-500">
                      {KIND_LABELS[u.kind as AppropriationKind] ?? u.kind}
                    </span>
                  </p>
                  <p className="text-xs text-slate-600">
                    {u.ids.length} line{u.ids.length === 1 ? '' : 's'}, {formatPeso(u.total)}
                    {u.fileName ? ` - ${u.fileName}` : ''}
                    {u.uploadedBy ? ` - uploaded by ${u.uploadedBy}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      navigate(
                        `/budget/appropriations/ordinances/${ordinanceId({
                          fiscalYear,
                          fundCode,
                          kind: u.kind as AppropriationKind,
                          reference: u.reference,
                        })}`,
                      )
                    }
                  >
                    Open
                  </Button>
                  {can('budget', 'approve') && (
                    <Button size="sm" variant="primary" onClick={() => setApprovingUpload(u)}>
                      Approve all {u.ids.length}
                    </Button>
                  )}
                  {can('budget', 'create') && (
                    <Button size="sm" variant="ghost" onClick={() => setDiscardingUpload(u)}>
                      Discard upload
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(approvingUpload)}
        onCancel={() => setApprovingUpload(null)}
        onConfirm={() => {
          if (approvingUpload) void approveUpload(approvingUpload);
        }}
        loading={busy}
        title="Approve this ordinance"
        confirmLabel="Approve all"
        variant="primary"
        message={
          approvingUpload && (
            <>
              <p>
                All {approvingUpload.ids.length} lines of <strong>{approvingUpload.reference}</strong>,{' '}
                {formatPeso(approvingUpload.total)}, become authority available for allotment.
              </p>
              <p className="mt-2">
                Every line is checked first. If any one cannot be approved, NONE is, and every line
                that failed is named - an ordinance becomes authority whole or not at all.
              </p>
            </>
          )
        }
      />

      {recordingOrdinance && (
        <RecordOrdinanceDialog
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          preset={typeof recordingOrdinance === 'object' ? recordingOrdinance : undefined}
          actor={
            user
              ? actorStamp({
                  uid: user.uid,
                  name: profile?.displayName ?? user.email ?? user.uid,
                  position: profile?.position,
                })
              : null
          }
          onClose={() => setRecordingOrdinance(false)}
          onRecorded={(id) => {
            setRecordingOrdinance(false);
            navigate(`/budget/appropriations/ordinances/${id}`);
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(discardingUpload)}
        onCancel={() => setDiscardingUpload(null)}
        onConfirm={() => {
          if (discardingUpload) void discardUpload(discardingUpload);
        }}
        loading={busy}
        title="Discard this upload"
        confirmLabel="Discard"
        variant="danger"
        message={
          discardingUpload && (
            <p>
              The {discardingUpload.ids.length} draft lines of{' '}
              <strong>{discardingUpload.reference}</strong> are deleted. None had been approved,
              so nothing in the books changes, and the file can be uploaded again.
            </p>
          )
        }
      />

      {/*
        ---------------------------------------------------------------------
        PREPARED AUGMENTATIONS, ABOVE THE LEDGER AND NOT IN IT
        ---------------------------------------------------------------------
        A draft is deliberately NOT a row in the Appropriation Ledger below,
        and the reason is the summary tiles. "Realignments and adjustments"
        foots the ledger; a draft counted there would put money the Local Chief
        Executive has not signed into a total an officer reads as the fund's
        position. So the ledger shows what is posted, and what is merely
        prepared sits above it, plainly labelled as not yet posted.
      */}
      {drafts.data.length > 0 && (
        <Card className="mb-4 border-amber-300 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-navy-900">
            Prepared augmentations and realignments - not yet posted
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Nothing has moved. No appropriation, no allotment, nothing obligable against these.
            Approving one posts the whole set. It moves appropriation only - no allotment.
          </p>

          <ul className="mt-3 divide-y divide-amber-200/70">
            {drafts.data.map((d) => {
              const lines = d.lines ?? [];
              const set = lines.length
                ? checkRealignmentSet(lines.map((l, i) => ({ lineNo: i + 1, amount: l.amount })))
                : null;
              const takes = lines.filter((l) => l.amount > 0).reduce((t, l) => t + l.amount, 0);
              /* The engine refuses an unbalanced set anyway; saying so here
                 saves the round trip and names the figure it is out by. */
              const actKind = actKindOfInstrument(d.instrument);
              const ref = (d.authorityReference ?? '').trim();
              const act = ref
                ? acts.data.find((a) => a.id === ordinanceId({ fiscalYear, fundCode, kind: actKind, reference: ref }))
                : undefined;
              const blocked = !lines.length
                ? 'It has no lines on it yet.'
                : set && !set.ok
                  ? set.violations[0]?.message ?? 'The set does not come to zero.'
                  : !ref
                    ? 'Add the authority it was signed under (Edit) before it can be approved.'
                    : !act
                      ? `Record ${ref} under Authorities and attach the signed copy before it can be approved.`
                      : !(act.attachmentCount ?? 0)
                        ? `Attach the signed copy to ${ref} (Open) before it can be approved.`
                        : null;

              return (
                <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-navy-900">
                      <span className="mr-2 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-amber-800">
                        {instrumentWord(d)}
                      </span>
                      {d.authorityReference || '(no authority reference)'}
                    </p>
                    <p className="text-xs text-slate-600">
                      {formatShortDate(d.authorityDate)} - {lines.length} line
                      {lines.length === 1 ? '' : 's'}, {formatPeso(takes)} moved
                      {blocked ? null : ' - balanced'}
                      {d.createdBy?.name ? ` - prepared by ${d.createdBy.name}` : ''}
                      {d.source === 'UPLOAD' ? ' from an uploaded file' : ''}
                    </p>
                    {blocked && <p className="mt-0.5 text-xs text-amber-800">{blocked}</p>}
                  </div>

                  <div className="flex items-center gap-2">
                    {/*
                      The augmentation on LBE Form No. 2, to be signed before
                      it is approved and posted. Patch 116. A realignment is
                      enacted by ordinance and has no such form.
                    */}
                    {d.instrument === 'AUGMENTATION' && (
                      <Button size="sm" variant="ghost" onClick={() => printPrepared(d)}>
                        Print form
                      </Button>
                    )}
                    {act ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => navigate(`/budget/appropriations/ordinances/${act.id}`)}
                      >
                        Open
                      </Button>
                    ) : (
                      ref &&
                      can('budget', 'create') && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            setRecordingOrdinance({ kind: actKind, reference: ref, date: d.authorityDate })
                          }
                        >
                          Record the {actKind === 'AUGMENTATION' ? 'order' : 'ordinance'}
                        </Button>
                      )
                    )}
                    {can('budget', 'create') && augmentationDraftEditable(d) && (
                      <Button size="sm" variant="secondary" onClick={() => setEditingDraft(d)}>
                        Edit
                      </Button>
                    )}
                    {can('budget', 'approve') && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={Boolean(blocked)}
                        onClick={() => setApprovingDraft(d)}
                      >
                        Approve and post
                      </Button>
                    )}
                    {can('budget', 'create') && (
                      <Button size="sm" variant="ghost" onClick={() => setDiscardingDraft(d)}>
                        Discard
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Patch 129: the form opens in the page, above the ledger - not as a window. */}
      {editingDraft && (
        <AppropriationForm
          key={editingDraft.id}
          draft={editingDraft}
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          inline
          onClose={() => setEditingDraft(null)}
          onSaved={() => {
            setEditingDraft(null);
            toast.success(
              `Prepared ${instrumentWord(editingDraft)} saved`,
              'Still not posted. Approve it when the figures are right.',
            );
          }}
          actor={
            user
              ? actorStamp({
                  uid: user.uid,
                  name: profile?.displayName ?? user.email ?? user.uid,
                  position: profile?.position,
                })
              : null
          }
        />
      )}
      {editing && (
        <AppropriationForm
          key={editing.id}
          existing={editing}
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          inline
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success(
              'Appropriation corrected',
              'It is still a draft. Approve it to make the authority available.',
            );
          }}
          actor={
            user
              ? actorStamp({
                  uid: user.uid,
                  name: profile?.displayName ?? user.email ?? user.uid,
                  position: profile?.position,
                })
              : null
          }
        />
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(a) => a.id}
        onRowClick={openRow}
        loading={loading}
        error={error}
        searchPlaceholder="Account, office or authority reference"
        emptyTitle="No appropriations recorded"
        emptyMessage={`Record the enacted budget for the ${fundLabel(fundCode)} before releasing allotments - Record an authority, then its lines inside it.`}
        exportMeta={{
          title: 'Appropriation Ledger',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {/* The line's own detail, from clicking its row. */}
      <AppropriationDetail
        appropriation={viewing}
        onClose={() => setViewing(null)}
        onPrintForm={(a) => {
          setViewing(null);
          printPosted(a);
        }}
        onEdit={
          can('budget', 'create')
            ? (a) => {
                setViewing(null);
                setEditing(a);
              }
            : undefined
        }
      />


      <ConfirmDialog
        open={Boolean(approvingDraft)}
        onCancel={() => setApprovingDraft(null)}
        onConfirm={() => {
          if (approvingDraft) void approveDraft(approvingDraft);
        }}
        loading={busy}
        title={`Post this ${approvingDraft ? instrumentWord(approvingDraft) : 'set'}`}
        confirmLabel="Approve and post"
        variant="primary"
        message={
          approvingDraft && (
            <>
              <p>
                This posts all {approvingDraft.lines?.length ?? 0} lines of{' '}
                <strong>{approvingDraft.authorityReference}</strong> together. It moves appropriation
                only - no allotment.
              </p>
              <p className="mt-2">
                The checks run now, not when it was prepared: that the set comes to zero, that the
                savings exist,
                {approvingDraft.instrument === 'AUGMENTATION'
                  ? ', that every line is in the same expense class'
                  : ''}
                , and that no line gives up more than its appropriation not yet allotted.{' '}
                If any of them fails NOTHING is posted and the prepared copy stays as it is.
              </p>
              <p className="mt-2">
                Afterwards the lines are in the Appropriation Ledger and this prepared copy is
                cleared. Posting the same authority reference twice is refused.
              </p>
            </>
          )
        }
      />

      <ConfirmDialog
        open={Boolean(discardingDraft)}
        onCancel={() => setDiscardingDraft(null)}
        onConfirm={() => {
          if (discardingDraft) void discardDraft(discardingDraft);
        }}
        loading={busy}
        title={`Discard this prepared ${discardingDraft ? instrumentWord(discardingDraft) : 'set'}`}
        confirmLabel="Discard"
        variant="danger"
        message={
          discardingDraft && (
            <p>
              <strong>{discardingDraft.authorityReference}</strong> and its{' '}
              {discardingDraft.lines?.length ?? 0} lines are deleted. Nothing had been posted from
              it, so nothing in the books changes - but what was typed is gone and is not
              recoverable.
            </p>
          )
        }
      />



      <ConfirmDialog
        open={Boolean(approving)}
        onCancel={() => setApproving(null)}
        onConfirm={() => {
          if (approving) void approve(approving);
        }}
        loading={busy}
        title="Approve appropriation"
        confirmLabel="Approve"
        variant="primary"
        message={
          approving && (
            <>
              <p>
                This makes <strong>{formatPeso(approving.amount)}</strong> of spending authority
                available against {appropriationLineLabel(approving)} for {approving.officeName}.
              </p>
              {/* The last moment the figure can be corrected cheaply, so the
                  dialog says so rather than only naming the consequence. */}
              <p className="mt-2">
                <strong>This is the last point at which it can simply be edited.</strong> After
                approving, a change is made by recording a supplemental appropriation or an
                adjustment, so that the original stays visible and the movement is traceable to
                its own ordinance.
              </p>
            </>
          )
        }
      />
    </div>
    {formSheet && <AugmentationFormSheet sheet={formSheet} />}
    </>
  );
}

/**
 * ---------------------------------------------------------------------------
 * ONE LINE, IN FULL
 * ---------------------------------------------------------------------------
 * The ledger table shows six columns because six is what fits. An appropriation
 * line carries roughly twice that, and the ones left out are not decoration:
 * the sector decides where the line appears on the SRE, the service sector
 * decides it again when the first is a funding source, the programme is what
 * an obligation is actually charged against on a project line, and the
 * authority reference is the ordinance the whole thing rests on.
 *
 * Until now the only way to read those was to open the edit form, which meant
 * opening a form to find out what a line said - and on an approved line there
 * was no way at all.
 *
 * Deliberately NOT the whole realignment set. A set is held together by its
 * authority reference and the office reads it on the ledger, filtered; pulling
 * the siblings in here would make a panel about one line into a report about
 * four, which is a different screen.
 */
function AppropriationDetail({
  appropriation,
  onClose,
  onEdit,
  onPrintForm,
}: {
  appropriation: Appropriation | null;
  onClose: () => void;
  onEdit?: (a: Appropriation) => void;
  /** Reprint the Augmentation Form of a posted augmentation. Patch 116. */
  onPrintForm?: (a: Appropriation) => void;
}) {
  if (!appropriation) return null;
  const a = appropriation;
  const byProgramme = !a.accountCode;
  const why = appropriationNotEditableBecause(a);

  const rows: Array<[string, React.ReactNode]> = [
    ['Type', a.kind === 'REALIGNMENT' && a.instrument === 'AUGMENTATION' ? 'Augmentation' : KIND_LABELS[a.kind] ?? a.kind],
    ['Office', a.officeName],
    [
      byProgramme ? 'Programme or project' : 'Object of expenditure',
      byProgramme ? `${a.fppCode} ${a.fppName}` : `${a.accountCode} ${a.accountName}`,
    ],
    ['Expense class', EXPENSE_CLASS_LABELS[a.expenseClass as ExpenseClass] ?? a.expenseClass],
    ['Sector', a.sector || '-'],
    ...(a.serviceSector ? ([['Service sector', a.serviceSector]] as Array<[string, React.ReactNode]>) : []),
    ['Amount', formatPeso(a.amount)],
    ['Authority', a.authorityReference || '(none recorded)'],
    ['Authority date', a.authorityDate ? formatShortDate(a.authorityDate) : '-'],
    ['Particulars', a.particulars || '-'],
    ['Recorded by', a.createdBy?.name ?? '-'],
    ...(a.approvedBy?.name
      ? ([['Approved by', a.approvedBy.name]] as Array<[string, React.ReactNode]>)
      : []),
    ...(a.importFileName
      ? ([['Loaded from', `${a.importFileName}, row ${a.importLineNo ?? '?'}`]] as Array<
          [string, React.ReactNode]
        >)
      : []),
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title="Appropriation line"
      description={`${a.officeName} - ${formatPeso(a.amount)}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {onPrintForm &&
            a.status === 'APPROVED' &&
            a.kind === 'REALIGNMENT' &&
            a.instrument === 'AUGMENTATION' && (
              <Button variant="secondary" onClick={() => onPrintForm(a)}>
                Print the Augmentation Form
              </Button>
            )}
          {onEdit && appropriationEditable(a) && (
            <Button variant="primary" onClick={() => onEdit(a)}>
              Edit
            </Button>
          )}
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <StatusBadge status={a.status} />
      </div>

      <dl className="divide-y divide-slate-100">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-3 gap-3 py-2">
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="col-span-2 text-sm text-navy-900">{value}</dd>
          </div>
        ))}
      </dl>

      {/* Why there is no Edit button, rather than only the absence of one. */}
      {why && !appropriationEditable(a) && (
        <Alert tone="info" className="mt-4">
          {why}
        </Alert>
      )}
    </Modal>
  );
}

function SummaryTile({
  label,
  amount,
  emphasis,
}: {
  label: string;
  amount: number;
  emphasis?: boolean;
}) {
  return (
    <div className={`cbo-card px-4 py-3 ${emphasis ? 'border-brand-300 bg-brand-50/40' : ''}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-base font-semibold tabular text-navy-900">
        {formatPeso(amount)}
      </p>
    </div>
  );
}

export function AppropriationForm({
  fiscalYear,
  fundCode,
  onClose,
  onSaved,
  actor,
  existing,
  draft,
  ordinance,
  inline,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onSaved: () => void;
  /**
   * Drawn in the page, in place of the lines it edits, rather than as a
   * window over it. Patch 125: on an act's page the form is part of the
   * Lines tab - Neil, "it should not be a pop-up window".
   */
  inline?: boolean;
  actor: ReturnType<typeof actorStamp> | null;
  /**
   * The draft being corrected, or nothing when recording a new one.
   *
   * One form for both, deliberately. A separate edit form would be the same
   * sixteen fields and the same eight validations written a second time, and
   * the second copy is the one that falls behind - the sector rule gets
   * tightened on the record form and not on the edit form, and a line that
   * could not be recorded can still be edited into existence.
   */
  existing?: Appropriation | null;
  /**
   * The prepared augmentation being corrected, or nothing.
   *
   * Never both this and `existing`: one is a single appropriation line, the
   * other a whole set of them, and the form is in one mode or the other.
   */
  draft?: AugmentationDraft | null;
  /**
   * The ordinance this line is being recorded INTO, from its own page.
   * Patch 119. The kind, the number and the date are the ordinance's and are
   * shown rather than asked; a line recorded here is approved with the rest
   * of the ordinance.
   */
  ordinance?: Ordinance | null;
}) {
  const toast = useToast();
  const editing = Boolean(existing);
  const editingDraft = Boolean(draft);
  const inOrdinance = Boolean(ordinance);
  /*
    A line can stop being editable while this form is open - another officer
    approves it from the same list a moment later. The row's Edit button is
    gone by then, but THIS form is not, and saving would fail at the database
    with a permission error that explains nothing. So the reason is read again
    here, shown in place of nothing, and the save is stopped.
  */
  const blockedReason = existing ? appropriationNotEditableBecause(existing) : null;
  const [kind, setKind] = useState<FormKind>(
    draft
      ? (draft.instrument as FormKind)
      : ((existing?.kind as FormKind | undefined) ?? (ordinance?.kind as FormKind | undefined) ?? 'ORIGINAL'),
  );
  const [authorityReference, setAuthorityReference] = useState(
    draft?.authorityReference ?? existing?.authorityReference ?? ordinance?.reference ?? '',
  );
  const [authorityDate, setAuthorityDate] = useState(
    draft?.authorityDate ?? existing?.authorityDate ?? ordinance?.date ?? todayPh(),
  );
  const [officeId, setOfficeId] = useState<string | null>(existing?.officeId ?? null);
  const [officeName, setOfficeName] = useState(existing?.officeName ?? '');
  const [accountCode, setAccountCode] = useState<string | null>(existing?.accountCode || null);
  const [accountName, setAccountName] = useState(existing?.accountName ?? '');
  /*
   * ---- WHAT THE ORDINANCE APPROPRIATED TO -----------------------------
   *
   * Two kinds of line, and until patch 86 this form could only record one.
   *
   * BY OBJECT. "Office Supplies Expenses, 150,000". The object code IS the
   * Function/Programme/Project, because the ordinance named no other thing to
   * appropriate to. This was hardcoded - `fppCode: accountCode` - and it is
   * right for exactly these lines.
   *
   * BY PROGRAMME. "Construction of Barangay Health Station, Payauan,
   * 2,000,000". The ordinance named a PROJECT and no object at all, and the
   * object becomes known later, when the obligation is raised against it.
   * `accountCode` is EMPTY on these, deliberately - budget control operates at
   * the level the appropriation was made at, and filling in a guess would
   * control the budget at a level the Sanggunian never set.
   *
   * CFMS has stored both shapes from the start; the ordinance UPLOAD loads
   * them correctly. Only this form could not, so a project-level line had to
   * go through a spreadsheet or not at all.
   */
  /*
    WHICH SHAPE A STORED LINE IS, read back the way it was written: a line
    appropriated by programme has an EMPTY accountCode on purpose, and its
    fppCode is the programme. Guessing from fppCode alone would misread an
    object line, whose fppCode is its own object code.
  */
  const [basis, setBasis] = useState<'OBJECT' | 'PROGRAMME'>(
    existing && !existing.accountCode ? 'PROGRAMME' : 'OBJECT',
  );
  const [programCode, setProgramCode] = useState<string | null>(
    existing && !existing.accountCode ? existing.fppCode ?? null : null,
  );
  const [programName, setProgramName] = useState(
    existing && !existing.accountCode ? existing.fppName ?? '' : '',
  );
  const programs = usePrograms();
  const yearPrograms = useMemo(
    () => programs.data.filter((p) => p.fiscalYear === fiscalYear),
    [programs.data, fiscalYear],
  );
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>(
    (existing?.expenseClass as ExpenseClass | undefined) ?? 'MOOE',
  );
  const [sector, setSector] = useState(existing?.sector ?? '');
  const [serviceSector, setServiceSector] = useState(existing?.serviceSector ?? '');
  const [amount, setAmount] = useState<number | null>(existing?.amount ?? null);
  const [particulars, setParticulars] = useState(existing?.particulars ?? '');
  const [saving, setSaving] = useState(false);
  const [realignLines, setRealignLines] = useState<RealignLine[]>(() =>
    draft?.lines?.length
      ? draft.lines.map((l) => ({
          ...blankLine(),
          officeId: l.officeId,
          officeName: l.officeName,
          lineId: l.lineId,
          fppCode: l.fppCode,
          fppName: l.fppName,
          sector: l.sector,
          serviceSector: l.serviceSector,
          accountCode: l.accountCode,
          accountName: l.accountName,
          expenseClass: l.expenseClass as ExpenseClass,
          amount: l.amount,
          particulars: l.particulars,
        }))
      : [blankLine(), blankLine()],
  );
  // The lines a realignment may move authority between: the ones that exist.
  const balances = useBudgetBalances(fiscalYear, fundCode);

  /** Both acts are recorded the same way: lines that come to zero. */
  const isRealignment = kind === 'REALIGNMENT' || kind === 'AUGMENTATION';
  /** Which of the two the user chose, which is now a single question. */
  const instrument: RealignmentInstrument =
    kind === 'AUGMENTATION' ? 'AUGMENTATION' : 'REALIGNMENT';
  /*
    Since patch 112 BOTH acts are prepared and posted on approval - the office
    asked for the realignment to be prepared first as well. `isAugmentation`
    remains for the one rule that differs: an augmentation may not cross an
    expense class.
  */
  const isAugmentation = kind === 'AUGMENTATION';
  const allowsNegative = isRealignment;
  /*
    NOT a non-null assertion any more, and the reason is worth the three lines.

    The form used to choose `kind` from this very list, so a match was certain.
    It now SEEDS it from a stored line, and AppropriationKind has a member the
    list does not offer - TRANSFER. One stored line of that kind and
    `selectedKind.label` would throw while rendering, which React answers by
    unmounting the tree: a white screen with nothing to report, exactly as the
    Bank Reconciliation did in patch 95.
  */
  const selectedKind =
    KINDS.find((k) => k.value === kind) ?? { value: kind, label: String(kind), hint: '' };

  const patchLine = (id: number, patch: Partial<RealignLine>) =>
    setRealignLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  /** Lines with something on them. A blank row the user never filled is not an error. */
  const filledLines = realignLines.filter((l) => l.officeId || l.lineId || l.amount);

  const incomplete = filledLines.filter((l) => !l.officeId || !l.lineId || !l.amount);

  /**
   * The same rule the upload screen and the server both run.
   *
   * It is evaluated on every keystroke so the figure the set is out by is on
   * screen while the amounts are being typed - which is when it can still be
   * fixed cheaply - rather than after a save that posts nothing.
   */
  const balance = useMemo(
    () =>
      filledLines.length === 0
        ? null
        : checkRealignmentSet(filledLines.map((l, i) => ({ lineNo: i + 1, amount: l.amount ?? 0 }))),
    [filledLines],
  );

  const takenUp = filledLines.filter((l) => (l.amount ?? 0) > 0).reduce((s2, l) => s2 + (l.amount ?? 0), 0);
  const givenUp = filledLines.filter((l) => (l.amount ?? 0) < 0).reduce((s2, l) => s2 + (l.amount ?? 0), 0);

  /**
   * An augmentation may only move savings within one expense class. The same
   * rule the server runs, shown here so the Budget Officer sees which classes
   * the set spans before sending rather than after.
   */
  const classCheck = useMemo(
    () =>
      isRealignment && instrument === 'AUGMENTATION' && filledLines.length > 0
        ? checkAugmentationExpenseClass(
            filledLines.map((l, i) => ({
              lineNo: i + 1,
              expenseClass: l.expenseClass,
              amount: l.amount ?? 0,
            })),
          )
        : null,
    [isRealignment, instrument, filledLines],
  );

  /**
   * Patch 128, corrected in 130: each source within its appropriation not
   * yet allotted (appropriation less allotment released; a hold counts as unallotted since patch 131). The same rule the engine runs at posting; here it is
   * shown while the amounts are typed, and saving is refused while it fails,
   * because no amount of finishing the draft later makes it possible.
   */
  const realignableCheck = useMemo(() => {
    if (!isRealignment || filledLines.length === 0) return null;
    const byLine = new Map<string, number>();
    for (const l of filledLines) {
      if (l.lineId) byLine.set(l.lineId, (byLine.get(l.lineId) ?? 0) + (l.amount ?? 0));
    }
    return checkRealignableBalances(
      [...byLine].map(([id, amount], i) => {
        const b = balances.data.find((x) => x.id === id);
        return {
          lineNo: i + 1,
          label: b
            ? `${b.accountCode || b.fppCode} ${b.accountName || b.fppName || ''} in ${b.officeName}`
            : id,
          amount,
          appropriationRevised: b?.appropriationRevised ?? 0,
          allotmentReleased: b?.allotmentReleased ?? 0,
          forLaterRelease: b?.forLaterRelease ?? 0,
        };
      }),
    );
  }, [isRealignment, filledLines, balances.data]);

  /**
   * ---------------------------------------------------------------------------
   * PREPARING AN AUGMENTATION OR A REALIGNMENT, rather than posting it
   * ---------------------------------------------------------------------------
   * Both land here, as one document per set. An augmentation has since patch
   * 103; a realignment since patch 112, at the office's request - it used to
   * post the moment this form was submitted, with nobody reading it back.
   *
   * THE SET IS NOT CHECKED HERE BEYOND HAVING A REFERENCE. A draft that must
   * balance before it can be saved is a draft you cannot leave half-done,
   * which is most of what a draft is for. The screen still shows the live
   * balance and the expense-class check while the amounts are typed, the
   * prepared list shows whether each set comes to zero, and the engine refuses
   * everything that is wrong at the moment of posting.
   */
  const savePreparedSet = async () => {
    if (!actor) return;
    /*
      THE AUTHORITY IS NOT NEEDED TO SAVE. Patch 118.

      It used to be refused here, and Neil met it as "why can it not be
      saved?" - the field shows a grey example, "Office Order No. 2026-__",
      which reads as filled in when it is empty. Worse, the order was wrong:
      since patch 116 the augmentation is PRINTED on LBE Form No. 2 and signed
      before it is approved, and the office order number may only exist once
      the Mayor has signed. So it is asked for where it matters - at approval,
      where the prepared list says it is missing and the engine refuses
      without it (`postingFromPreparedSet`).
    */
    if (realignableCheck && !realignableCheck.ok) {
      toast.error('More than the appropriation not yet allotted', realignableCheck.violations[0].message);
      return;
    }
    setSaving(true);
    try {
      const record = {
        fiscalYear,
        fundCode,
        instrument,
        authorityReference: authorityReference.trim(),
        authorityDate,
        lines: filledLines.map((l, i) => ({
          lineNo: i + 1,
          officeId: l.officeId,
          officeName: l.officeName,
          lineId: l.lineId,
          fppCode: l.fppCode,
          fppName: l.fppName,
          sector: l.sector,
          serviceSector: l.serviceSector,
          accountCode: l.accountCode,
          accountName: l.accountName,
          expenseClass: l.expenseClass,
          amount: l.amount ?? 0,
          particulars: l.particulars.trim(),
        })),
        status: 'DRAFT' as const,
      };

      if (draft) {
        await updateDraft(COL.augmentationDrafts, draft.id, record, actor);
      } else {
        await createDraft(COL.augmentationDrafts, record, actor);
      }
      onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (isRealignment) {
      if (editing) {
        toast.error(
          'A draft cannot become a realignment',
          'Close this, then prepare the realignment from its ordinance under Authorities.',
        );
        return;
      }
      return savePreparedSet();
    }
    const byProgramme = basis === 'PROGRAMME';

    if (!officeId || !amount || !actor) {
      toast.error('Incomplete', 'Office and amount are both required.');
      return;
    }
    if (byProgramme && !programCode) {
      toast.error(
        'Choose the programme',
        'A line appropriated by project or function has to name which one, or there is nothing for an obligation to be charged against.',
      );
      return;
    }
    if (!byProgramme && !accountCode) {
      toast.error('Choose the account', 'A line appropriated by object of expenditure needs its object code.');
      return;
    }
    /*
     * Personnel Services is appropriated by object, always - the engine's own
     * ordinance importer refuses a PS row with no object code, and a form that
     * accepted one here would create a line the upload would have rejected.
     */
    if (byProgramme && expenseClass === 'PS') {
      toast.error(
        'Personnel Services is appropriated by object of expenditure',
        'Salaries and the rest are named in the ordinance by their own object codes. Choose by object, or change the expense class.',
      );
      return;
    }
    const chosenSector = findSector(sector);
    if (!chosenSector) {
      toast.error('A sector is required', 'It is what decides where this line appears on the SRE.');
      return;
    }
    if (chosenSector.fundingSource) {
      const service = findSector(serviceSector);
      if (!service || service.fundingSource) {
        toast.error(
          `"${chosenSector.name}" is a funding source, not a service`,
          'Name the service sector this line delivers, or it cannot be placed on the SRE at all.',
        );
        return;
      }
    }
    // Patch 156: particulars are required on every entry.
    if (!particulars.trim()) {
      toast.error('Particulars are required', 'Say what this entry is for - it is printed on the reports.');
      return;
    }
    setSaving(true);
    try {
      /*
        The SAME payload either way, built once.

        The fields a correction may not touch are not omitted here - they are
        the ones this form never had: the status stays DRAFT, and createdBy,
        approvedBy and postedAt are protected by `firestore.rules` on every
        update. So an edit cannot quietly approve its own line, which is the
        thing worth being careful about on a screen that writes directly to
        the database rather than through the engine.
      */
      const record = {
          fiscalYear,
          fundCode,
          officeId,
          officeName,
          /*
           * On a line appropriated BY OBJECT the object code is the FPP: the
           * ordinance named nothing else to appropriate to. On one appropriated
           * BY PROGRAMME the FPP is the programme, and the object code is
           * EMPTY - not blank-for-now, empty on purpose. Budget control
           * operates at the level the appropriation was made at, and the object
           * becomes known when the obligation is raised.
           */
          fppCode: byProgramme ? programCode : accountCode,
          fppName: byProgramme ? programName : accountName,
          sector: chosenSector.name,
          serviceSector: chosenSector.fundingSource ? serviceSector : null,
          accountCode: byProgramme ? '' : accountCode,
          accountName: byProgramme ? '' : accountName,
          expenseClass,
          kind: storedKind(kind),
          authorityReference: authorityReference.trim() || null,
          /*
            The ordinance's lines are approved TOGETHER - "Approve all" on the
            ordinance and in the amber box above the ledger reads the lines by
            this. A line typed under a number joins the ones uploaded under
            it, which it did not before patch 119.
          */
          importReference: authorityReference.trim() || null,
          authorityDate,
          amount,
          particulars: particulars.trim() || null,
          status: 'DRAFT',
      };

      if (existing) {
        await updateDraft(COL.appropriations, existing.id, record, actor);
      } else {
        await createDraft(COL.appropriations, record, actor);
      }
      onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormFrame
      inline={inline}
      onClose={onClose}
      title={
        editingDraft
          ? `Correct this ${isAugmentation ? 'augmentation' : 'realignment'}`
          : editing
            ? 'Correct this appropriation'
            : isAugmentation
              ? 'Prepare an augmentation'
              : isRealignment
                ? 'Prepare a realignment'
                : 'Record an appropriation'
      }
      description={
        isRealignment
          ? 'Prepared, not posted. Nothing moves until it is approved - and every check on the set runs at that moment.'
          : editing
            ? 'It is still a draft, so it may be corrected in place. It stays a draft on save - approving it is a separate act.'
            : 'Saved as a draft. Approving it makes the authority available for allotment.'
      }
      size={isRealignment ? 'full' : 'lg'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={Boolean(blockedReason)}
            onClick={() => void save()}
          >
            {isRealignment
              ? editingDraft
                ? 'Save changes'
                : 'Save as prepared'
              : editing
                ? 'Save changes'
                : 'Save draft'}
          </Button>
        </>
      }
    >
      {blockedReason && (
        <Alert tone="warning" className="mb-4">
          This appropriation can no longer be corrected here. {blockedReason}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/*
          THE TYPE IS FIXED ONCE THE LINE EXISTS.

          Turning a draft Original into a Supplemental is not a correction, it
          is a claim that a different ordinance enacted it - and the two are
          reported separately and foot to different totals on the Appropriation
          Ledger. Record the right kind and delete this one.
        */}
        <Field
          label="Type"
          required={!editing && !editingDraft}
          htmlFor="kind"
          hint={
            editing || editingDraft
              ? 'Fixed once recorded. Discard and re-record to change it.'
              : selectedKind.hint
          }
        >
          {editing || editingDraft || inOrdinance ? (
            <div className="cbo-input flex items-center bg-slate-50 text-slate-600">
              {selectedKind.label}
            </div>
          ) : (
            <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as FormKind)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label={
              kind === 'AUGMENTATION' ? 'Authority of the Local Chief Executive' : 'Authority reference'
            }
            htmlFor="authority"
            required={false}
            hint={
              kind === 'AUGMENTATION'
                ? 'The office order or memorandum the Mayor signed it under'
                : kind === 'REALIGNMENT'
                  ? 'The ordinance of the Sanggunian authorising it'
                  : 'Ordinance or resolution number'
            }
          >
            {inOrdinance ? (
              <div className="cbo-input flex items-center bg-slate-50 text-slate-600">
                {authorityReference}
              </div>
            ) : (
              <TextInput
                id="authority"
                value={authorityReference}
                onChange={(e) => setAuthorityReference(e.target.value)}
                placeholder={kind === 'AUGMENTATION' ? 'Office Order No. 2026-__' : 'Ord. No. 2026-01'}
              />
            )}
          </Field>
          <Field label="Authority date" htmlFor="authorityDate">
            {inOrdinance ? (
              <div className="cbo-input flex items-center bg-slate-50 text-slate-600">
                {formatShortDate(authorityDate)}
              </div>
            ) : (
              <DateInput id="authorityDate" value={authorityDate} onChange={setAuthorityDate} />
            )}
          </Field>
        </div>

        {!isRealignment && (
          <Field label="Office" required htmlFor="office">
            <OfficePicker
              id="office"
              value={officeId}
              onChange={(v, o) => {
                setOfficeId(v);
                setOfficeName(o?.name ?? '');
              }}
            />
          </Field>
        )}

        {!isRealignment && (
          <>
            <Field
              label="Appropriated to"
              htmlFor="basis"
              hint="What the ordinance named on this line."
            >
              <Select
                id="basis"
                value={basis}
                onChange={(e) => setBasis(e.target.value as 'OBJECT' | 'PROGRAMME')}
              >
                <option value="OBJECT">An object of expenditure</option>
                <option value="PROGRAMME">A programme, project or function</option>
              </Select>
            </Field>

            {basis === 'OBJECT' ? (
              <Field label="Account" required htmlFor="account">
                <AccountPicker
                  id="account"
                  value={accountCode}
                  onChange={(code, account) => {
                    setAccountCode(code);
                    setAccountName(account?.name ?? '');
                  }}
                />
              </Field>
            ) : (
              <Field
                label="Programme"
                required
                htmlFor="programme"
                hint={
                  yearPrograms.length === 0
                    ? `No programmes are set up for ${fiscalYear} yet - add them on the Budget Programmes tab.`
                    : 'From the Budget Programmes tab. The same code next year is a separate programme.'
                }
              >
                <Combobox
                  id="programme"
                  options={yearPrograms.map((p) => ({
                    value: p.code,
                    code: p.code,
                    label: p.name,
                    detail: p.officeName ?? undefined,
                  }))}
                  value={programCode}
                  loading={programs.loading}
                  placeholder="Programme code or name"
                  emptyMessage={`No programme matches. Add it on the Budget Programmes tab for ${fiscalYear}.`}
                  onChange={(v, opt) => {
                    setProgramCode(v);
                    setProgramName(opt?.label ?? '');
                  }}
                />
              </Field>
            )}

            <Field label="Expense classification" htmlFor="expenseClass">
              <Select
                id="expenseClass"
                value={expenseClass}
                onChange={(e) => setExpenseClass(e.target.value as ExpenseClass)}
              >
                {(Object.keys(EXPENSE_CLASS_LABELS) as ExpenseClass[]).map((c) => (
                  <option key={c} value={c}>
                    {c} - {EXPENSE_CLASS_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Amount"
              required
              htmlFor="amount"
              hint={allowsNegative ? 'May be negative.' : undefined}
            >
              <AmountInput id="amount" value={amount} onChange={setAmount} allowNegative={allowsNegative} />
            </Field>

            <Field
              label="Sector"
              required
              htmlFor="sector"
              hint="Decides which of the four SRE expenditure buckets this line is reported in."
            >
              <Select id="sector" value={sector} onChange={(e) => setSector(e.target.value)}>
                <option value="">Choose a sector&hellip;</option>
                {SECTORS.map((sec) => (
                  <option key={sec.name} value={sec.name}>
                    {sec.name}
                    {sec.fundingSource ? ' (funding source)' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {findSector(sector)?.fundingSource && (
              <Field
                label="Service sector"
                required
                htmlFor="serviceSector"
                hint="A funding source is not a service. Name what this line actually delivers."
              >
                <Select
                  id="serviceSector"
                  value={serviceSector}
                  onChange={(e) => setServiceSector(e.target.value)}
                >
                  <option value="">Choose a service sector&hellip;</option>
                  {SERVICE_SECTORS.map((sec) => (
                    <option key={sec.name} value={sec.name}>
                      {sec.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="Particulars" required htmlFor="particulars" className="sm:col-span-2">
              <TextArea
                id="particulars"
                rows={2}
                value={particulars}
                onChange={(e) => setParticulars(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>

      {isRealignment && (
        <div className="mt-5">
          {/*
            The instrument selector that used to sit here is gone. It asked a
            second time what the Type at the top of the form already settled,
            and the two questions could disagree.
          */}
          {/*
            The two panels that explained Sections 336 and 321 and how the
            allotment moves were removed at the Budget Office's request in
            patch 110. The rules are unchanged - the engine still enforces the
            expense class, the authority and the savings, and its refusals say
            which rule a set broke. The Type's own hint names the act.
          */}
          {realignableCheck && !realignableCheck.ok && (
            <Alert tone="error" title="More than the appropriation not yet allotted" className="mb-4">
              {realignableCheck.violations.map((v) => (
                <p key={String(v.details?.lineNo)}>{v.message}</p>
              ))}
            </Alert>
          )}
          {classCheck && !classCheck.ok && (
            <Alert tone="error" title="An augmentation cannot cross an expense class" className="mb-4">
              {classCheck.violations[0].message}
            </Alert>
          )}

          <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-navy-900">The lines</p>
              <p className="text-xs text-slate-500">
                Take away with a negative amount, give with a positive one. The set must come to
                zero before it can be posted.
              </p>
            </div>
            <Button size="sm" onClick={() => setRealignLines((ls) => [...ls, blankLine()])}>
              Add a line
            </Button>
          </div>

          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-2 py-1.5 font-medium" style={{ minWidth: '16rem' }}>
                    Office
                  </th>
                  <th className="px-2 py-1.5 font-medium" style={{ minWidth: '26rem' }}>
                    Budget line (FPP)
                  </th>
                  <th className="px-2 py-1.5 font-medium" style={{ width: '5rem' }}>
                    Class
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" style={{ minWidth: '10rem' }}>
                    Amount
                  </th>
                  <th className="px-2 py-1.5 font-medium" style={{ minWidth: '14rem' }}>
                    Particulars
                  </th>
                  <th className="w-8 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {realignLines.map((line) => (
                  <tr key={line.id} className="align-top">
                    <td className="px-2 py-1.5">
                      <OfficePicker
                        value={line.officeId}
                        onChange={(v, o) =>
                          // A budget line belongs to one office, so changing
                          // the office clears the line rather than leaving
                          // another office's line selected under this name.
                          patchLine(line.id, {
                            officeId: v,
                            officeName: o?.name ?? '',
                            lineId: null,
                            fppCode: '',
                            accountCode: '',
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <BudgetLinePicker
                        balances={balances.data}
                        measure="unallotted"
                        officeId={line.officeId}
                        value={line.lineId}
                        onChange={(id, chosen) =>
                          patchLine(line.id, {
                            lineId: id,
                            fppCode: chosen?.fppCode ?? '',
                            fppName: chosen?.fppName ?? '',
                            sector: chosen?.sector ?? '',
                            serviceSector: chosen?.serviceSector ?? '',
                            accountCode: chosen?.accountCode ?? '',
                            accountName: chosen?.accountName ?? '',
                            expenseClass: chosen?.expenseClass ?? line.expenseClass,
                          })
                        }
                      />
                    </td>
                    {/*
                      The class is the budget line's own, shown rather than
                      chosen. It was a dropdown too narrow to show its value -
                      a blank box beside each line - and a class picked apart
                      from the line could only ever disagree with it.
                    */}
                    <td className="px-2 py-1.5 align-middle">
                      <span
                        className="text-sm font-medium text-navy-900"
                        title={EXPENSE_CLASS_LABELS[line.expenseClass as ExpenseClass]}
                      >
                        {line.lineId ? line.expenseClass : '-'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <AmountInput
                        value={line.amount}
                        onChange={(v) => patchLine(line.id, { amount: v })}
                        allowNegative
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <TextInput
                        value={line.particulars}
                        onChange={(e) => patchLine(line.id, { particulars: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        // Two is the floor, not a convenience: a realignment
                        // with one line left on screen is the shape the rule
                        // exists to refuse, and letting it be built invites
                        // the question of why it will not post.
                        disabled={realignLines.length <= 2}
                        onClick={() =>
                          setRealignLines((ls) => ls.filter((l) => l.id !== line.id))
                        }
                        title={
                          realignLines.length <= 2
                            ? 'A realignment needs at least two lines.'
                            : 'Remove this line'
                        }
                      >
                        &times;
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
            <span className="text-slate-600">
              Given up{' '}
              <strong className="cbo-amount">{formatPeso(Math.abs(givenUp))}</strong> &middot; taken
              up <strong className="cbo-amount">{formatPeso(takenUp)}</strong>
            </span>
            {balance?.ok ? (
              <span className="font-medium text-emerald-700">
                Balanced. The total appropriation of the fund does not change.
              </span>
            ) : balance ? (
              <span className="font-medium text-rose-700">{balance.violations[0].message}</span>
            ) : (
              <span className="text-slate-500">Nothing entered yet.</span>
            )}
          </div>

          {incomplete.length > 0 && (
            <Alert tone="warning" className="mt-2">
              {incomplete.length} line{incomplete.length === 1 ? '' : 's'} still{' '}
              {incomplete.length === 1 ? 'needs' : 'need'} an office, an account and an amount.
            </Alert>
          )}

          {!authorityReference.trim() && (
            <Alert tone="info" className="mt-2">
              {kind === 'AUGMENTATION'
                ? 'No authority entered yet. It can be saved without one, and added after the Mayor signs. It must be filled in before the augmentation can be approved - it is what stops the same augmentation being posted twice.'
                : 'No ordinance number entered yet. It can be saved without one, but it must be filled in before the realignment can be approved - it is what stops the same ordinance being posted twice.'}
            </Alert>
          )}
        </div>
      )}

    </FormFrame>
  );
}

/**
 * The form's frame: a window over the page, or - `inline` - a panel in it,
 * with the same title, description and buttons. Patch 125.
 */
function FormFrame({
  inline,
  onClose,
  title,
  description,
  size,
  footer,
  children,
}: {
  inline?: boolean;
  onClose: () => void;
  title: string;
  description: string;
  size: 'full' | 'lg';
  footer: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (inline) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [inline]);
  if (!inline) {
    return (
      <Modal open onClose={onClose} title={title} description={description} size={size} footer={footer}>
        {children}
      </Modal>
    );
  }
  return (
    <section ref={ref} className="cbo-card mb-4 border-brand-300 ring-1 ring-brand-200" aria-label={title}>
      <header className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-base font-semibold text-navy-900">{title}</h2>
        <p className="mt-0.5 text-sm text-slate-600">{description}</p>
      </header>
      <div className="px-5 py-4">{children}</div>
      <footer className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</footer>
    </section>
  );
}
