import type { Centavos } from '@/types/common';

/**
 * The limits an appropriation ordinance is reviewed against.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 3 of Part II — the
 * budget review checklist. These are the tests the reviewing authority applies
 * to an ordinance after it is enacted, and every one of them is a test CBO can
 * apply while it is still being drafted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH CHECKING BEFORE THE ORDINANCE IS ENACTED
 * ---------------------------------------------------------------------------
 * The consequences in the manual are not warnings. Breaching the Personal
 * Services cap means the ordinance is declared inoperative IN PART, and the
 * excess is disallowed. Failing to appropriate the LDRRMF at all, or
 * appropriating too little, means it is declared inoperative IN ITS ENTIRETY -
 * the whole budget of the municipality, for a shortfall on one line.
 *
 * By the time a reviewer finds it, the Sanggunian has enacted it and the
 * offices have begun spending against it. Found here, it is an amendment
 * before enactment.
 *
 * ---------------------------------------------------------------------------
 * WHAT CBO CANNOT CHECK, AND SAYS SO
 * ---------------------------------------------------------------------------
 * Every limit needs a denominator CBO does not hold - income realised last
 * year, income estimated this year, the National Tax Allotment. Those are
 * figures the Treasurer states, and they are entered once a year rather than
 * derived, because deriving them from CBO's own ledger would test the budget
 * against the municipality's own books instead of against the figures the
 * reviewing authority will use.
 * ---------------------------------------------------------------------------
 */

/**
 * The income class decides the Personal Services cap.
 *
 * Forty-five per cent for first to third class provinces, cities and
 * municipalities; fifty-five for fourth class or lower (Section 325 [a] of the
 * Local Government Code).
 */
export type IncomeClass = '1' | '2' | '3' | '4' | '5' | '6';

export const INCOME_CLASS_LABELS: Record<IncomeClass, string> = {
  '1': 'First class',
  '2': 'Second class',
  '3': 'Third class',
  '4': 'Fourth class',
  '5': 'Fifth class',
  '6': 'Sixth class',
};

export function psCapRate(incomeClass: IncomeClass): number {
  return ['1', '2', '3'].includes(incomeClass) ? 0.45 : 0.55;
}

/** The figures the Treasurer states once a year. */
export interface StatutoryInputs {
  incomeClass: IncomeClass;
  /**
   * Total annual income from REGULAR SOURCES realised in the next preceding
   * fiscal year. The denominator of the Personal Services cap.
   */
  regularIncomePrecedingYear: Centavos;
  /**
   * Estimated revenue from regular sources for the budget year. The
   * denominator of the LDRRMF minimum.
   */
  estimatedRegularIncome: Centavos;
  /**
   * The National Tax Allotment for the budget year. The denominator of the 20%
   * Development Fund.
   */
  nationalTaxAllotment: Centavos;
}

/** What the ordinance actually appropriates, totalled from the budget lines. */
export interface AppropriationTotals {
  personalServices: Centavos;
  ldrrmf: Centavos;
  /** The part of the LDRRMF the office has nominated as Quick Response Fund. */
  quickResponseFund: Centavos;
  developmentFund: Centavos;
}

export type LimitVerdict = 'OK' | 'BREACH' | 'CONDITION' | 'UNKNOWN';

export interface LimitResult {
  key: string;
  label: string;
  /** What the manual does about a breach, in its own terms. */
  consequence: string;
  verdict: LimitVerdict;
  /** The threshold, where one could be computed. */
  threshold: Centavos | null;
  actual: Centavos;
  /** Positive when the ordinance is on the wrong side of the threshold. */
  shortfall: Centavos | null;
  note: string;
}

const peso = (c: Centavos) => (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });

/**
 * The Personal Services cap.
 *
 * A MAXIMUM, unlike the other two. The appropriation must not exceed it.
 */
export function checkPsCap(
  inputs: StatutoryInputs,
  totals: AppropriationTotals,
): LimitResult {
  const rate = psCapRate(inputs.incomeClass);
  const base = inputs.regularIncomePrecedingYear;
  const common = {
    key: 'ps',
    label: `Personal Services, at most ${(rate * 100).toFixed(0)}%`,
    consequence:
      'The amount in excess is disallowed and the ordinance is declared inoperative in part.',
    actual: totals.personalServices,
  };

  if (base <= 0) {
    return {
      ...common,
      verdict: 'UNKNOWN',
      threshold: null,
      shortfall: null,
      note: 'Enter the regular income realised in the preceding fiscal year to check this.',
    };
  }

  const threshold = Math.round(base * rate);
  const excess = totals.personalServices - threshold;
  return {
    ...common,
    verdict: excess > 0 ? 'BREACH' : 'OK',
    threshold,
    shortfall: excess > 0 ? excess : null,
    note:
      excess > 0
        ? `Over the cap by ${peso(excess)}.`
        : `Within the cap, with ${peso(-excess)} to spare.`,
  };
}

/**
 * The Local Disaster Risk Reduction and Management Fund.
 *
 * A MINIMUM, and the one whose breach voids the whole ordinance. Section 21 of
 * RA 10121 and Rule 18, Section 1 of its IRR: not less than five per cent of
 * the estimated revenue from regular sources.
 */
export function checkLdrrmf(
  inputs: StatutoryInputs,
  totals: AppropriationTotals,
): LimitResult {
  const base = inputs.estimatedRegularIncome;
  const common = {
    key: 'ldrrmf',
    label: 'LDRRMF, at least 5%',
    consequence:
      'Non-provision or insufficient provision makes the ordinance inoperative IN ITS ENTIRETY.',
    actual: totals.ldrrmf,
  };

  if (base <= 0) {
    return {
      ...common,
      verdict: 'UNKNOWN',
      threshold: null,
      shortfall: null,
      note: 'Enter the estimated regular income for the budget year to check this.',
    };
  }

  const threshold = Math.round(base * 0.05);
  const deficiency = threshold - totals.ldrrmf;
  return {
    ...common,
    verdict: deficiency > 0 ? 'BREACH' : 'OK',
    threshold,
    shortfall: deficiency > 0 ? deficiency : null,
    note:
      deficiency > 0
        ? `Short of the minimum by ${peso(deficiency)}.`
        : `Meets the minimum, with ${peso(-deficiency)} above it.`,
  };
}

/**
 * The Quick Response Fund within the LDRRMF.
 *
 * Thirty per cent of the LDRRMF appropriation, as a stand-by fund for relief
 * and recovery. The manual treats a departure from 30% as a CONDITION on the
 * review rather than a breach that voids anything - the reviewer cites it, the
 * ordinance stands - so it is reported as a condition here too.
 *
 * Which lines are the QRF is not something CBO can work out. It is nominated
 * by the office on the screen, because a rule that guessed from a project name
 * would be wrong on the first ordinance that spelled it differently.
 */
export function checkQrf(totals: AppropriationTotals): LimitResult {
  const common = {
    key: 'qrf',
    label: 'Quick Response Fund, 30% of the LDRRMF',
    consequence: 'A departure from 30% is cited as a condition of the review.',
    actual: totals.quickResponseFund,
  };

  if (totals.ldrrmf <= 0) {
    return {
      ...common,
      verdict: 'UNKNOWN',
      threshold: null,
      shortfall: null,
      note: 'There is no LDRRMF appropriation to take 30% of.',
    };
  }

  const threshold = Math.round(totals.ldrrmf * 0.3);
  const difference = totals.quickResponseFund - threshold;
  if (totals.quickResponseFund === 0) {
    return {
      ...common,
      verdict: 'UNKNOWN',
      threshold,
      shortfall: null,
      note: 'No LDRRMF line has been nominated as Quick Response Fund yet.',
    };
  }

  return {
    ...common,
    verdict: difference === 0 ? 'OK' : 'CONDITION',
    threshold,
    shortfall: difference !== 0 ? Math.abs(difference) : null,
    note:
      difference === 0
        ? 'Exactly 30%.'
        : `${difference > 0 ? 'More' : 'Less'} than 30% by ${peso(Math.abs(difference))}.`,
  };
}

/**
 * The 20% Development Fund.
 *
 * Section 287 of the Local Government Code: not less than twenty per cent of
 * the annual National Tax Allotment shall be appropriated for development
 * projects. A MINIMUM.
 */
export function checkDevelopmentFund(
  inputs: StatutoryInputs,
  totals: AppropriationTotals,
): LimitResult {
  const base = inputs.nationalTaxAllotment;
  const common = {
    key: 'devFund',
    label: 'Development Fund, at least 20% of the NTA',
    consequence: 'The ordinance is declared inoperative in its entirety for non-provision.',
    actual: totals.developmentFund,
  };

  if (base <= 0) {
    return {
      ...common,
      verdict: 'UNKNOWN',
      threshold: null,
      shortfall: null,
      note: 'Enter the National Tax Allotment for the budget year to check this.',
    };
  }

  const threshold = Math.round(base * 0.2);
  const deficiency = threshold - totals.developmentFund;
  return {
    ...common,
    verdict: deficiency > 0 ? 'BREACH' : 'OK',
    threshold,
    shortfall: deficiency > 0 ? deficiency : null,
    note:
      deficiency > 0
        ? `Short of the minimum by ${peso(deficiency)}.`
        : `Meets the minimum, with ${peso(-deficiency)} above it.`,
  };
}

/** All four, in the order the review checklist applies them. */
export function checkStatutoryLimits(
  inputs: StatutoryInputs,
  totals: AppropriationTotals,
): LimitResult[] {
  return [
    checkLdrrmf(inputs, totals),
    checkQrf(totals),
    checkDevelopmentFund(inputs, totals),
    checkPsCap(inputs, totals),
  ];
}
