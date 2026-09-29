import { useMemo, useState } from 'react';
import { ReportShell, TotalRow } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useBudgetBalances } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { ExportColumn } from '@/lib/export';
import type { BudgetBalance } from '@/types/budget';
import { fundLabel } from './Obligations';

/**
 * The Registry of Appropriations, Allotments and Obligations.
 *
 * This is the budget module's canonical view: one row per budget line showing
 * the whole chain from appropriation through to the unpaid balance, with the
 * two control columns - available appropriation and available allotment -
 * shown as computed figures rather than as anything anyone types.
 *
 * Every figure here comes from `budgetBalances`, which only the Cloud
 * Functions write, and which a nightly job rebuilds from the underlying
 * appropriations, allotments and obligations to prove it has not drifted.
 */
export default function Registry() {
  const { fiscalYear, fundCode } = useFilters();
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [expenseClass, setExpenseClass] = useState<string>('');

  const { data, loading, error } = useBudgetBalances(fiscalYear, fundCode, officeId);

  const rows = useMemo(
    () =>
      data
        .filter((b) => !expenseClass || b.expenseClass === expenseClass)
        .filter(
          (b) =>
            b.appropriationRevised !== 0 || b.allotmentReleased !== 0 || b.obligated !== 0,
        )
        .sort(
          (a, b) =>
            a.officeName.localeCompare(b.officeName) ||
            (a.fppCode ?? '').localeCompare(b.fppCode ?? ''),
        ),
    [data, expenseClass],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          appropriation: acc.appropriation + r.appropriationRevised,
          allotment: acc.allotment + r.allotmentReleased,
          availableAppropriation: acc.availableAppropriation + r.availableAppropriation,
          obligated: acc.obligated + r.obligated,
          availableAllotment: acc.availableAllotment + r.availableAllotment,
          disbursed: acc.disbursed + r.disbursed,
          unpaid: acc.unpaid + r.unpaidObligations,
        }),
        {
          appropriation: 0,
          allotment: 0,
          availableAppropriation: 0,
          obligated: 0,
          availableAllotment: 0,
          disbursed: 0,
          unpaid: 0,
        },
      ),
    [rows],
  );

  const overspent = rows.filter((r) => r.availableAllotment < 0);
  const overReleased = rows.filter((r) => r.availableAppropriation < 0);

  const exportColumns: ExportColumn<BudgetBalance>[] = [
    { key: 'office', header: 'Office', value: (r) => r.officeName },
    { key: 'fpp', header: 'FPP', value: (r) => r.fppCode },
    { key: 'fppName', header: 'FPP Name', value: (r) => r.fppName ?? '' },
    { key: 'sector', header: 'Sector', value: (r) => r.sector ?? '' },
    // Empty on a project line, and that is the honest export: the ordinance
    // named no object of expenditure there.
    { key: 'code', header: 'Account Code', value: (r) => r.accountCode },
    { key: 'name', header: 'Account', value: (r) => r.accountName },
    { key: 'class', header: 'Class', value: (r) => r.expenseClass },
    { key: 'appropriation', header: 'Appropriation', kind: 'amount', value: (r) => r.appropriationRevised },
    { key: 'allotment', header: 'Allotment', kind: 'amount', value: (r) => r.allotmentReleased },
    { key: 'availApp', header: 'Available Appropriation', kind: 'amount', value: (r) => r.availableAppropriation },
    { key: 'obligated', header: 'Obligations', kind: 'amount', value: (r) => r.obligated },
    { key: 'availAllot', header: 'Available Allotment', kind: 'amount', value: (r) => r.availableAllotment },
    { key: 'disbursed', header: 'Disbursements', kind: 'amount', value: (r) => r.disbursed },
    { key: 'unpaid', header: 'Unpaid Obligations', kind: 'amount', value: (r) => r.unpaidObligations },
  ];

  return (
    <ReportShell
      meta={{
        title: 'Registry of Appropriations, Allotments and Obligations',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the fiscal year ${fiscalYear}`,
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Registry' }]}
      rows={rows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="Office" className="min-w-[16rem]">
            <OfficePicker value={officeId} onChange={(v) => setOfficeId(v)} />
          </Field>
          <Field label="Expense classification">
            <Select value={expenseClass} onChange={(e) => setExpenseClass(e.target.value)}>
              <option value="">All classifications</option>
              {(Object.keys(EXPENSE_CLASS_LABELS) as ExpenseClass[]).map((c) => (
                <option key={c} value={c}>
                  {c} - {EXPENSE_CLASS_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          Available appropriation is the revised appropriation less allotments released. Available
          allotment is allotments released less obligations incurred. Both are computed from the
          source documents and cannot be edited.
        </>
      }
    >
      {(overspent.length > 0 || overReleased.length > 0) && (
        <div className="mb-4 space-y-2 no-print">
          {overspent.length > 0 && (
            <Alert tone="error" title="Lines obligated beyond the allotment released">
              {overspent.length} budget line{overspent.length === 1 ? '' : 's'} shows a negative
              available allotment. This happens only where an authorised override was used; each
              one is recorded in the audit trail.
            </Alert>
          )}
          {overReleased.length > 0 && (
            <Alert tone="error" title="Lines with allotments exceeding the appropriation">
              {overReleased.length} budget line{overReleased.length === 1 ? '' : 's'} has more
              allotment released than appropriation authorises. Review before any further release.
            </Alert>
          )}
        </div>
      )}

      {loading ? (
        <Spinner label="Loading the registry" />
      ) : error ? (
        <p className="py-8 text-center text-sm text-rose-700">{error}</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No budget lines carry an appropriation, allotment or obligation for this selection.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="cbo-th">Office</th>
                <th className="cbo-th">Budget line (FPP)</th>
                <th className="cbo-th w-14">Class</th>
                <th className="cbo-th text-right">Appropriation</th>
                <th className="cbo-th text-right">Allotment</th>
                <th className="cbo-th text-right">Available appropriation</th>
                <th className="cbo-th text-right">Obligations</th>
                <th className="cbo-th text-right">Available allotment</th>
                <th className="cbo-th text-right">Disbursements</th>
                <th className="cbo-th text-right">Unpaid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="cbo-td text-xs text-slate-600">{r.officeName}</td>
                  <td className="cbo-td">
                    <span className="font-mono text-xs text-slate-500">{r.fppCode}</span>{' '}
                    <span className="text-sm">{r.fppName || r.accountName}</span>
                    {/* A project line has no object of expenditure until an
                        obligation is raised, so nothing is shown rather than
                        an empty code that looks like missing data. */}
                    {r.accountCode && r.accountCode !== r.fppCode && (
                      <span className="block text-2xs text-slate-400">
                        object {r.accountCode} {r.accountName}
                      </span>
                    )}
                    {r.sector && (
                      <span className="block text-2xs text-slate-400">
                        {r.sector}
                        {r.serviceSector ? ` · ${r.serviceSector}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="cbo-td text-xs">{r.expenseClass}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.appropriationRevised, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.allotmentReleased, { symbol: false, dash: true })}</td>
                  <td
                    className={`cbo-td cbo-amount ${r.availableAppropriation < 0 ? 'text-rose-700' : ''}`}
                  >
                    {formatPeso(r.availableAppropriation, { symbol: false, parens: true, dash: true })}
                  </td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.obligated, { symbol: false, dash: true })}</td>
                  <td className={`cbo-td cbo-amount ${r.availableAllotment < 0 ? 'text-rose-700' : ''}`}>
                    {formatPeso(r.availableAllotment, { symbol: false, parens: true, dash: true })}
                  </td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.disbursed, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.unpaidObligations, { symbol: false, dash: true })}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy-800 font-semibold">
                <td className="cbo-td border-b-0" colSpan={3}>
                  Total - {rows.length} budget lines
                </td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.appropriation, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.allotment, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.availableAppropriation, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.obligated, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.availableAllotment, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.disbursed, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.unpaid, { symbol: false })}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </ReportShell>
  );
}
