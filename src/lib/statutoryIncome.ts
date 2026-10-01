import type { Centavos } from '@/types/common';

/**
 * What the income estimates say the statutory denominators should be.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SUGGESTION AND NOT A VALUE
 * ---------------------------------------------------------------------------
 * statutoryLimits.ts says the denominators are typed in and not derived, and
 * gives the reason: "CFMS could compute last year's income from its own ledger.
 * It deliberately does not. The reviewing authority will use the figure in the
 * LGU's own statements, and a test run against a different number than the
 * reviewer's is a test that passes here and fails there."
 *
 * That reasoning still holds and nothing here weakens it. What has changed is
 * WHERE the figure would come from. Since patch 36, CFMS holds the income
 * estimates of LBP Form No. 1 - which is not CFMS's ledger at all. It is the
 * document the reviewing authority reads, the same one the Treasurer states
 * the figure off. Offering it is not deriving the test from the municipality's
 * own books; it is saving the Budget Officer from copying a number between two
 * screens of the same system and mistyping it.
 *
 * So nothing here writes anything. These functions produce a figure and the
 * lines behind it, the screen shows it beside what was typed, and a person
 * decides. Where the two disagree, that disagreement is the finding: one of
 * the income estimates and the statutory denominator is wrong, and a
 * five-per-cent LDRRMF threshold moves with it.
 *
 * ---------------------------------------------------------------------------
 * THE NATIONAL TAX ALLOTMENT IS NOMINATED, BUT THE ACCOUNT EXISTS
 * ---------------------------------------------------------------------------
 * A correction. This note used to say Candoni's chart carried no National Tax
 * Allotment account and that 40301010 Subsidy from National Government was
 * "the nearest thing". Both were wrong, and following the second would have
 * put a wrong denominator under a statutory test. The chart has:
 *
 *   40106010 Share from Internal Revenue Collections (IRA)
 *   40106020 Share from Expanded Value Added Tax
 *   40106030 Share from National Wealth
 *   40106040 Share from Tobacco Excise Tax (RA 7171 and 8240)
 *   40106050 Share from Economic Zones
 *
 * The finding came from a search of the chart whose output was cut off at ten
 * lines by unrelated matches on the word "Allotment" in the equity accounts,
 * and the conclusion was drawn from the truncated result without checking.
 *
 * It stays NOMINATED rather than hard-coded to 40106010 all the same, and for
 * a reason of its own: which of those five counts towards the 20% Development
 * Fund base is a question about the fund, not about the chart. Section 287 of
 * the Local Government Code sets the fund against the national tax allotment,
 * and whether a municipality's share of national wealth or tobacco excise is
 * part of that base is the Budget Officer's reading, not CFMS's. So the office
 * says which codes count and CFMS adds up what it was told - and the screen now
 * points at 40106010 rather than at the subsidy account.
 */

export interface IncomeEstimateLine {
  accountCode: string;
  accountName: string;
  /** REGULAR, NON_REGULAR or NON_INCOME, as LBP Form No. 1 splits them. */
  incomeClass: string;
  /** The whole year's estimate for this account. */
  annual: Centavos;
}

export interface IncomeSuggestion {
  /** What the estimates on record add up to. */
  amount: Centavos;
  /** The lines behind it, so the figure can be checked rather than believed. */
  lines: IncomeEstimateLine[];
  /**
   * True when nothing on record supports a figure at all - no estimates
   * loaded, or none of the nominated accounts carries one. A zero suggestion
   * and no suggestion are different things, and a screen must not offer the
   * first as though it were a figure.
   */
  empty: boolean;
}

const suggestion = (lines: IncomeEstimateLine[]): IncomeSuggestion => {
  const kept = lines.filter((l) => l.annual !== 0);
  return {
    amount: kept.reduce((s, l) => s + l.annual, 0),
    lines: [...kept].sort((a, b) => a.accountCode.localeCompare(b.accountCode)),
    empty: kept.length === 0,
  };
};

/**
 * The denominator of the LDRRMF minimum: estimated revenue from REGULAR
 * sources for the budget year.
 *
 * Regular only. The three-way split of LBP Form No. 1 exists precisely because
 * two statutory limits rest on it, and counting a non-regular receipt here
 * would raise the five-per-cent threshold on income the municipality is not
 * entitled to count.
 */
export function regularIncomeSuggestion(lines: IncomeEstimateLine[]): IncomeSuggestion {
  return suggestion(lines.filter((l) => l.incomeClass === 'REGULAR'));
}

/**
 * The denominator of the 20% Development Fund: the National Tax Allotment.
 *
 * Only the accounts the office has nominated. An empty nomination gives an
 * empty suggestion and never a total of everything, which would be the one
 * mistake that matters here: the Development Fund is measured against the NTA
 * alone, and against total income it would appear to comply at about a fifth
 * of the real requirement.
 */
export function ntaSuggestion(
  lines: IncomeEstimateLine[],
  nominatedCodes: string[] | undefined,
): IncomeSuggestion {
  const codes = new Set((nominatedCodes ?? []).map((c) => String(c).trim()).filter(Boolean));
  if (codes.size === 0) return { amount: 0, lines: [], empty: true };
  return suggestion(lines.filter((l) => codes.has(l.accountCode)));
}

export interface IncomeComparison {
  stated: Centavos;
  suggested: Centavos;
  /** stated - suggested. Positive means more was typed than is on record. */
  difference: Centavos;
  /** True when there is nothing to compare against. */
  cannotCompare: boolean;
  agrees: boolean;
  /**
   * How far apart they are as a fraction of the suggestion, for deciding
   * whether to interrupt. Null when there is nothing to divide by.
   */
  relative: number | null;
}

/**
 * The typed figure against the figure the estimates support.
 *
 * Deliberately exact: "agrees" means the two are the same to the centavo.
 * A tolerance here would be CFMS deciding how wrong a statutory denominator is
 * allowed to be, which is not its decision to make. The screen may choose to
 * interrupt only on a large `relative` difference; the truth stays exact.
 */
export function compareToStated(
  stated: Centavos,
  s: IncomeSuggestion,
): IncomeComparison {
  if (s.empty) {
    return {
      stated,
      suggested: 0,
      difference: 0,
      cannotCompare: true,
      agrees: false,
      relative: null,
    };
  }
  const difference = stated - s.amount;
  return {
    stated,
    suggested: s.amount,
    difference,
    cannotCompare: false,
    agrees: difference === 0,
    relative: s.amount === 0 ? null : difference / s.amount,
  };
}

/**
 * Whether a difference is worth putting in front of somebody.
 *
 * One per cent. Below that it is a rounding or a late amendment to one line;
 * above it, the five-per-cent LDRRMF threshold has moved by enough to change a
 * verdict, and the ordinance is the thing at stake.
 */
export const MATERIAL_DIFFERENCE = 0.01;

export function isMaterial(c: IncomeComparison): boolean {
  if (c.cannotCompare || c.agrees) return false;
  if (c.relative === null) return c.difference !== 0;
  return Math.abs(c.relative) >= MATERIAL_DIFFERENCE;
}
