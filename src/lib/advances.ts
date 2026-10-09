import type { Centavos } from '@/types/common';

/**
 * The cash advances to be liquidated, read off the General Ledger. Patch 133.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEDGER AND NOT A REGISTER OF ITS OWN
 * ---------------------------------------------------------------------------
 * CFMS had a `cashAdvances` collection that the liquidation report picked
 * from, and nothing ever wrote to it. Its comment said the engine created one
 * when a cash-advance voucher was posted; that was never built. So an advance
 * could be granted and posted - JEV 100-2026-10-0010, Dr Advances to Special
 * Disbursing Officer 10,000 for Ma Bella Dela Cruz - and the liquidation
 * report still offered nothing to liquidate.
 *
 * However an advance reaches the books - a voucher, an ADA on a RADAI, an
 * opening balance, a General Transaction - it is a DEBIT to an advance account
 * with the officer as the subsidiary. That is the one thing every path has in
 * common, so that is what this reads. The Accountant chooses which accounts
 * are advances (Master Data > Chart of Accounts); everything else follows.
 *
 * ---------------------------------------------------------------------------
 * HOW AN ADVANCE IS SETTLED
 * ---------------------------------------------------------------------------
 * Each debit is one advance granted. Each credit to the same account for the
 * same officer - a liquidation, a refund, a reversal - settles the oldest
 * advance first. The officer's balance on the account is exact; which advance
 * a credit settled is the oldest-first reading, the same rule the aging of
 * payables uses.
 */

export interface AdvanceLedgerEntry {
  id: string;
  fiscalYear: number;
  fundCode: string;
  entryDate: string;
  agingDate?: string | null;
  jevNo: string;
  /** Patch 150: the entry the line belongs to, so its number can open it. */
  jevId?: string | null;
  referenceNo?: string | null;
  accountCode: string;
  accountName: string;
  debit: Centavos;
  credit: Centavos;
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
  officeId?: string | null;
  officeName?: string | null;
  particulars?: string | null;
}

export interface AdvanceGranted {
  /** The ledger entry that granted it. The liquidation names this. */
  id: string;
  fiscalYear: number;
  fundCode: string;
  dateGranted: string;
  jevNo: string;
  reference: string;
  accountCode: string;
  accountName: string;
  subsidiaryType: string | null;
  officerId: string | null;
  officerName: string;
  officeId: string | null;
  officeName: string;
  purpose: string;
  amountGranted: Centavos;
  /** Credits applied to it, oldest advance first. */
  amountSettled: Centavos;
  outstanding: Centavos;
}

export interface AdvanceRegister {
  advances: AdvanceGranted[];
  /** Debits to an advance account with no officer named: nobody can liquidate them. */
  unassigned: AdvanceLedgerEntry[];
}

/**
 * Who an entry belongs to: the officer's NAME, normalised, where there is one,
 * else the subsidiary id. Patch 135: by name first, because a refund reaches
 * the advance through the Treasury's collections, and the RCD entry names the
 * officer as a subsidiary by name - it has no payee record id to carry. Keyed
 * by id, that credit would sit apart from the advance it settles.
 */
export const officerKey = (e: { subsidiaryId?: string | null; subsidiaryName?: string | null }) =>
  String(e.subsidiaryName ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ') || String(e.subsidiaryId ?? '').trim();

const dateOf = (e: AdvanceLedgerEntry) => e.agingDate || e.entryDate;

export function buildAdvanceRegister(
  entries: AdvanceLedgerEntry[],
  isAdvanceAccount: (code: string) => boolean,
): AdvanceRegister {
  const groups = new Map<string, AdvanceLedgerEntry[]>();
  const unassigned: AdvanceLedgerEntry[] = [];
  for (const e of entries) {
    if (!isAdvanceAccount(String(e.accountCode ?? '').trim())) continue;
    const who = officerKey(e);
    if (!who) {
      if ((e.debit ?? 0) > 0) unassigned.push(e);
      continue;
    }
    const k = `${e.fundCode}|${e.accountCode}|${who}`;
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  }

  const advances: AdvanceGranted[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort(
      (a, b) => dateOf(a).localeCompare(dateOf(b)) || a.jevNo.localeCompare(b.jevNo),
    );
    const grants: AdvanceGranted[] = [];
    let credits = 0;
    for (const e of sorted) {
      credits += e.credit ?? 0;
      if ((e.debit ?? 0) <= 0) continue;
      grants.push({
        id: e.id,
        fiscalYear: e.fiscalYear,
        fundCode: e.fundCode,
        dateGranted: dateOf(e),
        jevNo: e.jevNo,
        reference: e.referenceNo || e.jevNo,
        accountCode: e.accountCode,
        accountName: e.accountName,
        subsidiaryType: e.subsidiaryType ?? null,
        officerId: e.subsidiaryId ?? null,
        officerName: e.subsidiaryName ?? '',
        officeId: e.officeId ?? null,
        officeName: e.officeName ?? '',
        purpose: e.particulars ?? '',
        amountGranted: e.debit,
        amountSettled: 0,
        outstanding: e.debit,
      });
    }
    // Settle oldest first.
    for (const g of grants) {
      const take = Math.min(g.amountGranted, credits);
      g.amountSettled = take;
      g.outstanding = g.amountGranted - take;
      credits -= take;
    }
    advances.push(...grants);
  }

  advances.sort(
    (a, b) => a.dateGranted.localeCompare(b.dateGranted) || a.jevNo.localeCompare(b.jevNo),
  );
  return { advances, unassigned };
}

/** What an officer still owes on one advance account, all advances together. */
export function officerBalance(entries: Array<{ debit: Centavos; credit: Centavos }>): Centavos {
  return entries.reduce((t, e) => t + (e.debit ?? 0) - (e.credit ?? 0), 0);
}
