import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput, TextArea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { OfficePicker } from '@/components/pickers';
import { BudgetLinePicker } from '@/components/pickers/BudgetLinePicker';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useAllotments,
  useAroDrafts,
  useBudgetBalances,
  useEstimatedReceipts,
  useCollections,
} from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { allotmentWaiting } from '@/lib/budgetEditable';
import { engine } from '@/lib/engine';
import { appropriationLineLabel } from '@/lib/budgetLines';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { checkAllotmentWithdrawal } from '@/lib/accounting-rules';
import { type Allotment } from '@/types/budget';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import { fundLabel } from './Obligations';
import AllotmentReleaseOrders, { preparedSheet, type AroOrdersHandle } from './AllotmentReleaseOrders';
import { AllotmentDetail, KIND_NOTE, type DetailActions } from './AllotmentDetail';
import { AroPrintSheet, usePrintSheet, formOf, type AroSheet } from './AroPrint';
import {
  buildAllotmentRegister,
  budgetLineText,
  laterReleasesOf,
  type RegisterRow,
} from './allotmentRegister';

/**
 * The Allotment Register, and the withdrawal of allotment.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN STOPPED DOING
 * ---------------------------------------------------------------------------
 * It used to release allotment, one line at a time, with no order number, no
 * purpose and no approval by the Local Chief Executive. The Budget Operations
 * Manual has no such instrument: an allotment is released on an Allotment
 * Release Order, and there is no other way.
 *
 * Worse than duplication, it was a way round the control. The single-line
 * release did not read the For Later Release hold at all, so an amount the
 * Budget Officer had deliberately withheld could be released straight through
 * here - silently, because everything else still footed. A safeguard with a
 * door beside it is not a safeguard, and two menu items that both said
 * "allotment" made it impossible to tell which door you were standing in.
 *
 * So releasing lives on Budget › Allotment Release Orders, and this is the
 * register: every line released, the order it came from, and the one act that
 * genuinely is not an order - taking allotment back.
 *
 * ---------------------------------------------------------------------------
 * WHY A WITHDRAWAL IS NOT AN ORDER
 * ---------------------------------------------------------------------------
 * An Allotment Release Order gives authority. A withdrawal takes it back, and
 * it is checked against a different thing: not what the appropriation allows,
 * but what has already been obligated against the allotment being withdrawn.
 * Authority cannot be pulled out from under a commitment already made.
 */
export default function Allotments() {
  const { fiscalYear, fundCode } = useFilters();
  const navigate = useNavigate();
  const { can, hasRole } = useAuth();
  const toast = useToast();
  const { data, loading, error } = useAllotments(fiscalYear, fundCode);

  const [showForm, setShowForm] = useState(false);
  /*
    The release-order builder, which lives in AllotmentReleaseOrders but is
    opened from this page's header - so the state behind the button is here.
  */
  const [building, setBuilding] = useState(false);
  /** The held allotment line whose release window is open. */
  const [releasing, setReleasing] = useState<Allotment | null>(null);
  const [approving, setApproving] = useState<Allotment | null>(null);
  const [busy, setBusy] = useState(false);
  /** The order being printed - issued, or prepared and waiting. */
  const [sheet, setSheet] = useState<AroSheet | null>(null);
  const clearSheet = useCallback(() => setSheet(null), []);
  usePrintSheet(sheet, clearSheet);

  const totalReleased = useMemo(
    () => data.filter((a) => a.status === 'APPROVED').reduce((s, a) => s + a.amount, 0),
    [data],
  );

  const approveWithdrawal = async (allotment: Allotment) => {
    setBusy(true);
    try {
      const result = await engine.releaseAllotment({ allotmentId: allotment.id });
      toast.success(
        `Withdrawal ${result.allotmentNo} recorded`,
        `${formatPeso(Math.abs(allotment.amount))} taken back from ${appropriationLineLabel(allotment)}.`,
      );
      setApproving(null);
    } catch (err) {
      toast.error('The withdrawal was not recorded', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /*
    ONE REGISTER, patch 112 - and since patch 113 the prepared orders are in
    it too, marked Prepared, where they used to sit in a box of their own
    above it. A row is a document: a prepared order, an issued order with its
    lines inside it, a later release, a withdrawal. See allotmentRegister.ts.
  */
  const prepared = useAroDrafts(fiscalYear, fundCode);
  const register = useMemo(
    () => buildAllotmentRegister(data, prepared.data),
    [data, prepared.data],
  );

  /* Who may do what to a prepared order. The engine enforces both. */
  const canPrepare = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER', 'BUDGET_STAFF');
  const canApproveOrder = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER');
  /* The builder and the two confirmations live in AllotmentReleaseOrders. */
  const orders = useRef<AroOrdersHandle>(null);

  /** The row whose detail is open - clicking a row opens it. */
  const [viewing, setViewing] = useState<RegisterRow | null>(null);

  /** The order as it goes on paper: issued as issued, prepared with no number. */
  const sheetOf = (r: RegisterRow): AroSheet =>
    r.draft
      ? preparedSheet(r.draft)
      : {
          aroNo: r.reference,
          date: r.date,
          expenseClass: r.expenseClass,
          purpose: r.purpose,
          fundCode,
          fiscalYear,
          prepared: false,
          lines: r.lines.map((l) => ({
            key: l.key,
            officeName: l.officeName,
            fppCode: l.fppCode,
            fppName: l.fppName,
            accountCode: l.accountCode,
            accountName: l.accountName,
            released: l.amount,
            // As the order was issued - not what is left after a later release.
            held: l.heldAtIssue,
          })),
        };

  /**
   * Every act a row offers, in one place, so the row's buttons and the
   * detail panel's cannot drift apart. Each closes the panel first: the
   * window it opens - the builder, a confirmation - belongs on top.
   */
  const actionsFor = (r: RegisterRow): DetailActions => {
    const then = (fn: () => void) => () => {
      setViewing(null);
      fn();
    };
    const d = r.draft;
    return {
      print: r.kind === 'ORDER' || r.kind === 'PREPARED' ? then(() => setSheet(sheetOf(r))) : undefined,
      edit: d && canPrepare ? then(() => orders.current?.edit(d)) : undefined,
      discard: d && canPrepare ? then(() => orders.current?.discard(d)) : undefined,
      approve:
        d && canApproveOrder
          ? then(() => orders.current?.approve(d))
          : r.kind === 'WITHDRAWAL' && allotmentWaiting(r.allotments[0]) && can('budget', 'approve')
            ? then(() => setApproving(r.allotments[0]))
            : undefined,
      releaseHeld: can('budget', 'approve') ? (line) => then(() => setReleasing(line))() : undefined,
    };
  };

  const columns: Column<RegisterRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      width: '11rem',
      value: (r) => `${r.reference} ${KIND_NOTE[r.kind]}`,
      cell: (r) => (
        <div>
          {r.reference ? (
            <span className="font-mono text-xs">{r.reference}</span>
          ) : (
            <span className="text-xs italic text-slate-500">
              {r.kind === 'PREPARED' ? 'Number on approval' : 'Draft'}
            </span>
          )}
          {/*
            What kind of document this is. A line with no order came from a
            bulk upload before orders existed, and saying so is the point: it
            is the one thing on this register an auditor cannot trace to a form.
          */}
          <span className="block text-2xs text-slate-500">{KIND_NOTE[r.kind]}</span>
        </div>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (r) => r.date,
      cell: (r) => <span className="text-xs">{formatShortDate(r.date)}</span>,
    },
    {
      key: 'form',
      header: 'Form',
      width: '10rem',
      value: (r) =>
        r.kind === 'ORDER' || r.kind === 'PREPARED' ? formOf(r.expenseClass) : r.expenseClass,
      cell: (r) => {
        const isOrder = r.kind === 'ORDER' || r.kind === 'PREPARED';
        return (
          <div>
            {isOrder && <span className="text-xs">{formOf(r.expenseClass)}</span>}
            <span className={isOrder ? 'block text-2xs text-slate-500' : 'text-xs'}>
              {EXPENSE_CLASS_LABELS[r.expenseClass as ExpenseClass] ?? r.expenseClass}
            </span>
          </div>
        );
      },
    },
    {
      key: 'purpose',
      header: 'Purpose',
      value: (r) => r.purpose,
      cell: (r) => <span className="text-xs">{r.purpose}</span>,
    },
    {
      key: 'lines',
      header: 'Office and budget line',
      value: (r) =>
        r.lines
          .map((l) => {
            const b = budgetLineText(l);
            return `${l.officeName} ${b.code} ${b.name} ${l.fppCode}`;
          })
          .join('; '),
      cell: (r) => (
        <ul className="space-y-1">
          {r.lines.map((l) => {
            const b = budgetLineText(l);
            return (
              <li key={l.key} className="text-xs">
                <span className="text-slate-600">{l.officeName}</span>
                <span className="block">
                  {b.code && <span className="font-mono text-2xs text-slate-500">{b.code} </span>}
                  {b.name}
                  {!b.code && <span className="text-2xs text-slate-500"> (programme)</span>}
                  {r.lines.length > 1 && (
                    <span className="ml-2 font-mono text-2xs text-slate-500">
                      {formatPeso(l.amount, { symbol: false })}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ),
    },
    {
      key: 'released',
      header: 'Released',
      kind: 'amount',
      width: '9rem',
      value: (r) => r.released,
      cell: (r) => (
        <div>
          <span
            className={
              r.released < 0 ? 'text-rose-700' : r.kind === 'PREPARED' ? 'text-slate-500' : undefined
            }
          >
            {formatPeso(r.released, { symbol: false, parens: true })}
          </span>
          {/* Not released until approved, and not in the total above. */}
          {r.kind === 'PREPARED' && (
            <span className="block text-2xs font-normal text-slate-500">to release</span>
          )}
        </div>
      ),
    },
    {
      key: 'held',
      header: 'For later release',
      kind: 'amount',
      width: '9rem',
      value: (r) => r.heldAtIssue,
      cell: (r) =>
        r.heldAtIssue > 0 ? (
          <div>
            <span>{formatPeso(r.heldAtIssue, { symbol: false })}</span>
            {r.stillHeld !== r.heldAtIssue && (
              <span className="block text-2xs font-normal text-slate-500">
                {r.stillHeld > 0
                  ? `${formatPeso(r.stillHeld, { symbol: false })} still held`
                  : 'all released since'}
              </span>
            )}
          </div>
        ) : (
          <span className="text-slate-400">-</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      value: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'actions',
      header: '',
      width: '13rem',
      fixed: true,
      sortable: false,
      cell: (r) => {
        const act = actionsFor(r);
        /*
          The row opens its detail when clicked, so every button here stops
          the click going on to the row - otherwise Approve would also open
          the panel behind its own confirmation. See check-rules section 40.
        */
        return (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {act.print && (
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  act.print?.();
                }}
              >
                Print
              </Button>
            )}
            {act.edit && (
              <Button
                size="sm"
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  act.edit?.();
                }}
              >
                Edit
              </Button>
            )}
            {act.approve && (
              <Button
                size="sm"
                variant="primary"
                onClick={(e) => {
                  e.stopPropagation();
                  act.approve?.();
                }}
              >
                Approve
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
    {/* Everything on screen steps aside while an order prints, so the order
        comes out alone - it used to print with the register under it. */}
    <div className={sheet ? 'no-print' : undefined}>
      <PageHeader
        title="Allotments"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - ${formatPeso(totalReleased)} released`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Allotments' }]}
        actions={
          can('budget', 'create') && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate('/budget/allotments/upload')}
              >
                Bulk upload
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowForm(true)}>
                Withdraw allotment
              </Button>
              {/* Releasing is the thing this page is most often opened to do,
                  so it is the primary button. It used to be a whole screen
                  away. */}
              {!building && (
                <Button variant="primary" size="sm" onClick={() => setBuilding(true)}>
                  Prepare a release order
                </Button>
              )}
            </div>
          )
        }
      />

      {/*
        Preparing an order, and the orders prepared and waiting for the Budget
        Officer, sit above the register. Once approved, an order is a row of
        the register below - with its lines inside it. There used to be a
        table of orders here AND a table of their lines under it, each order
        appearing in both; patch 112 made them one.
      */}
      <AllotmentReleaseOrders
        ref={orders}
        embedded
        building={building}
        onBuildingChange={setBuilding}
      />

      <DataTable
        rows={register}
        columns={columns}
        rowKey={(r) => r.key}
        onRowClick={(r) => setViewing(r)}
        loading={loading}
        error={error}
        searchPlaceholder="ARO number, purpose, office or budget line"
        emptyTitle="No allotments released"
        emptyMessage="Offices cannot obligate until allotments are released against the approved appropriations."
        exportMeta={{
          title: 'Allotment Ledger',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {releasing && (
        <ReleaseHeldForm
          allotment={releasing}
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setReleasing(null)}
        />
      )}

      {showForm && (
        <AllotmentForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success(
              'Withdrawal saved as a draft',
              'Approve it to take the allotment back.',
            );
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(approving)}
        onCancel={() => setApproving(null)}
        onConfirm={() => {
          if (approving) void approveWithdrawal(approving);
        }}
        loading={busy}
        title="Withdraw allotment"
        confirmLabel="Withdraw"
        variant="danger"
        message={
          approving && (
            <p>
              This takes <strong>{formatPeso(Math.abs(approving.amount))}</strong> of allotment back
              from {appropriationLineLabel(approving)} for {approving.officeName}. The
              server re-checks what has already been obligated against this line first: authority
              cannot be pulled out from under a commitment already made.
            </p>
          )
        }
      />
    </div>
    <AllotmentDetail
      row={viewing}
      laterReleases={viewing && viewing.kind === 'ORDER' ? laterReleasesOf(viewing, register) : []}
      actions={viewing ? actionsFor(viewing) : {}}
      onClose={() => setViewing(null)}
    />
    {sheet && <AroPrintSheet sheet={sheet} />}
    </>
  );
}

function AllotmentForm({
  fiscalYear,
  fundCode,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();
  const balances = useBudgetBalances(fiscalYear, fundCode);

  const [allotmentDate, setAllotmentDate] = useState(todayPh());
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>('MOOE');
  const [amount, setAmount] = useState<number | null>(null);
  const [particulars, setParticulars] = useState('');
  const [saving, setSaving] = useState(false);

  /**
   * The appropriated line being drawn on, by its balance document id.
   *
   * The office and the account used to be typed separately, which let a
   * combination that was never appropriated be built - and it failed with
   * "insufficient allotment", which reads as a budget problem rather than as
   * "there is no such line". Now the line is chosen from the ones that exist.
   */
  const [lineId, setLineId] = useState<string | null>(null);
  const balance = useMemo(
    () => balances.data.find((b) => b.id === lineId) ?? null,
    [lineId, balances.data],
  );
  const accountCode = balance?.accountCode ?? null;
  const accountName = balance?.accountName ?? '';

  /**
   * A withdrawal is checked against what has been OBLIGATED, not against the
   * appropriation.
   *
   * The appropriation is not the question here: the money has already been
   * released, and the only thing that can stop it being taken back is a
   * commitment already made against it.
   *
   * The amount is entered as a positive figure and sent as a negative one.
   * The field used to say "enter a negative amount to withdraw allotment",
   * which put a minus sign between the officer and the act.
   */
  const check = useMemo(() => {
    if (!balance || !amount || amount <= 0) return null;
    return checkAllotmentWithdrawal({
      allotmentAlreadyReleased: balance.allotmentReleased,
      obligated: balance.obligated,
      requestedWithdrawal: -amount,
    });
  }, [balance, amount]);

  const save = async () => {
    if (!officeId || !balance || !amount || !user) {
      toast.error('Incomplete', 'An office, a budget line and an amount are all required.');
      return;
    }
    setSaving(true);
    try {
      await createDraft(
        COL.allotments,
        {
          fiscalYear,
          fundCode,
          allotmentDate,
          officeId,
          officeName,
          fppCode: balance.fppCode,
          fppName: balance.fppName ?? '',
          sector: balance.sector ?? null,
          serviceSector: balance.serviceSector ?? null,
          accountCode: accountCode ?? '',
          accountName,
          expenseClass,
          // Stored negative: a withdrawal reduces the allotment released.
          amount: -amount,
          particulars: particulars.trim() || null,
          status: 'DRAFT',
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
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
      title="Withdraw allotment"
      description="Saved as a draft. Approving it takes the allotment back from the office."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" required htmlFor="allotmentDate">
          <DateInput id="allotmentDate" value={allotmentDate} onChange={setAllotmentDate} />
        </Field>

        <Field label="Expense classification" htmlFor="ec">
          <Select id="ec" value={expenseClass} onChange={(e) => setExpenseClass(e.target.value as ExpenseClass)}>
            {(Object.keys(EXPENSE_CLASS_LABELS) as ExpenseClass[]).map((c) => (
              <option key={c} value={c}>
                {c} - {EXPENSE_CLASS_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Office" required htmlFor="office">
          <OfficePicker
            id="office"
            value={officeId}
            onChange={(v, o) => {
              setOfficeId(v);
              setOfficeName(o?.name ?? '');
              // A budget line belongs to one office. Keeping the old choice
              // would leave another office's line selected under this one's
              // name, and the save would post it against the wrong office.
              setLineId(null);
            }}
          />
        </Field>

        <Field
          label="Budget line"
          required
          htmlFor="line"
          hint="Only lines this office was appropriated. A project line shows its FPP and no object code, which is how it was enacted."
        >
          <BudgetLinePicker
            id="line"
            balances={balances.data}
            officeId={officeId}
            value={lineId}
            onChange={(id, line) => {
              setLineId(id);
              if (line) setExpenseClass(line.expenseClass);
            }}
          />
        </Field>

        <Field
          label="Amount to withdraw"
          required
          htmlFor="amount"
          hint="A positive figure. It is recorded as a reduction of the allotment released."
        >
          <AmountInput
            id="amount"
            value={amount}
            onChange={setAmount}
            invalid={check ? !check.ok : false}
          />
        </Field>

        <Field label="Particulars" htmlFor="particulars">
          <TextArea id="particulars" rows={2} value={particulars} onChange={(e) => setParticulars(e.target.value)} />
        </Field>
      </div>

      {balance && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Budget line position
          </p>
          <dl className="grid gap-3 sm:grid-cols-4">
            <Figure label="Released so far" value={balance.allotmentReleased} />
            <Figure label="Already obligated" value={balance.obligated} />
            <Figure label="Not yet obligated" value={balance.availableAllotment} />
            <Figure
              label="Released after this"
              value={balance.allotmentReleased - (amount ?? 0)}
              tone={check && !check.ok ? 'negative' : 'default'}
            />
          </dl>
        </div>
      )}

      {officeId && balances.data.filter((b) => b.officeId === officeId && b.appropriationRevised !== 0).length === 0 && (
        <Alert tone="warning" className="mt-4">
          This office has no approved appropriation for {fiscalYear}, so it has no allotment to
          withdraw either.
        </Alert>
      )}

      {check && !check.ok && (
        <Alert tone="error" className="mt-4" title="This allotment cannot be withdrawn">
          {check.violations[0].message} Cancel the obligations against this line first: authority
          cannot be pulled out from under a commitment already made.
        </Alert>
      )}
    </Modal>
  );
}

function Figure({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'negative';
}) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 font-mono text-sm tabular ${tone === 'negative' ? 'text-rose-700' : 'text-navy-900'}`}
      >
        {formatPeso(value)}
      </dd>
    </div>
  );
}

/**
 * Releasing allotment that an Allotment Release Order held back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COLLECTION FIGURE IS ON THIS SCREEN
 * ---------------------------------------------------------------------------
 * Column 5 of the ARO - "For Later Release" - exists, in the Budget Operations
 * Manual's own words, "to provide safeguards for shortfalls in the collection
 * of revenues". The Sanggunian appropriates against an ESTIMATE of what the
 * municipality will collect; the Budget Officer holds part of the release back
 * until the money is actually there.
 *
 * So the one question this window has to answer is: has it come in? It shows
 * what has actually been collected this year against the year's Estimated
 * Receipts, and how much of the estimate that is.
 *
 * CFMS DOES NOT DECIDE. It shows the figure and records it against the
 * release. A release may be right for a reason the figure does not show - a
 * receipt certain but not yet deposited, a grant confirmed in writing, a
 * reallocation the Sanggunian has approved - and refusing on the arithmetic
 * would mean the Budget Officer worked around CFMS on exactly the occasions
 * that matter most, with nothing recorded at all. What is recorded is the
 * figure as it stood when they decided.
 */
function ReleaseHeldForm({
  allotment,
  fiscalYear,
  fundCode,
  onClose,
}: {
  allotment: Allotment;
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const estimates = useEstimatedReceipts(fiscalYear, fundCode);
  const collections = useCollections(fiscalYear, fundCode);

  const held = allotment.forLaterRelease ?? 0;
  const [amount, setAmount] = useState<number | null>(held);
  const [date, setDate] = useState(todayPh());
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const estimate = useMemo(
    () => estimates.data.reduce((sum, e) => sum + (e.annual ?? 0), 0),
    [estimates.data],
  );

  /*
   * Collected, not receipted-and-still-in-a-drawer.
   *
   * A cancelled receipt is not money. Everything else counts: the safeguard is
   * about whether the revenue has come in, and a collection sitting
   * undeposited has still been collected.
   */
  const collected = useMemo(
    () =>
      collections.data
        .filter((c) => c.status !== 'CANCELLED')
        .reduce((sum, c) => sum + (c.totalAmount ?? 0), 0),
    [collections.data],
  );

  const share = estimate > 0 ? collected / estimate : 0;
  const loading = estimates.loading || collections.loading;

  const release = async () => {
    if (!amount || amount <= 0) {
      toast.error('Nothing to release', 'Enter the amount being released.');
      return;
    }
    if (amount > held) {
      toast.error(
        'More than is held',
        `Only ${formatPeso(held)} is held for later release on this line.`,
      );
      return;
    }
    if (!reason.trim()) {
      toast.error('A reason is required', 'It is recorded against the release and in the audit trail.');
      return;
    }

    setSaving(true);
    try {
      const result = await engine.releaseHeldAllotment({
        allotmentId: allotment.id,
        amount,
        date,
        reason: reason.trim(),
        collectionsAtRelease: collected,
        estimateAtRelease: estimate,
      });
      toast.success(
        `${formatPeso(result.released)} released`,
        result.stillHeld > 0
          ? `${formatPeso(result.stillHeld)} is still held on this line.`
          : 'Nothing is held on this line any more.',
      );
      onClose();
    } catch (err) {
      toast.error('Nothing was released', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Release allotment held on ${allotment.aroNo ? `ARO ${allotment.aroNo}` : 'this line'}`}
      description={`${allotment.accountName || allotment.fppName} - ${allotment.officeName}`}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" loading={saving} onClick={() => void release()}>
            Release
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-2xs uppercase tracking-wider text-slate-500">
          Collections against the estimate, fiscal year {fiscalYear}
        </p>
        {loading ? (
          <p className="mt-1 text-sm text-slate-500">Reading the collections…</p>
        ) : (
          <>
            <p className="mt-1 font-mono text-lg font-semibold tabular text-navy-900">
              {formatPeso(collected)}{' '}
              <span className="font-sans text-sm font-normal text-slate-500">
                of {formatPeso(estimate)} estimated
              </span>
            </p>
            {estimate > 0 ? (
              <p className="mt-1 text-xs text-slate-600">
                {(share * 100).toFixed(1)}% of the year's Estimated Receipts have come in.
                {share < 0.5 && (
                  <span className="font-medium text-amber-700">
                    {' '}
                    Less than half. This is what the hold was for.
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-1 text-xs text-amber-700">
                No Estimated Receipts are recorded for {fiscalYear}, so there is nothing to
                measure the collections against. Load them under Budget &gt; Sources of Financing.
              </p>
            )}
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Amount to release"
          required
          htmlFor="relAmount"
          hint={`${formatPeso(held)} is held on this line.`}
        >
          <AmountInput id="relAmount" value={amount} onChange={setAmount} />
        </Field>

        <Field label="Release date" required htmlFor="relDate">
          <DateInput id="relDate" value={date} onChange={setDate} />
        </Field>

        <Field
          label="Reason"
          required
          htmlFor="relReason"
          className="sm:col-span-2"
          hint="Recorded against the release and in the audit trail, with the collection figure above."
        >
          <TextArea
            id="relReason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Collections for the first semester have reached the estimate for the Real Property Tax."
          />
        </Field>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        The release is recorded as a NEW allotment line, so the register shows both the order
        that held the money back and the act that let it go. The offices can obligate against it
        from the moment it is released.
      </p>
    </Modal>
  );
}
