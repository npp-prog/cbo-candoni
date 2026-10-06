import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { COMPARISON_TABS } from './comparisonTabs';
import { Spinner, Alert } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAccounts, useBudgetBalances, useEstimatedReceipts, useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { monthName } from '@/lib/dates';
import { SRE_BUCKET_LABELS } from '@/lib/sectors';
import { EXPENSE_CLASS_LABELS } from '@/types/enums';
import type { ExportColumn } from '@/lib/export';
import type { PeriodNo } from '@/types/common';
import { fundLabel } from '../budget/Obligations';
import { INCOME_CLASS_LABELS, type IncomeClass } from '@/lib/estimatedReceipts';
import { REPORT_TABS } from '@/layout/sections';
import {
  buildComparison,
  buildReceiptComparison,
  unbudgetedActual,
  type ComparisonRow as Row,
  type GroupBy,
} from './budgetVsActualReport';

/**
 * Statement of Comparison of Budget and Actual Amounts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPORT EXISTS AND THE SAOB DOES NOT ALREADY COVER IT
 * ---------------------------------------------------------------------------
 * The SAOB is built entirely from the budget module: appropriation, allotment,
 * obligation, disbursement, all four figures maintained by the same functions
 * against the same documents. It is internally consistent by construction,
 * which is its strength and also its limit - it cannot disagree with itself,
 * so it cannot tell you when the books disagree with it.
 *
 * This statement puts the budget beside the GENERAL LEDGER. The left-hand
 * columns come from the appropriations; the actual column is the sum of the
 * posted expense entries, matched on the FPP. Two independent records of the
 * same spending, side by side.
 *
 * ---------------------------------------------------------------------------
 * THE COLUMN NOBODY ASKS FOR AND EVERYBODY NEEDS
 * ---------------------------------------------------------------------------
 * "Obligated less actual" is the difference between what the budget module
 * says was committed and what the ledger says was recorded. A positive figure
 * is ordinary - an obligation raised and not yet vouchered. A NEGATIVE figure
 * is not ordinary: the ledger carries expenditure against a budget line that
 * the budget module does not believe was ever committed to it.
 *
 * That happens when a voucher's FPP was changed after the obligation was
 * certified, or when a manual journal entry charged a line directly. Neither
 * is caught anywhere else in CFMS, and neither shows on any statement that
 * takes its figures from one side only.
 *
 * ---------------------------------------------------------------------------
 * WHAT "ACTUAL" MEANS HERE
 * ---------------------------------------------------------------------------
 * Posted debits to expense accounts, less credits to them, for the periods
 * selected. Not payments: an expense is actual when the liability is
 * recognised, which is the accrual basis the Revised Chart of Accounts is kept
 * on. The cash side is the Statement of Receipts and Expenditures, which is a
 * different question and a different report.
 * ---------------------------------------------------------------------------
 */


const GROUPS: Array<{ value: GroupBy; label: string }> = [
  { value: 'fpp', label: 'By FPP' },
  { value: 'office', label: 'By office' },
  { value: 'sector', label: 'By sector' },
  { value: 'expenseClass', label: 'By allotment class' },
];

export default function BudgetVsActual() {
  const { fiscalYear, fundCode } = useFilters();
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('fpp');
  const [throughPeriod, setThroughPeriod] = useState<PeriodNo>(12);

  const balances = useBudgetBalances(fiscalYear, fundCode, officeId);
  const ledger = useLedgerEntries(fiscalYear, fundCode, { throughPeriod });

  /*
   * The receipts half.
   *
   * The statement compares budget with actual, and until the estimated
   * receipts existed it could only do so for spending - an appropriation
   * ordinance enacts no receipts, so there was no budget column to put beside
   * the collections. The estimate now comes from the receipts portion of LBP
   * Form No. 1, recorded under Budget.
   */
  const estimates = useEstimatedReceipts(fiscalYear, fundCode);
  const accounts = useAccounts(false);

  const revenueCodes = useMemo(
    () => new Set(accounts.data.filter((a) => a.accountClass === 'REVENUE').map((a) => a.code)),
    [accounts.data],
  );

  const receipts = useMemo(
    () =>
      buildReceiptComparison(
        estimates.data.map((e) => ({
          accountCode: e.accountCode,
          accountName: e.accountName,
          incomeClass: e.incomeClass,
          annual: e.annual,
        })),
        ledger.data
          .filter((e) => revenueCodes.has(e.accountCode))
          .map((e) => ({
            accountCode: e.accountCode,
            accountName: e.accountName,
            // A revenue account carries a credit balance, so income is credits
            // less debits and a refunded collection reduces the line.
            amount: e.credit - e.debit,
          })),
      ),
    [estimates.data, ledger.data, revenueCodes],
  );

  const rows = useMemo(
    () => buildComparison(balances.data, ledger.data, groupBy),
    [balances.data, ledger.data, groupBy],
  );

  /**
   * Ledger expenditure charged to a line with no appropriation. It cannot
   * appear in the table, so the screen has to say so instead.
   */
  const unbudgeted = useMemo(
    () => unbudgetedActual(balances.data, ledger.data),
    [balances.data, ledger.data],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          originalBudget: acc.originalBudget + r.originalBudget,
          finalBudget: acc.finalBudget + r.finalBudget,
          obligated: acc.obligated + r.obligated,
          actual: acc.actual + r.actual,
        }),
        { originalBudget: 0, finalBudget: 0, obligated: 0, actual: 0 },
      ),
    [rows],
  );

  /** Lines where the ledger carries more than the budget module committed. */
  const overRecorded = rows.filter((r) => r.actual > r.obligated);

  const label = (r: Row) =>
    groupBy === 'fpp'
      ? `${r.fppCode} ${r.fppName}`
      : groupBy === 'office'
        ? r.officeName
        : groupBy === 'sector'
          ? r.sector || 'Unclassified'
          : `${r.expenseClass} - ${EXPENSE_CLASS_LABELS[r.expenseClass]}`;

  const exportColumns: ExportColumn<Row>[] = [
    { key: 'label', header: GROUPS.find((g) => g.value === groupBy)!.label.replace('By ', ''), value: label },
    { key: 'office', header: 'Office', value: (r) => r.officeName },
    { key: 'sector', header: 'Sector', value: (r) => r.sector },
    { key: 'bucket', header: 'SRE Bucket', value: (r) => (r.bucket ? SRE_BUCKET_LABELS[r.bucket] : 'Unclassified') },
    { key: 'original', header: 'Original Budget', kind: 'amount', value: (r) => r.originalBudget },
    { key: 'final', header: 'Final Budget', kind: 'amount', value: (r) => r.finalBudget },
    { key: 'obligated', header: 'Obligated', kind: 'amount', value: (r) => r.obligated },
    { key: 'actual', header: 'Actual (General Ledger)', kind: 'amount', value: (r) => r.actual },
    { key: 'variance', header: 'Final Budget less Actual', kind: 'amount', value: (r) => r.finalBudget - r.actual },
    { key: 'gap', header: 'Obligated less Actual', kind: 'amount', value: (r) => r.obligated - r.actual },
  ];

  const loading = balances.loading || ledger.loading;
  const error = balances.error ?? ledger.error;

  return (
    <ReportShell
      meta={{
        title: 'Statement of Comparison of Budget and Actual Amounts',
        fundLabel: fundLabel(fundCode),
        periodLabel:
          throughPeriod === 12
            ? `For the year ended 31 December ${fiscalYear}`
            : `For the period January to ${monthName(throughPeriod)} ${fiscalYear}`,
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Budget and Actual' }]}
      tabs={
        <>
          <SectionTabs tabs={REPORT_TABS} />
          <SectionTabs tabs={COMPARISON_TABS} />
        </>
      }

      rows={rows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="Office" className="w-64">
            <OfficePicker value={officeId} onChange={setOfficeId} />
          </Field>
          <Field label="Group by" className="w-52">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              {GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Up to and including" className="w-44">
            <Select
              value={String(throughPeriod)}
              onChange={(e) => setThroughPeriod(Number(e.target.value) as PeriodNo)}
            >
              {Array.from({ length: 12 }, (_, i) => (i + 1) as PeriodNo).map((p) => (
                <option key={p} value={p}>
                  {monthName(p)}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          The budget columns come from the appropriations. The actual column is the sum of posted
          expense entries in the General Ledger, matched on the FPP — two independent records of the
          same spending, which is the whole point of showing them side by side. Actual is on the
          accrual basis: an expense counts when the liability is recognised on the voucher, not when
          the cheque is released.
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : error ? (
        <Alert tone="error" title="The statement could not be built">
          {error}
        </Alert>
      ) : (
        <>
          {overRecorded.length > 0 && (
            <Alert
              tone="error"
              title={`${overRecorded.length} line${overRecorded.length === 1 ? '' : 's'} carry more in the ledger than was ever obligated`}
              className="mb-4 no-print"
            >
              The General Ledger has expenditure against{' '}
              {overRecorded.slice(0, 6).map((r) => r.fppCode).join(', ')}
              {overRecorded.length > 6 ? ', and others' : ''} that the budget module does not show as
              committed. That happens when a voucher&rsquo;s FPP was changed after its obligation was
              certified, or when a journal entry charged the line directly. Neither is wrong in
              itself, and neither is visible on any statement built from one side alone.
            </Alert>
          )}

          {unbudgeted.length > 0 && (
            <Alert
              tone="warning"
              title="Expenditure charged to a line with no appropriation"
              className="mb-4 no-print"
            >
              {unbudgeted.map((u) => `${u.fppCode} (${formatPeso(u.amount)})`).join(', ')}. These
              cannot appear in the table below, because the table is built from the budget lines.
              Said nothing about, they would simply vanish and the statement would foot to less than
              the municipality spent while looking complete.
            </Alert>
          )}

          <h3 className="mb-3 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
            Expenditures
          </h3>

          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="cbo-th">
                  {groupBy === 'fpp'
                    ? 'Function, Programme or Project'
                    : GROUPS.find((g) => g.value === groupBy)!.label.replace('By ', '')}
                </th>
                <th className="cbo-th w-32 text-right">Original</th>
                <th className="cbo-th w-32 text-right">Final Budget</th>
                <th className="cbo-th w-32 text-right">Obligated</th>
                <th className="cbo-th w-32 text-right">Actual</th>
                <th className="cbo-th w-32 text-right">Final less Actual</th>
                <th className="cbo-th w-32 text-right">Obligated less Actual</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const gap = r.obligated - r.actual;
                return (
                  <tr key={r.key}>
                    <td className="cbo-td">
                      <span className="text-sm text-navy-900">{label(r)}</span>
                      {groupBy === 'fpp' && (
                        <span className="block text-2xs text-slate-500">
                          {r.officeName}
                          {r.sector ? ` · ${r.sector}` : ''}
                        </span>
                      )}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.originalBudget, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.finalBudget, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.obligated, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.actual, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.finalBudget - r.actual, {
                        symbol: false,
                        parens: true,
                        dash: true,
                      })}
                    </td>
                    <td className={`cbo-td cbo-amount ${gap < 0 ? 'text-rose-700' : ''}`}>
                      {formatPeso(gap, { symbol: false, parens: true, dash: true })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy-800 font-semibold">
                <td className="cbo-td border-b-0">Total</td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(totals.originalBudget, { symbol: false })}
                </td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(totals.finalBudget, { symbol: false })}
                </td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(totals.obligated, { symbol: false })}
                </td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(totals.actual, { symbol: false })}
                </td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(totals.finalBudget - totals.actual, { symbol: false, parens: true })}
                </td>
                <td className="cbo-td cbo-amount border-b-0">
                  {formatPeso(totals.obligated - totals.actual, { symbol: false, parens: true })}
                </td>
              </tr>
            </tfoot>
          </table>

          <h3 className="mt-8 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
            Receipts
          </h3>

          {estimates.data.length === 0 ? (
            <Alert
              tone="warning"
              title="There is no budget column for receipts"
              className="mt-3 no-print"
            >
              No estimated receipts have been recorded for {fiscalYear} in the{' '}
              {fundLabel(fundCode)}. An appropriation ordinance authorises expenditure and enacts
              no receipts, so this half of the statement cannot be read off it. Record the receipts
              portion of LBP Form No. 1 on Budget &rsaquo; Estimated Receipts, and the comparison
              below fills in.
            </Alert>
          ) : (
            <table className="mt-3 w-full border-collapse">
              <thead>
                <tr>
                  <th className="cbo-th">Account</th>
                  <th className="cbo-th">Income class</th>
                  <th className="cbo-th text-right">Estimate</th>
                  <th className="cbo-th text-right">Actual</th>
                  <th className="cbo-th text-right">Variance</th>
                  <th className="cbo-th text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {receipts.rows.map((r) => (
                  <tr key={r.accountCode} className={r.unbudgeted ? 'bg-amber-50' : undefined}>
                    <td className="cbo-td text-sm">
                      <span className="font-mono text-2xs text-slate-500">{r.accountCode}</span>{' '}
                      {r.accountName}
                      {r.unbudgeted && (
                        <span className="block text-2xs text-amber-800">
                          Collected but never estimated
                        </span>
                      )}
                    </td>
                    <td className="cbo-td text-2xs text-slate-500">
                      {INCOME_CLASS_LABELS[r.incomeClass as IncomeClass] ?? ''}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.finalBudget, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.actual, { symbol: false, dash: true })}
                    </td>
                    <td
                      className={`cbo-td cbo-amount ${r.variance < 0 ? 'text-rose-700' : ''}`}
                    >
                      {formatPeso(r.variance, { symbol: false, parens: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {r.variancePct === null ? '' : `${(r.variancePct * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 font-semibold">
                  <td className="cbo-td border-b-0" colSpan={2}>
                    TOTAL RECEIPTS
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(receipts.total.finalBudget, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(receipts.total.actual, { symbol: false })}
                  </td>
                  <td
                    className={`cbo-td cbo-amount border-b-0 ${
                      receipts.total.variance < 0 ? 'text-rose-700' : ''
                    }`}
                  >
                    {formatPeso(receipts.total.variance, { symbol: false, parens: true })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {receipts.total.variancePct === null
                      ? ''
                      : `${(receipts.total.variancePct * 100).toFixed(1)}%`}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          {rows.length === 0 && (
            <Alert tone="info" title="Nothing to compare yet" className="mt-4">
              No appropriation has been recorded for {fiscalYear} in the{' '}
              {fundLabel(fundCode)}. Load the ordinance on Budget &rsaquo; Appropriation &rsaquo;
              Upload first.
            </Alert>
          )}
        </>
      )}
    </ReportShell>
  );
}
