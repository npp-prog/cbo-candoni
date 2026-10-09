import type { Centavos } from '@/types/common';

/**
 * LBP Form No. 8 - Statement of Funding Sources (Supplemental Budget).
 * Budget Operations Manual for LGUs, 2023 Edition, page 70. Patch 119,
 * redrawn in patches 123 and 126.
 *
 * The form has four numbered sources, in the manual's own order and words:
 *
 *   1.0 New Revenue Sources        (Tax Revenue, Loan Proceeds)
 *   2.0 Actual Collection in Excess of the Estimated Income
 *   3.0 Savings
 *   4.0 Realignment
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH SECTION COMES FROM
 * ---------------------------------------------------------------------------
 *   1.0, 2.0, 3.0  ENCODED - inside a supplemental ordinance or on the
 *                  Supplemental Sources tab (`fundingSources`, written by the
 *                  engine). They finance a supplemental budget, and it cannot
 *                  be approved without them.
 *   4.0            what REALIGNMENTS took - the negative lines of every
 *                  realignment posted this year, by the object they came
 *                  from. A realignment is part of the supplemental budget.
 *
 * An AUGMENTATION is not on the form. Neil, patch 126: savings moved by the
 * Local Chief Executive under the authority the Sanggunian gave need not be
 * in the supplemental budget. Savings that DO finance a supplemental budget
 * are encoded under 3.0. (Patch 123 had filled 3.0 from augmentations.)
 *
 * The new realigned budget - the positive side - is on the Appropriation
 * Ledger and on LBP Form No. 2, not here.
 */

export interface FundingSourceInput {
  kind: string;
  instrument?: string | null;
  status: string;
  accountCode?: string;
  accountName?: string;
  fppCode?: string;
  fppName?: string;
  authorityReference?: string;
  /** Negative on the side the authority was taken from. */
  amount: Centavos;
}

export interface EncodedSourceInput {
  id?: string;
  section: string;
  particulars: string;
  accountCode?: string | null;
  accountName?: string | null;
  amount: Centavos;
  actReference?: string | null;
}

export interface FundingSourceRow {
  /** Column 2: the account classification. */
  classification: string;
  accountCode: string;
  /** Column 1, for an encoded source: what it is. */
  particulars?: string;
  /** Column 3, always positive. */
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

const classificationOf = (a: {
  accountCode?: string | null;
  accountName?: string | null;
  fppCode?: string;
  fppName?: string;
}): string => {
  if (a.accountCode && a.accountName) return `${a.accountCode} - ${a.accountName}`;
  if (a.accountCode) return a.accountCode;
  if (a.accountName) return a.accountName;
  return a.fppName || a.fppCode || '';
};

function realignedFrom(appropriations: FundingSourceInput[]): FundingSourceRow[] {
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
  return [...byAccount.values()].sort(
    (x, y) =>
      x.accountCode.localeCompare(y.accountCode) ||
      x.classification.localeCompare(y.classification),
  );
}

function encodedRows(sources: EncodedSourceInput[], section: string): FundingSourceRow[] {
  return sources
    .filter((s) => s.section === section)
    .map((s) => ({
      classification: s.accountCode ? classificationOf(s) : '',
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
  const savings = encodedRows(sources, 'SAVINGS');
  const realignment = realignedFrom(appropriations);
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

// ---------------------------------------------------------------------------
// The register - what the tab shows on screen. Patch 126.
// ---------------------------------------------------------------------------

export interface RegisterRow {
  key: string;
  /** '1.0' .. '4.0', for sorting and the column. */
  number: string;
  section: string;
  particulars: string;
  classification: string;
  /** The act it belongs to, or null for an open source. */
  encodedIn: string | null;
  amount: Centavos;
  /** Set on an encoded source: it may be corrected or removed. A realignment row is read from the books. */
  sourceId: string | null;
}

const NUMBER: Record<string, string> = {
  NEW_REVENUE: '1.0',
  EXCESS_COLLECTION: '2.0',
  SAVINGS: '3.0',
  REALIGNMENT: '4.0',
};

/**
 * Every supplemental source of the year, one row each: the encoded ones as
 * encoded, and each realignment's taken-from side by ordinance and account.
 * The form groups the same figures by section; the register keeps them apart
 * so each can be traced to where it came from.
 */
export function buildSourceRegister(
  appropriations: FundingSourceInput[],
  sources: EncodedSourceInput[],
): RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (const s of sources) {
    const number = NUMBER[s.section];
    if (!number) continue; // CONTINUING is not a supplemental source
    rows.push({
      key: s.id ?? `${s.section}-${s.particulars}-${rows.length}`,
      number,
      section: s.section,
      particulars: s.particulars,
      classification: s.accountCode ? classificationOf(s) : '',
      encodedIn: s.actReference ?? null,
      amount: s.amount,
      sourceId: s.id ?? null,
    });
  }
  const realigned = new Map<string, RegisterRow>();
  for (const a of appropriations) {
    if (!isRealignmentSource(a)) continue;
    const ref = a.authorityReference ?? '';
    const key = `R-${ref}-${a.accountCode || a.fppCode}`;
    const row = realigned.get(key) ?? {
      key,
      number: '4.0',
      section: 'REALIGNMENT',
      particulars: 'Appropriation realigned from',
      classification: classificationOf(a),
      encodedIn: ref || null,
      amount: 0,
      sourceId: null,
    };
    row.amount += Math.abs(a.amount);
    realigned.set(key, row);
  }
  rows.push(...realigned.values());
  return rows.sort(
    (x, y) =>
      x.number.localeCompare(y.number) ||
      (x.encodedIn ?? '').localeCompare(y.encodedIn ?? '') ||
      x.particulars.localeCompare(y.particulars),
  );
}

// ---------------------------------------------------------------------------
// One supplemental budget's own LBP Form No. 8. Patch 129.
// ---------------------------------------------------------------------------

const ORDER: Record<string, number> = { NEW_REVENUE: 1, EXCESS_COLLECTION: 2, SAVINGS: 3 };

/**
 * The sources ONE supplemental ordinance stands on: those encoded in it, and
 * the part of the open sources (encoded on the Supplemental Sources tab) it
 * draws for what its own do not cover.
 *
 * Which open source a supplemental draws is not recorded - they are a pool -
 * so the form shows them taken in the form's own order, 1.0 then 2.0 then
 * 3.0, and only as much as the ordinance needs. A source drawn in part says
 * so. What prints therefore adds up to what the ordinance appropriates, or
 * to what it has if it is short.
 */
export function sourcesForAct(input: {
  actId: string;
  sources: Array<EncodedSourceInput & { actId?: string | null }>;
  /** What the act appropriates - approved and waiting. */
  needed: number;
  /** What is left of the open sources after the other acts drew on them. */
  openAvailable: number;
}): EncodedSourceInput[] {
  const supplemental = input.sources.filter((s) => ORDER[s.section]);
  const own = supplemental.filter((s) => s.actId === input.actId);
  const ownTotal = own.reduce((t, s) => t + s.amount, 0);
  let toDraw = Math.max(0, Math.min(input.needed - ownTotal, input.openAvailable));
  const open = supplemental
    .filter((s) => !s.actId)
    .sort((a, b) => ORDER[a.section] - ORDER[b.section] || a.particulars.localeCompare(b.particulars));
  const drawn: EncodedSourceInput[] = [];
  for (const s of open) {
    if (toDraw <= 0) break;
    const take = Math.min(s.amount, toDraw);
    drawn.push({
      ...s,
      particulars: take < s.amount ? `${s.particulars} (part)` : s.particulars,
      amount: take,
    });
    toDraw -= take;
  }
  return [...own, ...drawn];
}
