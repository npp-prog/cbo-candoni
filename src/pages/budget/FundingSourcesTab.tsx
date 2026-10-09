import { useMemo } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { ReportHeading } from '@/components/ReportShell';
import { ReportPrintStyle } from '@/components/print/ReportPrintStyle';
import { useAppropriations } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { printReport } from '@/lib/export';
import { fundLabel } from './Obligations';
import { buildFundingSources } from './fundingSources';

/**
 * The Funding Sources tab of Sources of Financing: LBP Form No. 8. Patch 119.
 *
 * Printed on A4 portrait, fitted to width, with the seal at the left of the
 * heading - as the other budget reports are since patch 117. The rest of the
 * page steps aside while it prints, so the form comes out alone.
 */
export function FundingSourcesTab({
  fiscalYear,
  fundCode,
}: {
  fiscalYear: number;
  fundCode: string;
}) {
  const appropriations = useAppropriations(fiscalYear, fundCode);
  const sheet = useMemo(() => buildFundingSources(appropriations.data), [appropriations.data]);

  const meta = {
    title: 'Statement of Funding Sources (Supplemental Budget)',
    fundLabel: fundLabel(fundCode),
    periodLabel: `FY ${fiscalYear}`,
  };

  const cell = 'border border-slate-400 px-2 py-1.5';
  const head = `${cell} bg-slate-50 text-center font-semibold`;

  return (
    <>
      <ReportPrintStyle orientation="portrait" />
      <div className="mt-4 flex items-center justify-between gap-3 no-print">
        <p className="text-xs text-slate-600">
          LBP Form No. 8, Budget Operations Manual for LGUs 2023, page 70. Section 4.0 is filled
          from the realignments posted this year - the appropriation TAKEN AWAY by each. The new
          realigned budget is on the Appropriation Ledger and on LBP Form No. 2.
        </p>
        <Button size="sm" variant="primary" onClick={() => printReport(meta)}>
          Print
        </Button>
      </div>

      <Card className="mt-3 cbo-report-sheet print:border-0 print:px-0 print:py-0">
        <p className="mb-2 text-xs font-semibold no-print-keep">LBP Form No. 8</p>
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
            <Section label="1.0 New Revenue Sources" />
            <Blank label="Tax Revenue" />
            <Blank label="Loan Proceeds (Borrowings)" />
            <Section label="2.0 Actual Collection in Excess of the Estimated Income" />
            <Blank />
            <Section label="3.0 Savings" />
            <Blank />
            <Section label="4.0 Realignment" amount={sheet.totalRealignment} />
            {sheet.realignment.length === 0 ? (
              <Blank />
            ) : (
              sheet.realignment.map((r) => (
                <tr key={r.accountCode || r.classification}>
                  <td className={`${cell} pl-6 text-slate-600`}>Appropriation realigned from</td>
                  <td className={cell}>{r.classification}</td>
                  <td className={`${cell} cbo-amount text-right`}>
                    {formatAmount(r.amount, false)}
                  </td>
                </tr>
              ))
            )}
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

        <p className="mt-3 text-2xs text-slate-500">
          Sections 1.0 to 3.0 are certified by the Treasurer and the Accountant from the
          supplemental budget&rsquo;s own funding, which the books do not record; they are left to
          be filled in by hand. Section 4.0 and the total are from the books.
        </p>

        <div className="mt-8">
          <p className="text-xs font-semibold">Certified Correct by:</p>
          <div className="mt-2 grid grid-cols-2 gap-10">
            <Signature position="Local Treasurer" />
            <Signature position="Local Accountant" />
          </div>
        </div>
      </Card>

      {sheet.realignment.length === 0 && (
        <Alert tone="info" className="mt-4 no-print">
          No realignment has been posted for {fiscalYear} in this fund, so section 4.0 is empty. A
          realignment is recorded and approved on the Appropriation screen; what it takes away
          appears here once it is posted.
        </Alert>
      )}
    </>
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
