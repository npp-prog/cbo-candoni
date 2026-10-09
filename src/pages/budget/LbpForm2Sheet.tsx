import { useEffect } from 'react';
import { Seal } from '@/components/ui/Seal';
import { FormPrintStyle } from '@/components/print/FormPrintStyle';
import { formatAmount } from '@/lib/money';
import type { Form2Group, Form2Office, Form2Row, Form2Sheet } from './lbpForm2';

/**
 * LBP Form No. 2 on paper, one page per office. Patch 119.
 *
 * A4 portrait, fitted to the width of the sheet, with the municipal seal
 * centred above the letterhead - as the Allotment Release Order and the
 * Augmentation Form are printed. The manual's signature block: Department
 * Head prepares, Local Budget Officer reviews, Local Chief Executive
 * approves.
 *
 * An ordinance not yet approved prints with a band saying so. It does not say
 * "do not sign" - this is the copy that goes for signature.
 */

export function usePrintForm2(sheet: Form2Sheet | null, clear: () => void) {
  useEffect(() => {
    if (!sheet) return;
    window.addEventListener('afterprint', clear);
    const timer = window.setTimeout(() => window.print(), 80);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', clear);
    };
  }, [sheet, clear]);
}

const cell = 'border border-slate-500 px-1 py-0.5';
const amt = `${cell} text-right tabular-nums`;

const dash = (n: number) => (n ? formatAmount(n, false) : '-');

export function LbpForm2Sheet({ sheet }: { sheet: Form2Sheet }) {
  return (
    <div
      className="print-only cbo-form-sheet text-[9pt] text-black"
      data-lbp2-sheet={sheet.prepared ? 'prepared' : 'approved'}
    >
      <FormPrintStyle orientation="portrait" fontPt={8} />
      {sheet.offices.length === 0 && (
        <p className="p-4 text-center">This ordinance has no lines to print.</p>
      )}
      {sheet.offices.map((office, i) => (
        <section
          key={office.officeId}
          className={i < sheet.offices.length - 1 ? 'break-after-page' : undefined}
          style={i < sheet.offices.length - 1 ? { pageBreakAfter: 'always' } : undefined}
        >
          {sheet.prepared && (
            <div className="mb-2 border-2 border-dashed border-slate-700 px-3 py-1 text-center text-[8pt] font-bold uppercase tracking-widest text-slate-700">
              Recorded - for signature - not yet approved in CFMS
            </div>
          )}

          <div className="relative text-center">
            <p className="absolute left-0 top-0 font-bold">LBP Form No. 2</p>
            <Seal className="mx-auto mb-1 h-14 w-14" />
            {sheet.headingLines.map((line, j) => (
              <p
                key={j}
                className={
                  j === 1 ? 'text-[9pt] font-bold uppercase tracking-wide' : 'text-[7.5pt]'
                }
              >
                {line}
              </p>
            ))}
          </div>

          <p className="mt-3 text-center font-bold uppercase">
            Programmed Appropriation and Obligation by Object of Expenditure
          </p>
          <p className="text-center">
            Local Government Unit: <span className="font-semibold underline">{sheet.lgu}</span>
          </p>
          <div className="mt-2 flex justify-between gap-4">
            <p>
              Department/Office:{' '}
              <span className="font-semibold underline">{office.officeName}</span>
            </p>
            <p>
              {sheet.kindLabel}: <span className="font-semibold underline">{sheet.reference}</span>
            </p>
          </div>

          <table className="mt-2 w-full border-collapse text-[7.5pt]">
            <thead>
              <tr>
                <th className={cell} rowSpan={3}>
                  Object of Expenditure
                </th>
                <th className={cell} rowSpan={3} style={{ width: '5rem' }}>
                  Account Code
                </th>
                <th className={cell} rowSpan={2} style={{ width: '5.5rem' }}>
                  Past Year
                </th>
                <th className={cell} colSpan={3}>
                  Current Year
                </th>
                <th className={cell} rowSpan={2} style={{ width: '5.5rem' }}>
                  Budget Year
                </th>
              </tr>
              <tr>
                <th className={cell} style={{ width: '5.5rem' }}>
                  First Semester
                </th>
                <th className={cell} style={{ width: '5.5rem' }}>
                  Second Semester
                </th>
                <th className={cell} style={{ width: '5.5rem' }}>
                  Total
                </th>
              </tr>
              <tr>
                <th className={`${cell} font-normal`}>(Actual)</th>
                <th className={`${cell} font-normal`}>(Actual)</th>
                <th className={`${cell} font-normal`}>(Estimates)</th>
                <th className={`${cell} font-normal`} />
                <th className={`${cell} font-normal`}>(Proposed)</th>
              </tr>
              <tr>
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <th key={n} className={`${cell} text-center font-normal`}>
                    ({n})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {office.groups.map((g) => (
                <Group key={g.heading} group={g} />
              ))}
              {office.spas.length > 0 && (
                <>
                  <tr className="font-bold">
                    <td className={cell} colSpan={7}>
                      Special Purpose Appropriations (SPAs)
                    </td>
                  </tr>
                  {office.spas.map((g) => (
                    <Group key={g.heading} group={g} indent />
                  ))}
                </>
              )}
              <Row row={office.total} bold />
            </tbody>
          </table>

          <div className="mt-6 grid grid-cols-3 gap-6">
            <Signature label="Prepared by:" position="Department Head" />
            <Signature label="Reviewed by:" position="Local Budget Officer" />
            <Signature label="Approved by:" position="Local Chief Executive" />
          </div>

          <p className="mt-4 text-[6.5pt] text-slate-600">
            Columns 3 and 4 are obligations in the books of the past year and of the first semester
            of the current year. Columns 5 and 6 - the second-semester estimate and the current
            year&rsquo;s total - are left blank for the Department Head. Column 7 is the ordinance as
            recorded in CFMS.
          </p>
        </section>
      ))}
    </div>
  );
}

function Group({ group, indent }: { group: Form2Group; indent?: boolean }) {
  if (group.rows.length === 0 && indent) return null;
  return (
    <>
      <tr className="font-bold">
        <td className={`${cell} ${indent ? 'pl-4' : ''}`} colSpan={7}>
          {group.heading}
        </td>
      </tr>
      {group.rows.map((r) => (
        <Row key={`${r.accountCode}-${r.object}`} row={r} indent />
      ))}
      {group.rows.length > 0 && <Row row={group.total} bold indent />}
    </>
  );
}

function Row({ row, bold, indent }: { row: Form2Row; bold?: boolean; indent?: boolean }) {
  return (
    <tr className={bold ? 'font-bold' : undefined}>
      <td className={`${cell} ${indent ? 'pl-4' : ''}`}>{row.object}</td>
      <td className={`${cell} font-mono`}>{row.accountCode}</td>
      <td className={amt}>{dash(row.pastYear)}</td>
      <td className={amt}>{dash(row.firstSemester)}</td>
      {/* Columns 5 and 6: blank, written in by hand (patch 129). */}
      <td className={amt} />
      <td className={amt} />
      <td className={amt}>{dash(row.proposed)}</td>
    </tr>
  );
}

function Signature({ label, position }: { label: string; position: string }) {
  return (
    <div>
      <p className="font-bold">{label}</p>
      <div className="mt-8 border-t border-black pt-0.5">
        <p>{position}</p>
      </div>
    </div>
  );
}

export type { Form2Office };
