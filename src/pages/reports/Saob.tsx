import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useBudgetBalances } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';

interface SaobRow {
  key: string;
  label: string;
  sublabel?: string;
  appropriation: Centavos;
  allotment: Centavos;
  obligations: Centavos;
  disbursements: Centavos;
  unpaidObligations: Centavos;
  availableAllotment: Centavos;
  balanceOfAppropriation: Centavos;
}

type GroupBy = 'account' | 'office' | 'expenseClass' | 'program';

/**
 * Statement of Appropriations, Obligations and Balances.
 *
 * The budget report COA asks for. It can be grouped four ways because four
 * different people need it: the Budget Officer works by account, a department
 * head by office, the Local Chief Executive by expense classification, and
 * the planning office by programme.
 */
export default function Saob() {
  const { fiscalYear, fundCode } = useFilters();
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('account');

  const { data, loading, error } = useBudgetBalances(fiscalYear, fundCode, officeId);

  const rows = useMemo<SaobRow[]>(() => {
    const map = new Map<string, SaobRow>();

    for (const b of data) {
      if (b.appropriationRevised === 0 && b.allotmentReleased === 0 && b.obligated === 0) continue;

      const key =
        groupBy === 'account'
          ? b.accountCode
          : groupBy === 'office'
            ? b.officeId
            : groupBy === 'expenseClass'
              ? b.expenseClass
              : (b.programId ?? 'unassigned');

      const label =
        groupBy === 'account'
          ? b.accountName
          : groupBy === 'office'
            ? b.officeName
            : groupBy === 'expenseClass'
              ? EXPENSE_CLASS_LABELS[b.expenseClass as ExpenseClass] ?? b.expenseClass
              : (b.programId ?? 'Not assigned to a programme');

      const row = map.get(key) ?? {
        key,
        label,
        sublabel: groupBy === 'account' ? b.accountCode : undefined,
        appropriation: 0,
        allotment: 0,
        obligations: 0,
        disbursements: 0,
        unpaidObligations: 0,
        availableAllotment: 0,
        balanceOfAppropriation: 0,
      };

      row.appropriation += b.appropriationRevised;
      row.allotment += b.allotmentReleased;
      row.obligations += b.obligated;
      row.disbursements += b.disbursed;
      row.unpaidObligations += b.unpaidObligations;
      row.availableAllotment += b.availableAllotment;
      row.balanceOfAppropriation += b.availableAppropriation;

      map.set(key, row);
    }

    return [...map.values()].sort((a, b) => (a.sublabel ?? a.label).localeCompare(b.sublabel ?? b.label));
  }, [data, groupBy]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          appropriation: acc.appropriation + r.appropriation,
          allotment: acc.allotment + r.allotment,
          obligations: acc.obligations + r.obligations,
          disbursements: acc.disbursements + r.disbursements,
          unpaidObligations: acc.unpaidObligations + r.unpaidObligations,
          availableAllotment: acc.availableAllotment + r.availableAllotment,
          balanceOfAppropriation: acc.balanceOfAppropriation + r.balanceOfAppropriation,
        }),
        {
          appropriation: 0,
          allotment: 0,
          obligations: 0,
          disbursements: 0,
          unpaidObligations: 0,
          availableAllotment: 0,
          balanceOfAppropriation: 0,
        },
      ),
    [rows],
  );

  const exportColumns: ExportColumn<SaobRow>[] = [
    { key: 'label', header: groupBy === 'account' ? 'Account' : 'Grouping', value: (r) => `${r.sublabel ?? ''} ${r.label}`.trim() },
    { key: 'appropriation', header: 'Appropriations', kind: 'amount', value: (r) => r.appropriation },
    { key: 'allotment', header: 'Allotments', kind: 'amount', value: (r) => r.allotment },
    { key: 'obligations', header: 'Obligations', kind: 'amount', value: (r) => r.obligations },
    { key: 'disbursements', header: 'Disbursements', kind: 'amount', value: (r) => r.disbursements },
    { key: 'unpaid', header: 'Unpaid Obligations', kind: 'amount', value: (r) => r.unpaidObligations },
    { key: 'availAllot', header: 'Available Allotment', kind: 'amount', value: (r) => r.availableAllotment },
    { key: 'balApprop', header: 'Balance of Appropriation', kind: 'amount', value: (r) => r.balanceOfAppropriation },
  ];

  return (
    <ReportShell
      meta={{
        title: 'Statement of Appropriations, Obligations and Balances',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the fiscal year ${fiscalYear}`,
        preparedBy: 'Municipal Budget Officer',
        certifiedBy: 'Municipal Budget Officer',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'SAOB' }]}
      rows={rows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="Group by">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              <option value="account">Account</option>
              <option value="office">Office</option>
              <option value="expenseClass">Expense classification</option>
              <option value="program">Programme</option>
            </Select>
          </Field>
          <Field label="Office" className="min-w-[16rem]">
            <OfficePicker value={officeId} onChange={(v) => setOfficeId(v)} />
          </Field>
        </>
      }
      footnote={
        <>
          Available allotment is allotments released less obligations incurred. Balance of
          appropriation is the revised appropriation less allotments released. Unpaid obligations
          are obligations incurred but not yet disbursed, and are the basis for the accounts
          payable recognised at year end.
        </>
      }
    >
      {loading ? (
        <Spinner label="Reading the budget registry" />
      ) : error ? (
        <p className="py-8 text-center text-sm text-rose-700">{error}</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No appropriations, allotments or obligations have been recorded for this selection.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="cbo-th">{groupBy === 'account' ? 'Account' : 'Grouping'}</th>
                <th className="cbo-th text-right">Appropriations</th>
                <th className="cbo-th text-right">Allotments</th>
                <th className="cbo-th text-right">Obligations</th>
                <th className="cbo-th text-right">Disbursements</th>
                <th className="cbo-th text-right">Unpaid obligations</th>
                <th className="cbo-th text-right">Available allotment</th>
                <th className="cbo-th text-right">Balance of appropriation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="cbo-td">
                    {r.sublabel && <span className="font-mono text-xs text-slate-500">{r.sublabel} </span>}
                    <span>{r.label}</span>
                  </td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.appropriation, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.allotment, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.obligations, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.disbursements, { symbol: false, dash: true })}</td>
                  <td className="cbo-td cbo-amount">{formatPeso(r.unpaidObligations, { symbol: false, dash: true })}</td>
                  <td className={`cbo-td cbo-amount ${r.availableAllotment < 0 ? 'text-rose-700' : ''}`}>
                    {formatPeso(r.availableAllotment, { symbol: false, parens: true, dash: true })}
                  </td>
                  <td className={`cbo-td cbo-amount ${r.balanceOfAppropriation < 0 ? 'text-rose-700' : ''}`}>
                    {formatPeso(r.balanceOfAppropriation, { symbol: false, parens: true, dash: true })}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy-800 font-semibold">
                <td className="cbo-td border-b-0">Total</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.appropriation, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.allotment, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.obligations, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.disbursements, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.unpaidObligations, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.availableAllotment, { symbol: false })}</td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(totals.balanceOfAppropriation, { symbol: false })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </ReportShell>
  );
}
