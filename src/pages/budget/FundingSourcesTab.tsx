import { useMemo, useState } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { ReportHeading } from '@/components/ReportShell';
import { ReportPrintStyle } from '@/components/print/ReportPrintStyle';
import { useAppropriations, useFundingSources } from '@/data/queries';
import { useAuth } from '@/auth/AuthProvider';
import { engine } from '@/lib/engine';
import type { FundingSource } from '@/types/budget';
import { FundingSourceDialog, FundingSourceList } from './FundingSourceDialog';
import { formatAmount, formatPeso } from '@/lib/money';
import { printReport } from '@/lib/export';
import { sectionLabel } from '@/lib/budgetActs';
import { fundLabel } from './Obligations';
import {
  buildFundingSources,
  buildSourceRegister,
  type FundingSourceRow,
  type RegisterRow,
} from './fundingSources';

const ENCODERS = [
  'SUPER_ADMIN',
  'BUDGET_OFFICER',
  'BUDGET_STAFF',
  'MUNICIPAL_TREASURER',
  'MUNICIPAL_ACCOUNTANT',
] as const;

/**
 * Sources of Financing > Supplemental Sources. Patch 119, redrawn in 126.
 *
 * On screen, the REGISTER: every source of the year's supplemental budgets,
 * one row each - 1.0, 2.0 and 3.0 as encoded (here or inside an ordinance),
 * 4.0 from each realignment posted - with where it came from and, for an
 * encoded one, Correct and Remove.
 *
 * On paper, LBP Form No. 8: "Print LBP Form No. 8" prints the form from the
 * same figures, A4 portrait, seal at the left of the heading. The form is not
 * drawn on screen. Neil: "The register will appear, not the form; there is a
 * print button where the form is printed."
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
  const register = useMemo(
    () => buildSourceRegister(appropriations.data, sources.data),
    [appropriations.data, sources.data],
  );
  const { hasRole } = useAuth();
  const toast = useToast();
  const canEncode = hasRole(...ENCODERS);
  const [editing, setEditing] = useState<FundingSource | 'new' | null>(null);
  const [removing, setRemoving] = useState<RegisterRow | null>(null);
  const [busy, setBusy] = useState(false);

  const meta = {
    title: 'Statement of Funding Sources (Supplemental Budget)',
    fundLabel: fundLabel(fundCode),
    periodLabel: `FY ${fiscalYear}`,
  };

  const remove = async () => {
    if (!removing?.sourceId) return;
    setBusy(true);
    try {
      await engine.saveFundingSource({ id: removing.sourceId, remove: true });
      toast.success('Source removed');
      setRemoving(null);
    } catch (err) {
      toast.error('Not removed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cell = 'border border-slate-400 px-2 py-1.5';
  const head = `${cell} bg-slate-50 text-center font-semibold`;
  const totals: Array<[string, number]> = [
    ['1.0 New Revenue', sheet.totalNewRevenue],
    ['2.0 Excess Collection', sheet.totalExcess],
    ['3.0 Savings', sheet.totalSavings],
    ['4.0 Realignment', sheet.totalRealignment],
  ];

  return (
    <>
      <ReportPrintStyle orientation="portrait" />

      <div className="no-print">
        <div className="mt-4 flex items-start justify-between gap-3">
          <p className="text-xs text-slate-600">
            What finances the supplemental budgets of {fiscalYear}. 1.0, 2.0 and 3.0 are encoded -
            here, or inside the supplemental ordinance - and a supplemental budget cannot be
            approved until they cover it. 4.0 is what each realignment took, from the books. An
            augmentation by the Local Chief Executive is not part of the supplemental budget and is
            not listed.
          </p>
          <div className="flex shrink-0 gap-2">
            {canEncode && (
              <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
                Encode a source
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={() => printReport(meta)}
              disabled={register.length === 0}
            >
              Print LBP Form No. 8
            </Button>
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-5">
          {totals.map(([label, amount]) => (
            <div key={label} className="cbo-card px-4 py-3">
              <p className="text-2xs uppercase tracking-wider text-slate-500">{label}</p>
              <p className="mt-0.5 font-mono text-sm text-navy-900">{formatPeso(amount)}</p>
            </div>
          ))}
          <div className="cbo-card border-brand-200 bg-brand-50/40 px-4 py-3">
            <p className="text-2xs uppercase tracking-wider text-slate-500">Total</p>
            <p className="mt-0.5 font-mono text-sm font-semibold text-navy-900">
              {formatPeso(sheet.total)}
            </p>
          </div>
        </div>

        <Card title="Register of supplemental sources" className="mt-4" bodyClassName="p-0">
          {register.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              Nothing for {fiscalYear} in this fund yet. Encode a source, or post a realignment -
              what it takes away appears here under 4.0.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Particulars</th>
                    <th className="px-3 py-2 font-medium">Account classification</th>
                    <th className="px-3 py-2 font-medium">Encoded in</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="w-36 px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {register.map((r) => {
                    const src = r.sourceId
                      ? sources.data.find((x) => x.id === r.sourceId)
                      : undefined;
                    return (
                      <tr key={r.key}>
                        <td className="px-3 py-2">
                          {r.section === 'REALIGNMENT'
                            ? '4.0 Realignment'
                            : sectionLabel(r.section)}
                        </td>
                        <td className="px-3 py-2">{r.particulars}</td>
                        <td className="px-3 py-2">{r.classification}</td>
                        <td className="px-3 py-2 text-slate-600">
                          {r.encodedIn ?? 'Open - any supplemental budget'}
                          {r.section === 'REALIGNMENT' && (
                            <span className="block text-2xs text-slate-400">from the books</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatPeso(r.amount, { symbol: false })}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {canEncode && src && (
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="secondary" onClick={() => setEditing(src)}>
                                Correct
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setRemoving(r)}>
                                Remove
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-navy-800 bg-slate-50 font-semibold">
                    <td className="px-3 py-2" colSpan={4}>
                      Total - {register.length} source{register.length === 1 ? '' : 's'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {formatPeso(sheet.total, { symbol: false })}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* LBP Form No. 8 - on paper only. */}
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

      {editing && (
        <FundingSourceDialog
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          act={null}
          existing={editing === 'new' ? null : editing}
          sections={['NEW_REVENUE', 'EXCESS_COLLECTION', 'SAVINGS']}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
        loading={busy}
        title="Remove this source"
        confirmLabel="Remove"
        variant="danger"
        message={
          <p>
            {removing?.particulars} ({formatPeso(removing?.amount ?? 0)}) is removed. If a
            supplemental budget already approved needs it, the removal is refused and the ordinance
            is named.
          </p>
        }
      />
    </>
  );
}

/**
 * Sources of Financing > Continuing. Patch 126 - moved off the supplemental
 * tab, since a continuing appropriation is not part of a supplemental budget.
 */
export function ContinuingSourcesTab({
  fiscalYear,
  fundCode,
}: {
  fiscalYear: number;
  fundCode: string;
}) {
  const sources = useFundingSources(fiscalYear, fundCode);
  const { hasRole } = useAuth();
  const canEncode = hasRole(...ENCODERS);
  const [editing, setEditing] = useState<FundingSource | 'new' | null>(null);
  const continuing = sources.data.filter((x) => x.section === 'CONTINUING');
  return (
    <>
      <Card
        title="Continuing sources"
        subtitle="Last year's authority carried into this one. A continuing appropriation cannot be approved until these cover it."
        className="mt-4"
        bodyClassName="p-0"
        actions={
          canEncode && (
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              Encode a source
            </Button>
          )
        }
      >
        <FundingSourceList
          sources={continuing}
          canEdit={canEncode}
          onEdit={setEditing}
          empty="No continuing source encoded."
        />
      </Card>
      {continuing.length === 0 && (
        <Alert tone="info" className="mt-4">
          Encode the continuing appropriations carried from last year here, or inside the continuing
          appropriation itself under Appropriations &gt; Authorities.
        </Alert>
      )}
      {editing && (
        <FundingSourceDialog
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          act={null}
          existing={editing === 'new' ? null : editing}
          sections={['CONTINUING']}
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
