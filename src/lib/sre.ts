import type { Centavos } from '@/types/common';
import { bucketFor, type SreBucket } from './sectors';

/**
 * The Statement of Receipts and Expenditures.
 *
 * The form is Annex A of DBM-DOF-DILG Joint Memorandum Circular No. 2018-1
 * dated 12 July 2018, reproduced line for line below. It is submitted to the
 * DOF-BLGF through the LGU Integrated Financial Tools, and its shape is not
 * the municipality's to choose.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINES ARE HERE AND THE MAPPING IS NOT
 * ---------------------------------------------------------------------------
 * The twenty-odd receipt lines are statutory: they are the same for every LGU
 * in the country and an LGU does not get to add a twenty-first. So they are in
 * code, where changing one is a reviewed change.
 *
 * WHICH ACCOUNT CODES BELONG ON EACH LINE is not statutory in the same way -
 * it depends on the municipality's own Chart of Accounts, and it is a
 * judgement the Accountant and the Treasurer make. So it is data, edited on
 * the screen, and CFMS ships with none of it filled in.
 *
 * That is deliberate and it is the whole reason this file has no default
 * mapping in it. A mapping invented here would produce a statement that foots
 * correctly and reports the wrong figures to BLGF, which is the worst possible
 * outcome for this particular form: wrong and confident. An unmapped account
 * is instead shown, loudly, with its amount, so the statement can never quietly
 * foot to less than the municipality received.
 * ---------------------------------------------------------------------------
 */

export type SreLineKind = 'HEADING' | 'ITEM' | 'SUBTOTAL' | 'TOTAL';

export interface SreLine {
  key: string;
  label: string;
  kind: SreLineKind;
  /** Nesting depth, for the indent on the printed form. */
  indent: 0 | 1 | 2 | 3;
  /** For a SUBTOTAL or TOTAL: the keys it adds up. */
  sum?: string[];
}

/**
 * The receipts section, exactly as Annex A prints it.
 *
 * "Internal Revenue Allotment" is the circular's own wording. It is the
 * National Tax Allotment since the Mandanas-Garcia ruling took effect, and the
 * label is left as the form has it because the form is what is submitted -
 * renaming it here would make CFMS's statement differ from the one BLGF expects
 * on the one line that carries the largest single figure.
 */
export const SRE_RECEIPT_LINES: SreLine[] = [
  { key: 'localSources', label: 'A. Local Sources', kind: 'HEADING', indent: 0 },
  { key: 'taxRevenue', label: '1. Tax Revenue', kind: 'HEADING', indent: 1 },
  { key: 'rptBasic', label: 'Basic Real Property Tax', kind: 'ITEM', indent: 2 },
  { key: 'rptSef', label: 'Special Education Fund', kind: 'ITEM', indent: 2 },
  { key: 'businessTax', label: 'b. Business Tax', kind: 'ITEM', indent: 2 },
  { key: 'otherLocalTaxes', label: 'c. Other Local Taxes', kind: 'ITEM', indent: 2 },
  {
    key: 'totalTaxRevenue',
    label: 'Total Tax Revenue',
    kind: 'SUBTOTAL',
    indent: 1,
    sum: ['rptBasic', 'rptSef', 'businessTax', 'otherLocalTaxes'],
  },

  { key: 'nonTaxRevenue', label: '2. Non Tax Revenue', kind: 'HEADING', indent: 1 },
  { key: 'regulatoryFees', label: 'Regulatory Fees', kind: 'ITEM', indent: 2 },
  { key: 'serviceCharges', label: 'Service/User Charges', kind: 'ITEM', indent: 2 },
  { key: 'economicEnterprise', label: 'Receipts from Economic Enterprise', kind: 'ITEM', indent: 2 },
  { key: 'otherReceipts', label: 'Other Receipts', kind: 'ITEM', indent: 2 },
  {
    key: 'totalNonTaxRevenue',
    label: 'Total Non Tax Revenue',
    kind: 'SUBTOTAL',
    indent: 1,
    sum: ['regulatoryFees', 'serviceCharges', 'economicEnterprise', 'otherReceipts'],
  },
  {
    key: 'totalLocalSources',
    label: 'Total Local Sources',
    kind: 'SUBTOTAL',
    indent: 0,
    sum: ['totalTaxRevenue', 'totalNonTaxRevenue'],
  },

  { key: 'externalSources', label: 'B. External Sources', kind: 'HEADING', indent: 0 },
  { key: 'ira', label: '1. Internal Revenue Allotment', kind: 'ITEM', indent: 1 },
  { key: 'goccShare', label: '2. Share from GOCCs (PAGCOR and PCSO)', kind: 'ITEM', indent: 1 },
  {
    key: 'otherNationalShares',
    label: '3. Other Shares from National Tax Collection',
    kind: 'HEADING',
    indent: 1,
  },
  { key: 'ecozone', label: 'Share from Ecozone', kind: 'ITEM', indent: 2 },
  { key: 'evat', label: 'Share from EVAT', kind: 'ITEM', indent: 2 },
  { key: 'nationalWealth', label: 'Share from National Wealth', kind: 'ITEM', indent: 2 },
  { key: 'tobaccoExcise', label: 'Share from Tobacco Excise Tax', kind: 'ITEM', indent: 2 },
  { key: 'ngTransfer', label: '4. National Government Transfer', kind: 'ITEM', indent: 1 },
  { key: 'interLocalTransfer', label: '5. Inter-Local Transfer', kind: 'ITEM', indent: 1 },
  {
    key: 'extraordinary',
    label: '6. Extraordinary Receipts / Grants / Donation / Aids',
    kind: 'ITEM',
    indent: 1,
  },
  {
    key: 'totalExternalSources',
    label: 'Total External Sources',
    kind: 'SUBTOTAL',
    indent: 0,
    sum: [
      'ira',
      'goccShare',
      'ecozone',
      'evat',
      'nationalWealth',
      'tobaccoExcise',
      'ngTransfer',
      'interLocalTransfer',
      'extraordinary',
    ],
  },

  { key: 'nonIncomeReceipts', label: 'C. Non-Income Receipts', kind: 'HEADING', indent: 0 },
  { key: 'capitalInvestment', label: '1. Capital Investment Receipts', kind: 'HEADING', indent: 1 },
  { key: 'saleOfAssets', label: 'Proceeds from Sale of Assets', kind: 'ITEM', indent: 2 },
  {
    key: 'saleOfDebtSecurities',
    label: 'Proceeds from Sale of Debt Securities of Other Entities',
    kind: 'ITEM',
    indent: 2,
  },
  { key: 'loanCollections', label: 'Collection of Loans Receivables', kind: 'ITEM', indent: 2 },
  {
    key: 'totalCapitalInvestment',
    label: 'Total Capital Investment Receipts',
    kind: 'SUBTOTAL',
    indent: 1,
    sum: ['saleOfAssets', 'saleOfDebtSecurities', 'loanCollections'],
  },
  {
    key: 'loansAndBorrowings',
    label: '2. Receipts from Loans and Borrowings',
    kind: 'HEADING',
    indent: 1,
  },
  { key: 'acquisitionOfLoans', label: 'Acquisition of Loans', kind: 'ITEM', indent: 2 },
  { key: 'issuanceOfBonds', label: 'Issuance of Bonds', kind: 'ITEM', indent: 2 },
  {
    key: 'totalLoansAndBorrowings',
    label: 'Total Receipts from Loans and Borrowings',
    kind: 'SUBTOTAL',
    indent: 1,
    sum: ['acquisitionOfLoans', 'issuanceOfBonds'],
  },
  {
    key: 'totalNonIncomeReceipts',
    label: 'Total Non-Income Receipts',
    kind: 'SUBTOTAL',
    indent: 0,
    sum: ['totalCapitalInvestment', 'totalLoansAndBorrowings'],
  },

  {
    key: 'totalReceipts',
    label: 'Total Receipts',
    kind: 'TOTAL',
    indent: 0,
    sum: ['totalLocalSources', 'totalExternalSources', 'totalNonIncomeReceipts'],
  },
];

/** The receipt lines an account code may be mapped to. */
export const SRE_MAPPABLE_LINES = SRE_RECEIPT_LINES.filter((l) => l.kind === 'ITEM');

/** Account codes per receipt line. Empty until the office fills it in. */
export type SreMapping = Record<string, string[]>;

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface SreEntry {
  fundCode: string;
  accountCode: string;
  accountName?: string;
  /** The budget line, present only on expenditure. */
  fppCode?: string;
  /** The office charged. With the FPP and the account, the budget line. */
  officeId?: string | null;
  /** The journal entry it came from, to name it in the reconciliation. */
  jevNo?: string;
  debit: Centavos;
  credit: Centavos;
}

/**
 * Receipts by line.
 *
 * A revenue account is credited, so the figure is credits less debits and a
 * refund of a collection reduces the line rather than adding to it.
 *
 * An account mapped to two lines is counted on both, and that is a mapping
 * mistake rather than something to silently resolve here - `mappingConflicts`
 * below finds them so the screen can say so.
 */
export function receiptsByLine(entries: SreEntry[], mapping: SreMapping): Map<string, Centavos> {
  const lineOf = new Map<string, string[]>();
  for (const [lineKey, codes] of Object.entries(mapping)) {
    for (const code of codes) {
      const list = lineOf.get(code) ?? [];
      list.push(lineKey);
      lineOf.set(code, list);
    }
  }

  const out = new Map<string, Centavos>();
  for (const e of entries) {
    const keys = lineOf.get(e.accountCode);
    if (!keys) continue;
    for (const key of keys) {
      out.set(key, (out.get(key) ?? 0) + e.credit - e.debit);
    }
  }
  return out;
}

/**
 * Estimated receipts, shaped so the same aggregation can place them.
 *
 * The estimate and the actual must land on the same line of the statement or
 * the budget column is not a comparison. Rather than a second function with a
 * second copy of the mapping logic - which would work until the day somebody
 * fixed one of them - an estimate is presented as a credit and put through
 * `receiptsByLine` exactly as a collection is.
 *
 * It also means one mapping serves both. The office maps an account code to a
 * receipt line once, and that decision governs where its estimate and its
 * collections both appear.
 */
export function estimatesAsEntries(
  rows: Array<{ fundCode: string; accountCode: string; accountName?: string; annual: Centavos }>,
): SreEntry[] {
  return rows.map((r) => ({
    fundCode: r.fundCode,
    accountCode: r.accountCode,
    accountName: r.accountName,
    credit: r.annual,
    debit: 0,
  }));
}

/** Account codes the office has put on more than one line. */
export function mappingConflicts(mapping: SreMapping): Array<{ accountCode: string; lines: string[] }> {
  const seen = new Map<string, string[]>();
  for (const [lineKey, codes] of Object.entries(mapping)) {
    for (const code of codes) {
      seen.set(code, [...(seen.get(code) ?? []), lineKey]);
    }
  }
  return [...seen.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([accountCode, lines]) => ({ accountCode, lines }));
}

/**
 * Resolves the subtotals and totals once the items are summed.
 *
 * Every figure on the statement above an item line is computed from the items,
 * never stored. A subtotal typed in anywhere would be a second version of the
 * truth, and the one that disagreed would be the one submitted.
 */
export function resolveTotals(items: Map<string, Centavos>): Map<string, Centavos> {
  const out = new Map(items);
  // The lines are declared in dependency order: an item before its subtotal, a
  // subtotal before the total that includes it. One pass is enough.
  for (const line of SRE_RECEIPT_LINES) {
    if (!line.sum) continue;
    out.set(line.key, line.sum.reduce((s, k) => s + (out.get(k) ?? 0), 0));
  }
  return out;
}

/**
 * Revenue that no line claims.
 *
 * Shown rather than dropped. A statement that foots to its own totals while
 * omitting a revenue account is wrong in the way that is hardest to notice.
 */
export function unmappedReceipts(
  entries: SreEntry[],
  mapping: SreMapping,
  isRevenue: (accountCode: string) => boolean,
): Array<{ accountCode: string; accountName: string; amount: Centavos }> {
  const mapped = new Set(Object.values(mapping).flat());
  const byCode = new Map<string, { accountName: string; amount: Centavos }>();

  for (const e of entries) {
    if (mapped.has(e.accountCode) || !isRevenue(e.accountCode)) continue;
    const current = byCode.get(e.accountCode) ?? { accountName: e.accountName ?? '', amount: 0 };
    current.amount += e.credit - e.debit;
    if (!current.accountName && e.accountName) current.accountName = e.accountName;
    byCode.set(e.accountCode, current);
  }

  return [...byCode.entries()]
    .filter(([, v]) => v.amount !== 0)
    .map(([accountCode, v]) => ({ accountCode, ...v }))
    .sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// Expenditures
// ---------------------------------------------------------------------------

export interface SectorOfFpp {
  fppCode: string;
  sector?: string;
  serviceSector?: string;
  /*
   * Patch 131. The rest of the budget line's identity. An FPP code is not
   * unique: "01" is a programme in two offices, and every office's Office
   * Supplies line carries 50203010. Keyed on the FPP alone, two lines of
   * different sectors overwrote each other and whichever was read last decided
   * the bucket of both. Optional, so a caller that has only the FPP still
   * works - by the FPP, and only where every line with it agrees.
   */
  fundCode?: string;
  officeId?: string;
  accountCode?: string;
}

/**
 * The budget line an expenditure entry was charged to. Patch 131.
 *
 * In order: the same office, FPP and object code; the same office and FPP on
 * a line appropriated by programme (no object - the entry's object is the one
 * the obligation bought); the only line of that office with that FPP. An entry
 * matching none of these is not guessed onto a line.
 */
export function budgetLineMatcher<L extends SectorOfFpp>(
  lines: L[],
): (e: { fundCode: string; fppCode?: string; officeId?: string | null; accountCode: string }) => L | null {
  const norm = (v: string | null | undefined) => String(v ?? '').trim();
  const byOfficeFpp = new Map<string, L[]>();
  for (const l of lines) {
    const k = `${norm(l.fundCode).toUpperCase()}|${norm(l.officeId)}|${norm(l.fppCode)}`;
    const list = byOfficeFpp.get(k) ?? [];
    list.push(l);
    byOfficeFpp.set(k, list);
  }
  return (e) => {
    if (!norm(e.officeId)) return null;
    const fund = norm(e.fundCode).toUpperCase();
    const list =
      byOfficeFpp.get(`${fund}|${norm(e.officeId)}|${norm(e.fppCode)}`) ??
      // Lines given without a fund match any fund.
      byOfficeFpp.get(`|${norm(e.officeId)}|${norm(e.fppCode)}`) ??
      [];
    if (list.length === 0) return null;
    const exact = list.find((l) => norm(l.accountCode) === norm(e.accountCode));
    if (exact) return exact;
    const programme = list.filter((l) => !norm(l.accountCode));
    if (programme.length === 1) return programme[0];
    return list.length === 1 ? list[0] : null;
  };
}

/** The bucket an FPP takes when the line cannot be told: only if every line agrees. */
function bucketByFppOnly(sectors: SectorOfFpp[]): Map<string, SreBucket | null> {
  const out = new Map<string, SreBucket | null>();
  for (const s of sectors) {
    const b = bucketFor(s.sector, s.serviceSector);
    if (!out.has(s.fppCode)) out.set(s.fppCode, b);
    else if (out.get(s.fppCode) !== b) out.set(s.fppCode, null);
  }
  return out;
}

export interface ExpenditureTotals {
  /** General Fund, by the four buckets of Annex A. */
  generalFund: Record<SreBucket, Centavos>;
  /** General Fund expenditure CFMS cannot place in a bucket. */
  generalFundUnclassified: Centavos;
  specialEducationFund: Centavos;
  trustFund: Centavos;
  total: Centavos;
}

const EMPTY_BUCKETS = (): Record<SreBucket, Centavos> => ({
  GENERAL: 0,
  ECONOMIC: 0,
  SOCIAL: 0,
  DEBT: 0,
});

/**
 * Expenditures by fund, and within the General Fund by the four buckets.
 *
 * The bucket comes from the SECTOR of the budget line the expense was charged
 * to, which is why the FPP had to reach the ledger. An expense CFMS cannot
 * place - an FPP whose sector is a funding source with no service named, or
 * one with no budget line at all - is counted in `generalFundUnclassified`
 * rather than pushed into General Services. It still foots into the total, so
 * the statement never under-reports what was spent; it simply admits that one
 * line of it is not yet classified.
 */
/**
 * The Budget Year column of the expenditure section.
 *
 * Annex A asks for the budget beside the actual, and on the spending side CFMS
 * has it: the appropriation ordinance is loaded, and every line carries the
 * sector that decides its bucket.
 *
 * It deliberately reuses `bucketFor` and returns the same shape as
 * `expendituresByFund`, so the budget and the actual are bucketed by one
 * decision rather than two. A line counted as Economic Services in one column
 * and General Services in the other would leave both columns footing to their
 * own totals while comparing different things.
 */
export interface AppropriationLine {
  fundCode: string;
  fppCode: string;
  sector?: string;
  serviceSector?: string;
  appropriationRevised: Centavos;
}

export function appropriationsByFund(lines: AppropriationLine[]): ExpenditureTotals {
  const generalFund = EMPTY_BUCKETS();
  let generalFundUnclassified = 0;
  let specialEducationFund = 0;
  let trustFund = 0;

  for (const line of lines) {
    const amount = line.appropriationRevised;
    if (amount === 0) continue;

    const fund = line.fundCode.trim().toUpperCase();
    if (fund === 'SEF') {
      specialEducationFund += amount;
      continue;
    }
    if (fund === 'TF') {
      trustFund += amount;
      continue;
    }

    const bucket = bucketFor(line.sector, line.serviceSector);
    if (bucket) generalFund[bucket] += amount;
    else generalFundUnclassified += amount;
  }

  const total =
    generalFund.GENERAL +
    generalFund.ECONOMIC +
    generalFund.SOCIAL +
    generalFund.DEBT +
    generalFundUnclassified +
    specialEducationFund +
    trustFund;

  return { generalFund, generalFundUnclassified, specialEducationFund, trustFund, total };
}

export function expendituresByFund(
  entries: SreEntry[],
  sectors: SectorOfFpp[],
): ExpenditureTotals {
  const lineOf = budgetLineMatcher(sectors);
  const byFpp = bucketByFppOnly(sectors);
  const generalFund = EMPTY_BUCKETS();
  let generalFundUnclassified = 0;
  let specialEducationFund = 0;
  let trustFund = 0;

  for (const e of entries) {
    // Only budget expenditure. The FPP is the marker: the posting rule refuses
    // an expense debit without one, and nothing else is given one.
    if (!e.fppCode) continue;
    const amount = e.debit - e.credit;
    if (amount === 0) continue;

    const fund = e.fundCode.trim().toUpperCase();
    if (fund === 'SEF') {
      specialEducationFund += amount;
      continue;
    }
    if (fund === 'TF') {
      trustFund += amount;
      continue;
    }

    const line = lineOf(e);
    const bucket = line
      ? bucketFor(line.sector, line.serviceSector)
      : (byFpp.get(e.fppCode) ?? null);
    if (bucket) generalFund[bucket] += amount;
    else generalFundUnclassified += amount;
  }

  const total =
    generalFund.GENERAL +
    generalFund.ECONOMIC +
    generalFund.SOCIAL +
    generalFund.DEBT +
    generalFundUnclassified +
    specialEducationFund +
    trustFund;

  return {
    generalFund,
    generalFundUnclassified,
    specialEducationFund,
    trustFund,
    total,
  };
}

// ---------------------------------------------------------------------------
// PATCH 131 - THE LEDGER AGAINST THE REGISTRY
// ---------------------------------------------------------------------------

export interface RegistryLine extends SectorOfFpp {
  fundCode: string;
  officeId: string;
  officeName: string;
  accountCode: string;
  label: string;
  /** Obligations incurred on the line, as the registry shows them. */
  obligated: Centavos;
}

export interface ReconcileRow {
  label: string;
  officeName: string;
  fundCode: string;
  obligated: Centavos;
  ledger: Centavos;
  /** Obligated less charged in the ledger. */
  difference: Centavos;
  jevNos: string[];
}

/**
 * Each budget line: what the registry says was obligated, what the General
 * Ledger has charged to it, and the journal entries behind the charge. Only
 * the lines that differ, plus one row per FPP the ledger charged that matches
 * no line. Patch 131.
 *
 * A difference is not always an error - an obligation not yet vouchered has
 * no expense in the books - but it is always the first thing to look at when
 * the SRE and the registry disagree.
 */
export function reconcileLedgerWithRegistry(
  lines: RegistryLine[],
  entries: SreEntry[],
): ReconcileRow[] {
  const lineOf = budgetLineMatcher(lines);
  const ledger = new Map<RegistryLine, { amount: Centavos; jevs: Set<string> }>();
  const stray = new Map<string, { amount: Centavos; jevs: Set<string>; fundCode: string }>();
  for (const e of entries) {
    if (!e.fppCode) continue;
    const amount = e.debit - e.credit;
    if (amount === 0) continue;
    const line = lineOf(e);
    if (line) {
      const cur = ledger.get(line) ?? { amount: 0, jevs: new Set<string>() };
      cur.amount += amount;
      if (e.jevNo) cur.jevs.add(e.jevNo);
      ledger.set(line, cur);
    } else {
      const k = `${e.fundCode}|${e.officeId ?? ''}|${e.fppCode}`;
      const cur = stray.get(k) ?? { amount: 0, jevs: new Set<string>(), fundCode: e.fundCode };
      cur.amount += amount;
      if (e.jevNo) cur.jevs.add(e.jevNo);
      stray.set(k, cur);
    }
  }
  const rows: ReconcileRow[] = [];
  for (const l of lines) {
    const g = ledger.get(l);
    const charged = g?.amount ?? 0;
    if (charged === l.obligated) continue;
    rows.push({
      label: l.label,
      officeName: l.officeName,
      fundCode: l.fundCode,
      obligated: l.obligated,
      ledger: charged,
      difference: l.obligated - charged,
      jevNos: [...(g?.jevs ?? [])].sort(),
    });
  }
  for (const [k, v] of stray) {
    if (v.amount === 0) continue;
    const [, office, fpp] = k.split('|');
    rows.push({
      label: `FPP ${fpp} - charged in the ledger, matching no budget line${office ? '' : ' (no office on the entry)'}`,
      officeName: '',
      fundCode: v.fundCode,
      obligated: 0,
      ledger: v.amount,
      difference: -v.amount,
      jevNos: [...v.jevs].sort(),
    });
  }
  return rows;
}
