/**
 * What the obligation form is called, which depends on the fund.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO NAMES FOR WHAT LOOKS LIKE ONE DOCUMENT
 * ---------------------------------------------------------------------------
 * In the General Fund and the Special Education Fund, a commitment is charged
 * against an appropriation the Sanggunian enacted, and the form is the
 * Obligation Request and Status.
 *
 * The Trust Fund has no appropriation of its own. The money belongs to
 * somebody else and is held for a stated purpose, so a commitment against it
 * is not an obligation of the municipality's budget at all - it is a
 * utilisation of funds entrusted to it, and the form is the Funding
 * Utilization Request and Status.
 *
 * The distinction is not clerical. An auditor who finds an OBR against a trust
 * account is looking at a municipality treating other people's money as its
 * own budget, and the form name is the first place that shows.
 *
 * CFMS records both on the same screen because the act of encoding them is
 * identical. What differs is what the screen calls it, and what the office is
 * asked to attach.
 * ---------------------------------------------------------------------------
 */

export interface ObligationFormName {
  /** OBR or FURS. */
  short: string;
  /** The full title, for the first mention on a screen and for a report heading. */
  long: string;
}

const OBR: ObligationFormName = { short: 'OBR', long: 'Obligation Request and Status' };
const FURS: ObligationFormName = {
  short: 'FURS',
  long: 'Funding Utilization Request and Status',
};

/**
 * Trust Fund gets the FURS; everything else gets the OBR.
 *
 * An unknown fund code falls to the OBR rather than throwing. A fund somebody
 * adds later is far more likely to be another appropriated fund than another
 * trust one, and a screen that refuses to render because it does not
 * recognise a fund code helps nobody.
 */
export function obligationForm(fundCode: string | undefined | null): ObligationFormName {
  return String(fundCode ?? '').trim().toUpperCase() === 'TF' ? FURS : OBR;
}

/** True when this fund's commitments are utilisations of trust money. */
export function isTrustFund(fundCode: string | undefined | null): boolean {
  return String(fundCode ?? '').trim().toUpperCase() === 'TF';
}
