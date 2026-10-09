import { buildBankFile, bankFileCsv } from './bankFile';

/**
 * The file the bank's own application reads, built from a Report of ADA Issued.
 *
 * ---------------------------------------------------------------------------
 * THE BANK'S FORMAT (patch 142 - the same as the voucher's bank file)
 * ---------------------------------------------------------------------------
 * Since patch 140 the voucher of a group ("Payee, et al.") wrote its bank file
 * in the format the office gave, while this one - "Download for the bank" on
 * the RADAI - still wrote the older one: a heading row, the name as typed and
 * the amount in pesos with a decimal point. The bank takes the first, so both
 * now come from one builder, src/lib/bankFile.ts:
 *
 *   column 1  ATM / account number - 10 digits, leading zeros kept
 *   column 2  the name in capitals, letters, digits and spaces only - no dot,
 *             no comma, no special character
 *   column 3  the amount in centavos, no decimal point (10,000.10 = 1000010)
 *
 *   No heading row; row 1 is the first payee. CRLF, no byte-order mark.
 *
 * ---------------------------------------------------------------------------
 * WHY IT REFUSES RATHER THAN LEAVING A COLUMN BLANK
 * ---------------------------------------------------------------------------
 * A row with no account number is not a row the bank can act on. It either
 * rejects the file - after the upload - or, on a less careful application,
 * pays the row that follows into the account above it. So the file is not
 * produced until every row has a 10-digit account number, a name and an
 * amount, and the refusal names the payees.
 */

export interface BankPayrollRow {
  /** The payee's account at the bank. */
  accountNumber?: string | null;
  name: string;
  /** Centavos, as everything in CFMS is. */
  amount: number;
}

export interface BankFileResult {
  /** The file's text, or null when it could not be built. */
  content: string | null;
  /** Payees with no account number at all. */
  missing: string[];
  /** Every reason the file was not built, one per payee and problem. */
  problems: string[];
  rowCount: number;
  total: number;
}

export function buildBankPayrollFile(rows: BankPayrollRow[]): BankFileResult {
  const missing = rows
    .filter((r) => !String(r.accountNumber ?? '').trim())
    .map((r) => r.name);
  const total = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const built = buildBankFile(
    rows.map((r) => ({
      payeeName: r.name,
      accountNumber: String(r.accountNumber ?? ''),
      amount: r.amount,
    })),
  );
  return {
    content: built.problems.length ? null : bankFileCsv(built.rows),
    missing,
    problems: built.problems,
    rowCount: rows.length,
    total,
  };
}
