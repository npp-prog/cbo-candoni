import { isRptAccount, sharesWithBarangay } from '@/pages/reports/rptAbstractReport';
import { TRUST_FUND_CODE } from '@/lib/trustPrograms';

/**
 * The detail a receipt line must carry before it can be recorded.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THREE FIELDS AND NOT ANY OTHERS
 * ---------------------------------------------------------------------------
 * Each of them is a field some REPORT is built from, and which cannot be
 * recovered afterwards from anything else on the receipt.
 *
 * THE TAX YEAR decides whether a basic real property tax collection is current
 * or preceding. The Abstract of Real Property Tax Collections has a column for
 * each, and the share remitted to the province differs between them.
 *
 * THE BARANGAY decides who gets the barangay share of the basic tax. It
 * follows the PROPERTY, not the payor, so it cannot be worked out from the
 * payor's address - and a collection with no barangay on it is money the
 * municipality is holding for a barangay nobody can name.
 *
 * THE TRUST PROGRAMME decides which memorandum of agreement a Trust Fund
 * receipt belongs to. The Fund Utilization Report is built per programme, and
 * a receipt with none is money in the Trust Fund that no programme accounts
 * for - which is the one thing the source of that money will ask about.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS REFUSED AT THE RECEIPT AND NOT REPORTED LATER
 * ---------------------------------------------------------------------------
 * These were optional, with "Year not stated" and "Barangay not stated" in the
 * dropdowns, and that is exactly what a busy counter leaves them on. The cost
 * does not land on the clerk; it lands months later on whoever has to produce
 * the abstract, by which time the only person who knew which barangay the land
 * was in has forgotten, and the receipt is issued and cannot be amended.
 *
 * Caught at the counter it costs one question to the taxpayer standing there.
 */

export interface ReceiptLine {
  lineNo?: number;
  accountCode?: string | null;
  accountName?: string | null;
  amount?: number | null;
  rptTaxYear?: string | null;
  barangayId?: string | null;
  trustProgramId?: string | null;
}

export interface MissingDetail {
  lineNo: number;
  accountCode: string;
  accountName: string;
  /** What is missing, in the words the screen uses for the field. */
  missing: string;
}

/**
 * What a receipt line is missing, if anything.
 *
 * A line with no amount is skipped: an empty row on a half-filled form is not
 * a collection, and refusing it would stop the clerk before they had typed
 * anything.
 */
export function missingDetail(line: ReceiptLine, fundCode: string): string[] {
  const out: string[] = [];
  if (!line.amount) return out;

  const code = String(line.accountCode ?? '').trim();
  if (!code) return out;

  if (isRptAccount(code)) {
    if (!line.rptTaxYear) out.push('the tax year');
    if (sharesWithBarangay(code) && !line.barangayId) out.push('the barangay');
  }

  if (String(fundCode ?? '').trim().toUpperCase() === TRUST_FUND_CODE && !line.trustProgramId) {
    out.push('the trust programme');
  }

  return out;
}

/** Every line of a receipt that is missing something, in line order. */
export function receiptDetailProblems(
  lines: readonly ReceiptLine[],
  fundCode: string,
): MissingDetail[] {
  const problems: MissingDetail[] = [];
  lines.forEach((line, index) => {
    const missing = missingDetail(line, fundCode);
    if (missing.length === 0) return;
    problems.push({
      lineNo: line.lineNo ?? index + 1,
      accountCode: String(line.accountCode ?? ''),
      accountName: String(line.accountName ?? ''),
      missing: missing.join(' and '),
    });
  });
  return problems;
}

/** One sentence naming what has to be filled in before the receipt is saved. */
export function describeProblems(problems: readonly MissingDetail[]): string {
  if (problems.length === 0) return '';
  if (problems.length === 1) {
    const only = problems[0];
    return `Line ${only.lineNo}, ${only.accountName || only.accountCode}, needs ${only.missing}.`;
  }
  return problems
    .map((p) => `line ${p.lineNo} needs ${p.missing}`)
    .join('; ')
    .replace(/^./, (c) => c.toUpperCase())
    .concat('.');
}

/**
 * Whether a receipt ALREADY RECORDED is missing any of it.
 *
 * Used by the list, to find the receipts written before CFMS asked. They
 * cannot be corrected by re-issuing the receipt - the paper is with the
 * taxpayer - so the point is to show the office which ones will be wrong in
 * the abstract while somebody still remembers them.
 */
export function receiptIsIncomplete(
  receipt: { lines?: readonly ReceiptLine[]; fundCode?: string },
): boolean {
  return receiptDetailProblems(receipt.lines ?? [], receipt.fundCode ?? '').length > 0;
}
