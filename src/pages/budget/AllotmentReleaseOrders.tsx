import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, DateInput, AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useBudgetBalances } from '@/data/queries';
import { createDraft, updateDraft, deleteDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { ConfirmDialog } from '@/components/ui/Modal';
import { engine } from '@/lib/engine';
import { formatPeso, amountInWords } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import { checkAllotmentAgainstAppropriation } from '@/lib/accounting-rules';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { AroDraft, BudgetBalance } from '@/types/budget';
import type { Centavos } from '@/types/common';
import { FORM_OF, formOf, type AroSheet } from './AroPrint';

/**
 * What the register's table asks of a prepared order. Patch 113 moved the
 * prepared orders into the register as rows, so their buttons are there now;
 * the acts themselves - the builder, the two confirmations - stay here, with
 * the state they need.
 */
export interface AroOrdersHandle {
  edit: (d: AroDraft) => void;
  approve: (d: AroDraft) => void;
  discard: (d: AroDraft) => void;
}
import { fundLabel } from './Obligations';

/**
 * Allotment Release Orders.
 *
 * Budget Operations Manual for LGUs, 2023 Edition. Recommended by the Local
 * Budget Officer, approved by the Local Chief Executive, and the instrument by
 * which an enacted appropriation becomes spendable authority.
 *
 * ---------------------------------------------------------------------------
 * FOUR FORMS, NOT ONE
 * ---------------------------------------------------------------------------
 * There is no single ARO form in the manual. There are four:
 *
 *     LBE Form No. 1   Personal Services
 *     LBE Form No. 1A  Maintenance and Other Operating Expenses
 *     LBE Form No. 1B  Financial Expenses
 *     LBE Form No. 1C  Capital Outlay
 *
 * Each is released on its own schedule - PS comprehensively or quarterly,
 * Capital Outlay against the work programme and the ranking of projects in the
 * approved AIP. So an order covers one expense class, and this screen asks
 * which before it offers any budget line.
 *
 * ---------------------------------------------------------------------------
 * FOR LATER RELEASE
 * ---------------------------------------------------------------------------
 * The manual's fifth column, and the reason this screen exists rather than the
 * plain allotment form on the previous page. The Budget Officer releases part
 * of an appropriation and deliberately withholds the rest, "to provide
 * safeguards for shortfalls in the collection of revenues".
 *
 * Until now CFMS could not tell a withheld appropriation from a fully released
 * one. A department reading its available balance saw authority the Budget
 * Officer had decided it could not yet have - and would obligate against it.
 * ---------------------------------------------------------------------------
 */

interface DraftLine {
  id: number;
  balanceId: string | null;
  amount: Centavos | null;
  forLaterRelease: Centavos | null;
}

let nextId = 1;
const blank = (): DraftLine => ({
  id: nextId++,
  balanceId: null,
  amount: null,
  forLaterRelease: null,
});


/**
 * Issuing allotment by order, and the orders already issued.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT A SCREEN OF ITS OWN ANY MORE
 * ---------------------------------------------------------------------------
 * It was, then it was a tab beside the register, and now it is part of the
 * register's page. The reason is the same each time and the Budget Officer has
 * said it twice: releasing allotment and reading what has been released are
 * one job, and every boundary CFMS put between them was a boundary the officer
 * had to cross to do it.
 *
 * `embedded` is what the register passes. On its own - at the old address,
 * which still works - it keeps its heading.
 */
interface AroOrdersProps {
  /** Rendered inside the register's page: no heading of its own. */
  embedded?: boolean;
  /** The register owns the button, so it owns the state behind it. */
  building?: boolean;
  onBuildingChange?: (next: boolean) => void;
}

const AllotmentReleaseOrders = forwardRef<AroOrdersHandle, AroOrdersProps>(function AllotmentReleaseOrders(
  { embedded, building: buildingIn, onBuildingChange },
  ref,
) {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole, user, profile } = useAuth();
  const toast = useToast();

  const balances = useBudgetBalances(fiscalYear, fundCode);

  const [buildingOwn, setBuildingOwn] = useState(false);
  const building = buildingIn ?? buildingOwn;
  const setBuilding = (next: boolean) => {
    setBuildingOwn(next);
    onBuildingChange?.(next);
  };
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>('MOOE');
  const [purpose, setPurpose] = useState('');
  const [date, setDate] = useState(todayPh());
  const [lines, setLines] = useState<DraftLine[]>(() => [blank()]);
  const [saving, setSaving] = useState(false);

  /*
    ---------------------------------------------------------------------------
    TWO PEOPLE NOW, WHERE THERE WAS ONE
    ---------------------------------------------------------------------------
    Recording an order released it, and only the Budget Officer could do it.
    Since patch 110 an order is PREPARED - by Budget Staff or the Budget
    Officer - and released only when the Budget Officer APPROVES it. The
    engine enforces both; this says whether the builder may save. Who may
    approve is decided on the register's page, where the button now is.
  */
  const canPrepare = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER', 'BUDGET_STAFF');

  /* The prepared order being corrected, if the builder was opened on one. */
  const [editingDraft, setEditingDraft] = useState<AroDraft | null>(null);
  const [approvingDraft, setApprovingDraft] = useState<AroDraft | null>(null);
  const [discardingDraft, setDiscardingDraft] = useState<AroDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const actor = user
    ? actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      })
    : null;

  /* Open the builder on a prepared order, with everything it carried. */
  const editDraft = (d: AroDraft) => {
    setEditingDraft(d);
    setExpenseClass(d.expenseClass);
    setPurpose(d.purpose ?? '');
    setDate(d.date);
    setLines(
      (d.lines ?? []).length
        ? d.lines.map((l) => ({
            ...blank(),
            balanceId: l.balanceId,
            amount: l.amount || null,
            forLaterRelease: l.forLaterRelease || null,
          }))
        : [blank()],
    );
    setBuilding(true);
  };

  const closeBuilder = () => {
    setBuilding(false);
    setEditingDraft(null);
    setLines([blank()]);
    setPurpose('');
  };

  /** Only lines of the chosen expense class may go on this order. */
  const available = useMemo(
    () =>
      balances.data
        .filter((b) => b.expenseClass === expenseClass && b.appropriationRevised !== 0)
        .sort(
          (a, b) =>
            a.officeName.localeCompare(b.officeName) || a.fppCode.localeCompare(b.fppCode),
        ),
    [balances.data, expenseClass],
  );

  const byId = useMemo(() => new Map(available.map((b) => [b.id, b])), [available]);

  const filled = useMemo(
    () => lines.filter((l) => l.balanceId && ((l.amount ?? 0) > 0 || (l.forLaterRelease ?? 0) > 0)),
    [lines],
  );

  /**
   * The same rule the server runs, with the NEW hold counted.
   *
   * Counting only the hold already on the line would let an order that
   * withholds three hundred thousand and releases eight hundred out of a
   * million pass here and fail on the server - which is the shape of check
   * that teaches an office to stop reading the screen.
   */
  const problems = useMemo(
    () =>
      filled
        .map((line) => {
          const balance = byId.get(line.balanceId as string);
          if (!balance) return null;
          const check = checkAllotmentAgainstAppropriation({
            appropriationRevised: balance.appropriationRevised,
            forLaterRelease: (balance.forLaterRelease ?? 0) + (line.forLaterRelease ?? 0),
            allotmentAlreadyReleased: balance.allotmentReleased,
            requestedRelease: line.amount ?? 0,
          });
          return check.ok ? null : { line, balance, message: check.violations[0].message };
        })
        .filter(
          (p): p is { line: DraftLine; balance: BudgetBalance; message: string } => p !== null,
        ),
    [filled, byId],
  );

  /**
   * Two draft rows pointing at the same budget line.
   *
   * Each would pass the check above on its own while the pair overdraws the
   * appropriation, because neither can see the other. The server sums them
   * before it reads and would refuse the order; here the duplicate is simply
   * not allowed to be entered.
   */
  const duplicated = useMemo(() => {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const l of filled) {
      const id = l.balanceId as string;
      if (seen.has(id)) twice.add(id);
      seen.add(id);
    }
    return twice;
  }, [filled]);

  const totalReleased = filled.reduce((s, l) => s + (l.amount ?? 0), 0);
  const totalHeld = filled.reduce((s, l) => s + (l.forLaterRelease ?? 0), 0);

  const ready =
    filled.length > 0 && problems.length === 0 && duplicated.size === 0 && purpose.trim().length > 0;

  /**
   * Saving the order as PREPARED. Nothing is released and no balance moves.
   *
   * The whole line is stored - office, budget line, names and amounts - and
   * not just the balance id, so the prepared list can show what the order
   * says without reading every budget line, and so approval reads the order
   * as it was prepared.
   */
  const prepare = async () => {
    if (!actor) return;
    setSaving(true);
    try {
      const record = {
        fiscalYear,
        fundCode,
        expenseClass,
        purpose: purpose.trim(),
        date,
        lines: filled.map((l) => {
          const b = byId.get(l.balanceId as string) as BudgetBalance;
          return {
            balanceId: b.id,
            officeId: b.officeId,
            officeName: b.officeName,
            fppCode: b.fppCode,
            fppName: b.fppName ?? '',
            accountCode: b.accountCode,
            accountName: b.accountName ?? '',
            amount: l.amount ?? 0,
            forLaterRelease: l.forLaterRelease ?? 0,
          };
        }),
        status: 'DRAFT' as const,
      };
      if (editingDraft) {
        await updateDraft(COL.aroDrafts, editingDraft.id, record, actor);
      } else {
        await createDraft(COL.aroDrafts, record, actor);
      }
      toast.success(
        `${FORM_OF[expenseClass]} prepared`,
        `${formatPeso(totalReleased)} to release${
          totalHeld > 0 ? `, ${formatPeso(totalHeld)} to hold back` : ''
        }. Nothing is released until the Budget Officer approves it.`,
      );
      closeBuilder();
    } catch (err) {
      toast.error('Could not save the order', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /** The Budget Officer's act. The engine reads the stored order itself. */
  const approve = async (d: AroDraft) => {
    setBusy(true);
    try {
      const result = await engine.approveAro({ draftId: d.id });
      toast.success(
        `${result.form} released as ${result.aroNo}`,
        `${formatPeso(result.totalReleased)} released${
          result.totalHeld > 0 ? `, ${formatPeso(result.totalHeld)} held for later release` : ''
        }.`,
      );
      setApprovingDraft(null);
    } catch (err) {
      toast.error('Nothing was released', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async (d: AroDraft) => {
    setBusy(true);
    try {
      await deleteDraft(COL.aroDrafts, d.id);
      toast.success('Prepared order discarded', 'Nothing had been released from it.');
      setDiscardingDraft(null);
    } catch (err) {
      toast.error('Could not discard it', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const builderTop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (building) builderTop.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [building, editingDraft]);

  useImperativeHandle(ref, () => ({
    edit: editDraft,
    approve: setApprovingDraft,
    discard: setDiscardingDraft,
  }));

  return (
    <>
      <div>
        {!embedded && (
          <PageHeader
            title="Allotment Release Orders"
            subtitle={`${fundLabel(fundCode)} · fiscal year ${fiscalYear}`}
            breadcrumbs={[{ label: 'Budget' }, { label: 'Allotments' }]}
            actions={
              canPrepare && !building ? (
                <Button variant="primary" onClick={() => setBuilding(true)}>
                  Prepare an order
                </Button>
              ) : undefined
            }
          />
        )}

        {/* Brought into view when it opens: Edit is pressed on a row that may
            be far down the register, and the builder opens up here. */}
        <div ref={builderTop} className="scroll-mt-4" />
        {building && (
          <Card
            title={`${editingDraft ? 'Correct' : 'Prepare'} ${FORM_OF[expenseClass]}`}
            subtitle="Saved as prepared. Nothing is released until the Budget Officer approves it. One expense class to an order - the manual has a separate form for each."
            className="mb-5"
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-600">
                  Releasing <strong className="font-mono">{formatPeso(totalReleased)}</strong>
                  {totalHeld > 0 && (
                    <>
                      {' '}
                      · holding back <strong className="font-mono">{formatPeso(totalHeld)}</strong>
                    </>
                  )}
                  {totalReleased > 0 && (
                    <span className="mt-1 block text-2xs uppercase tracking-wide text-slate-500">
                      {amountInWords(totalReleased)}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button onClick={closeBuilder}>Cancel</Button>
                  <Button
                    variant="primary"
                    loading={saving}
                    disabled={!ready || saving || !canPrepare}
                    onClick={() => void prepare()}
                  >
                    {editingDraft ? 'Save changes' : 'Save as prepared'}
                  </Button>
                </div>
              </div>
            }
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Expense class" required hint="Decides which of the four forms this is.">
                <Select
                  value={expenseClass}
                  onChange={(e) => {
                    setExpenseClass(e.target.value as ExpenseClass);
                    // A budget line belongs to one expense class. Keeping the
                    // rows already chosen would leave another class's lines on
                    // this order, and the server would refuse the lot.
                    setLines([blank()]);
                  }}
                >
                  {(Object.keys(EXPENSE_CLASS_LABELS) as ExpenseClass[]).map((c) => (
                    <option key={c} value={c}>
                      {c} — {EXPENSE_CLASS_LABELS[c]} ({FORM_OF[c]})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Date of issue" required>
                <DateInput value={date} onChange={setDate} />
              </Field>

              <Field
                label="Purpose"
                required
                hint="Printed on the face of the order. The allotment may be used solely for it."
              >
                <TextInput value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              </Field>
            </div>

            {available.length === 0 ? (
              <Alert tone="warning" className="mt-4">
                No {expenseClass} appropriation has been recorded for {fiscalYear} in this fund.
                Load the appropriation ordinance first — an allotment may only be released against
                authority the Sanggunian has enacted.
              </Alert>
            ) : (
              <>
                <div className="mt-4 overflow-x-auto rounded border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-left text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5 font-medium" style={{ minWidth: '18rem' }}>
                          Budget line
                        </th>
                        <th
                          className="px-2 py-1.5 text-right font-medium"
                          style={{ width: '10rem' }}
                        >
                          Available
                        </th>
                        <th
                          className="px-2 py-1.5 text-right font-medium"
                          style={{ width: '11rem' }}
                        >
                          This release
                        </th>
                        <th
                          className="px-2 py-1.5 text-right font-medium"
                          style={{ width: '11rem' }}
                        >
                          For later release
                        </th>
                        <th className="w-8 px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {lines.map((line) => {
                        const balance = line.balanceId ? byId.get(line.balanceId) : null;
                        const bad = problems.find((p) => p.line.id === line.id);
                        const twice = line.balanceId ? duplicated.has(line.balanceId) : false;
                        return (
                          <tr
                            key={line.id}
                            className={bad || twice ? 'bg-rose-50 align-top' : 'align-top'}
                          >
                            <td className="px-2 py-1.5">
                              <Select
                                value={line.balanceId ?? ''}
                                onChange={(e) =>
                                  setLines((ls) =>
                                    ls.map((l) =>
                                      l.id === line.id
                                        ? { ...l, balanceId: e.target.value || null }
                                        : l,
                                    ),
                                  )
                                }
                              >
                                <option value="">Choose an appropriated line&hellip;</option>
                                {available.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.officeName} · {o.fppCode} {o.fppName || o.accountName}
                                  </option>
                                ))}
                              </Select>
                              {bad && (
                                <p className="mt-1 text-[11px] text-rose-700">{bad.message}</p>
                              )}
                              {twice && !bad && (
                                <p className="mt-1 text-[11px] text-rose-700">
                                  This budget line is already on another row of this order. Put the
                                  whole amount on one row.
                                </p>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">
                              {balance
                                ? formatPeso(balance.availableAppropriation, { symbol: false })
                                : '—'}
                              {balance && (balance.forLaterRelease ?? 0) > 0 && (
                                <span className="block font-sans text-2xs text-slate-500">
                                  {formatPeso(balance.forLaterRelease ?? 0, { symbol: false })}{' '}
                                  already held
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <AmountInput
                                value={line.amount}
                                onChange={(v) =>
                                  setLines((ls) =>
                                    ls.map((l) => (l.id === line.id ? { ...l, amount: v } : l)),
                                  )
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <AmountInput
                                value={line.forLaterRelease}
                                onChange={(v) =>
                                  setLines((ls) =>
                                    ls.map((l) =>
                                      l.id === line.id ? { ...l, forLaterRelease: v } : l,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={lines.length <= 1}
                                onClick={() => setLines((ls) => ls.filter((l) => l.id !== line.id))}
                              >
                                &times;
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="mt-2">
                  <Button size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>
                    Add a line
                  </Button>
                </div>

                <Alert tone="info" className="mt-3">
                  <strong>For later release</strong> is authority the Sanggunian enacted that you
                  are deliberately withholding — the manual&rsquo;s safeguard against a shortfall
                  in the collection of revenue. It does not reduce the appropriation; it makes that
                  much of it unavailable to allot until a later order releases it.
                </Alert>
              </>
            )}
          </Card>
        )}


        <ConfirmDialog
          open={Boolean(approvingDraft)}
          onCancel={() => setApprovingDraft(null)}
          onConfirm={() => {
            if (approvingDraft) void approve(approvingDraft);
          }}
          loading={busy}
          title="Approve and release this order"
          confirmLabel="Approve and release"
          variant="primary"
          message={
            approvingDraft && (
              <>
                <p>
                  This releases{' '}
                  <strong>
                    {formatPeso(
                      (approvingDraft.lines ?? []).reduce((t, l) => t + (l.amount ?? 0), 0),
                    )}
                  </strong>{' '}
                  of allotment on {formOf(approvingDraft.expenseClass)} and issues its ARO number.
                </p>
                <p className="mt-2">
                  Every line is checked against the appropriation as it stands now, not as it stood
                  when the order was prepared. If any line no longer fits, nothing is released and
                  the order stays prepared for correcting.
                </p>
              </>
            )
          }
        />

        <ConfirmDialog
          open={Boolean(discardingDraft)}
          onCancel={() => setDiscardingDraft(null)}
          onConfirm={() => {
            if (discardingDraft) void discard(discardingDraft);
          }}
          loading={busy}
          title="Discard this prepared order"
          confirmLabel="Discard"
          variant="danger"
          message={
            discardingDraft && (
              <p>
                The prepared {formOf(discardingDraft.expenseClass)} and its{' '}
                {(discardingDraft.lines ?? []).length} lines are deleted. Nothing had been released
                from it, so nothing in the books changes.
              </p>
            )
          }
        />
      </div>
    </>
  );
});

export default AllotmentReleaseOrders;

/** A prepared order as it goes on paper: no ARO number yet, the lines as prepared. */
export function preparedSheet(d: AroDraft): AroSheet {
  return {
    aroNo: null,
    date: d.date,
    expenseClass: d.expenseClass,
    purpose: d.purpose ?? '',
    fundCode: d.fundCode,
    fiscalYear: d.fiscalYear,
    prepared: true,
    preparedBy: d.createdBy?.name ?? null,
    lines: [...(d.lines ?? [])]
      .sort((a, b) => a.officeName.localeCompare(b.officeName) || a.fppCode.localeCompare(b.fppCode))
      .map((l, i) => ({
        key: `${l.balanceId}-${i}`,
        officeName: l.officeName,
        fppCode: l.fppCode,
        fppName: l.fppName ?? '',
        accountCode: l.accountCode ?? '',
        accountName: l.accountName ?? '',
        released: l.amount ?? 0,
        held: l.forLaterRelease ?? 0,
      })),
  };
}
