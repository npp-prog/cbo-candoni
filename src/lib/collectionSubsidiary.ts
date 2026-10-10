/**
 * Patch 158 - which receipt lines name a subsidiary ledger account.
 *
 * Most of what the Treasury receipts is revenue, and a revenue account is
 * kept as one figure: nobody asks "how much Business Tax did Juan pay?" of
 * the General Ledger. But a receipt can also settle a RECEIVABLE (a refund
 * of an unliquidated cash advance, a disallowance being paid back) or put
 * money into a PAYABLE (a bidder's security, a performance bond). Those
 * accounts are kept per party - the subsidiary ledger is what says who still
 * owes, or who is owed - so the receipt has to say which party it was.
 *
 * So a line needs a subsidiary when:
 *   - its account is NOT a revenue account (not class 4: an asset, a
 *     liability or equity - in practice a receivable or a payable), or
 *   - its account is a revenue account the Accountant has ticked "Has a
 *     subsidiary ledger" on, in Master Data > Chart of Accounts.
 *
 * The RCD that reports the receipt journalizes it with that subsidiary, one
 * credit per account and subsidiary.
 */

export function isRevenueAccount(code: string): boolean {
  return String(code ?? '')
    .trim()
    .startsWith('4');
}

export function collectionLineNeedsSubsidiary(
  code: string | null | undefined,
  account?: { requiresSubsidiary?: boolean | null } | null,
): boolean {
  const c = String(code ?? '').trim();
  if (!c) return false;
  if (account?.requiresSubsidiary === true) return true;
  return !isRevenueAccount(c);
}

export interface SubsidiaryLine {
  accountCode?: string | null;
  accountName?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
}

/** The lines that need a subsidiary and do not have one: "line 2 (10305020 Advances...)". */
export function missingSubsidiaries(
  lines: SubsidiaryLine[],
  accountOf: (code: string) => { requiresSubsidiary?: boolean | null } | null | undefined,
): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    const code = String(l.accountCode ?? '').trim();
    if (!collectionLineNeedsSubsidiary(code, accountOf(code))) return;
    if (l.subsidiaryId && l.subsidiaryName) return;
    out.push(`line ${i + 1} (${code}${l.accountName ? ` ${l.accountName}` : ''})`);
  });
  return out;
}

/**
 * The credits of a collection report: one per account and subsidiary, in the
 * order first met. A line with no subsidiary is gathered with the others of
 * its account, as before.
 */
export function creditsByAccountAndSubsidiary(
  lines: Array<{
    accountCode: string;
    accountName: string;
    amount: number;
    subsidiaryType?: string | null;
    subsidiaryId?: string | null;
    subsidiaryName?: string | null;
  }>,
): Array<{
  accountCode: string;
  accountName: string;
  amount: number;
  subsidiaryType: string | null;
  subsidiaryId: string | null;
  subsidiaryName: string | null;
}> {
  const map = new Map<
    string,
    {
      accountCode: string;
      accountName: string;
      amount: number;
      subsidiaryType: string | null;
      subsidiaryId: string | null;
      subsidiaryName: string | null;
    }
  >();
  for (const l of lines) {
    const sub = l.subsidiaryId && l.subsidiaryType ? `${l.subsidiaryType}:${l.subsidiaryId}` : '';
    const key = `${l.accountCode}|${sub}`;
    const g = map.get(key);
    if (g) g.amount += l.amount;
    else
      map.set(key, {
        accountCode: l.accountCode,
        accountName: l.accountName,
        amount: l.amount,
        subsidiaryType: sub ? (l.subsidiaryType ?? null) : null,
        subsidiaryId: sub ? (l.subsidiaryId ?? null) : null,
        subsidiaryName: sub ? (l.subsidiaryName ?? null) : null,
      });
  }
  return [...map.values()];
}
