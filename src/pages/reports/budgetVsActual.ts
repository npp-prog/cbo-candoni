import { bucketFor, type SreBucket } from '@/lib/sectors';
import type { Centavos } from '@/types/common';
import type { ExpenseClass } from '@/types/enums';

/**
 * Putting the budget beside the General Ledger.
 *
 * Kept out of the screen so it can be tested. The arithmetic here has one trap
 * in it that produces a plausible-looking wrong total rather than an error, and
 * a report nobody can check is worse than no report.
 */

/** The fields of a budget balance this comparison needs. */
export interface ComparisonBalance {
  fppCode: string;
  fppName?: string;
  accountName?: string;
  officeId: string;
  officeName: string;
  sector?: string;
  serviceSector?: string;
  expenseClass: ExpenseClass;
  appropriationOriginal: Centavos;
  appropriationContinuing: Centavos;
  appropriationRevised: Centavos;
  obligated: Centavos;
}

/** The fields of a ledger entry this comparison needs. */
export interface ComparisonEntry {
  fppCode?: string;
  debit: Centavos;
  credit: Centavos;
}

export interface ComparisonRow {
  key: string;
  fppCode: string;
  fppName: string;
  officeName: string;
  sector: string;
  bucket: SreBucket | null;
  expenseClass: ExpenseClass;
  originalBudget: Centavos;
  finalBudget: Centavos;
  obligated: Centavos;
  actual: Centavos;
}

export type GroupBy = 'fpp' | 'office' | 'sector' | 'expenseClass';

/**
 * Actual expenditure per FPP.
 *
 * Only entries carrying an FPP count, and that is sufficient rather than
 * lax: the posting rule refuses an expense debit without one, and nothing
 * that is not budget expenditure is given one. So the FPP is the marker, and
 * this does not need the Chart of Accounts to decide what is an expense.
 *
 * Debits LESS credits, so a reversal removes what it reverses instead of
 * adding to it, and a correcting entry that moves a charge from one FPP to
 * another shows correctly on both lines.
 */
export function actualByFpp(entries: ComparisonEntry[]): Map<string, Centavos> {
  const map = new Map<string, Centavos>();
  for (const e of entries) {
    if (!e.fppCode) continue;
    map.set(e.fppCode, (map.get(e.fppCode) ?? 0) + e.debit - e.credit);
  }
  return map;
}

const keyOf = (b: ComparisonBalance, groupBy: GroupBy): string =>
  groupBy === 'fpp'
    ? b.fppCode
    : groupBy === 'office'
      ? b.officeId
      : groupBy === 'sector'
        ? b.serviceSector || b.sector || 'Unclassified'
        : b.expenseClass;

export function buildComparison(
  balances: ComparisonBalance[],
  entries: ComparisonEntry[],
  groupBy: GroupBy,
): ComparisonRow[] {
  const actual = actualByFpp(entries);
  const map = new Map<string, ComparisonRow>();

  for (const b of balances) {
    if (b.appropriationRevised === 0 && b.obligated === 0) continue;

    const key = keyOf(b, groupBy);
    const row: ComparisonRow = map.get(key) ?? {
      key,
      fppCode: b.fppCode,
      fppName: b.fppName || b.accountName || b.fppCode,
      officeName: b.officeName,
      sector: b.serviceSector || b.sector || '',
      bucket: bucketFor(b.sector, b.serviceSector),
      expenseClass: b.expenseClass,
      originalBudget: 0,
      finalBudget: 0,
      obligated: 0,
      actual: 0,
    };

    row.originalBudget += b.appropriationOriginal + b.appropriationContinuing;
    row.finalBudget += b.appropriationRevised;
    row.obligated += b.obligated;
    map.set(key, row);
  }

  /*
   * ---------------------------------------------------------------------------
   * THE TRAP
   * ---------------------------------------------------------------------------
   * One FPP can appear on two budget lines - the same project appropriated to
   * two offices, which the ordinance does - but the ledger total for that FPP
   * is a single figure. Adding it inside the loop above would give the whole
   * figure to each line and count the spending twice.
   *
   * Nothing would fail. The budget columns would be right, the actual column
   * would be double, and the variance would say the municipality had overspent
   * a line it had not. So each FPP's actual is claimed once, here.
   * ---------------------------------------------------------------------------
   */
  const claimed = new Set<string>();
  for (const b of balances) {
    if (!b.fppCode || claimed.has(b.fppCode)) continue;
    claimed.add(b.fppCode);
    const row = map.get(keyOf(b, groupBy));
    if (row) row.actual += actual.get(b.fppCode) ?? 0;
  }

  return [...map.values()].sort(
    (a, b) => a.officeName.localeCompare(b.officeName) || a.fppCode.localeCompare(b.fppCode),
  );
}

/**
 * Ledger expenditure charged to an FPP with no appropriation at all.
 *
 * It cannot appear in the comparison, because the comparison is built from the
 * budget lines. Returned separately so the screen can say so: left unsaid it
 * would simply vanish, and the statement would foot to less than the
 * municipality spent while looking complete.
 */
export function unbudgetedActual(
  balances: ComparisonBalance[],
  entries: ComparisonEntry[],
): Array<{ fppCode: string; amount: Centavos }> {
  const known = new Set(balances.map((b) => b.fppCode).filter(Boolean));
  const out: Array<{ fppCode: string; amount: Centavos }> = [];
  for (const [fppCode, amount] of actualByFpp(entries)) {
    if (!known.has(fppCode) && amount !== 0) out.push({ fppCode, amount });
  }
  return out.sort((a, b) => b.amount - a.amount);
}
