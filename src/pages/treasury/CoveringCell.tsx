import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CoveredDocument } from './CoveredDocument';
import type { TreasuryReport } from '@/types/treasury';

/**
 * The "Covering" column of a list of treasury reports - and a way in.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 * It shows what it always showed: how many documents the report covers and the
 * serials they run between. What is new is that the serial OPENS:
 *
 *   ONE DOCUMENT - most of Candoni's reports, a single check or a single
 *   receipt - and the serial opens that document straight from the list: the
 *   check with its voucher and status, the receipt with its revenue accounts.
 *   The same panel the register shows, and the same one patch 106 put inside
 *   the report.
 *
 *   SEVERAL - and the serial range opens the report on its Documents Covered
 *   tab, where every one of them is listed and each opens in turn. A list
 *   cannot show forty serials in one cell, and picking one at random would be
 *   worse than showing none.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLICKS ARE STOPPED WHERE THEY ARE
 * ---------------------------------------------------------------------------
 * The row around it is clickable too and opens the report. So:
 *
 *   A click on the SERIAL opens the document and stops there, or the report
 *   would open behind it.
 *
 *   A click anywhere in the DOCUMENT'S PANEL - its Close button, its backdrop,
 *   its link back to the report - stops too. CFMS's pop-ups are not detached
 *   from the page: a click inside one travels up to whatever opened it, which
 *   here is a table row. Without the stop, closing the panel would open the
 *   report.
 *
 *   A click on the "1 document" TEXT is NOT stopped. It is part of the row and
 *   opens the report like every other part of it; a dead patch in the middle
 *   of a clickable row is the kind of thing that makes people think the row
 *   is broken.
 *
 * The panel is drawn on the page itself rather than inside the table cell. A
 * full-screen pop-up nested in a table cell is at the mercy of whatever the
 * table's containers do to their contents, and a scrolling table is exactly
 * the kind of container that clips them.
 *
 * Kept as one component so both lists - the Treasury register and the
 * Accounting list for journalizing - do it identically. Two copies of a click
 * rule are two places for the row to start swallowing clicks it should not.
 */
export function CoveringCell({ report }: { report: TreasuryReport }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const lines = report.lines ?? [];
  const count = lines.length;
  const single = count === 1 ? lines[0] : null;

  const serial = report.serialFrom
    ? `${report.serialFrom}${
        report.serialTo && report.serialTo !== report.serialFrom ? ` - ${report.serialTo}` : ''
      }`
    : single?.sourceNo ?? '';

  return (
    <span className="text-sm">
      {count} document{count === 1 ? '' : 's'}
      {serial && (
        <button
          type="button"
          className="ml-2 rounded font-mono text-xs text-brand-700 underline decoration-dotted underline-offset-2 hover:bg-brand-50 hover:decoration-solid"
          title={single ? 'Open this document' : 'Open the report to see every document it covers'}
          onClick={(e) => {
            e.stopPropagation();
            if (single) setOpen(true);
            else navigate(`/treasury/reports/${report.id}`);
          }}
        >
          {serial}
        </button>
      )}

      {single &&
        open &&
        createPortal(
          <div onClick={(e) => e.stopPropagation()}>
            <CoveredDocument
              reportType={report.reportType}
              sourceId={single.sourceId}
              sourceNo={single.sourceNo}
              onClose={() => setOpen(false)}
            />
          </div>,
          document.body,
        )}
    </span>
  );
}
