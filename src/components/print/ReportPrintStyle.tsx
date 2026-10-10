/**
 * A report on A4, fitted to the width of the sheet. Patch 117.
 *
 * The budget registries and reports print on the application's ordinary page
 * - A4 portrait with 15mm by 12mm margins - and on screen they sit in a box
 * that scrolls sideways when the columns are wider than the window. Neither
 * survives the printer: a scrolling box prints only the part that was in view,
 * and a table wider than the paper is cut off at the edge without a word. The
 * Report of Receipts, with a column for every month of the quarter, came out
 * with its right-hand columns missing.
 *
 * So while one of these reports is on screen it emits its own page:
 *
 *   A4, in the orientation the report needs - landscape for the registries
 *   and the quarterly reports, which are wide; portrait for the SRE, which is
 *   a statement.
 *
 *   The report laid out in a box exactly as wide as the printable area, its
 *   tables `table-layout: fixed` at 100%, and the sideways-scrolling wrappers
 *   opened up - so the table divides the paper's width among its columns and
 *   cannot be wider than the sheet. That is "fit to width" done by the page
 *   rather than left to a setting in the print dialogue.
 *
 *   Figures are kept whole on one line; names and titles wrap.
 *
 * It is a <style> element mounted with the report, so it leaves with the
 * report and nothing else in CFMS prints differently.
 */

const MARGIN_MM = 10;

export function ReportPrintStyle({ orientation }: { orientation: 'portrait' | 'landscape' }) {
  const width = (orientation === 'landscape' ? 297 : 210) - MARGIN_MM * 2;
  const css = `
@media print {
  @page { size: A4 ${orientation}; margin: ${MARGIN_MM}mm; }

  .cbo-report-sheet {
    width: ${width}mm !important;
    max-width: ${width}mm !important;
    margin: 0 !important;
    padding: 0 !important;
    font-size: 8pt !important;
  }

  /* A box that scrolls sideways prints only what was in view. Open it up. */
  .cbo-report-sheet .overflow-x-auto,
  .cbo-report-sheet .overflow-auto,
  .cbo-report-sheet .overflow-hidden {
    overflow: visible !important;
  }

  /* Patch 165: a statement kept narrow on screen takes the full width on paper. */
  .cbo-report-sheet [class*="max-w-"] {
    max-width: none !important;
  }

  .cbo-report-sheet table {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    table-layout: fixed !important;
    font-size: 7.5pt !important;
  }

  .cbo-report-sheet th,
  .cbo-report-sheet td {
    padding-left: 2px !important;
    padding-right: 2px !important;
    white-space: normal !important;
    overflow-wrap: anywhere;
    word-break: normal;
  }

  /*
    The screen's own sizes - text-sm amounts, text-xs names - are set on the
    cells and their contents, and would beat the table's size. On paper every
    cell takes the sheet's size, or the widest figures run into each other.
  */
  .cbo-report-sheet td,
  .cbo-report-sheet td * {
    font-size: 7pt !important;
    letter-spacing: 0 !important;
  }

  .cbo-report-sheet th,
  .cbo-report-sheet th * {
    font-size: 6.5pt !important;
    letter-spacing: 0 !important;
  }

  /* A figure is read as one thing; it never breaks across two lines. */
  .cbo-report-sheet .cbo-amount,
  .cbo-report-sheet .tabular,
  .cbo-report-sheet .tabular-nums,
  .cbo-report-sheet .font-mono,
  .cbo-report-sheet td.text-right {
    white-space: nowrap !important;
    overflow-wrap: normal !important;
  }

  /*
    Patch 150. The shading - the heading row and the total - is part of the
    form, and a browser leaves background colours off the paper unless told
    otherwise ("Background graphics" in the print dialogue). Told here.
  */
  .cbo-report-sheet,
  .cbo-report-sheet * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  /* The heading with the seal at its left is a grid, not a table group. */
  .cbo-report-sheet .report-header {
    display: grid !important;
  }
}`;
  return <style>{css}</style>;
}
