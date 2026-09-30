import type { Centavos } from '@/types/common';

/**
 * The Abstract of Real Property Tax Collections, GAM Appendix 45.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FORM IS FOR
 * ---------------------------------------------------------------------------
 * GAM Volume I, Section 68, says it plainly:
 *
 *   "The accountant shall also maintain the Abstract of Real Property Tax
 *    Collections TO FACILITATE THE DISTRIBUTION AND REMITTANCE OF THE SHARES
 *    OF THE DIFFERENT GOVERNMENT UNITS CONCERNED in the real property tax
 *    collections."
 *
 * So it is not a second collection report. The municipality collects real
 * property tax that is not all its own, and this is the working paper that
 * says how much belongs to whom - the entry to make, and the cheque to draw.
 *
 * ---------------------------------------------------------------------------
 * THE SHARING, AND WHY IT IS NOT SETTINGS
 * ---------------------------------------------------------------------------
 * Every other split in CBO that could not be derived was offered to the office
 * to nominate. This one is not, because it is not the municipality's to
 * choose. Both rates are in the GAM:
 *
 *   BASIC real property tax - Volume I, Section 69, the pro-forma entries:
 *      Municipality 40%, Province 35%, Barangay 25%.
 *
 *   SPECIAL EDUCATION FUND - Volume I, Section 109:
 *      "In case of provinces, the proceeds of the special education tax shall
 *       be DIVIDED EQUALLY between the provincial and municipal school
 *       boards" - so 50% and 50%, and no barangay share at all.
 *
 * Candoni is a municipality in a province, which is the case both rules are
 * written for. A city would share differently and CBO would be wrong for one;
 * the screen says which case it is applying.
 *
 * The discount follows the tax. Section 43: discounts "shall be apportioned to
 * the concerned LGUs in accordance with the sharing prescribed for real
 * property tax and special education tax" - so a discount given to a taxpayer
 * is borne by all three, not by the municipality alone, and each share is
 * computed on the gross and reduced by its own part of the discount.
 *
 * ---------------------------------------------------------------------------
 * WHAT CBO CANNOT DO HERE, STATED RATHER THAN GUESSED
 * ---------------------------------------------------------------------------
 * Two things, both of them limits of what is recorded rather than of the
 * arithmetic:
 *
 *   THE BARANGAY SHARE CANNOT BE BROKEN DOWN BY BARANGAY. Section 271 of the
 *   Local Government Code gives the 25% to the barangay where the property is
 *   located, and a collection in CBO records the payor and the receipt but not
 *   the property, so there is nothing to group by. The total is right; the
 *   split between barangays has to come from the Treasurer's own register.
 *
 *   THE PENALTIES CANNOT BE SPLIT BETWEEN BASIC AND SEF. Section 44 says fines
 *   and penalties are distributed on the same sharing as the tax they arose
 *   from - but the chart carries ONE account, 4-01-05-020 Tax Revenue - Fines
 *   and Penalties - Property Taxes, for both, and the two taxes share
 *   differently. So the penalties are reported as their own figure and left
 *   unallocated rather than pushed through one of the two rates.
 */

/** The accounts this abstract is drawn from. All are in Candoni's chart. */
export const RPT_ACCOUNTS = {
  basic: '40102040',
  basicDiscount: '40102041',
  sef: '40102050',
  sefDiscount: '40102051',
  penalties: '40105020',
  /** Where the province's and barangays' shares are recognised. */
  dueToLgus: '20201070',
} as const;

export interface ShareRate {
  label: string;
  /** Basis points out of 10,000, so 4,000 is 40%. No floating point. */
  rate: number;
  /** True for the municipality itself, which keeps rather than remits. */
  own?: boolean;
}

/** GAM Volume I, Section 69. */
export const BASIC_SHARES: ShareRate[] = [
  { label: 'Municipality', rate: 4_000, own: true },
  { label: 'Province', rate: 3_500 },
  { label: 'Barangays', rate: 2_500 },
];

/** GAM Volume I, Section 109 - divided equally, and no barangay share. */
export const SEF_SHARES: ShareRate[] = [
  { label: 'Municipal School Board', rate: 5_000, own: true },
  { label: 'Provincial School Board', rate: 5_000 },
];

export const BASIS = 10_000;

/**
 * Split an amount by the rates, exactly.
 *
 * Integer centavos and largest remainder: the parts always sum to the whole,
 * and the odd centavo goes to the largest share rather than to whichever line
 * happened to be first. A tax share that is out by a centavo is a remittance
 * that does not reconcile, so this cannot be allowed to drift.
 */
export function splitByShares(amount: Centavos, shares: ShareRate[]): Centavos[] {
  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount);

  const parts = shares.map((s, i) => ({
    i,
    exact: (magnitude * s.rate) / BASIS,
    value: Math.floor((magnitude * s.rate) / BASIS),
  }));

  let remainder = magnitude - parts.reduce((s, p) => s + p.value, 0);
  for (const p of [...parts].sort((a, b) => b.exact - a.exact || a.i - b.i)) {
    if (remainder <= 0) break;
    p.value += 1;
    remainder -= 1;
  }

  return parts.sort((a, b) => a.i - b.i).map((p) => p.value * sign);
}

export interface RptLedgerEntry {
  period: number;
  accountCode: string;
  /** Debit positive, credit negative, as the ledger stores it. */
  signedAmount: Centavos;
}

export interface RptTaxBlock {
  /** 'Basic Real Property Tax' or 'Special Education Fund'. */
  title: string;
  shares: ShareRate[];
  /** The tax earned, before the discount. Positive. */
  gross: Centavos;
  /** The discount allowed. Positive. */
  discount: Centavos;
  /** gross less discount: what is actually collectible. */
  net: Centavos;
  rows: Array<{
    label: string;
    rate: number;
    own: boolean;
    grossShare: Centavos;
    discountShare: Centavos;
    /** grossShare less discountShare: what this unit is entitled to. */
    netShare: Centavos;
  }>;
}

export interface RptAbstractMonth {
  period: number;
  basicGross: Centavos;
  basicDiscount: Centavos;
  sefGross: Centavos;
  sefDiscount: Centavos;
  penalties: Centavos;
}

export interface RptAbstract {
  months: RptAbstractMonth[];
  basic: RptTaxBlock;
  sef: RptTaxBlock;
  /** Section 44 shares these too, but one account carries both taxes. */
  penalties: Centavos;
  /** The province and barangay shares of both taxes: what has to be remitted. */
  totalToRemit: Centavos;
  /** What the municipality keeps, across both taxes. */
  totalOwn: Centavos;
  /** Movement on Due to LGUs in the period, as a credit. */
  dueToLgusMovement: Centavos;
  /**
   * dueToLgusMovement less totalToRemit. Zero where the sharing entry has been
   * drawn for everything this abstract covers.
   */
  dueToLgusDifference: Centavos;
}

/**
 * A revenue account is credit-normal, so a collection arrives as a negative
 * signed amount. Everything below presents positive.
 */
const credit = (entries: RptLedgerEntry[], code: string): Centavos => {
  const total = entries
    .filter((e) => e.accountCode === code)
    .reduce((s, e) => s + e.signedAmount, 0);
  // Negating a zero gives -0, which prints as "-0.00" and is not equal to 0
  // in a strict comparison. Nothing collected is nothing, not minus nothing.
  return total === 0 ? 0 : -total;
};

/** A discount is a debit against revenue, so it arrives positive already. */
const debit = (entries: RptLedgerEntry[], code: string): Centavos =>
  entries.filter((e) => e.accountCode === code).reduce((s, e) => s + e.signedAmount, 0);

function block(
  title: string,
  shares: ShareRate[],
  gross: Centavos,
  discount: Centavos,
): RptTaxBlock {
  const grossShares = splitByShares(gross, shares);
  const discountShares = splitByShares(discount, shares);

  return {
    title,
    shares,
    gross,
    discount,
    net: gross - discount,
    rows: shares.map((s, i) => ({
      label: s.label,
      rate: s.rate,
      own: s.own === true,
      grossShare: grossShares[i],
      discountShare: discountShares[i],
      netShare: grossShares[i] - discountShares[i],
    })),
  };
}

export function buildRptAbstract(input: {
  entries: RptLedgerEntry[];
  fromPeriod: number;
  throughPeriod: number;
}): RptAbstract {
  const inPeriod = input.entries.filter(
    (e) => e.period >= input.fromPeriod && e.period <= input.throughPeriod,
  );

  const months: RptAbstractMonth[] = [];
  for (let p = input.fromPeriod; p <= input.throughPeriod; p++) {
    const ofMonth = inPeriod.filter((e) => e.period === p);
    const month: RptAbstractMonth = {
      period: p,
      basicGross: credit(ofMonth, RPT_ACCOUNTS.basic),
      basicDiscount: debit(ofMonth, RPT_ACCOUNTS.basicDiscount),
      sefGross: credit(ofMonth, RPT_ACCOUNTS.sef),
      sefDiscount: debit(ofMonth, RPT_ACCOUNTS.sefDiscount),
      penalties: credit(ofMonth, RPT_ACCOUNTS.penalties),
    };
    const empty =
      month.basicGross === 0 &&
      month.basicDiscount === 0 &&
      month.sefGross === 0 &&
      month.sefDiscount === 0 &&
      month.penalties === 0;
    if (!empty) months.push(month);
  }

  const basic = block(
    'Basic Real Property Tax',
    BASIC_SHARES,
    credit(inPeriod, RPT_ACCOUNTS.basic),
    debit(inPeriod, RPT_ACCOUNTS.basicDiscount),
  );
  const sef = block(
    'Special Education Fund',
    SEF_SHARES,
    credit(inPeriod, RPT_ACCOUNTS.sef),
    debit(inPeriod, RPT_ACCOUNTS.sefDiscount),
  );

  const sumRows = (b: RptTaxBlock, own: boolean) =>
    b.rows.filter((r) => r.own === own).reduce((s, r) => s + r.netShare, 0);

  const totalToRemit = sumRows(basic, false) + sumRows(sef, false);
  const totalOwn = sumRows(basic, true) + sumRows(sef, true);
  const dueToLgusMovement = credit(inPeriod, RPT_ACCOUNTS.dueToLgus);

  return {
    months,
    basic,
    sef,
    penalties: credit(inPeriod, RPT_ACCOUNTS.penalties),
    totalToRemit,
    totalOwn,
    dueToLgusMovement,
    dueToLgusDifference: dueToLgusMovement - totalToRemit,
  };
}
