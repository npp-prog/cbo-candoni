import { readSheet, findText, findCell, normaliseDate, type SheetRow } from '@/lib/spreadsheet';
import { parsePeso } from '@/lib/money';

/**
 * Reading the Treasurer's RCI and RADAI files.
 *
 * The columns as the office writes them:
 *
 *   CHECK (Date, Serial No.) | DV/PAYROLL NO. | OBR NO. |
 *   RESPONSIBILITY CENTER CODE | PAYEE | NATURE OF PAYMENT | AMOUNT
 *
 * Two things about that list are worth stating plainly.
 *
 * The DV number is what the whole upload turns on. It is the only column that
 * names something CBO already knows about, and everything else in the row -
 * the payee, the amount, the nature of payment - is checked against the voucher
 * it points to rather than believed. A row without one cannot be placed at all.
 *
 * The obligation number is headed "OBR NO." here, but the same column has been
 * headed "CAFOA NO." for years in the Treasurer's own system, and printed
 * reports going back through the files still say so. Both headings are accepted.
 * A reader that only knew the new name would quietly drop the column from every
 * older file and nobody would notice until an audit asked which obligation a
 * payment was charged to.
 */

export interface ParsedRow {
  lineNo: number;
  date: string;
  serialNo: string;
  dvNo: string;
  obrNo: string;
  payeeName: string;
  particulars: string;
  responsibilityCenter: string;
  amount: number;
  /**
   * Why this row cannot be sent at all. A row with no amount or no readable
   * date is not a payment CBO could hold for later - there is nothing in it to
   * hold. These have to be fixed in the file.
   */
  problem?: string;
  /**
   * Why this row will go up but be held rather than posted. Shown before the
   * upload so the office is not surprised by a report that covers less than it
   * expected - but it is not a reason to stop, and the server decides in the
   * end regardless of what is said here.
   */
  willHold?: string;
}

/**
 * Column patterns, most specific first.
 *
 * `findCell` returns the first heading that matches, so ordering is the whole
 * mechanism: "Check Date" has to be tried before a bare "Date", or a file
 * carrying both hands back whichever its author happened to put on the left.
 */
const COLUMNS = {
  date: [/check\s*date/i, /ada\s*date/i, /date\s*issued/i, /^date/i, /date/i],
  serial: [/serial/i, /check\s*(no|number)/i, /^check$/i],
  dvNo: [/dv\s*(no|number)/i, /dv\s*\//i, /voucher\s*(no|number)/i, /\bdv\b/i, /voucher/i],
  // "CAFOA NO." is the same column under the name the office used before.
  obrNo: [/obr/i, /obligation/i, /cafoa/i, /allotment\s*and\s*obligation/i],
  responsibilityCenter: [/responsibility/i, /\brc\s*code\b/i, /cost\s*cent/i],
  payee: [/payee/i, /supplier/i, /creditor/i, /paid\s*to/i, /^name/i],
  particulars: [/nature\s*of\s*payment/i, /particular/i, /purpose/i, /description/i, /nature/i],
  amount: [/^amount/i, /amount\s*paid/i, /net\s*amount/i, /amount/i, /^net$/i],
};

/**
 * Reads a file into rows, and says of each whether it can be sent.
 *
 * Nothing is rejected here beyond what makes a row unsendable - a row naming a
 * voucher CBO has never heard of still goes up, because only the server can
 * know that, and the answer to it is to hold the row rather than to refuse the
 * file. What this catches is the narrower case of a row the server could not
 * even read: no amount, no date, and for an RCI no check number.
 */
export async function parsePaymentFile(
  file: File,
  importType: 'RCI' | 'RADAI',
): Promise<ParsedRow[]> {
  const sheet = await readSheet(file);
  const rows: ParsedRow[] = [];

  sheet.forEach((raw: SheetRow, i) => {
    const amount = parsePeso(String(findCell(raw, COLUMNS.amount) ?? '')) ?? 0;
    const dvNo = findText(raw, COLUMNS.dvNo).toUpperCase();
    const date = normaliseDate(findCell(raw, COLUMNS.date));
    const serialNo = findText(raw, COLUMNS.serial).toUpperCase();

    // A wholly blank line, or the footing the report prints under the columns.
    // Neither is a payment, and both appear in every export.
    //
    // The footing is the one worth being careful about: it carries the report
    // total in the amount column and nothing else, so a reader that tested only
    // for an amount would take it for a payment of two hundred thousand pesos
    // with no voucher behind it. What marks it out is that it names nothing -
    // no date, no voucher, no serial - which no real payment ever does.
    if (!dvNo && !serialNo && (!amount || !date)) return;

    const problems: string[] = [];
    if (!amount) problems.push('no amount');
    if (!date) problems.push('no readable date');

    const holds: string[] = [];
    if (!dvNo) holds.push('no DV number');
    if (importType === 'RCI' && !serialNo) holds.push('no check number');

    rows.push({
      lineNo: i + 1,
      date,
      serialNo,
      dvNo,
      obrNo: findText(raw, COLUMNS.obrNo).toUpperCase(),
      payeeName: findText(raw, COLUMNS.payee),
      particulars: findText(raw, COLUMNS.particulars),
      responsibilityCenter: findText(raw, COLUMNS.responsibilityCenter),
      amount,
      problem: problems.length ? problems.join(', ') : undefined,
      willHold: holds.length ? holds.join(', ') : undefined,
    });
  });

  return rows;
}
