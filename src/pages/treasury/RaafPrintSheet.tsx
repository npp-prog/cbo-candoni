import { createPortal } from 'react-dom';
import { ReportHeading } from '@/components/ReportShell';
import { ReportPrintStyle } from '@/components/print/ReportPrintStyle';
import type { Raaf, RaafSerialRange } from '@/types/accountableForms';

/**
 * Patch 158 - the RAAF on paper.
 *
 * The report opens in a window over the register, and a window is screen
 * furniture: it never printed. Print gave the register behind it instead. So
 * the report is laid out a second time here, for the printer only: A4
 * landscape, fitted to the width of the sheet, the municipal seal at the left
 * of the heading like every other Treasury report, the table ruled and its
 * heading shaded.
 *
 * It is put at the top of the page (a portal into <body>) and, while it is
 * mounted, everything else on the page is left off the paper.
 */

export const RAAF_TITLE = 'Report on the Accountability for Accountable Forms';

const TH = 'border border-slate-500 bg-slate-100 px-1.5 py-1 text-center font-semibold';
const TD = 'border border-slate-500 px-1.5 py-1 align-top';

function ranges(list: RaafSerialRange[]): string {
  if (!list || list.length === 0) return '-';
  return list.map((r) => (r.from === r.to ? r.from : `${r.from} - ${r.to}`)).join(', ');
}

function qty(n: number): string {
  return n ? n.toLocaleString('en-PH') : '-';
}

export function RaafPrintSheet({ raaf }: { raaf: Raaf }) {
  const only = `
@media print {
  body > *:not(.cbo-raaf-print) { display: none !important; }
  body > .cbo-raaf-print { display: block !important; }
}`;

  const sheet = (
    <div className="cbo-raaf-print hidden">
      <style>{only}</style>
      <ReportPrintStyle orientation="landscape" />
      <div className="cbo-report-sheet text-xs text-navy-900">
        <ReportHeading
          seal="left"
          meta={{
            title: RAAF_TITLE,
            fundLabel: raaf.raafNo ? `RAAF No. ${raaf.raafNo}` : 'Draft - not yet certified',
            periodLabel: raaf.periodLabel,
          }}
        />

        <div className="mb-2 flex justify-between gap-4">
          <p>
            Accountable officer: <span className="font-semibold">{raaf.officerName}</span>
            {raaf.officerPosition ? `, ${raaf.officerPosition}` : ''}
          </p>
          {raaf.officeName && <p>Office: {raaf.officeName}</p>}
        </div>

        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH} rowSpan={2} style={{ width: '16%' }}>
                Accountable form
              </th>
              <th className={TH} colSpan={2}>
                Beginning balance
              </th>
              <th className={TH} colSpan={2}>
                Receipt
              </th>
              <th className={TH} colSpan={2}>
                Issued
              </th>
              <th className={TH} colSpan={2}>
                Ending balance
              </th>
            </tr>
            <tr>
              {[0, 1, 2, 3].map((i) => [
                <th key={`q${i}`} className={TH} style={{ width: '5%' }}>
                  Qty
                </th>,
                <th key={`s${i}`} className={TH}>
                  Inclusive serial nos.
                </th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {raaf.lines.map((l) => (
              <tr key={l.formCode}>
                <td className={TD}>
                  {l.printedAs}
                  {l.withdrawnQty > 0 && (
                    <div className="text-[7pt]">
                      {l.withdrawnQty} spoiled or cancelled: {ranges(l.withdrawnRanges)}
                    </div>
                  )}
                </td>
                <td className={`${TD} text-right tabular-nums`}>{qty(l.beginningQty)}</td>
                <td className={TD}>{ranges(l.beginningRanges)}</td>
                <td className={`${TD} text-right tabular-nums`}>{qty(l.receiptQty)}</td>
                <td className={TD}>{ranges(l.receiptRanges)}</td>
                <td className={`${TD} text-right tabular-nums`}>{qty(l.issuedQty)}</td>
                <td className={TD}>{ranges(l.issuedRanges)}</td>
                <td className={`${TD} text-right tabular-nums`}>{qty(l.endingQty)}</td>
                <td className={TD}>{ranges(l.endingRanges)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-10 grid grid-cols-2 gap-16">
          <div>
            <p className="text-[8pt]">Prepared by:</p>
            <p className="mt-8 border-t border-navy-900 pt-1 text-center font-semibold uppercase">
              {raaf.preparedBy?.name ?? ''}
            </p>
          </div>
          <div>
            <p className="text-[8pt]">Certified correct:</p>
            <p className="mt-8 border-t border-navy-900 pt-1 text-center font-semibold uppercase">
              {raaf.certifiedBy?.name ?? raaf.officerName}
            </p>
            <p className="text-center text-[8pt]">
              {raaf.officerPosition ?? 'Accountable Officer'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}
