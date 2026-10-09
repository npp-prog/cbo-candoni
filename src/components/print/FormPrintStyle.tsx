/**
 * The page a prescribed treasury form is printed on.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FORMS NEED THEIR OWN PAGE AND THE REST OF CFMS DOES NOT
 * ---------------------------------------------------------------------------
 * `index.css` prints the application on A4 PORTRAIT with 15mm by 12mm margins,
 * which is right for a trial balance, a statement, an ageing report - anything
 * whose shape is a column of figures.
 *
 * It is wrong for these five. The RCI carries nine columns, the RCD's Section
 * D splits every peso by how it was tendered, and an eRCD's Breakdown of
 * Collections has one column per revenue account the intermediary collected
 * against - which at Candoni is routinely eight or ten. On portrait A4 the
 * right-hand columns run off the sheet, and a browser printing a table that
 * does not fit does not warn anybody: it simply cuts it off at the paper's
 * edge. The office then files a certified report with a column missing.
 *
 * So these screens emit their own `@page` while they are mounted, the way the
 * check calibration sheet does. It comes later in the cascade than index.css,
 * so it wins, and it leaves with the screen rather than changing how the rest
 * of the system prints.
 *
 * ---------------------------------------------------------------------------
 * "FIT TO WIDTH", AND HOW IT IS ACTUALLY DONE
 * ---------------------------------------------------------------------------
 * Fit-to-width is a setting in the browser's print dialog, and a web page
 * cannot press it. What a page CAN do is make the fitting unnecessary, which
 * is what this does and is the more reliable of the two:
 *
 *   The form is laid out in a box exactly as wide as the printable area -
 *   A4 landscape, 297mm, less the margins. Not "about as wide": exactly.
 *
 *   Every table inside it is `table-layout: fixed` at `width: 100%`. A fixed
 *   table divides the width it is given among its columns instead of asking
 *   them how wide they would like to be, so the table CANNOT be wider than
 *   the page. There is nothing left to overflow.
 *
 *   Long text wraps rather than widening its column, and figures are kept
 *   from breaking mid-number.
 *
 * The cost is honest and worth stating: a report with a great many columns
 * gets narrow ones. Twelve columns across 277mm is 23mm each, which prints an
 * amount comfortably and a long account title over two lines. The remedy for a
 * report that is genuinely too wide to read is fewer columns - one report per
 * nature of collection - which is what the eRCD screen already advises.
 *
 * It also means the office does NOT have to remember to choose landscape in
 * the print dialog. The page asks for landscape itself; the browser obeys.
 */

/** A4, and the box the form is laid out in. */
const MARGIN_MM = 8;

/** The printable height of one A4 sheet, in millimetres. */
export function printableHeightMm(orientation: 'landscape' | 'portrait' = 'landscape'): number {
  return (orientation === 'landscape' ? 210 : 297) - MARGIN_MM * 2;
}

/**
 * Landscape for the wide treasury forms, as before. Since patch 117 the
 * Allotment Release Order and the Augmentation Form use the same machinery in
 * PORTRAIT - they are narrow forms, printed the way the manual prints them -
 * and at their own type size rather than the treasury forms' 7.5pt.
 */
export function FormPrintStyle({
  orientation = 'landscape',
  fontPt = 7.5,
}: {
  orientation?: 'landscape' | 'portrait';
  fontPt?: number;
} = {}) {
  const PRINTABLE_MM = (orientation === 'landscape' ? 297 : 210) - MARGIN_MM * 2;
  /*
    The form's geometry, written once and used twice: for the printed page,
    and (patch 141) for the hidden copy that measures how many ruled rows fit
    on one page - see useFitRows. The copy must be laid out exactly as the
    paper is, or the count is wrong.
  */
  const sheet = (scope: string) => `
  /* The form's own box: exactly the printable width, so nothing can exceed it. */
  ${scope}.cbo-form-sheet {
    width: ${PRINTABLE_MM}mm !important;
    max-width: ${PRINTABLE_MM}mm !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    box-shadow: none !important;
    font-size: ${fontPt}pt !important;
    line-height: 1.25 !important;
  }

  /*
    A fixed table divides the width it is given rather than asking its columns
    how wide they would like to be, so it cannot be wider than the sheet. This
    is the whole of "fit to width".
  */
  ${scope}.cbo-form-sheet table:not(.cbo-form-inline) {
    width: 100% !important;
    max-width: 100% !important;
    table-layout: fixed !important;
  }

  /*
    Patch 146: shading prints. A browser leaves background colours off paper
    unless told otherwise ("Background graphics" in the dialog), so the shaded
    header and total rows came out white. This asks for them exactly.
  */
  ${scope}.cbo-form-sheet,
  ${scope}.cbo-form-sheet * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  ${scope}.cbo-form-sheet th,
  ${scope}.cbo-form-sheet td {
    overflow-wrap: anywhere;
    word-break: normal;
    padding-left: 2px !important;
    padding-right: 2px !important;
  }

  /* A figure is read as one thing; it must not break across two lines. */
  ${scope}.cbo-form-sheet .tabular,
  ${scope}.cbo-form-sheet .font-mono,
  ${scope}.cbo-form-sheet td.text-right {
    overflow-wrap: normal;
    word-break: keep-all;
    white-space: nowrap;
  }`;
  const css = `
@media print {
  @page { size: A4 ${orientation}; margin: ${MARGIN_MM}mm; }

  html, body { background: #fff !important; }
${sheet('')}

  /* The signature block is signed in ink; it is never split across a page. */
  .cbo-form-signatures { page-break-inside: avoid; break-inside: avoid; }
}

/* The measuring copy: laid out as the paper is, out of sight, never printed. */
.cbo-form-measure {
  position: absolute !important;
  left: -100000px !important;
  top: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
${sheet('.cbo-form-measure ')}
@media print { .cbo-form-measure { display: none !important; } }`;
  return <style>{css}</style>;
}

/*
 * Patch 142: the "Draft for checking - not yet certified - do not sign" band
 * printed across a draft report is gone, at the office's request. The screen
 * still says, above the form, when a report is a draft or was withdrawn.
 */
/**
 * The statuses in which the form on screen IS the certified document.
 *
 * Both flows are named, because this component prints both and they do not use
 * the same words:
 *
 *   A TREASURY REPORT runs DRAFT, CERTIFIED, JOURNALIZED, CANCELLED. The
 *   Treasurer signs at CERTIFIED and Accounting raises the entry at
 *   JOURNALIZED, which is later still - so both are finished copies.
 *
 *   A LEGACY RCD, from before the RCD became a treasury report, runs DRAFT,
 *   SUBMITTED, VERIFIED, POSTED, CANCELLED. Only POSTED is finished. SUBMITTED
 *   and VERIFIED are stages on the way and keep the band, which is the
 *   cautious reading and the right one: a band on a copy that did not need it
 *   costs a reprint, and a missing band on one that did costs a signature on
 *   the wrong paper.
 *
 * Listing JOURNALIZED is not a detail. Without it, every report Accounting had
 * already journalized would have reprinted stamped DRAFT - the one case where
 * a wrong band would be both common and obviously wrong to the office.
 */
const CERTIFIED_STATUSES = ['CERTIFIED', 'JOURNALIZED', 'POSTED'];

/** Whether the form on screen is the finished document rather than a checking copy. */
export function isCertifiedCopy(status?: string | null): boolean {
  return CERTIFIED_STATUSES.includes(String(status ?? ''));
}
