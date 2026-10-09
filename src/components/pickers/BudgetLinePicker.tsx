import { useMemo } from 'react';
import { Select } from '@/components/ui/Field';
import { formatPeso } from '@/lib/money';
import { realignableBalance } from '@/lib/accounting-rules';
import type { BudgetBalance } from '@/types/budget';

/**
 * Choosing a line of the budget to draw on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED TYPING THE OFFICE AND THE ACCOUNT
 * ---------------------------------------------------------------------------
 * An allotment or an obligation may only be raised against a line the
 * Sanggunian actually appropriated. When the office and the account were typed
 * in separately, a combination that had never been appropriated was easy to
 * build - and it did not fail with "there is no such line", it failed with
 * "insufficient allotment", which reads as a budget problem and sends somebody
 * to the Budget Officer for a release that cannot be made.
 *
 * Offering the appropriated lines instead makes the wrong answer unavailable
 * rather than merely refused.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FPP AND THE ACCOUNT ARE SHOWN TOGETHER
 * ---------------------------------------------------------------------------
 * A third of the FY2025 ordinance was appropriated by project, with no object
 * of expenditure named at all. Those lines have an FPP and no account code;
 * the personnel and routine maintenance lines have an FPP that IS an account
 * code. Showing the pair is the only honest label, because on a project line
 * the account column is genuinely empty and a picker that hid that would look
 * broken.
 * ---------------------------------------------------------------------------
 */
export function BudgetLinePicker({
  balances,
  officeId,
  value,
  onChange,
  disabled,
  id,
  measure = 'allotment',
}: {
  /**
   * Which balance the label shows. `allotment` - what may still be
   * obligated - for an obligation. `unobligated` - the appropriation less
   * obligations, all a realignment or augmentation may take (patch 128).
   */
  measure?: 'allotment' | 'unobligated';
  /** Every running balance for the fiscal year and fund in view. */
  balances: BudgetBalance[];
  /** Narrows to one office; null offers every office's lines. */
  officeId?: string | null;
  /** The chosen line's budgetBalances document id. */
  value: string | null;
  onChange: (id: string | null, line: BudgetBalance | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const options = useMemo(
    () =>
      balances
        .filter((b) => !officeId || b.officeId === officeId)
        // A line with no appropriation cannot be drawn on. It appears in the
        // balances only because something else touched it.
        .filter((b) => b.appropriationRevised !== 0)
        .sort(
          (a, b) =>
            a.officeName.localeCompare(b.officeName) ||
            (a.fppCode ?? '').localeCompare(b.fppCode ?? ''),
        ),
    [balances, officeId],
  );

  return (
    <Select
      id={id}
      disabled={disabled}
      value={value ?? ''}
      onChange={(e) => {
        const chosen = options.find((o) => o.id === e.target.value) ?? null;
        onChange(chosen ? chosen.id : null, chosen);
      }}
    >
      <option value="">Choose an appropriated line&hellip;</option>
      {options.map((b) => (
        <option key={b.id} value={b.id}>
          {label(b, measure)}
        </option>
      ))}
    </Select>
  );
}

function label(b: BudgetBalance, measure: 'allotment' | 'unobligated'): string {
  const name = b.fppName || b.accountName || b.fppCode;
  const object = b.accountCode ? ` · ${b.accountCode}` : '';
  if (measure === 'unobligated') {
    const free = formatPeso(realignableBalance(b), { symbol: false });
    return `${b.fppCode}${object} — ${name} (${b.expenseClass}, ${free} unobligated)`;
  }
  const available = formatPeso(b.availableAllotment, { symbol: false });
  return `${b.fppCode}${object} — ${name} (${b.expenseClass}, ${available} available)`;
}
