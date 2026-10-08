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

/** A4 landscape, and the box the form is laid out in. */
const MARGIN_MM = 8;
const PRINTABLE_MM = 297 - MARGIN_MM * 2;

export function FormPrintStyle() {
  const css = `
@media print {
  @page { size: A4 landscape; margin: ${MARGIN_MM}mm; }

  html, body { background: #fff !important; }

  /* The form's own box: exactly the printable width, so nothing can exceed it. */
  .cbo-form-sheet {
    width: ${PRINTABLE_MM}mm !important;
    max-width: ${PRINTABLE_MM}mm !important;
    margin: 0 !important;
    padding: 0 !important;
    font-size: 7.5pt !important;
    line-height: 1.25 !important;
  }

  /*
    A fixed table divides the width it is given rather than asking its columns
    how wide they would like to be, so it cannot be wider than the sheet. This
    is the whole of "fit to width".
  */
  .cbo-form-sheet table {
    width: 100% !important;
    max-width: 100% !important;
    table-layout: fixed !important;
  }

  .cbo-form-sheet th,
  .cbo-form-sheet td {
    overflow-wrap: anywhere;
    word-break: normal;
    padding-left: 2px !important;
    padding-right: 2px !important;
  }

  /* A figure is read as one thing; it must not break across two lines. */
  .cbo-form-sheet .tabular,
  .cbo-form-sheet .font-mono,
  .cbo-form-sheet td.text-right {
    overflow-wrap: normal;
    word-break: keep-all;
    white-space: nowrap;
  }

  /* The signature block is signed in ink; it is never split across a page. */
  .cbo-form-signatures { page-break-inside: avoid; break-inside: avoid; }
}`;
  return <style>{css}</style>;
}

/**
 * The band that says a printed form is not the certified one.
 *
 * ---------------------------------------------------------------------------
 * WHY PRINTING A DRAFT IS ALLOWED, AND WHY IT IS STAMPED
 * ---------------------------------------------------------------------------
 * Until patch 104 these screens printed a draft without a word on the paper to
 * say so, and warned on screen that doing it at all was a bad idea. Both halves
 * of that were wrong.
 *
 * THE WARNING WAS WRONG because checking a report on paper before signing it is
 * how the work is actually done. The Treasurer reads the figures against the
 * receipts in front of them, and reading forty lines off a monitor is not the
 * same act. Refusing to print until after certification asks the office to
 * certify first and check afterwards, which is the wrong way round and is the
 * one order these screens exist to prevent.
 *
 * THE SILENCE WAS THE REAL RISK. A draft printed on the prescribed form is
 * indistinguishable from the certified one: same letterhead, same certification
 * paragraph, same signature lines. Left on a desk it can be signed, and then a
 * form exists saying the Treasurer certified a report that CFMS has no record
 * of them certifying - and whose figures have since moved.
 *
 * So the paper says what it is, in a band across the top of every page and
 * again over the certification. It cannot be mistaken for the final form and it
 * cannot be quietly photocopied into one.
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

export function DraftBand({ status }: { status?: string | null }) {
  if (isCertifiedCopy(status)) return null;

  const withdrawn = status === 'CANCELLED';

  return (
    <div
      className={`mb-2 border-2 border-dashed px-3 py-1.5 text-center text-[10px] font-bold uppercase tracking-widest ${
        withdrawn ? 'border-rose-700 text-rose-700' : 'border-slate-700 text-slate-700'
      }`}
    >
      {withdrawn
        ? 'Withdrawn - not a valid report'
        : 'Draft for checking - not yet certified - do not sign'}
    </div>
  );
}
