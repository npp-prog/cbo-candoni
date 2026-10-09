import type { Centavos } from '@/types/common';

/**
 * LBP Form No. 8 - Statement of Funding Sources (Supplemental Budget).
 * Budget Operations Manual for LGUs, 2023 Edition, page 70. Patch 119.
 *
 * The form has four numbered sources, in the manual's own order and words:
 *
 *   1.0 New Revenue Sources        (Tax Revenue, Loan Proceeds)
 *   2.0 Actual Collection in Excess of the Estimated Income
 *   3.0 Savings
 *   4.0 Realignment
 *
 * with an account classification and an amount against each, certified by
 * the Local Treasurer and the Local Accountant.
 *
 * ---------------------------------------------------------------------------
 * WHAT CFMS FILLS IN, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * 4.0 REALIGNMENT is filled from the books. A realignment is posted as lines
 * of opposite sign; the NEGATIVE lines are the appropriation taken away, and
 * those are the funding source. They are grouped by the object of expenditure
 * they were taken from - the "account classification" the form asks for - and
 * the positive side, the new realigned budget, is on the Appropriation Ledger
 * and on LBP Form No. 2, not here.
 *
 * 1.0, 2.0 and 3.0 are NOT derived. Which new revenue or which excess
 * collection funds a supplemental budget is a decision the Treasurer and the
 * Accountant certify, not a figure the books can produce; and "savings" on
 * this form means savings declared to fund a supplemental budget, which is
 * not the same act as an augmentation. Those lines print blank, to be filled
 * in by hand, and the sheet says so.
 */

export interface FundingSourceInput {
  kind: string;
  instrument?: string | null;
  status: string;
  accountCode?: string;
  accountName?: string;
  fppCode?: string;
  fppName?: string;
  /** Negative on the side the authority was taken from. */
  amount: Centavos;
}

export interface FundingSourceRow {
  /** Column 2: the account classification - the object the authority came from. */
  classification: string;
  accountCode: string;
  /** Column 3, always positive. */
  amount: Centavos;
}

export interface FundingSourcesSheet {
  realignment: FundingSourceRow[];
  totalRealignment: Centavos;
  total: Centavos;
}

/** A line of a posted realignment that took authority away. */
export function isRealignmentSource(a: FundingSourceInput): boolean {
  return (
    a.status === 'APPROVED' &&
    a.kind === 'REALIGNMENT' &&
    // SUPPLEMENTAL is what a realignment's instrument was called before patch 58.
    (a.instrument === 'REALIGNMENT' || a.instrument === 'SUPPLEMENTAL') &&
    a.amount < 0
  );
}

const classificationOf = (a: FundingSourceInput): string => {
  if (a.accountCode && a.accountName) return `${a.accountCode} - ${a.accountName}`;
  if (a.accountName) return a.accountName;
  return a.fppName || a.fppCode || '';
};

export function buildFundingSources(appropriations: FundingSourceInput[]): FundingSourcesSheet {
  const byAccount = new Map<string, FundingSourceRow>();
  for (const a of appropriations) {
    if (!isRealignmentSource(a)) continue;
    const key = a.accountCode || a.fppCode || classificationOf(a);
    const row = byAccount.get(key) ?? {
      classification: classificationOf(a),
      accountCode: a.accountCode ?? '',
      amount: 0,
    };
    row.amount += Math.abs(a.amount);
    byAccount.set(key, row);
  }
  const realignment = [...byAccount.values()].sort(
    (x, y) =>
      x.accountCode.localeCompare(y.accountCode) ||
      x.classification.localeCompare(y.classification),
  );
  const totalRealignment = realignment.reduce((t, r) => t + r.amount, 0);
  return { realignment, totalRealignment, total: totalRealignment };
}
