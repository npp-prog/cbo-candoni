import { useEffect } from 'react';
import { Seal } from '@/components/ui/Seal';
import { FormPrintStyle } from '@/components/print/FormPrintStyle';
import { formatAmount } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { LBE_FORM_2_NOTES, type AugmentationRow, type AugmentationSheet } from './augmentationForm';
import { printAs, printFileName } from '@/lib/printTitle';

/**
 * LBE Form No. 2 on paper. Patch 116.
 *
 * Laid out as page 186 of the Budget Operations Manual lays it out: the
 * heading, the two halves FROM and TO with their six numbered columns, the
 * totals, and the manual's own signature block - the Local Budget Officer
 * prepares, the Local Accountant certifies correct, the Local Chief Executive
 * (or the Vice-LCE) approves. The notes are printed under it, word for word.
 *
 * A PREPARED augmentation prints with a band saying it is not yet posted. It
 * does not say "do not sign": this copy exists to be signed. Posting it in
 * CFMS is the step that follows the signatures.
 */

/** Opens the print dialogue once the sheet is on the page, and clears it after. */
export function usePrintAugmentation(sheet: AugmentationSheet | null, clear: () => void) {
  useEffect(() => {
    if (!sheet) return;
    window.addEventListener('afterprint', clear);
    // Patch 156: saved to PDF under the form's name and authority.
    const timer = window.setTimeout(
      () => printAs(printFileName('Augmentation Form', sheet.ordinanceNo)),
      80,
    );
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', clear);
    };
  }, [sheet, clear]);
}

const cell = 'border border-slate-500 px-1.5 py-1';

export function AugmentationFormSheet({ sheet }: { sheet: AugmentationSheet }) {
  // The halves are independent lists; the table is as long as the longer,
  // with the shorter side left blank - as the form looks filled in by hand.
  const rows = Math.max(sheet.from.length, sheet.to.length, 2);

  return (
    <div
      className="print-only cbo-form-sheet text-[10pt] text-black"
      data-augmentation-sheet={sheet.prepared ? 'prepared' : 'posted'}
    >
      {/* A4 portrait, laid out to the printable width. Patch 117. */}
      <FormPrintStyle orientation="portrait" fontPt={10} />
      {sheet.prepared && (
        <div className="mb-3 border-2 border-dashed border-slate-700 px-3 py-1.5 text-center text-[9pt] font-bold uppercase tracking-widest text-slate-700">
          Prepared - for signature - not yet posted in CFMS
        </div>
      )}

      {/*
        The seal centred at the top, above "Republic of the Philippines", and
        the letterhead under it - as on the Allotment Release Order. The form
        number keeps the top-left corner the manual gives it. Patch 117.
      */}
      <div className="relative text-center">
        <p className="absolute left-0 top-0 font-bold">LBE Form No. 2</p>
        <Seal className="mx-auto mb-1.5 h-16 w-16" />
        {sheet.headingLines.map((line, i) => (
          <p key={i} className={i === 1 ? 'text-[10pt] font-bold uppercase tracking-wide' : 'text-[8pt]'}>
            {line}
          </p>
        ))}
      </div>

      <div className="mt-4 text-center">
        <p className="font-bold">AUGMENTATION FORM</p>
        <p className="font-bold">FY {sheet.fiscalYear}</p>
      </div>

      <div className="mt-4 space-y-0.5">
        <p>
          Local Government Unit: <span className="font-semibold underline">{sheet.lgu}</span>
        </p>
        <div className="flex justify-between gap-6">
          <p>
            Office:{' '}
            <span className={sheet.office === 'Executive' ? 'font-semibold underline' : 'text-slate-400'}>
              Executive
            </span>
            /
            <span className={sheet.office === 'Sanggunian' ? 'font-semibold underline' : 'text-slate-400'}>
              Sanggunian
            </span>
          </p>
          <p>
            Ordinance No.:{' '}
            {sheet.ordinanceNo ? (
              <span className="font-semibold underline">{sheet.ordinanceNo}</span>
            ) : (
              <span className="inline-block w-40 border-b border-black">&nbsp;</span>
            )}
            {sheet.authorityDate && (
              <span className="ml-1 text-[8pt]">({formatLongDate(sheet.authorityDate)})</span>
            )}
          </p>
        </div>
      </div>

      <table className="mt-3 w-full border-collapse text-[9pt]">
        <thead>
          <tr>
            <th className={`${cell} text-center`} colSpan={3}>
              Sources of Funds
            </th>
            <th className={`${cell} text-center`} colSpan={3}>
              Uses of Funds
            </th>
          </tr>
          <tr>
            <th className={`${cell} text-center tracking-[0.3em]`} colSpan={3}>
              FROM
            </th>
            <th className={`${cell} text-center tracking-[0.3em]`} colSpan={3}>
              TO
            </th>
          </tr>
          <tr>
            <th className={`${cell} text-center`}>Object of Expenditures</th>
            <th className={`${cell} text-center`} style={{ width: '5.5rem' }}>
              Expense Class
            </th>
            <th className={`${cell} text-center`} style={{ width: '7rem' }}>
              Amount
            </th>
            <th className={`${cell} text-center`}>Object of Expenditures</th>
            <th className={`${cell} text-center`} style={{ width: '5.5rem' }}>
              Expense Class
            </th>
            <th className={`${cell} text-center`} style={{ width: '7rem' }}>
              Amount
            </th>
          </tr>
          <tr>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <th key={n} className={`${cell} text-center font-normal`}>
                ({n})
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i} className="align-top">
              <Half row={sheet.from[i]} />
              <Half row={sheet.to[i]} />
            </tr>
          ))}
          <tr className="font-bold">
            <td className={cell} colSpan={2}>
              TOTAL
            </td>
            <td className={`${cell} text-right tabular-nums`}>{formatAmount(sheet.totalFrom, false)}</td>
            <td className={cell} colSpan={2}>
              TOTAL
            </td>
            <td className={`${cell} text-right tabular-nums`}>{formatAmount(sheet.totalTo, false)}</td>
          </tr>
        </tbody>
      </table>

      {!sheet.balanced && (
        <p className="mt-1 text-[8pt] font-semibold">
          The two totals do not agree. An augmentation must take exactly what it gives; correct it
          in CFMS before it is signed.
        </p>
      )}

      <div className="mt-8 grid grid-cols-2 gap-10">
        <Signature label="Prepared by:" position="Local Budget Officer" />
        <Signature label="Certified Correct by:" position="Local Accountant" />
      </div>
      <div className="mt-8 w-1/2 pr-5">
        <Signature label="Approved by:" position="Local Chief Executive (LCE)/Vice-LCE" />
      </div>

      <div className="mt-8 text-[8pt]">
        <p className="font-bold">Notes:</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          {LBE_FORM_2_NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ol>
      </div>

      {sheet.prepared && sheet.preparedBy && (
        <p className="mt-4 text-[7pt] text-slate-500">Prepared in CFMS by {sheet.preparedBy}.</p>
      )}
    </div>
  );
}

function Half({ row }: { row?: AugmentationRow }) {
  if (!row) {
    return (
      <>
        <td className={`${cell} h-6`} />
        <td className={cell} />
        <td className={cell} />
      </>
    );
  }
  return (
    <>
      <td className={cell}>
        {row.objectOfExpenditure}
        <span className="block text-[7pt] text-slate-600">{row.officeName}</span>
      </td>
      <td className={`${cell} text-center`}>{row.expenseClass}</td>
      <td className={`${cell} text-right tabular-nums`}>{formatAmount(row.amount, false)}</td>
    </>
  );
}

function Signature({ label, position }: { label: string; position: string }) {
  return (
    <div>
      <p className="font-bold">{label}</p>
      <div className="mt-10 border-t border-black pt-0.5">
        <p>{position}</p>
      </div>
    </div>
  );
}
