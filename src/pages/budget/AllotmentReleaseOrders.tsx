import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, DateInput, AmountInput } from '@/components/ui/Field';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { Letterhead, SignatureLine } from '@/components/print/formParts';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAllotments, useAroDrafts, useBudgetBalances } from '@/data/queries';
import { createDraft, updateDraft, deleteDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { aroDraftWaiting } from '@/lib/budgetEditable';
import { ConfirmDialog } from '@/components/ui/Modal';
import { engine } from '@/lib/engine';
import { formatPeso, formatAmount, amountInWords } from '@/lib/money';
import { formatShortDate, formatLongDate, todayPh } from '@/lib/dates';
import { checkAllotmentAgainstAppropriation } from '@/lib/accounting-rules';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { Allotment, AroDraft, BudgetBalance } from '@/types/budget';
import type { Centavos } from '@/types/common';
import { useEntity } from '@/data/useEntity';
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

const FORM_OF: Record<ExpenseClass, string> = {
  PS: 'LBE Form No. 1',
  MOOE: 'LBE Form No. 1A',
  FE: 'LBE Form No. 1B',
  CO: 'LBE Form No. 1C',
};

const formOf = (expenseClass: string): string =>
  FORM_OF[expenseClass as ExpenseClass] ?? 'Allotment Release Order';

interface IssuedOrder {
  aroNo: string;
  date: string;
  expenseClass: string;
  purpose: string;
  released: Centavos;
  held: Centavos;
  lineCount: number;
}

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
export default function AllotmentReleaseOrders({
  embedded,
  building: buildingIn,
  onBuildingChange,
}: {
  /** Rendered inside the register's page: no heading of its own. */
  embedded?: boolean;
  /** The register owns the button, so it owns the state behind it. */
  building?: boolean;
  onBuildingChange?: (next: boolean) => void;
} = {}) {
  const entity = useEntity();
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole, user, profile } = useAuth();
  const toast = useToast();

  const balances = useBudgetBalances(fiscalYear, fundCode);
  const allotments = useAllotments(fiscalYear, fundCode);

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
  const [printing, setPrinting] = useState<IssuedOrder | null>(null);

  /*
    ---------------------------------------------------------------------------
    TWO PEOPLE NOW, WHERE THERE WAS ONE
    ---------------------------------------------------------------------------
    Recording an order released it, and only the Budget Officer could do it.
    Since patch 110 an order is PREPARED - by Budget Staff or the Budget
    Officer - and released only when the Budget Officer APPROVES it. The
    engine enforces both; these say which buttons to offer.
  */
  const canPrepare = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER', 'BUDGET_STAFF');
  const canApprove = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER');

  const drafts = useAroDrafts(fiscalYear, fundCode);
  const waiting = useMemo(
    () => drafts.data.filter((d) => aroDraftWaiting(d)),
    [drafts.data],
  );
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

  /** Issued orders, assembled from the allotment lines that share a number. */
  const issued = useMemo(() => {
    const map = new Map<string, IssuedOrder>();
    for (const a of allotments.data) {
      if (!a.aroNo) continue;
      const entry = map.get(a.aroNo) ?? {
        aroNo: a.aroNo,
        date: a.allotmentDate,
        expenseClass: a.expenseClass as string,
        purpose: a.aroPurpose ?? '',
        released: 0,
        held: 0,
        lineCount: 0,
      };
      entry.released += a.amount;
      entry.held += a.forLaterRelease ?? 0;
      entry.lineCount += 1;
      map.set(a.aroNo, entry);
    }
    return [...map.values()].sort((a, b) => b.aroNo.localeCompare(a.aroNo));
  }, [allotments.data]);

  const printLines: Allotment[] = useMemo(
    () =>
      printing
        ? allotments.data
            .filter((a) => a.aroNo === printing.aroNo)
            .sort(
              (a, b) =>
                a.officeName.localeCompare(b.officeName) || a.fppCode.localeCompare(b.fppCode),
            )
        : [],
    [printing, allotments.data],
  );

  // The browser's own print dialogue, once the sheet below has rendered.
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener('afterprint', done);
    const timer = window.setTimeout(() => window.print(), 80);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  const columns: Column<IssuedOrder>[] = [
    {
      key: 'aroNo',
      header: 'ARO No.',
      width: '11rem',
      value: (r) => r.aroNo,
      cell: (r) => <span className="font-mono text-xs">{r.aroNo}</span>,
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
      width: '11rem',
      value: (r) => formOf(r.expenseClass),
      cell: (r) => (
        <div>
          <span className="text-xs">{formOf(r.expenseClass)}</span>
          <span className="block text-2xs text-slate-500">
            {EXPENSE_CLASS_LABELS[r.expenseClass as ExpenseClass] ?? r.expenseClass}
          </span>
        </div>
      ),
    },
    {
      key: 'purpose',
      header: 'Purpose',
      value: (r) => r.purpose,
      cell: (r) => <span className="text-xs">{r.purpose}</span>,
    },
    {
      key: 'lineCount',
      header: 'Lines',
      kind: 'number',
      width: '5rem',
      value: (r) => r.lineCount,
      cell: (r) => <span className="text-xs">{r.lineCount}</span>,
    },
    {
      key: 'released',
      header: 'Released',
      kind: 'amount',
      width: '9rem',
      value: (r) => r.released,
      cell: (r) => <span>{formatAmount(r.released)}</span>,
    },
    {
      key: 'held',
      header: 'For later release',
      kind: 'amount',
      width: '9rem',
      value: (r) => r.held,
      cell: (r) => <span>{formatAmount(r.held)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '5rem',
      fixed: true,
      cell: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setPrinting(r)}>
          Print
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className={printing ? 'no-print' : undefined}>
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

        {/*
          ---------------------------------------------------------------------
          PREPARED, AND WAITING FOR THE BUDGET OFFICER
          ---------------------------------------------------------------------
          Above the orders issued and plainly labelled, because nothing in this
          box has released a peso. An office reading its available allotment
          must not count these, and the tiles and the register below do not -
          they read the allotment lines, which only approval writes.
        */}
        {waiting.length > 0 && (
          <Card className="mb-5 border-amber-300 bg-amber-50/40">
            <h2 className="text-sm font-semibold text-navy-900">
              Prepared release orders - waiting for approval
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              Nothing has been released. Approving an order releases it, issues its ARO number, and
              checks every line against the appropriation as it stands at that moment.
            </p>

            <ul className="mt-3 divide-y divide-amber-200/70">
              {waiting.map((d) => {
                const released = (d.lines ?? []).reduce((t, l) => t + (l.amount ?? 0), 0);
                const held = (d.lines ?? []).reduce((t, l) => t + (l.forLaterRelease ?? 0), 0);
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-navy-900">
                        {formOf(d.expenseClass)} - {d.purpose || '(no purpose yet)'}
                      </p>
                      <p className="text-xs text-slate-600">
                        {formatShortDate(d.date)} - {(d.lines ?? []).length} line
                        {(d.lines ?? []).length === 1 ? '' : 's'}, {formatPeso(released)} to release
                        {held > 0 ? `, ${formatPeso(held)} to hold back` : ''}
                        {d.createdBy?.name ? ` - prepared by ${d.createdBy.name}` : ''}
                        {d.source === 'UPLOAD' ? ' from an uploaded file' : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {canPrepare && (
                        <Button size="sm" variant="secondary" onClick={() => editDraft(d)}>
                          Edit
                        </Button>
                      )}
                      {canApprove && (
                        <Button size="sm" variant="primary" onClick={() => setApprovingDraft(d)}>
                          Approve and release
                        </Button>
                      )}
                      {canPrepare && (
                        <Button size="sm" variant="ghost" onClick={() => setDiscardingDraft(d)}>
                          Discard
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {!canApprove && (
              <p className="mt-2 text-2xs text-slate-500">
                Only the Budget Officer can approve a release order.
              </p>
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

        {/*
          Inside the register the orders are context, not the subject: the
          register below is the list being read, and this says what put the
          lines in it. So no search box of its own - searching happens on the
          register, where the lines are.
        */}
        {(!embedded || issued.length > 0) && (
          <Card title="Release orders issued" bodyClassName="p-0">
            <DataTable
              rows={issued}
              columns={columns}
              rowKey={(r) => r.aroNo}
              loading={allotments.loading}
              error={allotments.error}
              searchPlaceholder={embedded ? undefined : 'ARO number or purpose'}
              emptyTitle="No Allotment Release Order has been issued"
              emptyMessage={`Nothing has been released by order in ${fiscalYear} for this fund.`}
            />
          </Card>
        )}
      </div>

      {printing && (
        <div className="print-only">
          <Letterhead
            appendix={formOf(printing.expenseClass)}
            lines={entity.headingLines}
            title="Allotment Release Order"
          />

          <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-2xs">
            <p>
              <span className="text-slate-500">ARO No.:</span>{' '}
              <span className="font-mono font-semibold">{printing.aroNo}</span>
            </p>
            <p className="text-right">
              <span className="text-slate-500">Date:</span> {formatLongDate(printing.date)}
            </p>
            <p>
              <span className="text-slate-500">Fund:</span> {fundLabel(fundCode)}
            </p>
            <p className="text-right">
              <span className="text-slate-500">Fiscal Year:</span> {fiscalYear}
            </p>
            <p className="col-span-2">
              <span className="text-slate-500">Expense Class:</span>{' '}
              {EXPENSE_CLASS_LABELS[printing.expenseClass as ExpenseClass] ?? printing.expenseClass}
            </p>
            <p className="col-span-2">
              <span className="text-slate-500">Purpose:</span> {printing.purpose}
            </p>
          </div>

          <table className="w-full border-collapse text-2xs">
            <thead>
              <tr>
                <th className="border border-slate-400 px-1.5 py-1 text-left">Office / Function</th>
                <th className="border border-slate-400 px-1.5 py-1 text-left">FPP</th>
                <th className="border border-slate-400 px-1.5 py-1 text-left">Object</th>
                <th
                  className="border border-slate-400 px-1.5 py-1 text-right"
                  style={{ width: '6.5rem' }}
                >
                  Amount Released
                </th>
                <th
                  className="border border-slate-400 px-1.5 py-1 text-right"
                  style={{ width: '6.5rem' }}
                >
                  For Later Release
                </th>
              </tr>
            </thead>
            <tbody>
              {printLines.map((l) => (
                <tr key={l.id}>
                  <td className="border border-slate-400 px-1.5 py-1">{l.officeName}</td>
                  <td className="border border-slate-400 px-1.5 py-1">
                    {l.fppCode} {l.fppName}
                  </td>
                  <td className="border border-slate-400 px-1.5 py-1">
                    {l.accountCode ? `${l.accountCode} ${l.accountName}` : '—'}
                  </td>
                  <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                    {formatAmount(l.amount, false)}
                  </td>
                  <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                    {formatAmount(l.forLaterRelease ?? 0, false)}
                  </td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="border border-slate-400 px-1.5 py-1" colSpan={3}>
                  Total
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(printing.released, false)}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(printing.held, false)}
                </td>
              </tr>
            </tbody>
          </table>

          <p className="mt-2 text-2xs">
            Amount released: <strong>{amountInWords(printing.released)}</strong>
          </p>

          <p className="mt-3 text-2xs leading-relaxed">
            The allotment released hereunder is chargeable against the appropriation authorised
            under the Annual Budget for Fiscal Year {fiscalYear} and may be obligated solely for
            the purpose stated above. The amount shown in the &ldquo;For Later Release&rdquo;
            column is withheld and shall not be obligated until it is covered by a subsequent
            Allotment Release Order.
          </p>

          <div className="mt-8 grid grid-cols-2 gap-10">
            <SignatureLine label="Recommended by" role="Municipal Budget Officer" />
            <SignatureLine label="Approved by" role="Municipal Mayor" />
          </div>
        </div>
      )}
    </>
  );
}
