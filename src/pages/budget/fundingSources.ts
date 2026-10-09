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
 * WHERE EACH SECTION COMES FROM (patch 123)
 * ---------------------------------------------------------------------------
 *   1.0, 2.0   ENCODED - inside a supplemental ordinance or on the Sources
 *              tab (`fundingSources`, written by the engine). They are what
 *              finances a supplemental budget, and it cannot be approved
 *              without them.
 *   3.0        the SAVINGS augmentations took - the negative lines of every
 *              augmentation posted this year, by the object they came from.
 *   4.0        what REALIGNMENTS took - the negative lines of every
 *              realignment posted this year, by the object they came from.
 *
 * Patch 119 left 1.0 to 3.0 blank for the hand. Neil, 09 Oct 2026: the
 * augmentation's source is 3.0 Savings, and the supplemental's sources are
 * encoded, so the form is filled from the books in all four.
 *
 * The new realigned or augmented budget - the positive side - is on the
 * Appropriation Ledger and on LBP Form No. 2, not here.
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
  /** Column 1, for an encoded source: what it is. */
  particulars?: string;
  accountCode: string;
  /** Column 3, always positive. */
  amount: Centavos;
}

export interface EncodedSourceInput {
  section: string;
  particulars: string;
  accountCode?: string | null;
  accountName?: string | null;
  amount: Centavos;
}

export interface FundingSourcesSheet {
  newRevenue: FundingSourceRow[];
  totalNewRevenue: Centavos;
  excess: FundingSourceRow[];
  totalExcess: Centavos;
  savings: FundingSourceRow[];
  totalSavings: Centavos;
  realignment: FundingSourceRow[];
  totalRealignment: Centavos;
  total: Centavos;
}

/** A line of a posted augmentation that gave up its savings. */
export function isSavingsSource(a: FundingSourceInput): boolean {
  return a.status === 'APPROVED' && a.kind === 'REALIGNMENT' && a.instrument === 'AUGMENTATION' && a.amount < 0;
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

function takenFrom(appropriations: FundingSourceInput[], test: (a: FundingSourceInput) => boolean) {
  const byAccount = new Map<string, FundingSourceRow>();
  for (const a of appropriations) {
    if (!test(a)) continue;
    const key = a.accountCode || a.fppCode || classificationOf(a);
    const row = byAccount.get(key) ?? {
      classification: classificationOf(a),
      accountCode: a.accountCode ?? '',
      amount: 0,
    };
    row.amount += Math.abs(a.amount);
    byAccount.set(key, row);
  }
  return [...byAccount.values()].sort(
    (x, y) => x.accountCode.localeCompare(y.accountCode) || x.classification.localeCompare(y.classification),
  );
}

function encodedRows(sources: EncodedSourceInput[], section: string): FundingSourceRow[] {
  return sources
    .filter((s) => s.section === section)
    .map((s) => ({
      classification: s.accountCode
        ? `${s.accountCode}${s.accountName ? ` - ${s.accountName}` : ''}`
        : s.particulars,
      accountCode: s.accountCode ?? '',
      particulars: s.particulars,
      amount: s.amount,
    }));
}

const sum = (rows: FundingSourceRow[]) => rows.reduce((t, r) => t + r.amount, 0);

export function buildFundingSources(
  appropriations: FundingSourceInput[],
  sources: EncodedSourceInput[] = [],
): FundingSourcesSheet {
  const newRevenue = encodedRows(sources, 'NEW_REVENUE');
  const excess = encodedRows(sources, 'EXCESS_COLLECTION');
  const savings = takenFrom(appropriations, isSavingsSource);
  const realignment = takenFrom(appropriations, isRealignmentSource);
  const t = {
    totalNewRevenue: sum(newRevenue),
    totalExcess: sum(excess),
    totalSavings: sum(savings),
    totalRealignment: sum(realignment),
  };
  return {
    newRevenue,
    excess,
    savings,
    realignment,
    ...t,
    total: t.totalNewRevenue + t.totalExcess + t.totalSavings + t.totalRealignment,
  };
}
