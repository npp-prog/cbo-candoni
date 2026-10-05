/**
 * The file the bank's own application reads, built from a Report of ADA Issued.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THE ORDINARY CSV EXPORT
 * ---------------------------------------------------------------------------
 * Every other CSV CFMS writes is for a person: `exportCsv` puts the four-line
 * COA letterhead at the top, a "Generated" line under it, and a blank line
 * before the headers, so the file opens in Excel looking like the report it
 * came from.
 *
 * This one is not read by a person. It is uploaded to the bank, which parses
 * it, and every one of those courtesies is a line the parser does not expect.
 * The file is three columns and the rows, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY IT REFUSES RATHER THAN LEAVING A COLUMN BLANK
 * ---------------------------------------------------------------------------
 * A row with no account number is not a row the bank can act on. It either
 * rejects the file - at which point the office has to find out why, from the
 * bank, after the upload - or, on a bank application that is less careful than
 * it should be, it pays the row that follows into the account above it.
 *
 * CFMS cannot tell which of those a given bank does, so it does not produce the
 * file at all until every payee has an account number on their master record.
 * The refusal names the payees, because "something is missing" sends somebody
 * through forty rows by hand.
 */

export interface BankPayrollRow {
  /** The payee's account at the bank, from their master record. */
  accountNumber?: string | null;
  name: string;
  /** Centavos, as everything in CFMS is. */
  amount: number;
}

export interface BankFileResult {
  /** The file's text, or null when it could not be built. */
  content: string | null;
  /** Payees with no account number on file. Empty when the file was built. */
  missing: string[];
  rowCount: number;
  total: number;
}

/**
 * Pesos with two decimals, no symbol and no thousands separator.
 *
 * A grouped figure - 1,234.56 - is a number followed by a comma in a
 * comma-separated file, which is how an upload of forty payments becomes an
 * upload of eighty broken ones.
 */
function toPesoString(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/**
 * Quoted only where it has to be, and never able to start a formula.
 *
 * The leading-apostrophe guard is the same one `exportCsv` uses: a name
 * beginning =, +, - or @ is executed by Excel when the file is opened there,
 * and these files do get opened in Excel on the way to the bank.
 */
function csvCell(value: string): string {
  const v = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Builds the file, or says who is missing an account number.
 *
 * The header row is `ATM Number,Name,Amount`, which is the order the office
 * asked for. If the bank wants different headings or a different order, this is
 * the one place to change it - and that is the reason it is a function rather
 * than three lines inside a button.
 */
export function buildBankPayrollFile(rows: BankPayrollRow[]): BankFileResult {
  const missing = rows
    .filter((r) => !String(r.accountNumber ?? '').trim())
    .map((r) => r.name);

  const total = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  if (missing.length > 0) {
    return { content: null, missing, rowCount: rows.length, total };
  }

  const lines = [
    'ATM Number,Name,Amount',
    ...rows.map((r) =>
      [
        csvCell(String(r.accountNumber).trim()),
        csvCell(r.name),
        toPesoString(r.amount),
      ].join(','),
    ),
  ];

  /*
   * CRLF and no byte-order mark.
   *
   * The ordinary export writes a BOM so Excel renders the peso sign. There is
   * no peso sign here, and a BOM is three bytes a parser reads as part of the
   * first heading - which is how "ATM Number" becomes a column the bank's
   * application does not recognise.
   */
  return { content: lines.join('\r\n'), missing: [], rowCount: rows.length, total };
}
