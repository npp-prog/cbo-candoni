import { createPortal } from 'react-dom';
import { Seal } from '@/components/ui/Seal';
import { ReportPrintStyle } from '@/components/print/ReportPrintStyle';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { Brs } from '@/lib/brs';
import type { BrsHeader } from '@/lib/brsXlsx';

/**
 * Patch 163 - the Bank Reconciliation Statement on paper, in the office's
 * format: the statement on the first page (A4 portrait, seal at the top),
 * the schedules from the second.
 *
 * Put at the top of <body> (a portal) and, while printing, everything else on
 * the screen is left off the paper - the statement tabs, the imported lines
 * and the controls are not part of the BRS.
 */

/** "Land Bank of the Philippines" -> "LBP"; a short name is kept as it is. */
export function bankShortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return name.trim();
  return words
    .filter((w) => !/^(of|the|and|&)$/i.test(w))
    .map((w) => w[0].toUpperCase())
    .join('');
}

const fig = (v: number) =>
  v === 0
    ? '-'
    : v < 0
      ? `(${formatPeso(-v, { symbol: false })})`
      : formatPeso(v, { symbol: false });

const TH = 'border border-slate-600 bg-slate-100 px-2 py-1 text-center font-semibold';
const TD = 'border border-slate-600 px-2 py-1 align-top';
const NUM = `${TD} text-right tabular-nums whitespace-nowrap`;

function Heading({ title, brs }: { title: string; brs: Brs }) {
  return (
    <header className="mb-4 text-center">
      <Seal className="mx-auto mb-1 h-20 w-20" />
      <p className="font-semibold uppercase">Municipal Government of Candoni</p>
      <p className="mt-1 text-sm font-bold uppercase">{title}</p>
      <p>For the Month of {brs.monthLabel}</p>
    </header>
  );
}

export function BrsPrintSheet({ brs, header }: { brs: Brs; header: BrsHeader }) {
  const only = `
@media print {
  body > *:not(.cbo-brs-print) { display: none !important; }
  body > .cbo-brs-print { display: block !important; }
  .cbo-brs-print .cbo-brs-page + .cbo-brs-page { break-before: page; page-break-before: always; }
}`;

  const sheet = (
    <div className="cbo-brs-print hidden">
      <style>{only}</style>
      <ReportPrintStyle orientation="portrait" />

      <div className="cbo-report-sheet cbo-brs-page text-xs text-navy-900">
        <Heading title="Bank Reconciliation Statement" brs={brs} />

        <table className="mb-3 w-full">
          <tbody>
            <tr>
              <td className="w-24 py-0.5">Bank Name:</td>
              <td className="py-0.5 font-semibold">{header.bankName}</td>
              <td className="w-24 py-0.5">Fund:</td>
              <td className="py-0.5 font-semibold">{header.fundLabel}</td>
            </tr>
            <tr>
              <td className="py-0.5">Branch:</td>
              <td className="py-0.5 font-semibold">{header.branch}</td>
              <td className="py-0.5">Account No.:</td>
              <td className="py-0.5 font-semibold">{header.accountNumber}</td>
            </tr>
          </tbody>
        </table>

        <table className="w-full border-collapse">
          <colgroup>
            <col style={{ width: '44%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '22%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className={TH}>Particular</th>
              <th className={TH}>Book</th>
              <th className={TH}>Bank</th>
              <th className={TH}>Explanatory Note</th>
            </tr>
          </thead>
          <tbody>
            <tr className="font-semibold">
              <td className={TD}>Unadjusted Balances</td>
              <td className={NUM}>{fig(brs.bookBalance)}</td>
              <td className={NUM}>{fig(brs.bankBalance)}</td>
              <td className={TD} />
            </tr>
            <tr>
              <td className={TD}>Reconciling Items:</td>
              <td className={TD} />
              <td className={TD} />
              <td className={TD} />
            </tr>
            {brs.lines.map((l) => (
              <tr key={l.key}>
                <td className={`${TD} pl-6`}>{l.label}</td>
                <td className={NUM}>{l.column === 'BOOK' ? fig(l.amount) : ''}</td>
                <td className={NUM}>{l.column === 'BANK' ? fig(l.amount) : ''}</td>
                <td className={TD}>{l.note}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td className={TD}>Adjusted Balances</td>
              <td className={NUM} style={{ borderBottom: '3px double #1e293b' }}>
                {fig(brs.adjustedBook)}
              </td>
              <td className={NUM} style={{ borderBottom: '3px double #1e293b' }}>
                {fig(brs.adjustedBank)}
              </td>
              <td className={TD} />
            </tr>
          </tbody>
        </table>

        <div className="mt-16 grid grid-cols-2 gap-16">
          {[
            { label: 'Prepared by:', who: header.preparedBy },
            { label: 'Certified Correct:', who: header.certifiedBy },
          ].map((s) => (
            <div key={s.label}>
              <p>{s.label}</p>
              <p className="mt-10 border-t border-navy-900 pt-1 text-center font-semibold uppercase">
                {s.who.name}
              </p>
              <p className="text-center">{s.who.position}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="cbo-report-sheet cbo-brs-page text-xs text-navy-900">
        <Heading title="Schedules of Reconciling Items" brs={brs} />
        <p className="mb-3 text-center">
          {header.bankName} - Account No. {header.accountNumber} - {header.fundLabel}
        </p>
        {brs.lines.map((l, i) => (
          <section key={l.key} className="mb-4 break-inside-avoid">
            <p className="mb-1 font-semibold">
              {i + 1}. {l.label} ({l.column === 'BOOK' ? 'Book' : 'Bank'})
            </p>
            <table className="w-full border-collapse">
              <colgroup>
                <col style={{ width: '12%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '33%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '25%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className={TH}>Date</th>
                  <th className={TH}>Reference No</th>
                  <th className={TH}>Name</th>
                  <th className={TH}>Amount</th>
                  <th className={TH}>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {l.items.length === 0 && (
                  <tr>
                    <td className={TD} colSpan={5}>
                      None
                    </td>
                  </tr>
                )}
                {l.items.map((it, k) => (
                  <tr key={`${it.ref}-${k}`}>
                    <td className={TD}>{formatShortDate(it.date)}</td>
                    <td className={TD}>{it.ref}</td>
                    <td className={TD}>{it.name}</td>
                    <td className={NUM}>{fig(it.amount)}</td>
                    <td className={TD}>{it.remarks}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={`${TD} text-right`} colSpan={3}>
                    Subtotal
                  </td>
                  <td className={NUM}>{fig(l.amount)}</td>
                  <td className={TD} />
                </tr>
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}
