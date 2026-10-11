import * as XLSX from 'xlsx';
import { localIsoDate } from './dates';

/**
 * Reading spreadsheets the municipality already produces.
 *
 * Every import in CFMS reads a file that some other system wrote - the
 * Treasurer's RCI, the collection abstract, the old ledger's opening balances.
 * None of those were designed with CFMS in mind, and none of them will be
 * changed to suit it.
 *
 * So the rule here is that the file is right and the reader adapts. Column
 * headings are matched by pattern rather than by name, dates are accepted in
 * whatever shape the exporting program emitted, and anything unrecognised is
 * ignored rather than treated as an error. Insisting on an exact header is how
 * a two-minute import becomes an afternoon of renaming columns, and the first
 * person to give up on that afternoon starts keeping the figures in a separate
 * spreadsheet instead.
 */

export type SheetRow = Record<string, unknown>;

/** Reads the first sheet of a .csv, .xls or .xlsx into plain objects. */
export async function readSheet(
  file: File,
  /**
   * Patch 174: read a CSV as text, cell for cell - an O.R. number 0007100001
   * keeps its zeros instead of becoming the number 7100001.
   */
  options: { csvAsText?: boolean } = {},
): Promise<SheetRow[]> {
  const buffer = await file.arrayBuffer();
  const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
  const book = XLSX.read(buffer, { type: 'array', raw: Boolean(options.csvAsText && isCsv) });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<SheetRow>(sheet, { defval: '' });
}

/**
 * The first sheet as rows of cell text, with no heading assumed. Patch 140:
 * for files with no heading row, such as the bank's payee upload file.
 */
export async function readSheetGrid(file: File): Promise<string[][]> {
  const buffer = await file.arrayBuffer();
  // raw: false keeps "0011223344" as text where the file stored it as text.
  const book = XLSX.read(buffer, { type: 'array', raw: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils
    .sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false })
    .map((r) => r.map((c) => (c == null ? '' : String(c).trim())));
}

/**
 * The first cell in the row whose heading matches one of the patterns.
 *
 * Patterns are tried in order, so put the specific one first: `/dv\s*no/i`
 * before `/^no/i`, or a row with both a DV number and a check number will hand
 * back whichever the exporting program happened to place on the left.
 */
export function findCell(row: SheetRow, patterns: RegExp[]): unknown {
  for (const pattern of patterns) {
    for (const key of Object.keys(row)) {
      if (pattern.test(key)) return row[key];
    }
  }
  return undefined;
}

/** `findCell` as trimmed text, which is what nearly every caller wants. */
export function findText(row: SheetRow, patterns: RegExp[]): string {
  const value = findCell(row, patterns);
  return value == null ? '' : String(value).trim();
}

/**
 * A date in `YYYY-MM-DD`, or an empty string if the cell holds nothing usable.
 *
 * Excel keeps dates as a serial number counted from 1899-12-30, and a file
 * saved from Excel will hand one over even where the column looked like a date
 * on screen. Everything else is left to `Date`, with a sanity check on the year
 * so that a stray "12" in a date column does not become the year 2001.
 */
export function normaliseDate(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && value > 20_000 && value < 80_000) {
    const ms = Date.UTC(1899, 11, 30) + value * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 1990) {
    return localIsoDate(parsed); // patch 180: not toISOString (UTC, a day early)
  }
  return '';
}
