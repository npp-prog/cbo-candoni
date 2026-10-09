import { ReportHeading } from '@/components/ReportShell';
import type { ReportMeta } from '@/lib/export';
import { formatAmount } from '@/lib/money';
import type { FundingSourceRow, FundingSourcesSheet } from './fundingSources';

/**
 * LBP Form No. 8 on paper. Patch 129 - one component for both places it is
 * printed from: the Supplemental Sources tab (the year) and a supplemental
 * ordinance's own page (that ordinance's sources). Print-only: drawn when the
 * page prints, never on screen. The page supplies <ReportPrintStyle />.
 */
export function LbpForm8Sheet({ sheet, meta }: { sheet: FundingSourcesSheet; meta: ReportMeta }) {
  const cell = 'border border-slate-400 px-2 py-1.5';
  const head = `${cell} bg-slate-50 text-center font-semibold`;
  return (
    <div className="print-only">
      <div className="cbo-report-sheet">
        <p className="mb-2 text-xs font-semibold">LBP Form No. 8</p>
        <ReportHeading meta={meta} seal />

        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className={head}>Particulars</th>
              <th className={head} style={{ width: '16rem' }}>
                Account Classification
              </th>
              <th className={head} style={{ width: '10rem' }}>
                Amounts
              </th>
            </tr>
            <tr>
              <th className={`${cell} text-center font-normal`}>(1)</th>
              <th className={`${cell} text-center font-normal`}>(2)</th>
              <th className={`${cell} text-center font-normal`}>(3)</th>
            </tr>
          </thead>
          <tbody>
            <Section label="1.0 New Revenue Sources" amount={sheet.totalNewRevenue} />
            <Rows rows={sheet.newRevenue} />
            <Section
              label="2.0 Actual Collection in Excess of the Estimated Income"
              amount={sheet.totalExcess}
            />
            <Rows rows={sheet.excess} />
            <Section label="3.0 Savings" amount={sheet.totalSavings} />
            <Rows rows={sheet.savings} />
            <Section label="4.0 Realignment" amount={sheet.totalRealignment} />
            <Rows rows={sheet.realignment} particulars="Appropriation realigned from" />
            <tr className="font-bold">
              <td className={cell} colSpan={2}>
                TOTAL
              </td>
              <td className={`${cell} cbo-amount text-right`}>
                {formatAmount(sheet.total, false)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="mt-8">
          <p className="text-xs font-semibold">Certified Correct by:</p>
          <div className="mt-2 grid grid-cols-2 gap-10">
            <Signature position="Local Treasurer" />
            <Signature position="Local Accountant" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ label, amount }: { label: string; amount?: number }) {
  return (
    <tr className="font-semibold">
      <td className="border border-slate-400 px-2 py-1.5">{label}</td>
      <td className="border border-slate-400 px-2 py-1.5" />
      <td className="border border-slate-400 px-2 py-1.5 cbo-amount text-right">
        {amount !== undefined && amount > 0 ? formatAmount(amount, false) : ''}
      </td>
    </tr>
  );
}

function Rows({ rows, particulars }: { rows: FundingSourceRow[]; particulars?: string }) {
  if (rows.length === 0) return <Blank />;
  return (
    <>
      {rows.map((r, i) => (
        <tr key={`${r.accountCode}-${r.classification}-${i}`}>
          <td className="border border-slate-400 px-2 py-1.5 pl-6 text-slate-600">
            {r.particulars ?? particulars ?? ''}
          </td>
          <td className="border border-slate-400 px-2 py-1.5">{r.classification}</td>
          <td className="border border-slate-400 px-2 py-1.5 cbo-amount text-right">
            {formatAmount(r.amount, false)}
          </td>
        </tr>
      ))}
    </>
  );
}

function Blank({ label }: { label?: string }) {
  return (
    <tr>
      <td className="border border-slate-400 px-2 py-1.5 pl-6 text-slate-600">{label ?? ' '}</td>
      <td className="border border-slate-400 px-2 py-1.5" />
      <td className="border border-slate-400 px-2 py-1.5" />
    </tr>
  );
}

function Signature({ position }: { position: string }) {
  return (
    <div>
      <div className="mt-8 border-t border-black pt-0.5">
        <p className="text-xs">{position}</p>
      </div>
    </div>
  );
}
