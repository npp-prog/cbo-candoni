/**
 * The lines of Annex 8, the Statement of Comparison of Budget and Actual
 * Amounts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS STATEMENT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * GAM Volume I, Section 370: "A separate additional financial statement for the
 * comparison of budget and actual amounts shall be prepared SINCE THE FINANCIAL
 * STATEMENTS AND BUDGET OF THE LGUs ARE NOT ON THE SAME ACCOUNTING BASIS."
 *
 * That sentence is the whole design brief. The other statements are accrual;
 * the budget is not; this one is the bridge, and the manual adds that it "shall
 * not be presented in comparison with the previous year figures" - so unlike
 * every other statement, no comparative column.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE COLUMNS, AND WHAT SECTIONS 371 TO 373 SAY EACH ONE IS
 * ---------------------------------------------------------------------------
 *   Original budget   Section 371: "the initial approved budget for the budget
 *                     period, for both the sources of funds and appropriations,
 *                     AND THE CARRY-ON CONTINUING APPROPRIATIONS in the
 *                     previous years."
 *   Final budget      Section 372: "the original budget adjusted for
 *                     supplemental budgets, realignments, reversions,
 *                     distribution of lump sum appropriations and other
 *                     authorized legislative actions during the budget year."
 *   Difference        Original less Final.
 *   Actual amounts    Section 373: "the amounts that result from execution of
 *                     the budget."
 *   Difference        Final budget less Actual.
 *
 * The first two map onto figures CBO already maintains: `appropriationOriginal`
 * plus `appropriationContinuing` for the original - the continuing part is in
 * the definition, not an addition here - and `appropriationRevised` for the
 * final, which is precisely "adjusted for supplemental budgets, realignments
 * and reversions".
 *
 * What "Actual amounts" means is NOT derivable, and is dealt with on the
 * screen rather than decided here. See ACTUAL_BASIS below.
 */

export interface ScbaaRevenueLine {
  /** Indent level: 0 for a heading such as "A. Local Sources". */
  level: number;
  label: string;
  /**
   * Account code prefixes feeding this line, longest match winning.
   * Empty on a heading, and empty on the lines the chart cannot answer.
   */
  prefixes: string[];
  /** A heading or total line carries no figures of its own. */
  heading?: boolean;
  /** Computed as the sum of the lines named here rather than from accounts. */
  totalOf?: string[];
  /** Printed even when nothing backs it, with the reason. */
  notInChart?: string;
}

/**
 * The revenue half, in the annex's own order and wording.
 *
 * Every prefix is a sub-major group of the Revised Chart of Accounts, so which
 * line an account falls on is read off its code exactly as it is on the
 * Statement of Financial Performance. Three lines carry no prefix, and each one
 * says why rather than being dropped:
 *
 * The capital and investment receipts and the borrowings are CASH RECEIPTS that
 * are not income. Selling a vehicle debits cash and credits the asset and a
 * gain; drawing a loan debits cash and credits a payable. Neither reaches an
 * income account, and the actual column of this statement is built from the
 * collections the Treasury reported - which are keyed by income account. They
 * are printed because the annex prints them, and they stay empty until CBO
 * records a non-income receipt in a way this statement can read.
 */
export const SCBAA_REVENUE: ScbaaRevenueLine[] = [
  { level: 0, label: 'A. Local Sources', prefixes: [], heading: true },
  { level: 1, label: '1. Tax Revenue', prefixes: [], heading: true },
  { level: 2, label: 'a. Tax Revenue - Property', prefixes: ['40102'] },
  { level: 2, label: 'b. Tax Revenue - Goods and Services', prefixes: ['40103'] },
  // Professional and community tax, other taxes, and the fines and penalties on
  // taxes: everything of 4-01 that is not property, not goods and services, and
  // not a share of a national tax.
  { level: 2, label: 'c. Other Local Taxes', prefixes: ['40101', '40104', '40105'] },
  {
    level: 1,
    label: 'Total Tax Revenue',
    prefixes: [],
    totalOf: [
      'a. Tax Revenue - Property',
      'b. Tax Revenue - Goods and Services',
      'c. Other Local Taxes',
    ],
  },
  { level: 1, label: '2. Non-Tax Revenue', prefixes: [], heading: true },
  { level: 2, label: 'a. Service Income', prefixes: ['40201'] },
  { level: 2, label: 'b. Business Income', prefixes: ['40202'] },
  { level: 2, label: 'c. Other Income and Receipts', prefixes: ['40601'] },
  {
    level: 1,
    label: 'Total Non-Tax Revenue',
    prefixes: [],
    totalOf: ['a. Service Income', 'b. Business Income', 'c. Other Income and Receipts'],
  },
  {
    level: 0,
    label: 'Total Local Sources',
    prefixes: [],
    totalOf: ['Total Tax Revenue', 'Total Non-Tax Revenue'],
  },

  { level: 0, label: 'B. External Sources', prefixes: [], heading: true },
  {
    level: 1,
    label: '1. Share from the National Internal Revenue Taxes (IRA)',
    prefixes: ['4010601'],
  },
  { level: 1, label: '2. Share from GOCCs', prefixes: ['40401'] },
  { level: 1, label: '3. Other Shares from National Tax Collections', prefixes: [], heading: true },
  { level: 2, label: 'a. Share from Ecozone', prefixes: ['4010605'] },
  { level: 2, label: 'b. Share from EVAT', prefixes: ['4010602'] },
  { level: 2, label: 'c. Share from National Wealth', prefixes: ['4010603'] },
  { level: 2, label: 'd. Share from Tobacco Excise Tax', prefixes: ['4010604'] },
  { level: 1, label: '4. Other Receipts', prefixes: [], heading: true },
  { level: 2, label: 'a. Grants and Donations', prefixes: ['40402'] },
  { level: 2, label: 'b. Other Subsidy Income', prefixes: ['40301'] },
  { level: 1, label: '5. Inter-Local Transfer', prefixes: ['40302'] },
  { level: 1, label: '6. Capital /Investment Receipts', prefixes: [], heading: true },
  {
    level: 2,
    label: 'a. Sale of Capital Assets',
    prefixes: [],
    notInChart: 'A disposal credits the asset and a gain, never an income account.',
  },
  {
    level: 2,
    label: 'b. Sale of Investments',
    prefixes: [],
    notInChart: 'A disposal credits the investment, never an income account.',
  },
  {
    level: 2,
    label: 'c. Proceeds from Collections of Loans Receivable',
    prefixes: [],
    notInChart: 'A collection credits the receivable, never an income account.',
  },
  {
    level: 0,
    label: 'C. Receipts from Borrowings',
    prefixes: [],
    notInChart: 'A drawdown credits a payable, never an income account.',
  },
];

/** The grand total line at the foot of the revenue half. */
export const SCBAA_REVENUE_TOTAL_OF = ['Total Local Sources', 'B. External Sources'];

/**
 * The expenditure half: the annex's eleven sector lines, in its order.
 *
 * This is the NATIONAL list and it is not Candoni's. The municipality's own
 * appropriation ordinance names its sectors differently - it has no Education
 * and no Labour line, and it has an "Allocation for Senior Citizens and PWD"
 * and a "Debt Services" that Annex 8 has no line for at all.
 *
 * Eight of the eleven match by name and are taken automatically. The rest are
 * nominated, the way the SRE revenue mapping and the Quick Response Fund lines
 * are: the office says which annex line a sector belongs on. Falling back to
 * "Others" on its own would quietly understate whichever service the ordinance
 * actually funds.
 */
export const SCBAA_SECTORS: string[] = [
  'General Public Services',
  'Education',
  'Health, Nutrition and Population Control',
  'Labor and Employment',
  'Housing and Community Development',
  'Social Services and Social Welfare',
  'Economic Services',
  'LDRRMF',
  '20% Development Fund',
  'Share from National Wealth',
  'Others',
];

/**
 * The expense classes each sector is broken into.
 *
 * Annex 8 prints three - Personnel Services, MOOE, Capital Outlay - and has no
 * line for Financial Expenses. Candoni's chart and its ordinance both use FE,
 * so it is carried as a fourth row: the alternative is an expenditure total
 * that does not foot to the appropriation, which is a worse fault on this
 * statement than a row the annex does not show.
 */
export const SCBAA_EXPENSE_CLASSES: Array<{ key: string; label: string; onAnnex: boolean }> = [
  { key: 'PS', label: 'Personnel Services', onAnnex: true },
  { key: 'MOOE', label: 'Maintenance and Other Operating Expenses', onAnnex: true },
  { key: 'CO', label: 'Capital Outlay', onAnnex: true },
  { key: 'FE', label: 'Financial Expenses', onAnnex: false },
];

/**
 * What the Actual column is measured on.
 *
 * NOT derivable, and the reason it is a setting rather than a default. Section
 * 373 says only "the amounts that result from execution of the budget", and the
 * two readings both have support:
 *
 *   OBLIGATIONS   Budget execution in an LGU is reported in obligations - the
 *                 SAOB, the RAAO and the registries all work that way - and an
 *                 obligation is the point at which the appropriation is used up.
 *
 *   DISBURSEMENTS The reconciliation the annex itself prints underneath
 *                 adjusts from this statement to the Statement of Financial
 *                 Performance through non-cash expenses and capital
 *                 expenditure, which reads as a cash basis.
 *
 * Whichever the municipality submits, the statement says which it used. A
 * figure this size printed without saying what it counts is the kind of thing
 * an auditor asks about once and does not forget.
 */
export type ActualBasis = 'OBLIGATIONS' | 'DISBURSEMENTS';

export const ACTUAL_BASIS_LABELS: Record<ActualBasis, string> = {
  OBLIGATIONS: 'Obligations incurred',
  DISBURSEMENTS: 'Disbursements paid',
};

export const ACTUAL_BASIS_NOTES: Record<ActualBasis, string> = {
  OBLIGATIONS:
    'Budget execution in an LGU is reported in obligations - the SAOB and the registries all work that way - and an obligation is the point at which the appropriation is used up.',
  DISBURSEMENTS:
    'The reconciliation printed under Annex 8 adjusts from this statement to the Statement of Financial Performance through non-cash expenses and capital expenditure, which reads as a cash basis.',
};

/** Longest matching prefix, as on the other statements. */
export function revenueLineFor(code: string): ScbaaRevenueLine | undefined {
  const c = String(code ?? '').trim();
  let best: ScbaaRevenueLine | undefined;
  let bestLength = -1;
  for (const line of SCBAA_REVENUE) {
    for (const prefix of line.prefixes) {
      if (c.startsWith(prefix) && prefix.length > bestLength) {
        best = line;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * The annex line a municipal sector name belongs on, where the two agree.
 *
 * Exact match only, ignoring case and spacing. A near match is not a match:
 * "Social Services" and "Social Services and Social Welfare" might be the same
 * thing or might not, and a statement is not the place to find out.
 */
export function autoMatchSector(sectorName: string): string | null {
  const norm = (v: string) => v.trim().toUpperCase().replace(/\s+/g, ' ');
  const target = norm(sectorName);
  return SCBAA_SECTORS.find((s) => norm(s) === target) ?? null;
}
