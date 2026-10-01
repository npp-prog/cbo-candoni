/**
 * Estimated receipts - the financing side of the budget year.
 *
 * ------------------------------------------------------------------------
 * THIS FILE IS VENDORED INTO THE CLOUD FUNCTIONS BUILD.
 * The copy at `functions/src/lib/estimatedReceipts.ts` must be byte-identical
 * below the header. `scripts/sync-rules.mjs` copies it and CI compares them.
 * ------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * An appropriation ordinance authorises EXPENDITURE. It does not enact the
 * receipts that will pay for it - those are estimates, certified by the Local
 * Finance Committee as "reasonably projected as collectible for the Budget
 * Year" on LBP Form No. 1, and nothing in the ordinance CFMS loads carries
 * them.
 *
 * So CFMS could compare budget with actual on the spending side and had
 * nothing at all on the receiving side. The SRE has a column for estimated
 * receipts and the Statement of Comparison of Budget and Actual Amounts has a
 * whole receipts section, and both were empty - not because the figures were
 * missing from the municipality, but because there was nowhere in CFMS to put
 * them.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS KEYED ON THE ACCOUNT CODE
 * ---------------------------------------------------------------------------
 * The actual side is per account code, because that is what the General
 * Ledger records. A budget-against-actual comparison needs both sides on the
 * same key or it is not a comparison, it is two lists side by side.
 *
 * It also means the SRE mapping the office has already made - which account
 * code sits on which line of Annex A - places the estimate on exactly the line
 * it places the actual. One mapping, used twice, so the two can never land on
 * different lines of the same statement.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUARTERS
 * ---------------------------------------------------------------------------
 * LBAc Form No. 1 asks for the estimate quarter by quarter. LBP Form No. 1 and
 * the SRE want the year. Holding four figures and adding them gives both; the
 * reverse does not, and holding the two separately is how a municipality ends
 * up with an annual estimate that does not equal its own quarterly one.
 */

export type Centavos = number;

export interface Violation {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
}

const OK: CheckResult = { ok: true, violations: [] };

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * LBP Form No. 1's own three-way split of the receipts section.
 *
 * It is not decoration. "Regular Income" is the base of two statutory tests -
 * the LDRRMF is "not less than 5% of the estimated revenue from regular
 * sources" and the Personal Services cap is a percentage of regular income -
 * so an estimate filed under the wrong one moves a legal threshold.
 */
export type IncomeClass = 'REGULAR' | 'NON_REGULAR' | 'NON_INCOME';

export const INCOME_CLASSES: IncomeClass[] = ['REGULAR', 'NON_REGULAR', 'NON_INCOME'];

export const INCOME_CLASS_LABELS: Record<IncomeClass, string> = {
  REGULAR: 'Regular Income',
  NON_REGULAR: 'Non-Regular Income',
  NON_INCOME: 'Non-Income Receipts',
};

export const INCOME_CLASS_HINTS: Record<IncomeClass, string> = {
  REGULAR:
    'Local sources and the recurring external shares: taxes, regulatory fees, service charges, economic enterprises, the National Tax Allotment, the GOCC and national-wealth shares.',
  NON_REGULAR:
    'Receipts that are real income but do not recur: inter-local transfers, grants, donations and aids.',
  NON_INCOME:
    'Receipts that are not income at all: loan proceeds, bond issues, collections of loans receivable and proceeds from the sale of assets. They finance the budget without being revenue.',
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface ReceiptKey {
  fiscalYear: number;
  fundCode: string;
  accountCode: string;
}

/**
 * The document id of one estimated-receipt line.
 *
 * Deliberately NOT a budget key - there is no office, no FPP and no expense
 * class here, because an estimate of what will be collected is not charged to
 * anybody's appropriation. One line per account per fund per year, which is
 * also what makes a second upload of the same file replace the first rather
 * than double it.
 */
export function receiptKeyId(k: ReceiptKey): string {
  return `${k.fiscalYear}__${k.fundCode}__${k.accountCode}`;
}

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

export interface QuarterlyEstimate {
  q1: Centavos;
  q2: Centavos;
  q3: Centavos;
  q4: Centavos;
}

export const EMPTY_QUARTERS: QuarterlyEstimate = { q1: 0, q2: 0, q3: 0, q4: 0 };

/** The budget-year figure: LBP Form No. 1 column 7, and the SRE's estimate. */
export function annualOf(e: Partial<QuarterlyEstimate> | undefined): Centavos {
  if (!e) return 0;
  return (e.q1 ?? 0) + (e.q2 ?? 0) + (e.q3 ?? 0) + (e.q4 ?? 0);
}

/** January to the end of a quarter - LBAc Form No. 1 column 5. */
export function estimateThroughQuarter(
  e: Partial<QuarterlyEstimate> | undefined,
  quarter: 1 | 2 | 3 | 4,
): Centavos {
  if (!e) return 0;
  const parts = [e.q1 ?? 0, e.q2 ?? 0, e.q3 ?? 0, e.q4 ?? 0];
  let total = 0;
  for (let i = 0; i < quarter; i++) total += parts[i];
  return total;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface ReceiptLineInput extends QuarterlyEstimate {
  /** 1-based, for the message that names the offending row of an upload. */
  lineNo: number;
  accountCode: string;
  incomeClass: string;
}

/**
 * One line of an estimate.
 *
 * A negative estimate is refused rather than netted. An LGU does not estimate
 * that it will collect minus four hundred thousand pesos of business tax; a
 * minus sign in that column is a mis-keyed refund or a spreadsheet formula
 * that reached the wrong cell, and letting it through would quietly reduce the
 * base of the LDRRMF and PS tests.
 */
export function checkReceiptLine(line: ReceiptLineInput): CheckResult {
  const violations: Violation[] = [];

  if (!line.accountCode) {
    violations.push({
      code: 'RECEIPT_NO_ACCOUNT',
      message: `Line ${line.lineNo} names no account code.`,
    });
  }

  if (!INCOME_CLASSES.includes(line.incomeClass as IncomeClass)) {
    violations.push({
      code: 'RECEIPT_BAD_CLASS',
      message:
        `Line ${line.lineNo} is classed "${line.incomeClass}". It must be one of ` +
        `${INCOME_CLASSES.join(', ')} - LBP Form No. 1 splits the receipts section three ways, ` +
        'and two statutory limits are measured against the regular part.',
    });
  }

  const quarters: Array<[string, Centavos]> = [
    ['1st', line.q1],
    ['2nd', line.q2],
    ['3rd', line.q3],
    ['4th', line.q4],
  ];

  for (const [label, amount] of quarters) {
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
      violations.push({
        code: 'RECEIPT_UNREADABLE',
        message: `Line ${line.lineNo} has an unreadable amount in the ${label} quarter.`,
      });
    } else if (amount < 0) {
      violations.push({
        code: 'RECEIPT_NEGATIVE',
        message:
          `Line ${line.lineNo} estimates a negative amount in the ${label} quarter. An estimate ` +
          'of what will be collected cannot be below nothing.',
      });
    }
  }

  return violations.length === 0 ? OK : { ok: false, violations };
}

/**
 * A whole upload.
 *
 * The duplicate check is the one that matters. Two rows for the same account
 * in one file is an ordinary spreadsheet accident - a subtotal row left in, an
 * account listed once for each of two offices - and because each line is
 * written to a document keyed on the account, the second would silently
 * REPLACE the first rather than add to it. The file would post, report no
 * error, and the municipality's estimate for that account would be whichever
 * row happened to be last.
 */
export function checkReceiptSet(lines: ReceiptLineInput[]): CheckResult {
  const violations: Violation[] = [];

  if (lines.length === 0) {
    return {
      ok: false,
      violations: [{ code: 'RECEIPT_EMPTY', message: 'The file carries no rows.' }],
    };
  }

  for (const line of lines) {
    const result = checkReceiptLine(line);
    if (!result.ok) violations.push(...result.violations);
  }

  const seen = new Map<string, number>();
  for (const line of lines) {
    if (!line.accountCode) continue;
    const first = seen.get(line.accountCode);
    if (first !== undefined) {
      violations.push({
        code: 'RECEIPT_DUPLICATE',
        message:
          `Account ${line.accountCode} appears on line ${first} and again on line ${line.lineNo}. ` +
          'One line per account: the second would replace the first rather than add to it, and ' +
          'the file would post with the wrong estimate and no error.',
        details: { accountCode: line.accountCode, first, second: line.lineNo },
      });
    } else {
      seen.set(line.accountCode, line.lineNo);
    }
  }

  const total = lines.reduce((s, l) => s + annualOf(l), 0);
  if (total === 0) {
    violations.push({
      code: 'RECEIPT_ALL_ZERO',
      message:
        'Every line of this file estimates nothing. Recording an estimate of zero for the whole ' +
        'year would leave the SRE and the Statement of Comparison reporting a budget of nothing ' +
        'against real collections.',
    });
  }

  return violations.length === 0 ? OK : { ok: false, violations };
}
