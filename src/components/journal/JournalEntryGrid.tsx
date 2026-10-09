import { useMemo } from 'react';
import { entryGridColumns } from '@/lib/entryGridColumns';
import clsx from 'clsx';
import { AccountPicker, SubsidiaryPicker } from '@/components/pickers';
import { AmountInput, TextInput } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { formatPeso } from '@/lib/money';
import { checkDoubleEntry } from '@/lib/accounting-rules';
import type { Centavos } from '@/types/common';

/**
 * The journal entry grid.
 *
 * The running debit and credit totals, and the difference between them, are
 * shown live at the foot. That is the single most useful thing this component
 * does: an accountant building a correcting entry wants to see the entry come
 * into balance as they type, not to be told after pressing Save that it is out
 * by 1,250.00 somewhere.
 *
 * The balance check here uses exactly the same function the Cloud Function
 * uses when it posts. The server's verdict is the one that counts - but
 * because both run the same code, a user is never surprised by it.
 */

export interface GridLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  /**
   * The budget line this charge is against. Not shown or asked for in the grid
   * (patch 139): it is carried, unseen, from the obligation behind a voucher,
   * and filled from it by the engine where a line was added by hand. An entry
   * with no obligation behind it has none.
   */
  fppCode?: string;
  fppName?: string;
  debit: Centavos;
  credit: Centavos;
  particulars?: string;
  /**
   * The subsidiary ledger this line belongs to.
   *
   * Accounts Payable, Due to Officers and Employees, Cash in Bank and the
   * advances are CONTROL accounts: the General Ledger balance is only
   * meaningful because it is the sum of what is owed to, or held for, each
   * named party. A line posted to one of them with no subsidiary is a figure
   * nobody can trace, and the Subsidiary Ledger report shows exactly that as
   * an unassigned amount that stops it agreeing with the control account.
   */
  subsidiaryType?: string;
  subsidiaryId?: string;
  subsidiaryName?: string;
}

/** One FPP a line may be charged to, as the picker offers it. */
export interface FppOption {
  fppCode: string;
  fppName: string;
  officeName?: string;
}

export function JournalEntryGrid({
  lines,
  onChange,
  readOnly,
  showParticulars = true,
  fundCode,
}: {
  lines: GridLine[];
  onChange: (lines: GridLine[]) => void;
  readOnly?: boolean;
  showParticulars?: boolean;
  /** Narrows the bank accounts the subsidiary picker offers. */
  fundCode?: string;
}) {
  /*
   * The column layout, so the totals row and the header cannot disagree about
   * how many columns there are. See src/lib/entryGridColumns.ts - the counting
   * has been wrong once already.
   */
  const layout = useMemo(
    // Patch 139: no budget line (FPP) column. The FPP of an expense comes from
    // the obligation behind the voucher (fppFromObligation), not from the grid.
    () => entryGridColumns({ showParticulars, withFpp: false }),
    [showParticulars],
  );

  const totals = useMemo(() => {
    const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    return { totalDebit, totalCredit, difference: totalDebit - totalCredit };
  }, [lines]);

  const check = useMemo(
    () =>
      checkDoubleEntry(
        lines.map((l) => ({
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          debit: l.debit || 0,
          credit: l.credit || 0,
        })),
      ),
    [lines],
  );

  const update = (index: number, patch: Partial<GridLine>) => {
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    onChange([
      ...lines,
      {
        lineNo: (lines[lines.length - 1]?.lineNo ?? 0) + 1,
        accountCode: '',
        accountName: '',
        debit: 0,
        credit: 0,
      },
    ]);
  };

  const removeLine = (index: number) => {
    onChange(lines.filter((_, i) => i !== index).map((l, i) => ({ ...l, lineNo: i + 1 })));
  };

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            {/*
              ----------------------------------------------------------------
              THE COLUMN ORDER IS THE ORDER AN ENTRY IS READ IN
              ----------------------------------------------------------------
              Account, what it was for, how much, and only then the two
              classifications - who it is traced to and which budget line it is
              charged against.

              It used to run Account, Budget line, Subsidiary, Particulars,
              Debit, Credit, which put two long dropdowns between the account
              and its own figures. On a voucher with four lines the amounts
              were off the right-hand edge, so the one thing the Accountant is
              checking - does this balance - needed a sideways scroll to see.

              The amounts sit next to the account now. The classifications
              trail, which is also the order they are FILLED in: an encoder
              knows the account and the amount before they know which budget
              line the Budget Office wants it against.
            */}
            <tr>
              <th className="cbo-th w-10">#</th>
              <th className="cbo-th min-w-[18rem]">Account</th>
              {showParticulars && <th className="cbo-th min-w-[12rem]">Particulars</th>}
              <th className="cbo-th cbo-amount-col">Debit</th>
              <th className="cbo-th cbo-amount-col">Credit</th>
              <th className="cbo-th min-w-[14rem]">Subsidiary ledger</th>
              {!readOnly && <th className="cbo-th w-10" />}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="cbo-td text-center font-mono text-xs text-slate-400">{line.lineNo}</td>

                <td className="cbo-td">
                  {readOnly ? (
                    <div>
                      <span className="font-mono text-xs text-slate-500">{line.accountCode}</span>{' '}
                      <span className="text-navy-900">{line.accountName}</span>
                    </div>
                  ) : (
                    <AccountPicker
                      value={line.accountCode || null}
                      onChange={(code, account) =>
                        update(index, {
                          accountCode: code ?? '',
                          accountName: account?.name ?? '',
                        })
                      }
                      invalid={!line.accountCode && (line.debit > 0 || line.credit > 0)}
                    />
                  )}
                </td>

                {showParticulars && (
                  <td className="cbo-td">
                    {readOnly ? (
                      <span className="text-xs text-slate-600">{line.particulars}</span>
                    ) : (
                      <TextInput
                        value={line.particulars ?? ''}
                        onChange={(e) => update(index, { particulars: e.target.value })}
                        placeholder="Optional"
                        className="py-1.5"
                      />
                    )}
                  </td>
                )}

                <td className="cbo-td">
                  {readOnly ? (
                    <span className="cbo-amount block">{line.debit ? formatPeso(line.debit, { symbol: false }) : '-'}</span>
                  ) : (
                    <AmountInput
                      value={line.debit || null}
                      onChange={(v) => update(index, { debit: v ?? 0, credit: v ? 0 : line.credit })}
                      className="py-1.5"
                    />
                  )}
                </td>

                <td className="cbo-td">
                  {readOnly ? (
                    <span className="cbo-amount block">{line.credit ? formatPeso(line.credit, { symbol: false }) : '-'}</span>
                  ) : (
                    <AmountInput
                      value={line.credit || null}
                      onChange={(v) => update(index, { credit: v ?? 0, debit: v ? 0 : line.debit })}
                      className="py-1.5"
                    />
                  )}
                </td>

                <td className="cbo-td">
                  {readOnly ? (
                    line.subsidiaryName ? (
                      <span className="text-sm text-navy-900">{line.subsidiaryName}</span>
                    ) : (
                      <span className="text-xs text-slate-400">&mdash;</span>
                    )
                  ) : (
                    <SubsidiaryPicker
                      fundCode={fundCode}
                      value={
                        line.subsidiaryType && line.subsidiaryId
                          ? `${line.subsidiaryType}:${line.subsidiaryId}`
                          : null
                      }
                      onChange={(chosen) =>
                        update(index, {
                          subsidiaryType: chosen?.type,
                          subsidiaryId: chosen?.id,
                          subsidiaryName: chosen?.name,
                        })
                      }
                    />
                  )}
                </td>

                {!readOnly && (
                  <td className="cbo-td text-center">
                    <button
                      onClick={() => removeLine(index)}
                      disabled={lines.length <= 2}
                      className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                      aria-label={`Remove line ${line.lineNo}`}
                      title={lines.length <= 2 ? 'An entry needs at least two lines' : 'Remove line'}
                    >
                      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path
                          fillRule="evenodd"
                          d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className="bg-slate-50 font-medium">
              {/*
                Every optional column has to be counted or the totals slide out
                from under the Debit and Credit they add up. It has been wrong
                once already - the budget line column was missed, so on a JEV
                that charges one, Total sat a column to the left of its own
                figures.

                With Debit and Credit moved next to the account, what precedes
                them is the line number, the account and - if shown - the
                particulars; what follows is the subsidiary and the budget
                line.
              */}
              <td className="cbo-td" colSpan={layout.leading}>
                <span className="text-sm text-navy-900">Total</span>
              </td>
              <td className="cbo-td cbo-amount text-navy-900">
                {formatPeso(totals.totalDebit, { symbol: false })}
              </td>
              <td className="cbo-td cbo-amount text-navy-900">
                {formatPeso(totals.totalCredit, { symbol: false })}
              </td>
              <td className="cbo-td" colSpan={layout.trailing} />
              {!readOnly && <td className="cbo-td" />}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {!readOnly && (
          <Button size="sm" onClick={addLine}>
            Add line
          </Button>
        )}

        <div
          className={clsx(
            'ml-auto rounded-md px-3 py-1.5 text-sm',
            totals.difference === 0
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-rose-50 text-rose-800',
          )}
        >
          {totals.difference === 0 ? (
            <span className="font-medium">In balance</span>
          ) : (
            <>
              <span className="font-medium">Out of balance by </span>
              <span className="font-mono tabular">{formatPeso(Math.abs(totals.difference))}</span>
              <span className="ml-1 text-xs">
                ({totals.difference > 0 ? 'debits exceed credits' : 'credits exceed debits'})
              </span>
            </>
          )}
        </div>
      </div>

      {!readOnly && !check.ok && (
        <ul className="mt-2 space-y-1">
          {check.violations
            .filter((v) => v.code !== 'JEV_UNBALANCED')
            .map((v, i) => (
              <li key={i} className="text-xs text-amber-700">
                {v.message}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
