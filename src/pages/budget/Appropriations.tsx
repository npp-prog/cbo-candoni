import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, Select, DateInput, AmountInput, TextArea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, OfficePicker } from '@/components/pickers';
import { BudgetLinePicker } from '@/components/pickers/BudgetLinePicker';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAppropriations, useBudgetBalances } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import {
  checkAugmentationExpenseClass,
  checkRealignmentSet,
  type RealignmentInstrument,
} from '@/lib/accounting-rules';
import { SECTORS, SERVICE_SECTORS, findSector } from '@/lib/sectors';
import { formatShortDate, todayPh } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { Appropriation, AppropriationKind } from '@/types/budget';
import { fundLabel } from './Obligations';

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
const KINDS: Array<{ value: AppropriationKind; label: string; hint: string }> = [
  { value: 'ORIGINAL', label: 'Original', hint: 'The annual budget as enacted.' },
  { value: 'SUPPLEMENTAL', label: 'Supplemental', hint: 'Additional authority enacted during the year.' },
  { value: 'CONTINUING', label: 'Continuing', hint: 'Prior-year authority carried forward.' },
  {
    value: 'REALIGNMENT',
    label: 'Realignment',
    hint: 'Two or more lines that come to zero. Take away with a negative amount, give with a positive one.',
  },
  { value: 'ADJUSTMENT', label: 'Adjustment', hint: 'A correction. May be negative.' },
];

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

  const [showForm, setShowForm] = useState(false);
  const [approving, setApproving] = useState<Appropriation | null>(null);
  const [busy, setBusy] = useState(false);

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
        `${formatPeso(appropriation.amount)} of authority is now available for allotment against ${appropriation.accountCode}.`,
      );
      setApproving(null);
    } catch (err) {
      toast.error('Could not approve', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Appropriation>[] = [
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
              {a.instrument === 'AUGMENTATION' ? 'Augmentation (Sec. 336)' : 'Supplemental (Sec. 321)'}
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
      header: 'Account',
      value: (a) => `${a.accountCode} ${a.accountName}`,
      cell: (a) => (
        <div>
          <span className="font-mono text-xs text-slate-500">{a.accountCode}</span>{' '}
          <span className="text-sm">{a.accountName}</span>
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
        </div>
      ),
      fixed: true,
      sortable: false,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Appropriations"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Appropriation' }]}
        actions={
          can('budget', 'create') && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => navigate('/budget/appropriations/upload')}>
                Upload ordinance
              </Button>
              (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              Record appropriation
            </Button>
            </div>
          )
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryTile label="Original" amount={totals.original} />
        <SummaryTile label="Supplemental" amount={totals.supplemental} />
        <SummaryTile label="Continuing" amount={totals.continuing} />
        <SummaryTile label="Realignments and adjustments" amount={totals.adjustments} />
        <SummaryTile label="Revised appropriation" amount={totals.revised} emphasis />
      </div>

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(a) => a.id}
        loading={loading}
        error={error}
        searchPlaceholder="Account, office or authority reference"
        emptyTitle="No appropriations recorded"
        emptyMessage={`Record the enacted budget for the ${fundLabel(fundCode)} before releasing allotments.`}
        exportMeta={{
          title: 'Appropriation Ledger',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <AppropriationForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Appropriation saved as a draft', 'Approve it to make the authority available.');
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
            <p>
              This makes <strong>{formatPeso(approving.amount)}</strong> of spending authority
              available against {approving.accountCode} {approving.accountName} for{' '}
              {approving.officeName}. An approved appropriation cannot be edited; a change is made
              by recording a supplemental appropriation or an adjustment.
            </p>
          )
        }
      />
    </div>
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

function AppropriationForm({
  fiscalYear,
  fundCode,
  onClose,
  onSaved,
  actor,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onSaved: () => void;
  actor: ReturnType<typeof actorStamp> | null;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<AppropriationKind>('ORIGINAL');
  const [authorityReference, setAuthorityReference] = useState('');
  const [authorityDate, setAuthorityDate] = useState(todayPh());
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [accountCode, setAccountCode] = useState<string | null>(null);
  const [accountName, setAccountName] = useState('');
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>('MOOE');
  const [sector, setSector] = useState('');
  const [serviceSector, setServiceSector] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [particulars, setParticulars] = useState('');
  const [saving, setSaving] = useState(false);
  const [realignLines, setRealignLines] = useState<RealignLine[]>(() => [blankLine(), blankLine()]);
  const [instrument, setInstrument] = useState<RealignmentInstrument>('AUGMENTATION');
  // The lines a realignment may move authority between: the ones that exist.
  const balances = useBudgetBalances(fiscalYear, fundCode);

  const isRealignment = kind === 'REALIGNMENT';
  const allowsNegative = kind === 'ADJUSTMENT' || isRealignment;
  const selectedKind = KINDS.find((k) => k.value === kind)!;

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

  const realignmentReady =
    isRealignment &&
    incomplete.length === 0 &&
    balance !== null &&
    balance.ok &&
    (classCheck === null || classCheck.ok) &&
    authorityReference.trim().length > 0;

  /**
   * Posting a realignment.
   *
   * It goes through the same server call the upload screen uses, and that is
   * the point rather than a shortcut. That call already resolves every office
   * and account against master data, sums two rows that fall on the same
   * budget line, refuses to drive any line negative or below the allotments
   * already released, checks the set comes to zero, and writes the whole thing
   * in one transaction. A second path that did nine-tenths of that would be a
   * second set of rules to keep in step, and the tenth would be the one that
   * mattered.
   *
   * A realignment is therefore posted, not saved as a draft. There is no
   * half-way state to leave it in: the lines land together or none of them
   * does.
   */
  const postRealignment = async () => {
    setSaving(true);
    try {
      const res = await engine.importBudgetLines({
        kind: 'APPROPRIATION',
        fiscalYear,
        fundCode,
        appropriationKind: 'REALIGNMENT',
        instrument,
        reference: authorityReference.trim(),
        date: authorityDate,
        fileName: 'Recorded on screen',
        rows: filledLines.map((l, i) => ({
          lineNo: i + 1,
          office: l.officeName,
          fpp: l.fppCode,
          fppName: l.fppName || undefined,
          sector: l.sector,
          serviceSector: l.serviceSector || undefined,
          accountCode: l.accountCode || undefined,
          expenseClass: l.expenseClass,
          amount: l.amount as number,
          particulars: l.particulars.trim() || undefined,
        })),
      });
      toast.success(
        'Realignment posted',
        `${res.posted} line${res.posted === 1 ? '' : 's'}. The total appropriation of the fund is unchanged.`,
      );
      onSaved();
    } catch (err) {
      toast.error('Nothing was posted', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (isRealignment) return postRealignment();
    if (!officeId || !accountCode || !amount || !actor) {
      toast.error('Incomplete', 'Office, account and amount are all required.');
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
    setSaving(true);
    try {
      await createDraft(
        COL.appropriations,
        {
          fiscalYear,
          fundCode,
          officeId,
          officeName,
          // Recorded one line at a time, this form appropriates by object of
          // expenditure, so the object code IS the FPP. A project-level
          // appropriation has no object code and is loaded from the annex,
          // where the FPP is the project.
          fppCode: accountCode,
          fppName: accountName,
          sector: chosenSector.name,
          serviceSector: chosenSector.fundingSource ? serviceSector : null,
          accountCode,
          accountName,
          expenseClass,
          kind,
          authorityReference: authorityReference.trim() || null,
          authorityDate,
          amount,
          particulars: particulars.trim() || null,
          status: 'DRAFT',
        },
        actor,
      );
      onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isRealignment ? 'Record a realignment' : 'Record an appropriation'}
      description={
        isRealignment
          ? 'Posted whole, not saved as a draft. There is no half-way state for a realignment to sit in.'
          : 'Saved as a draft. Approving it makes the authority available for allotment.'
      }
      size={isRealignment ? 'xl' : 'lg'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={isRealignment && !realignmentReady}
            onClick={() => void save()}
          >
            {isRealignment ? 'Post realignment' : 'Save draft'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" required htmlFor="kind" hint={selectedKind.hint}>
          <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as AppropriationKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Authority reference"
            htmlFor="authority"
            required={isRealignment}
            hint="Ordinance or resolution number"
          >
            <TextInput
              id="authority"
              value={authorityReference}
              onChange={(e) => setAuthorityReference(e.target.value)}
              placeholder="Ord. No. 2026-01"
            />
          </Field>
          <Field label="Authority date" htmlFor="authorityDate">
            <DateInput id="authorityDate" value={authorityDate} onChange={setAuthorityDate} />
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

            <Field label="Particulars" htmlFor="particulars" className="sm:col-span-2">
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
          <Field
            label="Under which instrument"
            required
            htmlFor="instrument"
            className="mb-4 max-w-xl"
            hint={
              instrument === 'AUGMENTATION'
                ? 'Section 336. No ordinance is needed where the annual budget carries the omnibus authority — and it may only move savings within ONE expense class.'
                : 'Section 321. An ordinance of the Sanggunian, which may move authority across expense classes.'
            }
          >
            <Select
              id="instrument"
              value={instrument}
              onChange={(e) => setInstrument(e.target.value as RealignmentInstrument)}
            >
              <option value="AUGMENTATION">Augmentation, under the omnibus authority</option>
              <option value="SUPPLEMENTAL">Supplemental budget, by ordinance</option>
            </Select>
          </Field>

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
                  <th className="px-2 py-1.5 font-medium" style={{ minWidth: '12rem' }}>
                    Office
                  </th>
                  <th className="px-2 py-1.5 font-medium" style={{ minWidth: '18rem' }}>
                    Budget line (FPP)
                  </th>
                  <th className="px-2 py-1.5 font-medium" style={{ width: '6rem' }}>
                    Class
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" style={{ minWidth: '9rem' }}>
                    Amount
                  </th>
                  <th className="px-2 py-1.5 font-medium" style={{ minWidth: '10rem' }}>
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
                    <td className="px-2 py-1.5">
                      <Select
                        value={line.expenseClass}
                        onChange={(e) =>
                          patchLine(line.id, { expenseClass: e.target.value as ExpenseClass })
                        }
                      >
                        {(Object.keys(EXPENSE_CLASS_LABELS) as ExpenseClass[]).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </Select>
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
            <Alert tone="warning" className="mt-2">
              The authority reference is required for a realignment. It is what stops the same
              ordinance being posted twice.
            </Alert>
          )}
        </div>
      )}

      {allowsNegative && (
        <Alert tone="info" className="mt-4">
          A realignment or transfer is recorded as two entries of equal size and opposite sign: a
          negative one against the line the authority comes from, and a positive one against the
          line it goes to. Record both, so the fund total is unchanged.
        </Alert>
      )}
    </Modal>
  );
}
