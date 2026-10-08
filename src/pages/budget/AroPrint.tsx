import { useEffect } from 'react';
import { Letterhead, SignatureLine } from '@/components/print/formParts';
import { FormPrintStyle } from '@/components/print/FormPrintStyle';
import { useEntity } from '@/data/useEntity';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { Centavos } from '@/types/common';
import { fundLabel } from './Obligations';

/**
 * The Allotment Release Order on paper - issued, or only prepared.
 *
 * ---------------------------------------------------------------------------
 * PRINTING A PREPARED ORDER (patch 112)
 * ---------------------------------------------------------------------------
 * The order is signed on paper - recommended by the Budget Officer, approved
 * by the Local Chief Executive - and the office wants to circulate it for
 * those signatures BEFORE it is released in CFMS. Until now only an issued
 * order printed, which put the release ahead of the signatures it rests on.
 *
 * A prepared order prints on the same form, with two differences, and both
 * are on the paper so that neither can be missed:
 *
 *   THE BAND across the top says it is prepared and not yet released. Unlike
 *   the band on a treasury report, it does NOT say "do not sign": signing is
 *   exactly what this copy is for.
 *
 *   THE ARO NUMBER IS BLANK, with a line to write it on. CFMS issues the number
 *   when the order is approved, from a series that must not have gaps - so a
 *   number cannot be reserved for an order that may yet be discarded. The
 *   number on the approval toast is the one to write in.
 *
 * The figures on a prepared copy are the order as prepared. Approval checks
 * every line again against the appropriation as it then stands; if anything
 * was changed after printing, print it again.
 */

export interface AroSheetLine {
  key: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  accountCode: string;
  accountName: string;
  released: Centavos;
  /** What the order held back. On an issued order, as it stood at issue. */
  held: Centavos;
}

export interface AroSheet {
  /** Null on a prepared order: the number is issued on approval. */
  aroNo: string | null;
  date: string;
  expenseClass: string;
  purpose: string;
  fundCode: string;
  fiscalYear: number;
  lines: AroSheetLine[];
  prepared: boolean;
  preparedBy?: string | null;
}

export const FORM_OF: Record<ExpenseClass, string> = {
  PS: 'LBE Form No. 1',
  MOOE: 'LBE Form No. 1A',
  FE: 'LBE Form No. 1B',
  CO: 'LBE Form No. 1C',
};

export const formOf = (expenseClass: string): string =>
  FORM_OF[expenseClass as ExpenseClass] ?? 'Allotment Release Order';

/** Opens the browser's print dialogue once the sheet has rendered, and clears it after. */
export function usePrintSheet(sheet: AroSheet | null, clear: () => void) {
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

export function AroPrintSheet({ sheet }: { sheet: AroSheet }) {
  const entity = useEntity();
  const released = sheet.lines.reduce((t, l) => t + l.released, 0);
  const held = sheet.lines.reduce((t, l) => t + l.held, 0);

  return (
    <div className="print-only cbo-form-sheet" data-aro-sheet={sheet.prepared ? 'prepared' : 'issued'}>
      {/* A4 portrait, laid out to the printable width so nothing runs off
          the sheet whatever the print dialogue's scale. Patch 117. */}
      <FormPrintStyle orientation="portrait" fontPt={9} />
      {sheet.prepared && (
        <div className="mb-2 border-2 border-dashed border-slate-700 px-3 py-1.5 text-center text-[10px] font-bold uppercase tracking-widest text-slate-700">
          Prepared - for signature - not yet released in CFMS
        </div>
      )}

      <Letterhead
        appendix={formOf(sheet.expenseClass)}
        lines={entity.headingLines}
        title="Allotment Release Order"
        seal
      />

      <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-2xs">
        <p>
          <span className="text-slate-500">ARO No.:</span>{' '}
          {sheet.aroNo ? (
            <span className="font-mono font-semibold">{sheet.aroNo}</span>
          ) : (
            <span>
              <span className="inline-block w-40 border-b border-slate-500">&nbsp;</span>{' '}
              <span className="text-slate-500">(issued on release)</span>
            </span>
          )}
        </p>
        <p className="text-right">
          <span className="text-slate-500">Date:</span> {formatLongDate(sheet.date)}
        </p>
        <p>
          <span className="text-slate-500">Fund:</span> {fundLabel(sheet.fundCode)}
        </p>
        <p className="text-right">
          <span className="text-slate-500">Fiscal Year:</span> {sheet.fiscalYear}
        </p>
        <p className="col-span-2">
          <span className="text-slate-500">Expense Class:</span>{' '}
          {EXPENSE_CLASS_LABELS[sheet.expenseClass as ExpenseClass] ?? sheet.expenseClass}
        </p>
        <p className="col-span-2">
          <span className="text-slate-500">Purpose:</span> {sheet.purpose}
        </p>
      </div>

      <table className="w-full border-collapse text-2xs">
        <thead>
          <tr>
            <th className="border border-slate-400 px-1.5 py-1 text-left">Office / Function</th>
            <th className="border border-slate-400 px-1.5 py-1 text-left">FPP</th>
            <th className="border border-slate-400 px-1.5 py-1 text-left">Object</th>
            <th
              className="border border-slate-400 px-1.5 py-1 text-right"
              style={{ width: '6.5rem' }}
            >
              Amount Released
            </th>
            <th
              className="border border-slate-400 px-1.5 py-1 text-right"
              style={{ width: '6.5rem' }}
            >
              For Later Release
            </th>
          </tr>
        </thead>
        <tbody>
          {sheet.lines.map((l) => (
            <tr key={l.key}>
              <td className="border border-slate-400 px-1.5 py-1">{l.officeName}</td>
              <td className="border border-slate-400 px-1.5 py-1">
                {l.fppCode} {l.fppName}
              </td>
              <td className="border border-slate-400 px-1.5 py-1">
                {l.accountCode ? `${l.accountCode} ${l.accountName}` : '-'}
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(l.released, false)}
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(l.held, false)}
              </td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border border-slate-400 px-1.5 py-1" colSpan={3}>
              Total
            </td>
            <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
              {formatAmount(released, false)}
            </td>
            <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
              {formatAmount(held, false)}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="mt-2 text-2xs">
        Amount released: <strong>{amountInWords(released)}</strong>
      </p>

      <p className="mt-3 text-2xs leading-relaxed">
        The allotment released hereunder is chargeable against the appropriation authorised under
        the Annual Budget for Fiscal Year {sheet.fiscalYear} and may be obligated solely for the
        purpose stated above. The amount shown in the &ldquo;For Later Release&rdquo; column is
        withheld and shall not be obligated until it is covered by a subsequent Allotment Release
        Order.
      </p>

      <div className="mt-8 grid grid-cols-2 gap-10">
        <SignatureLine label="Recommended by" role="Municipal Budget Officer" />
        <SignatureLine label="Approved by" role="Municipal Mayor" />
      </div>

      {sheet.prepared && sheet.preparedBy && (
        <p className="mt-6 text-[9px] text-slate-500">Prepared in CFMS by {sheet.preparedBy}.</p>
      )}
    </div>
  );
}
