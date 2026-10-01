import { useEffect, useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { ReportShell } from '@/components/ReportShell';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { Alert, Card, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { useFilters } from '@/context/FilterContext';
import { useBudgetBalances, useEstimatedReceipts, useRcds } from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { SECTORS } from '@/lib/sectors';
import {
  ACTUAL_BASIS_LABELS,
  ACTUAL_BASIS_NOTES,
  SCBAA_SECTORS,
  autoMatchSector,
  type ActualBasis,
} from '@/lib/scbaaLines';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import {
  buildScbaaExpenditure,
  buildScbaaRevenue,
  type ScbaaFigures,
  type ScbaaRevenueRow,
} from './scbaaReport';
import { COMPARISON_TABS } from './comparisonTabs';
import { fundLabel } from '../budget/Obligations';
import { COLLECTED } from '../budget/reairrReport';

/**
 * Statement of Comparison of Budget and Actual Amounts - GAM Annex 8.
 *
 * Five columns, no comparative year. Section 370 is explicit that this
 * statement "shall not be presented in comparison with the previous year
 * figures", which makes it the only one of the six that is not.
 */

interface ScbaaSettings {
  /** Municipal sector name to Annex 8 line. */
  sectorMapping?: Record<string, string>;
  actualBasis?: ActualBasis;
}

export default function Scbaa() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const balances = useBudgetBalances(fiscalYear, fundCode);
  const estimates = useEstimatedReceipts(fiscalYear, fundCode);
  const rcds = useRcds(fiscalYear, fundCode);

  const stored = useDocument<ScbaaSettings>(COL.settings, 'scbaa');
  const [form, setForm] = useState<ScbaaSettings>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (stored.loading || dirty) return;
    setForm(stored.data ?? {});
  }, [stored.data, stored.loading, dirty]);

  const canEdit = hasRole(
    'SUPER_ADMIN',
    'MUNICIPAL_ACCOUNTANT',
    'MUNICIPAL_TREASURER',
    'BUDGET_OFFICER',
  );

  const basis: ActualBasis = form.actualBasis ?? 'OBLIGATIONS';

  /**
   * Actual collections, from the reports the Treasury submitted.
   *
   * The same rule the Registry of Estimated and Actual Income uses, and the
   * same reason: a draft report is a working paper and a cancelled one
   * collected nothing.
   */
  const actuals = useMemo(() => {
    const out: Array<{ accountCode: string; amount: Centavos }> = [];
    for (const r of rcds.data) {
      if (!COLLECTED.has(r.status)) continue;
      for (const a of r.accountSummary ?? []) {
        out.push({ accountCode: a.accountCode, amount: a.amount });
      }
    }
    return out;
  }, [rcds.data]);

  const revenue = useMemo(
    () => buildScbaaRevenue({ estimates: estimates.data, actuals }),
    [estimates.data, actuals],
  );

  const expenditure = useMemo(
    () =>
      buildScbaaExpenditure({
        lines: balances.data,
        basis,
        sectorMapping: form.sectorMapping,
      }),
    [balances.data, basis, form.sectorMapping],
  );

  /** The ordinance's own sectors that no annex line takes without help. */
  const needMapping = useMemo(
    () => SECTORS.map((s) => s.name).filter((n) => autoMatchSector(n) === null),
    [],
  );

  const save = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, COL.settings, 'scbaa'), form, { merge: true });
      toast.success('Saved', 'The statement will use these from now on.');
      setDirty(false);
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const loading = balances.loading || estimates.loading || rcds.loading;

  const exportRows = [
    ...revenue.rows
      .filter((r) => !r.line.heading)
      .map((r) => ({ half: 'Revenue', label: r.line.label, f: r.figures })),
    ...expenditure.blocks.flatMap((b) =>
      b.rows.map((r) => ({ half: `Expenditure - ${b.sector}`, label: r.classLabel, f: r.figures })),
    ),
  ];

  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: 'half', header: 'Section', value: (r) => r.half },
    { key: 'label', header: 'Particulars', value: (r) => r.label },
    { key: 'orig', header: 'Original Budget', kind: 'amount', value: (r) => r.f.original },
    { key: 'final', header: 'Final Budget', kind: 'amount', value: (r) => r.f.final },
    {
      key: 'd1',
      header: 'Difference Original and Final Budget',
      kind: 'amount',
      value: (r) => r.f.differenceOriginalFinal,
    },
    { key: 'actual', header: 'Actual Amounts', kind: 'amount', value: (r) => r.f.actual },
    {
      key: 'd2',
      header: 'Difference Final Budget and Actual',
      kind: 'amount',
      value: (r) => r.f.differenceFinalActual,
    },
  ];

  return (
    <ReportShell
      meta={{
        title: 'Statement of Comparison of Budget and Actual Amounts',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the Year Ended December 31, ${fiscalYear}`,
        preparedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Budget and Actual' }]}
      tabs={<SectionTabs tabs={COMPARISON_TABS} />}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={
        <Field label="Actual amounts are" className="w-64">
          <Select
            value={basis}
            disabled={!canEdit}
            onChange={(e) => {
              setForm((f) => ({ ...f, actualBasis: e.target.value as ActualBasis }));
              setDirty(true);
            }}
          >
            {(Object.keys(ACTUAL_BASIS_LABELS) as ActualBasis[]).map((b) => (
              <option key={b} value={b}>
                {ACTUAL_BASIS_LABELS[b]}
              </option>
            ))}
          </Select>
        </Field>
      }
      actions={
        dirty ? (
          <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
            Save the choices
          </Button>
        ) : undefined
      }
      footnote={
        <>
          <p>
            GAM for Local Government Units, Annex 8. Section 370: this statement exists because the
            financial statements and the budget are not on the same accounting basis, and it is the
            one statement that carries no comparative year.
          </p>
          <p className="mt-1">
            Original budget is the initial appropriation plus the continuing appropriations carried
            from previous years (Section 371). Final budget is that adjusted for supplemental
            budgets, realignments and reversions (Section 372).{' '}
            <strong>Actual amounts are {ACTUAL_BASIS_LABELS[basis].toLowerCase()}</strong> —{' '}
            {ACTUAL_BASIS_NOTES[basis]}
          </p>
          {revenue.originalEqualsFinal && (
            <p className="mt-1">
              On the revenue half the original and final columns carry the same figure. CBO holds
              one estimate per income account and no record of which ordinance set it, so it cannot
              separate an annual budget from a supplemental. That is a limitation of the records,
              not a statement that none was enacted.
            </p>
          )}
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : (
        <>
          <Decisions
            needMapping={needMapping}
            mapping={form.sectorMapping ?? {}}
            unmatched={expenditure.unmatchedSectors}
            canEdit={canEdit}
            onChange={(sector, line) => {
              setForm((f) => ({
                ...f,
                sectorMapping: { ...(f.sectorMapping ?? {}), [sector]: line },
              }));
              setDirty(true);
            }}
          />

          {revenue.unmapped.length > 0 && (
            <Alert
              tone="error"
              title={`${revenue.unmapped.length} income account could not be placed`}
              className="mb-4"
            >
              <p className="mb-2">
                These carry an estimate or a collection and appear under no line of the annex, so
                the revenue half below is incomplete.
              </p>
              <ul className="space-y-1 font-mono text-xs">
                {revenue.unmapped.map((u) => (
                  <li key={u.accountCode}>
                    {u.accountCode} {u.accountName} — {formatPeso(u.actual)}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          <table className="w-full text-sm">
            <Head />
            <tbody>
              <SectionRow label="Revenue" />
              {revenue.rows.map((r) => (
                <RevenueRow key={r.line.label} row={r} />
              ))}
              <FiguresRow label="Total Revenues and Receipts" f={revenue.total} emphasis rule />

              <SectionRow label="Expenditures" />
              {expenditure.blocks.map((b) => (
                <tr key={b.sector} className="contents">
                  <SectorBlock sector={b.sector} rows={b.rows} total={b.total} />
                </tr>
              ))}
              <FiguresRow label="Total" f={expenditure.total} emphasis rule />
            </tbody>
          </table>
        </>
      )}
    </ReportShell>
  );
}

function Head() {
  return (
    <thead>
      <tr className="border-b border-slate-300 text-slate-600">
        <th className="cbo-th text-left">Particulars</th>
        <th className="cbo-th text-right" style={{ width: '9rem' }}>
          Original Budget
        </th>
        <th className="cbo-th text-right" style={{ width: '9rem' }}>
          Final Budget
        </th>
        <th className="cbo-th text-right" style={{ width: '9rem' }}>
          Difference Original and Final Budget
        </th>
        <th className="cbo-th text-right" style={{ width: '9rem' }}>
          Actual Amounts
        </th>
        <th className="cbo-th text-right" style={{ width: '9rem' }}>
          Difference Final Budget and Actual
        </th>
      </tr>
    </thead>
  );
}

function SectionRow({ label }: { label: string }) {
  return (
    <tr className="border-t border-slate-300 font-semibold text-navy-900">
      <td className="cbo-td" colSpan={6}>
        {label}
      </td>
    </tr>
  );
}

function FiguresRow({
  label,
  f,
  indent = 0,
  emphasis,
  rule,
  muted,
}: {
  label: string;
  f: ScbaaFigures;
  indent?: number;
  emphasis?: boolean;
  rule?: boolean;
  muted?: string;
}) {
  return (
    <tr
      className={`${rule ? 'border-t border-slate-300' : 'border-b border-slate-100'} ${
        emphasis ? 'font-semibold text-navy-900' : 'text-slate-700'
      }`}
    >
      <td className="cbo-td" style={{ paddingLeft: `${0.5 + indent * 1.25}rem` }}>
        {label}
        {muted && <span className="ml-2 text-2xs text-slate-400">{muted}</span>}
      </td>
      <td className="cbo-td cbo-amount">{formatPeso(f.original)}</td>
      <td className="cbo-td cbo-amount">{formatPeso(f.final)}</td>
      <td className="cbo-td cbo-amount text-slate-500">
        {formatPeso(f.differenceOriginalFinal)}
      </td>
      <td className="cbo-td cbo-amount">{formatPeso(f.actual)}</td>
      <td className="cbo-td cbo-amount text-slate-500">{formatPeso(f.differenceFinalActual)}</td>
    </tr>
  );
}

function RevenueRow({ row }: { row: ScbaaRevenueRow }) {
  if (row.line.heading) {
    return (
      <tr className="border-b border-slate-100 text-slate-700">
        <td className="cbo-td" style={{ paddingLeft: `${0.5 + row.line.level * 1.25}rem` }}>
          {row.line.label}
        </td>
        <td className="cbo-td" colSpan={5} />
      </tr>
    );
  }
  return (
    <FiguresRow
      label={row.line.label}
      f={row.figures}
      indent={row.line.level}
      emphasis={!!row.line.totalOf}
      rule={!!row.line.totalOf}
      // Printed because the annex prints it, with the reason it is empty.
      muted={row.line.notInChart}
    />
  );
}

function SectorBlock({
  sector,
  rows,
  total,
}: {
  sector: string;
  rows: Array<{ classKey: string; classLabel: string; onAnnex: boolean; figures: ScbaaFigures }>;
  total: ScbaaFigures;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 font-medium text-navy-800">
        <td className="cbo-td" colSpan={6}>
          {sector}
        </td>
      </tr>
      {rows.map((r) => (
        <FiguresRow
          key={r.classKey}
          label={r.classLabel}
          f={r.figures}
          indent={1}
          // Annex 8 prints three expense classes and has no Financial Expenses
          // line. It is carried so the total foots, and marked so nobody thinks
          // the annex asked for it.
          muted={r.onAnnex ? undefined : 'not on Annex 8'}
        />
      ))}
      <FiguresRow label={`Total ${sector}`} f={total} indent={1} rule />
    </>
  );
}

/**
 * The two decisions this statement cannot make for itself.
 *
 * Above the statement, not below it, and shown whenever a sector is still
 * unplaced: an unmapped sector is money missing from the expenditure half, and
 * the half still totals without it.
 */
function Decisions({
  needMapping,
  mapping,
  unmatched,
  canEdit,
  onChange,
}: {
  needMapping: string[];
  mapping: Record<string, string>;
  unmatched: Array<{ sector: string; amount: Centavos }>;
  canEdit: boolean;
  onChange: (sector: string, line: string) => void;
}) {
  const outstanding = unmatched.filter((u) => u.sector !== '(no sector recorded)');
  const noSector = unmatched.find((u) => u.sector === '(no sector recorded)');

  if (needMapping.length === 0 && unmatched.length === 0) return null;

  return (
    <Card
      title="Which Annex 8 line each sector belongs on"
      subtitle="Nominated, because the annex prints the national list and the ordinance does not use it."
      className="mb-5 no-print"
    >
      {outstanding.length > 0 && (
        <Alert tone="error" title="An appropriation is not on the statement" className="mb-3">
          {outstanding.map((u) => (
            <p key={u.sector}>
              {u.sector} — {formatPeso(u.amount)} appropriated, on no line of the annex.
            </p>
          ))}
          <p className="mt-2">
            Nothing is swept into &ldquo;Others&rdquo; on its own: that would understate whichever
            service the ordinance actually funds, and the total below would still foot.
          </p>
        </Alert>
      )}

      {noSector && (
        <Alert tone="warning" title="A budget line carries no sector" className="mb-3">
          {formatPeso(noSector.amount)} is appropriated against lines with no sector recorded. Set
          the sector on those lines under Budget transactions &rarr; Appropriation.
        </Alert>
      )}

      <div className="space-y-3">
        {needMapping.map((sector) => (
          <Field key={sector} label={sector}>
            <Select
              value={mapping[sector] ?? ''}
              disabled={!canEdit}
              onChange={(e) => onChange(sector, e.target.value)}
            >
              <option value="">Not yet decided</option>
              {SCBAA_SECTORS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Eight of the eleven annex lines match the ordinance by name and are taken automatically.
        These are the ones that do not: Annex 8 has no line for them, and where they belong is a
        question about what they fund rather than about their names.
      </p>
    </Card>
  );
}
