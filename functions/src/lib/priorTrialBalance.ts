// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/priorTrialBalance.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
/**
 * Patch 169 - THE PRIOR YEAR'S TRIAL BALANCES, for the comparative statements.
 *
 * The year CFMS takes over has no preceding year in its General Ledger, so the
 * comparative column of the financial statements has nothing to read. The
 * office uploads the preceding year's two trial balances instead:
 *
 *   PRE   the pre-closing trial balance - revenue and expense still open; the
 *         comparative Statement of Financial Performance is read from it.
 *   POST  the post-closing trial balance - revenue and expense closed to
 *         equity; the comparative Statement of Financial Position is read
 *         from it.
 *
 * The post-closing trial balance is the closing position of the preceding
 * year, which is exactly what the Opening Balances of this year opened with.
 * So it must agree with them, account by account. The browser shows the
 * difference; the engine refuses an upload that has one.
 *
 * Kept in one file shared by the browser and the engine (scripts/sync-rules),
 * so the check the screen shows and the check the engine makes are one check.
 *
 * Amounts are integer centavos.
 */

export type PriorTbKind = 'PRE' | 'POST';

export const PRIOR_TB_KINDS: PriorTbKind[] = ['PRE', 'POST'];

export const PRIOR_TB_LABELS: Record<PriorTbKind, string> = {
  PRE: 'Pre-closing trial balance',
  POST: 'Post-closing trial balance',
};

export interface PriorTbLine {
  accountCode: string;
  /** The title as the file has it. */
  accountName?: string;
  debit: number;
  credit: number;
}

/** The document id: one trial balance per year, fund and kind. */
export function priorTbId(fiscalYear: number, fundCode: string, kind: PriorTbKind): string {
  return `${fiscalYear}__${fundCode}__${kind}`;
}

/** Debit less credit, by account code; zero accounts left out. */
export function netByCode(lines: Array<{ accountCode: string; debit?: number; credit?: number }>) {
  const m = new Map<string, number>();
  for (const l of lines) {
    const code = String(l.accountCode ?? '').trim();
    if (!code) continue;
    m.set(code, (m.get(code) ?? 0) + Math.round(l.debit ?? 0) - Math.round(l.credit ?? 0));
  }
  for (const [k, v] of [...m]) if (v === 0) m.delete(k);
  return m;
}

/** Revenue (4-) and expense (5-) accounts still carrying a balance. */
export function openNominalAccounts(net: Map<string, number>): string[] {
  return [...net]
    .filter(([code, v]) => v !== 0 && (code.startsWith('4') || code.startsWith('5')))
    .map(([code]) => code)
    .sort();
}

export interface OpeningDifference {
  accountCode: string;
  /** Debit less credit on the post-closing trial balance. */
  trialBalance: number;
  /** Debit less credit on the Opening Balances entry of the next year. */
  opening: number;
  difference: number;
}

/**
 * The accounts on which the post-closing trial balance and the next year's
 * opening balances disagree. Empty when they agree.
 */
export function compareWithOpening(
  postClosing: Map<string, number>,
  opening: Map<string, number>,
): OpeningDifference[] {
  const codes = new Set([...postClosing.keys(), ...opening.keys()]);
  const out: OpeningDifference[] = [];
  for (const code of codes) {
    const tb = postClosing.get(code) ?? 0;
    const op = opening.get(code) ?? 0;
    if (tb !== op)
      out.push({ accountCode: code, trialBalance: tb, opening: op, difference: tb - op });
  }
  return out.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

/** Natural balances (as the statements present them) from a trial balance. */
export function naturalFromTb(net: Map<string, number>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [code, v] of net) {
    const c = code[0];
    m.set(code, c === '1' || c === '5' ? v : -v);
  }
  return m;
}
