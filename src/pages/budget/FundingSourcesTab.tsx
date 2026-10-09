import { useMemo, useState } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { ReportHeading } from '@/components/ReportShell';
import { ReportPrintStyle } from '@/components/print/ReportPrintStyle';
import { useAppropriations, useFundingSources } from '@/data/queries';
import { useAuth } from '@/auth/AuthProvider';
import type { FundingSource } from '@/types/budget';
import { FundingSourceDialog, FundingSourceList } from './FundingSourceDialog';
import { formatAmount } from '@/lib/money';
import { printReport } from '@/lib/export';
import { fundLabel } from './Obligations';
import { buildFundingSources, type FundingSourceRow } from './fundingSources';

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
  const sources = useFundingSources(fiscalYear, fundCode);
  const sheet = useMemo(
    () => buildFundingSources(appropriations.data, sources.data),
    [appropriations.data, sources.data],
  );
  const { hasRole } = useAuth();
  const canEncode = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER', 'BUDGET_STAFF', 'MUNICIPAL_TREASURER', 'MUNICIPAL_ACCOUNTANT');
  const [editing, setEditing] = useState<FundingSource | 'new' | null>(null);
  const supplementalSources = sources.data.filter((x) => x.section !== 'CONTINUING');
  const continuing = sources.data.filter((x) => x.section === 'CONTINUING');

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
          LBP Form No. 8, Budget Operations Manual for LGUs 2023, page 70. 1.0 and 2.0 are the
          sources encoded below or inside a supplemental ordinance - a supplemental budget cannot be
          approved without them. 3.0 is what augmentations took as savings, and 4.0 what
          realignments took, both from the books.
        </p>
        <div className="flex shrink-0 gap-2">
          {canEncode && (
            <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
              Encode a source
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => printReport(meta)}>
            Print
          </Button>
        </div>
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
            <Section label="1.0 New Revenue Sources" amount={sheet.totalNewRevenue} />
            <Rows rows={sheet.newRevenue} />
            <Section label="2.0 Actual Collection in Excess of the Estimated Income" amount={sheet.totalExcess} />
            <Rows rows={sheet.excess} />
            <Section label="3.0 Savings" amount={sheet.totalSavings} />
            <Rows rows={sheet.savings} particulars="Savings from" />
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
      </Card>

      <Card title="Encoded sources - 1.0 and 2.0" className="mt-4 no-print" bodyClassName="p-0">
        <FundingSourceList
          sources={supplementalSources}
          canEdit={canEncode}
          onEdit={setEditing}
          empty="Nothing encoded. A supplemental budget cannot be approved until its sources are here or in the ordinance itself."
        />
      </Card>

      <Card
        title="Continuing"
        subtitle="Last year's authority carried into this one. A continuing appropriation cannot be approved without it. Not part of LBP Form No. 8."
        className="mt-4 no-print"
        bodyClassName="p-0"
      >
        <FundingSourceList
          sources={continuing}
          canEdit={canEncode}
          onEdit={setEditing}
          empty="No continuing source encoded."
        />
      </Card>

      {sheet.total === 0 && (
        <Alert tone="info" className="mt-4 no-print">
          Nothing to show for {fiscalYear} in this fund yet. Encode a source above, or post a
          realignment or augmentation - what it takes away appears under 4.0 or 3.0.
        </Alert>
      )}

      {editing && (
        <FundingSourceDialog
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          act={null}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
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

function Rows({ rows, particulars }: { rows: FundingSourceRow[]; particulars?: string }) {
  if (rows.length === 0) return <Blank />;
  return (
    <>
      {rows.map((r, i) => (
        <tr key={`${r.accountCode}-${r.classification}-${i}`}>
          <td className="border border-slate-400 px-2 py-1.5 pl-6 text-slate-600">
            {r.particulars ?? particulars ?? ''}
          </td>
          <td className="border border-slate-400 px-2 py-1.5">{r.particulars ? (r.accountCode ? r.classification : '') : r.classification}</td>
          <td className="border border-slate-400 px-2 py-1.5 cbo-amount text-right">{formatAmount(r.amount, false)}</td>
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
