import { useMemo } from 'react';
import { useAccounts, useBudgetBalances } from './queries';
import type { FppOption } from '@/components/journal/JournalEntryGrid';

/**
 * The budget lines a journal entry may be charged to, and which accounts are
 * expenses.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OPTIONS COME FROM THE BALANCES AND NOT FROM A MASTER LIST
 * ---------------------------------------------------------------------------
 * `budgetBalances` holds one document per line the municipality actually
 * appropriated this year, in this fund. A master list of every programme ever
 * created would offer last year's projects and this year's unfunded ones, and
 * an entry charged to one of those would sit in the Statement of Comparison of
 * Budget and Actual Amounts against an appropriation of nothing.
 *
 * The rule is the same one the allotment and the obligation follow: you may
 * only charge a line that exists.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXPENSE SET IS NEEDED AT ALL
 * ---------------------------------------------------------------------------
 * An FPP is required on a line that debits an expense and meaningless on every
 * other line - the credit to Accounts Payable, the cash line, the opening
 * balance. Marking them all as incomplete would train the office to ignore the
 * marking, so the grid has to know which accounts are expenses.
 */
export function useFppOptions(fiscalYear: number, fundCode: string): {
  fppOptions: FppOption[];
  expenseCodes: Set<string>;
  loading: boolean;
} {
  const balances = useBudgetBalances(fiscalYear, fundCode);
  const accounts = useAccounts(false);

  const fppOptions = useMemo(() => {
    const byCode = new Map<string, FppOption>();
    for (const b of balances.data) {
      if (!b.fppCode) continue;
      // A line with no appropriation cannot be charged. It appears among the
      // balances only because something else touched it.
      if (b.appropriationRevised === 0) continue;
      // One entry per FPP, not per budget line: the same project appropriated
      // to two offices is one thing to charge, and offering it twice invites
      // the question of which one is right.
      if (!byCode.has(b.fppCode)) {
        byCode.set(b.fppCode, {
          fppCode: b.fppCode,
          fppName: b.fppName || b.accountName || b.fppCode,
          officeName: b.officeName,
        });
      }
    }
    return [...byCode.values()].sort((a, b) => a.fppCode.localeCompare(b.fppCode));
  }, [balances.data]);

  const expenseCodes = useMemo(
    () => new Set(accounts.data.filter((a) => a.accountClass === 'EXPENSE').map((a) => a.code)),
    [accounts.data],
  );

  return { fppOptions, expenseCodes, loading: balances.loading || accounts.loading };
}
