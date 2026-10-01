import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReportShell } from '@/components/ReportShell';
import { Spinner, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { PeriodPicker } from '@/components/PeriodPicker';
import { useFilters } from '@/context/FilterContext';
import { useAccounts, useEstimatedReceipts, useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import {
  lastMonthOf,
  periodColumns,
  periodHeading,
  periodLabel,
  showsManualColumnNumbers,
  type ReportPeriod,
} from '@/lib/reportPeriods';
import {
  buildReceiptsReport,
  type IncomeEstimates,
  type ReceiptEntry,
  type ReceiptRow,
} from './quarterlyReceiptsReport';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';

/**
 * LBAc Form No. 1 — the Report of Receipts.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 5 of Part II, Item
 * 5.5. Prepared by the Local Treasurer, certified correct by the Local
 * Accountant, submitted to the Local Finance Committee through the Local
 * Budget Officer on or before the tenth day of the month following the quarter
 * reported.
 *
 * ---------------------------------------------------------------------------
 * THE SUBMISSION IS QUARTERLY; THE QUESTION IS NOT
 * ---------------------------------------------------------------------------
 * The quarter is the deadline, not the only period anybody asks about. Choose
 * a quarter and what comes out is the manual's form, column numbers and all.
 * Choose a month, the year, or a running position as of a month, and the same
 * figures answer the question that was actually asked.
 *
 * The manual's column numbers appear on the quarter and nowhere else. Above a
 * monthly or annual layout they would be numbering something different, and a
 * reader checking the submission against the form would check the wrong one.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE FIGURES COME FROM
 * ---------------------------------------------------------------------------
 * The actual income comes from the General Ledger, not the collections
 * register, because the manual ties the to-date column to the Trial Balance. A
 * collection receipted but not yet journalised is not yet income, and a report
 * that counted it would disagree with the books it is filed beside — by
 * exactly the receipts nobody has posted, which is the hardest kind of
 * difference to find later.
 *
 * The estimate comes from the Estimated Receipts module. This form used to
 * keep its own copy, which meant the same figure lived in two places and the
 * quarterly report could disagree with the annual statement about what the
 * municipality expected to collect.
 * ---------------------------------------------------------------------------
 */

export default function QuarterlyReceipts() {
  const { fiscalYear, fundCode } = useFilters();

  const [period, setPeriod] = useState<ReportPeriod>({ mode: 'QUARTERLY', index: 1 });

  const columns = periodColumns(period);
  const lastMonth = lastMonthOf(period);

  const accounts = useAccounts();
  // Through the end of the period. The to-date column is January to date, so
  // the whole year up to that point is needed - not just the period's months.
  const ledger = useLedgerEntries(fiscalYear, fundCode, { throughPeriod: lastMonth });
  const stored = useEstimatedReceipts(fiscalYear, fundCode);

  const revenueAccounts = useMemo(
    () =>
      accounts.data
        .filter((a) => a.accountClass === 'REVENUE')
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts.data],
  );

  const accountNames = useMemo(
    () => new Map(revenueAccounts.map((a) => [a.code, a.name])),
    [revenueAccounts],
  );

  /**
   * Only the revenue accounts. An expense or an asset entry sharing the period
   * has no business on a report of receipts, and the ledger query brings back
   * every account for the period.
   */
  const entries = useMemo<ReceiptEntry[]>(
    () =>
      ledger.data
        .filter((e) => accountNames.has(e.accountCode))
        .map((e) => ({
          accountCode: e.accountCode,
          accountName: e.accountName || (accountNames.get(e.accountCode) ?? ''),
          period: e.period,
          signedAmount: e.signedAmount,
        })),
    [ledger.data, accountNames],
  );

  const estimates = useMemo<IncomeEstimates>(() => {
    const out: IncomeEstimates = {};
    for (const r of stored.data) {
      out[r.accountCode] = { q1: r.q1, q2: r.q2, q3: r.q3, q4: r.q4 };
    }
    return out;
  }, [stored.data]);

  const report = useMemo(
    () => buildReceiptsReport(entries, estimates, period),
    [entries, estimates, period],
  );

  const numbered = showsManualColumnNumbers(period);
  /** The manual's column number, or nothing at all off the quarterly form. */
  const n = (num: number) => (numbered ? ` (${num})` : '');

  const nameOf = (row: ReceiptRow) => row.accountName || accountNames.get(row.accountCode) || '';

  const exportColumns: ExportColumn<ReceiptRow>[] = [
    { key: 'name', header: `Account Title/Description of Income${n(1)}`, value: (r) => nameOf(r) },
    { key: 'code', header: `Account Code${n(2)}`, value: (r) => r.accountCode },
    {
      key: 'estPrev',
      header: `Estimated Income Previous Period${n(3)}`,
      kind: 'amount',
      value: (r) => r.estimatedPrevious ?? 0,
    },
    {
      key: 'estThis',
      header: `Estimated Income This Period${n(4)}`,
      kind: 'amount',
      value: (r) => r.estimatedThis ?? 0,
    },
    {
      key: 'estToDate',
      header: `Total Estimated Income to Date${n(5)}`,
      kind: 'amount',
      value: (r) => r.estimatedToDate ?? 0,
    },
    ...columns.map((c, i) => ({
      key: c.key,
      header: `${c.label}${numbered ? ` (${6 + i})` : ''}`,
      kind: 'amount' as const,
      value: (r: ReceiptRow) => r.columns[i] ?? 0,
    })),
    {
      key: 'actualToDate',
      header: `Total Actual Income to Date${n(9)}`,
      kind: 'amount',
      value: (r) => r.actualToDate,
    },
    {
      key: 'variance',
      header: `Variance Amount${n(10)}`,
      kind: 'amount',
      value: (r) => r.variance ?? 0,
    },
    {
      key: 'variancePct',
      header: `Variance %${n(11)}`,
      value: (r) => (r.variancePct === null ? '' : (r.variancePct * 100).toFixed(2)),
    },
    {
      key: 'remarks',
      header: `Remarks${n(12)}`,
      value: (r) => (r.unestimated ? 'No estimate certified for this account' : ''),
    },
  ];

  const loading = ledger.loading || accounts.loading || stored.loading;
  const error = ledger.error ?? accounts.error ?? stored.error;

  /** Columns to the left of the breakdown, for the footer colspan. */
  const leftColumns = 2 + (report.rows.length >= 0 ? 3 : 3);

  return (
    <ReportShell
      meta={{
        title: 'Report of Receipts',
        fundLabel: fundLabel(fundCode),
        periodLabel: periodHeading(period, fiscalYear),
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Reports' }, { label: 'LBAc Form No. 1' }]}
      rows={report.rows}
      exportColumns={exportColumns}
      actions={
        <Link to="/budget/estimated-receipts">
          <Button size="sm">Estimated receipts</Button>
        </Link>
      }
      filters={<PeriodPicker value={period} onChange={setPeriod} />}
      footnote={
        <>
          LBAc Form No. 1, Budget Operations Manual for LGUs, 2023 Edition. Prepared by the Local
          Treasurer and certified correct by the Local Accountant, based on the actual collections
          from the Report of Daily Collections. Submitted to the Local Finance Committee through
          the Local Budget Officer on or before the tenth day of the month following the quarter
          reported.{' '}
          {numbered ? (
            <>The column numbers above are the manual&rsquo;s own.</>
          ) : (
            <>
              The manual&rsquo;s column numbers are not shown, because they describe the quarterly
              form and this is {periodLabel(period).toLowerCase()}. Choose Quarterly to produce the
              form as it is submitted.
            </>
          )}{' '}
          The estimate to date and the actual to date are both January to the end of the period
          &mdash; neither is the sum of the columns beside it, and the actual to date should tally
          with the income accounts on the Trial Balance as of that date.
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : error ? (
        <Alert tone="error" title="The report could not be built">
          {error}
        </Alert>
      ) : (
        <>
          {report.estimateUnavailable && !report.noEstimates && (
            <Alert
              tone="info"
              title="This period has no estimate to compare against"
              className="mb-4 no-print"
            >
              The Local Finance Committee certifies estimated income <strong>by quarter</strong>,
              and {periodLabel(period).toLowerCase()} does not close on one. CBO will not divide a
              quarter into months: that would produce figures nobody certified and a variance CBO
              had invented, reported to the Committee as though the Treasurer had projected it. The
              collections below are real; the estimate and variance columns are blank until the
              period closes a quarter.
            </Alert>
          )}

          {report.noEstimates && (
            <Alert
              tone="warning"
              title="No estimated income has been recorded for this fund"
              className="mb-4 no-print"
            >
              The estimate and the variance against it are what this form exists to show. Without
              the figures the Local Finance Committee certified, what is below is a list of
              collections and not LBAc Form No. 1. They are recorded once, for the whole year, on{' '}
              <Link className="underline" to="/budget/estimated-receipts">
                Budget &rsaquo; Estimated Receipts
              </Link>{' '}
              &mdash; the same figures the SRE and the Statement of Comparison use.
            </Alert>
          )}

          {!report.noEstimates && report.unestimatedCodes.length > 0 && (
            <Alert
              tone="info"
              title={`${report.unestimatedCodes.length} account${
                report.unestimatedCodes.length === 1 ? '' : 's'
              } collected income that was not estimated`}
              className="mb-4 no-print"
            >
              {report.unestimatedCodes.join(', ')}. Their variance is the whole amount collected and
              the percentage is left blank, because the manual&rsquo;s formula divides by the
              estimate. Either the estimate belongs on one of these accounts, or the collection
              belongs on another &mdash; worth settling before this is signed.
            </Alert>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="cbo-th" rowSpan={2}>
                    Account Title/Description of Income{n(1)}
                  </th>
                  <th className="cbo-th" rowSpan={2}>
                    Account Code{n(2)}
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Estimated Income Previous Period{n(3)}
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Estimated Income This Period{n(4)}
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Total Estimated Income to Date{n(5)}
                  </th>
                  {columns.length > 0 && (
                    <th className="cbo-th text-center" colSpan={columns.length}>
                      Actual Income for the Period
                    </th>
                  )}
                  <th className="cbo-th text-right" rowSpan={2}>
                    Total Actual Income to Date{n(9)}
                  </th>
                  <th className="cbo-th text-center" colSpan={2}>
                    Variance
                  </th>
                  <th className="cbo-th" rowSpan={2}>
                    Remarks{n(12)}
                  </th>
                </tr>
                <tr>
                  {columns.map((c, i) => (
                    <th key={c.key} className="cbo-th text-right">
                      {c.label}
                      {numbered ? ` (${6 + i})` : ''}
                    </th>
                  ))}
                  <th className="cbo-th text-right">Amount{n(10)}</th>
                  <th className="cbo-th text-right">%{n(11)}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.accountCode}>
                    <td className="cbo-td">{nameOf(r)}</td>
                    <td className="cbo-td font-mono text-2xs text-slate-500">{r.accountCode}</td>
                    <Amount value={r.estimatedPrevious} />
                    <Amount value={r.estimatedThis} />
                    <Amount value={r.estimatedToDate} />
                    {r.columns.map((v, i) => (
                      <Amount key={columns[i]?.key ?? i} value={v} />
                    ))}
                    <Amount value={r.actualToDate} />
                    <Amount value={r.variance} negative={(r.variance ?? 0) < 0} />
                    <Percent value={r.variancePct} />
                    <td className="cbo-td text-2xs text-slate-500">
                      {r.unestimated ? 'No estimate certified' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 font-semibold">
                  <td className="cbo-td border-b-0" colSpan={2}>
                    TOTAL
                  </td>
                  <Amount value={report.total.estimatedPrevious} foot />
                  <Amount value={report.total.estimatedThis} foot />
                  <Amount value={report.total.estimatedToDate} foot />
                  {report.total.columns.map((v, i) => (
                    <Amount key={columns[i]?.key ?? i} value={v} foot />
                  ))}
                  <Amount value={report.total.actualToDate} foot />
                  <Amount
                    value={report.total.variance}
                    negative={(report.total.variance ?? 0) < 0}
                    foot
                  />
                  <Percent value={report.total.variancePct} foot />
                  <td className="cbo-td border-b-0" />
                </tr>
              </tfoot>
            </table>
          </div>

          {report.rows.length === 0 && (
            <Alert tone="info" title="No income recorded yet" className="mt-4">
              No revenue account carries an entry in {fiscalYear} for {fundLabel(fundCode)} up to
              the end of {periodLabel(period).toLowerCase()}, and no estimate has been recorded
              either.
            </Alert>
          )}

          <div className="mt-10 grid grid-cols-2 gap-10 text-2xs">
            <div>
              <p className="text-slate-500">Prepared by:</p>
              <p className="mt-10 border-t border-slate-500 pt-1 text-center font-semibold">
                &nbsp;
              </p>
              <p className="text-center text-slate-500">Local Treasurer</p>
              <p className="mt-2 text-slate-500">Date: ______________</p>
            </div>
            <div>
              <p className="text-slate-500">Certified Correct by:</p>
              <p className="mt-10 border-t border-slate-500 pt-1 text-center font-semibold">
                &nbsp;
              </p>
              <p className="text-center text-slate-500">Local Accountant</p>
              <p className="mt-2 text-slate-500">Date: ______________</p>
            </div>
          </div>
        </>
      )}
    </ReportShell>
  );
}

/**
 * A money cell.
 *
 * Null is genuinely different from zero here: zero is an estimate of nothing,
 * null is no estimate at all. A dash for both would tell the Treasurer the
 * Committee had projected no income when in fact it had projected for a period
 * this report does not cover.
 */
function Amount({
  value,
  negative,
  foot,
}: {
  value: Centavos | null;
  negative?: boolean;
  foot?: boolean;
}) {
  return (
    <td
      className={`cbo-td cbo-amount ${negative ? 'text-rose-700' : ''} ${foot ? 'border-b-0' : ''}`}
    >
      {value === null ? (
        <span className="text-slate-300">&mdash;</span>
      ) : (
        formatPeso(value, { symbol: false, dash: !foot, parens: true })
      )}
    </td>
  );
}

/**
 * The variance percentage.
 *
 * Blank, not a zero and not a dash, where there is nothing to divide by: a
 * dash in a percentage column reads as "no change", and no change against
 * nothing expected is precisely the wrong thing to tell the Treasurer.
 */
function Percent({ value, foot }: { value: number | null; foot?: boolean }) {
  return (
    <td className={`cbo-td cbo-amount ${foot ? 'border-b-0' : ''}`}>
      {value === null ? (
        <span className="text-slate-300">&nbsp;</span>
      ) : (
        <span className={value < 0 ? 'text-rose-700' : undefined}>
          {(value * 100).toFixed(2)}%
        </span>
      )}
    </td>
  );
}
