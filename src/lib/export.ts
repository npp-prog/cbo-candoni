import * as XLSX from 'xlsx';
import { engine } from './engine';
import { formatLongDate, todayPh } from './dates';
import { toPesos } from './money';

/**
 * Report export.
 *
 * Two rules govern everything here:
 *
 *   1. Amounts leave CBO as numbers, not as pre-formatted strings. An
 *      accountant who receives "₱1,234,567.89" in a spreadsheet cell cannot
 *      add it up. Centavos are converted to a peso number with two decimals
 *      and the cell is given a Philippine currency format instead.
 *
 *   2. Every export is logged. COA expects to know who took a copy of the
 *      books and when, and the logging call is fire-and-forget so a failure to
 *      log never blocks the user from getting their file.
 */

export interface ExportColumn<T> {
  key: string;
  header: string;
  /** Returns a raw value: a number for amounts, a string otherwise. */
  value: (row: T) => string | number | null;
  /** Amount columns get a currency number format and right alignment. */
  kind?: 'text' | 'amount' | 'number' | 'date';
  width?: number;
}

export interface ReportMeta {
  title: string;
  /** e.g. "General Fund" */
  fundLabel?: string;
  /** e.g. "For the month ended 30 September 2026" */
  periodLabel?: string;
  municipality?: string;
  province?: string;
  preparedBy?: string;
  reviewedBy?: string;
  certifiedBy?: string;
  approvedBy?: string;
}

const DEFAULT_MUNICIPALITY = 'Municipality of Candoni';
const DEFAULT_PROVINCE = 'Province of Negros Occidental';

/** The official four-line heading every CBO report carries. */
export function reportHeadingLines(meta: ReportMeta): string[] {
  return [
    'Republic of the Philippines',
    meta.province ?? DEFAULT_PROVINCE,
    meta.municipality ?? DEFAULT_MUNICIPALITY,
    '',
    meta.title,
    ...(meta.fundLabel ? [meta.fundLabel] : []),
    ...(meta.periodLabel ? [meta.periodLabel] : []),
  ];
}

function logExport(meta: ReportMeta, format: string) {
  void engine
    .recordExport({
      report: meta.title,
      format,
      filters: { fund: meta.fundLabel, period: meta.periodLabel },
    })
    .catch(() => {
      // Logging is best-effort. The user still gets their file.
    });
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick; revoking synchronously can cancel the download
  // in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(meta: ReportMeta, ext: string): string {
  const base = [meta.title, meta.fundLabel, meta.periodLabel]
    .filter(Boolean)
    .join(' - ')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return `${base || 'CBO_Report'}_${todayPh()}.${ext}`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function exportCsv<T>(rows: T[], columns: ExportColumn<T>[], meta: ReportMeta): void {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // A leading =, +, - or @ in a CSV cell is interpreted as a formula by
    // Excel. Prefixing with a single quote neutralises it.
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };

  const lines: string[] = [];
  for (const line of reportHeadingLines(meta)) lines.push(esc(line));
  lines.push(esc(`Generated ${formatLongDate(todayPh())}`));
  lines.push('');
  lines.push(columns.map((c) => esc(c.header)).join(','));

  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const v = c.value(row);
          if (c.kind === 'amount' && typeof v === 'number') return toPesos(v).toFixed(2);
          return esc(v);
        })
        .join(','),
    );
  }

  // A UTF-8 BOM so Excel on Windows renders the peso sign correctly.
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }), safeFilename(meta, 'csv'));
  logExport(meta, 'CSV');
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

const PESO_FORMAT = '#,##0.00;(#,##0.00);"-"';

export function exportXlsx<T>(rows: T[], columns: ExportColumn<T>[], meta: ReportMeta): void {
  const heading = reportHeadingLines(meta);
  const aoa: Array<Array<string | number | null>> = [];

  for (const line of heading) aoa.push([line]);
  aoa.push([`Generated ${formatLongDate(todayPh())}`]);
  aoa.push([]);
  aoa.push(columns.map((c) => c.header));

  for (const row of rows) {
    aoa.push(
      columns.map((c) => {
        const v = c.value(row);
        if (c.kind === 'amount' && typeof v === 'number') return toPesos(v);
        return v;
      }),
    );
  }

  // Signature block, as it appears on the printed report.
  if (meta.preparedBy || meta.reviewedBy || meta.approvedBy) {
    aoa.push([]);
    aoa.push([]);
    aoa.push(['Prepared by:', '', 'Reviewed by:', '', 'Approved by:']);
    aoa.push([meta.preparedBy ?? '', '', meta.reviewedBy ?? '', '', meta.approvedBy ?? '']);
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  const headerRowIndex = heading.length + 2; // 0-based row of the column headers
  const firstDataRow = headerRowIndex + 1;

  // Apply the currency format to amount columns.
  columns.forEach((col, colIndex) => {
    if (col.kind !== 'amount') return;
    for (let r = firstDataRow; r < firstDataRow + rows.length; r++) {
      const address = XLSX.utils.encode_cell({ r, c: colIndex });
      const cell = sheet[address];
      if (cell && typeof cell.v === 'number') {
        cell.t = 'n';
        cell.z = PESO_FORMAT;
      }
    }
  });

  sheet['!cols'] = columns.map((c) => ({
    wch: c.width ?? Math.max(12, Math.min(40, c.header.length + 4)),
  }));

  // Freeze the header row so long reports stay readable while scrolling.
  sheet['!freeze'] = { xSplit: '0', ySplit: String(firstDataRow), topLeftCell: `A${firstDataRow + 1}`, activePane: 'bottomLeft', state: 'frozen' };

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, meta.title.slice(0, 28) || 'Report');
  XLSX.writeFile(book, safeFilename(meta, 'xlsx'), { compression: true });

  logExport(meta, 'XLSX');
}

// ---------------------------------------------------------------------------
// Print / PDF
// ---------------------------------------------------------------------------

/**
 * Printing goes through the browser's own print dialogue rather than a
 * bundled PDF generator.
 *
 * That is a deliberate trade. A client-side PDF library would give byte-exact
 * output, at the cost of several hundred kilobytes of bundle, a second layout
 * engine to maintain, and fonts that have to be embedded for the peso sign to
 * render. The browser already lays out and paginates the report correctly
 * under the `@media print` rules in index.css, and "Save as PDF" is present in
 * every print dialogue on every platform the municipality uses. Where a
 * server-rendered PDF is genuinely needed - a signed archival copy at year end
 * - that belongs in a Cloud Function, not in the browser.
 */
export function printReport(meta: ReportMeta): void {
  logExport(meta, 'PRINT');
  window.print();
}

// ---------------------------------------------------------------------------
// Bank statement import (the reverse direction)
// ---------------------------------------------------------------------------

export interface ParsedStatementRow {
  transactionDate: string;
  postingDate?: string;
  referenceNo?: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance?: number;
}

/**
 * Parses a CSV or XLSX bank statement into rows, given a column mapping the
 * user has confirmed on screen.
 *
 * Parsing happens in the browser because bank export formats vary and a human
 * has to look at the file and say which column is which. What is *not* left to
 * the browser is deciding whether these rows are new: duplicate detection
 * happens server-side in `importBankStatement`, because re-importing the same
 * statement is the most common and most damaging mistake in reconciliation.
 */
export function parseStatementFile(
  data: ArrayBuffer,
  mapping: {
    transactionDate: string;
    postingDate?: string;
    referenceNo?: string;
    description: string;
    debit?: string;
    credit?: string;
    amount?: string;
    runningBalance?: string;
  },
): { rows: ParsedStatementRow[]; warnings: string[] } {
  const book = XLSX.read(data, { type: 'array', cellDates: true, raw: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

  const warnings: string[] = [];
  const rows: ParsedStatementRow[] = [];

  json.forEach((raw, index) => {
    const dateValue = raw[mapping.transactionDate];
    const transactionDate = toIsoDate(dateValue);
    if (!transactionDate) {
      warnings.push(`Row ${index + 2}: could not read a transaction date, row skipped.`);
      return;
    }

    let debit = 0;
    let credit = 0;

    if (mapping.amount) {
      // A single signed amount column: negative is a withdrawal.
      const amount = toCentavos(raw[mapping.amount]);
      if (amount < 0) debit = Math.abs(amount);
      else credit = amount;
    } else {
      debit = Math.abs(toCentavos(raw[mapping.debit ?? '']));
      credit = Math.abs(toCentavos(raw[mapping.credit ?? '']));
    }

    if (debit === 0 && credit === 0) {
      warnings.push(`Row ${index + 2}: no amount found, row skipped.`);
      return;
    }

    rows.push({
      transactionDate,
      postingDate: mapping.postingDate ? toIsoDate(raw[mapping.postingDate]) || undefined : undefined,
      referenceNo: mapping.referenceNo ? String(raw[mapping.referenceNo] ?? '').trim() || undefined : undefined,
      description: String(raw[mapping.description] ?? '').trim(),
      debit,
      credit,
      runningBalance: mapping.runningBalance ? toCentavos(raw[mapping.runningBalance]) : undefined,
    });
  });

  return { rows, warnings };
}

/** Column headers found in an uploaded statement, for the mapping UI. */
export function readStatementHeaders(data: ArrayBuffer): { headers: string[]; sampleRows: Record<string, unknown>[] } {
  const book = XLSX.read(data, { type: 'array', cellDates: true, raw: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const headers = json.length > 0 ? Object.keys(json[0]) : [];
  return { headers, sampleRows: json.slice(0, 5) };
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value ?? '').trim();
  if (!s) return '';

  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // DD/MM/YYYY and MM/DD/YYYY are ambiguous. Philippine bank statements
  // overwhelmingly use MM/DD/YYYY, so that is assumed, and a day above 12 in
  // the first position is treated as DD/MM/YYYY.
  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    let [, a, b, y] = slash;
    let month = Number(a);
    let day = Number(b);
    if (month > 12) {
      [month, day] = [day, month];
    }
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString().slice(0, 10);
}

function toCentavos(value: unknown): number {
  if (typeof value === 'number') return Math.round(value * 100);
  const s = String(value ?? '').replace(/[₱P,\s]/gi, '').trim();
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s);
  const n = Number(negative ? s.slice(1, -1) : s);
  if (!Number.isFinite(n)) return 0;
  return Math.round((negative ? -n : n) * 100);
}
