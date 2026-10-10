// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/priorCashFlow.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
import { captionsForFund, isCashAccount, type CashFlowSection } from './cashFlowLines';

/**
 * Patch 170 - THE PRIOR YEAR'S STATEMENT OF CASH FLOWS, for the comparative
 * column.
 *
 * A trial balance shows where the cash ended, not how it moved, so the
 * preceding year's cash flows cannot be read from the trial balances uploaded
 * in patch 169. The office sets them up instead, on Accounting > Setup >
 * Prior Year Cash Flows: the cash balance at the beginning of the year and
 * one figure for each caption of Annex 9 (Annex 9-A for the Trust Fund), as
 * the submitted statement had them.
 *
 * The figures are checked where they can be. The year's cash at the end - the
 * beginning plus the inflows less the outflows - must be the cash the next
 * year opened with: the cash accounts (1-01) on the Opening Balances entry,
 * and on the post-closing trial balance where one is uploaded. A set of
 * figures that does not land on that balance is refused.
 *
 * Shared by the browser and the engine (scripts/sync-rules). Integer centavos.
 */

export interface PriorCashFlowLine {
  section: CashFlowSection;
  direction: 'IN' | 'OUT';
  caption: string;
  /** Always positive: inflows and outflows are separate captions. */
  amount: number;
}

/** One set of prior-year cash flows per year and fund. */
export function priorCashFlowId(fiscalYear: number, fundCode: string): string {
  return `${fiscalYear}__${fundCode}`;
}

export function cashFlowKey(section: string, direction: string, caption: string): string {
  return `${section}::${direction}::${caption}`;
}

/** The captions this fund's statement prints, as blank lines to fill. */
export function blankPriorLines(fundCode: string): PriorCashFlowLine[] {
  return captionsForFund(fundCode).map((d) => ({
    section: d.section,
    direction: d.direction,
    caption: d.caption,
    amount: 0,
  }));
}

/** Lines on a caption the fund's statement does not print. */
export function unknownCaptions(fundCode: string, lines: PriorCashFlowLine[]): string[] {
  const known = new Set(
    captionsForFund(fundCode).map((d) => cashFlowKey(d.section, d.direction, d.caption)),
  );
  return lines
    .filter((l) => !known.has(cashFlowKey(l.section, l.direction, l.caption)))
    .map((l) => l.caption);
}

export interface PriorCashFlowTotals {
  bySection: Record<CashFlowSection, { totalIn: number; totalOut: number; net: number }>;
  netFlows: number;
  endingCash: number;
}

export function priorCashFlowTotals(
  lines: PriorCashFlowLine[],
  beginningCash: number,
): PriorCashFlowTotals {
  const bySection: PriorCashFlowTotals['bySection'] = {
    OPERATING: { totalIn: 0, totalOut: 0, net: 0 },
    INVESTING: { totalIn: 0, totalOut: 0, net: 0 },
    FINANCING: { totalIn: 0, totalOut: 0, net: 0 },
  };
  for (const l of lines) {
    const s = bySection[l.section];
    if (!s) continue;
    const a = Math.round(l.amount ?? 0);
    if (l.direction === 'IN') s.totalIn += a;
    else s.totalOut += a;
  }
  let netFlows = 0;
  for (const s of Object.values(bySection)) {
    s.net = s.totalIn - s.totalOut;
    netFlows += s.net;
  }
  return { bySection, netFlows, endingCash: Math.round(beginningCash) + netFlows };
}

/** The cash (1-01) on a set of lines, debit less credit. */
export function cashOn(lines: Array<{ accountCode: string; debit?: number; credit?: number }>) {
  return lines
    .filter((l) => isCashAccount(l.accountCode))
    .reduce((s, l) => s + Math.round(l.debit ?? 0) - Math.round(l.credit ?? 0), 0);
}
