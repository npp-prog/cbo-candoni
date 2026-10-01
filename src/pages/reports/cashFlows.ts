import {
  TRUST_FUND_CODE,
  captionFor,
  captionsForFund,
  isCashAccount,
  type CashFlowSection,
} from '@/lib/cashFlowLines';
import type { Centavos } from '@/types/common';

/**
 * The Statement of Cash Flows, GAM Annex 9 (and Annex 9-A for the Trust Fund).
 *
 * The reasoning behind the attribution is in lib/cashFlowLines.ts; this is the
 * arithmetic. In one sentence: a journal entry balances, so each non-cash
 * line's contribution to that entry's cash movement is exactly the negative of
 * its own signed amount, and the captions are read off the counterpart
 * account.
 *
 * ---------------------------------------------------------------------------
 * THE STATEMENT PROVES ITSELF
 * ---------------------------------------------------------------------------
 * This is the one financial statement that can be checked without a second
 * source, and the check is not a tolerance - it is exact.
 *
 * Cash at the beginning, plus every flow this statement reports, must equal
 * the balance of the cash accounts in the General Ledger at the end. The two
 * sides are built from different things: the left from the counterpart lines
 * of each entry, the right from the cash lines. If a journal entry were
 * dropped, double-counted, or half-attributed, the two would part company.
 *
 * So `tiesOut` is reported on the screen, and the statement is not presented
 * as complete while it is false. Nothing here is rounded or allocated, so a
 * drift of a single centavo is a real defect and not a rounding artefact.
 */

export interface CashFlowEntry {
  jevId: string;
  jevNo: string;
  period: number;
  accountCode: string;
  accountName: string;
  /** Debit positive, credit negative. */
  signedAmount: Centavos;
  sourceType?: string;
}

export interface CashFlowAccount {
  accountCode: string;
  accountName: string;
  amount: Centavos;
}

export interface CashFlowRow {
  caption: string;
  section: CashFlowSection;
  direction: 'IN' | 'OUT';
  /** Always positive: the annex prints inflows and outflows in separate blocks. */
  amount: Centavos;
  /** The counterpart accounts behind the caption, largest first, for checking. */
  accounts: CashFlowAccount[];
}

export interface CashFlowBlock {
  section: CashFlowSection;
  inflows: CashFlowRow[];
  outflows: CashFlowRow[];
  totalIn: Centavos;
  totalOut: Centavos;
  /** Inflows less outflows. */
  net: Centavos;
}

export interface CashFlowStatement {
  blocks: CashFlowBlock[];
  /** Operating plus investing plus financing. */
  netFlows: Centavos;
  openingCash: Centavos;
  /** Opening plus net flows: what the statement says the closing balance is. */
  closingCash: Centavos;
  /** The cash accounts' balance per the General Ledger, summed independently. */
  closingCashPerLedger: Centavos;
  /** closingCash less closingCashPerLedger. Zero, or the statement is wrong. */
  drift: Centavos;
  tiesOut: boolean;
  /**
   * Journal entries whose lines do not sum to zero. A posted entry cannot be
   * one, so anything here means the ledger itself is damaged, and it is
   * surfaced rather than absorbed into a caption.
   */
  unbalanced: Array<{ jevNo: string; difference: Centavos }>;
  /** Cash brought in by an opening-balance entry rather than by the prior year. */
  openingFromOpeningEntry: Centavos;
  /** As supplied. Both this and openingFromOpeningEntry carrying a figure means
   *  the year was opened twice over, which is a data error worth showing. */
  priorClosingCash: Centavos;
  /** Entries that moved cash and so contributed to the statement. */
  cashEntries: number;
  /** Cash-to-cash entries - deposits, transfers - which correctly contribute nothing. */
  transferEntries: number;
}

const SECTIONS: CashFlowSection[] = ['OPERATING', 'INVESTING', 'FINANCING'];

export function buildCashFlows(input: {
  /** Every ledger line of the fiscal year, not only the cash ones: the
   *  counterpart lines are what the captions are read from. */
  entries: CashFlowEntry[];
  throughPeriod: number;
  /**
   * The cash balance carried in from the preceding year. Zero for a fund whose
   * first year in CFMS this is - there the opening balance arrives as an
   * OPENING journal entry inside this year instead, and is picked up below.
   */
  priorClosingCash: Centavos;
  /** 'TF' presents the shorter Annex 9-A. */
  fundCode?: string;
}): CashFlowStatement {
  const captions = captionsForFund(input.fundCode);
  const isTrustFund = input.fundCode === TRUST_FUND_CODE;
  const inPeriod = input.entries.filter((e) => e.period <= input.throughPeriod);

  // --- the two figures the statement is checked against ---------------------
  let openingFromOpeningEntry = 0;
  let cashMovementAllEntries = 0;
  for (const e of inPeriod) {
    if (!isCashAccount(e.accountCode)) continue;
    cashMovementAllEntries += e.signedAmount;
    if (e.sourceType === 'OPENING') openingFromOpeningEntry += e.signedAmount;
  }

  const openingCash = input.priorClosingCash + openingFromOpeningEntry;
  const closingCashPerLedger = input.priorClosingCash + cashMovementAllEntries;

  // --- attribution ---------------------------------------------------------
  const byJev = new Map<string, CashFlowEntry[]>();
  for (const e of inPeriod) {
    /*
     * The opening-balance entry is not a cash flow. It is Dr Cash and the rest
     * of the assets, Cr Government Equity, recording the position the books
     * were converted with - and if it went through the attribution below, the
     * whole opening cash balance would be reported as an operating receipt
     * against Government Equity. It sets the opening line instead.
     */
    if (e.sourceType === 'OPENING') continue;
    const got = byJev.get(e.jevId);
    if (got) got.push(e);
    else byJev.set(e.jevId, [e]);
  }

  const rows = new Map<string, CashFlowRow>();
  const accountTotals = new Map<string, Map<string, CashFlowAccount>>();
  for (const def of captions) {
    const key = rowKey(def.section, def.direction, def.caption);
    rows.set(key, {
      caption: def.caption,
      section: def.section,
      direction: def.direction,
      amount: 0,
      accounts: [],
    });
    accountTotals.set(key, new Map());
  }

  const unbalanced: CashFlowStatement['unbalanced'] = [];
  let cashEntries = 0;
  let transferEntries = 0;

  for (const lines of byJev.values()) {
    const cashLines = lines.filter((l) => isCashAccount(l.accountCode));
    if (cashLines.length === 0) continue; // moved no cash; not on this statement

    const others = lines.filter((l) => !isCashAccount(l.accountCode));
    if (others.length === 0) {
      /*
       * Every line is a cash account: a deposit of collections, or a transfer
       * between bank accounts. There is no counterpart to attribute and there
       * must not be - the money was already reported when it was collected,
       * and reporting it again on deposit would double the whole statement.
       */
      transferEntries += 1;
      continue;
    }
    cashEntries += 1;

    const total = lines.reduce((s, l) => s + l.signedAmount, 0);
    if (total !== 0) {
      unbalanced.push({ jevNo: lines[0].jevNo, difference: total });
    }

    for (const line of others) {
      // The heart of it: this line's share of the cash movement is the
      // negative of its own signed amount. Exact, by double entry.
      const contribution = -line.signedAmount;
      if (contribution === 0) continue;

      const direction: 'IN' | 'OUT' = contribution > 0 ? 'IN' : 'OUT';
      const def = captionFor(line.accountCode, direction, line.accountName, captions);
      const key = rowKey(def.section, def.direction, def.caption);

      const row = rows.get(key)!;
      row.amount += Math.abs(contribution);

      const accounts = accountTotals.get(key)!;
      const got = accounts.get(line.accountCode) ?? {
        accountCode: line.accountCode,
        accountName: line.accountName,
        amount: 0,
      };
      got.amount += Math.abs(contribution);
      accounts.set(line.accountCode, got);
    }
  }

  for (const [key, row] of rows) {
    row.accounts = [...accountTotals.get(key)!.values()].sort((a, b) => b.amount - a.amount);
  }

  // --- blocks --------------------------------------------------------------
  const blocks: CashFlowBlock[] = SECTIONS.map((section) => {
    let all = [...rows.values()].filter((r) => r.section === section);
    /*
     * Annex 9-A prints the Trust Fund's investing and financing sections as
     * bare headings. Showing only the captions that carry a figure reproduces
     * that for a trust fund with no such activity, without hiding one that has.
     */
    if (isTrustFund && section !== 'OPERATING') all = all.filter((r) => r.amount !== 0);
    const inflows = all.filter((r) => r.direction === 'IN');
    const outflows = all.filter((r) => r.direction === 'OUT');
    const totalIn = inflows.reduce((s, r) => s + r.amount, 0);
    const totalOut = outflows.reduce((s, r) => s + r.amount, 0);
    return { section, inflows, outflows, totalIn, totalOut, net: totalIn - totalOut };
  });

  const netFlows = blocks.reduce((s, b) => s + b.net, 0);
  const closingCash = openingCash + netFlows;
  const drift = closingCash - closingCashPerLedger;

  return {
    blocks,
    netFlows,
    openingCash,
    closingCash,
    closingCashPerLedger,
    drift,
    tiesOut: drift === 0,
    unbalanced,
    openingFromOpeningEntry,
    priorClosingCash: input.priorClosingCash,
    cashEntries,
    transferEntries,
  };
}

function rowKey(section: CashFlowSection, direction: 'IN' | 'OUT', caption: string): string {
  return `${section}::${direction}::${caption}`;
}

export const SECTION_LABELS: Record<CashFlowSection, string> = {
  OPERATING: 'Cash Flows From Operating Activities',
  INVESTING: 'Cash Flows From Investing Activities',
  FINANCING: 'Cash Flows From Financing Activities',
};
