import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Spinner, Alert } from '@/components/ui/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { Field } from '@/components/ui/Field';
import { OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAllotments, useObligations, useBudgetBalances } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { figuresForPeriod, totalPeriod } from '@/lib/budgetPeriods';
import {
  DEFAULT_PERIOD,
  periodHeading,
  periodLabel,
  periodRange,
  showsManualColumnNumbers,
  type ReportPeriod,
} from '@/lib/reportPeriods';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { BUDGET_REPORT_TABS } from '@/layout/sections';

/**
 * LBAc Form No. 2 — the Financial Report of Operations.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 5 of Part II,
 * Item 5.5. Prepared by the Local Budget Officer and submitted to the Local
 * Finance Committee on or before the tenth day of the month following the
 * quarter reported.
 *
 * ---------------------------------------------------------------------------
 * THE COLUMNS ARE THE MANUAL'S, NOT CFMS'S
 * ---------------------------------------------------------------------------
 * Appropriation continuing and current; allotment released in previous
 * periods, this period, total; balance of appropriation; obligations in
 * previous periods, this period, total; unobligated allotment. In that order,
 * with the manual's own column numbers in the heading, because the officer
 * filling in the submission reads down the form and across CFMS's screen at
 * the same time.
 *
 * The quarter is the SUBMISSION deadline, not the only period anybody asks
 * about, so the period is chosen. The manual's column numbers appear on the
 * quarter and nowhere else: above a monthly or annual layout they would be
 * numbering a different form.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIGURES ARE COMPUTED FROM THE DOCUMENTS AND NOT FROM THE BALANCES
 * ---------------------------------------------------------------------------
 * The running balances hold one figure per line for the whole year. This form
 * asks for the year split at the start of the quarter, and a year-to-date
 * total cannot be split after the fact - so the releases and the commitments
 * are added up from the allotments and the obligations themselves, each with
 * its own date.
 *
 * The year-to-date totals that produces must equal the running balances, which
 * are maintained inside the transactions that wrote those same documents. Two
 * independent paths to the same figure, and the report checks them against
 * each other rather than trusting either.
 * ---------------------------------------------------------------------------
 */

interface Row {
  key: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  expenseClass: string;
  continuing: Centavos;
  current: Centavos;
  allotmentPrevious: Centavos;
  allotmentThis: Centavos;
  obligationPrevious: Centavos;
  obligationThis: Centavos;
}

export default function QuarterlyFinancialReport() {
  const { fiscalYear, fundCode } = useFilters();
  const [period, setPeriod] = useState<ReportPeriod>(DEFAULT_PERIOD);
  const [officeId, setOfficeId] = useState<string | null>(null);

  const allotments = useAllotments(fiscalYear, fundCode);
  const obligations = useObligations(fiscalYear, fundCode);
  const balances = useBudgetBalances(fiscalYear, fundCode);

  const range = periodRange(period, fiscalYear);
  const numbered = showsManualColumnNumbers(period);
  /** The manual's column number, or nothing at all off the quarterly form. */
  const n = (num: number) => (numbered ? ` (${num})` : '');

  const figures = useMemo(
    () => figuresForPeriod(allotments.data, obligations.data, range.from, range.to),
    [allotments.data, obligations.data, range.from, range.to],
  );

  /**
   * The appropriation columns come from the balances, which is right: an
   * appropriation is not dated into a quarter the way a release is. Columns 3
   * and 4 of the form ask for continuing and current authority as it stands,
   * not as it stood in March.
   */
  const appropriationOf = useMemo(() => {
    const map = new Map<string, { continuing: Centavos; current: Centavos }>();
    for (const b of balances.data) {
      const key = `${b.officeId}__${b.fppCode}__${b.accountCode || '-'}`;
      const entry = map.get(key) ?? { continuing: 0, current: 0 };
      entry.continuing += b.appropriationContinuing;
      entry.current +=
        b.appropriationOriginal + b.appropriationSupplemental + b.appropriationAdjustments;
      map.set(key, entry);
    }
    return map;
  }, [balances.data]);

  const rows = useMemo<Row[]>(
    () =>
      figures
        .filter((f) => !officeId || f.officeId === officeId)
        .map((f) => {
          const appropriation = appropriationOf.get(f.key) ?? { continuing: 0, current: 0 };
          return {
            key: f.key,
            officeName: f.officeName,
            fppCode: f.fppCode,
            fppName: f.fppName,
            expenseClass: f.expenseClass,
            continuing: appropriation.continuing,
            current: appropriation.current,
            allotmentPrevious: f.allotmentPrevious,
            allotmentThis: f.allotmentThisPeriod,
            obligationPrevious: f.obligationPrevious,
            obligationThis: f.obligationThisPeriod,
          };
        })
        .filter(
          (r) =>
            r.continuing !== 0 ||
            r.current !== 0 ||
            r.allotmentPrevious !== 0 ||
            r.allotmentThis !== 0 ||
            r.obligationPrevious !== 0 ||
            r.obligationThis !== 0,
        ),
    [figures, appropriationOf, officeId],
  );

  const totals = useMemo(() => {
    const period = totalPeriod(
      figures.filter((f) => !officeId || f.officeId === officeId),
    );
    const appropriation = rows.reduce(
      (acc, r) => ({
        continuing: acc.continuing + r.continuing,
        current: acc.current + r.current,
      }),
      { continuing: 0, current: 0 },
    );
    return { ...period, ...appropriation };
  }, [figures, rows, officeId]);

  /**
   * The year-to-date figure the documents give, against the figure the running
   * balances hold.
   *
   * These are maintained by different code on different occasions - the
   * balances inside the transaction that writes each document, these by adding
   * the documents up afterwards - so they are a genuine cross-check rather
   * than the same number twice. A difference means one of them is wrong, and
   * the form goes to the Local Finance Committee, so it says so instead of
   * choosing.
   */
  const drift = useMemo(() => {
    // Only when the whole year is in view. A quarter's figures are a slice of
    // the running balances and are not supposed to equal them, so comparing
    // them would report a difference on every report but the last.
    if (period.mode !== 'ANNUAL' || officeId) return null;
    const fromBalances = balances.data.reduce(
      (acc, b) => ({
        allotment: acc.allotment + b.allotmentReleased,
        obligated: acc.obligated + b.obligated,
      }),
      { allotment: 0, obligated: 0 },
    );
    const allotmentGap = totals.allotmentTotal - fromBalances.allotment;
    const obligatedGap = totals.obligationTotal - fromBalances.obligated;
    if (allotmentGap === 0 && obligatedGap === 0) return null;
    return { allotmentGap, obligatedGap };
  }, [period.mode, officeId, balances.data, totals]);

  const exportColumns: ExportColumn<Row>[] = [
    { key: 'fpp', header: '(1) MFO/PPA', value: (r) => `${r.fppCode} ${r.fppName}` },
    { key: 'office', header: '(2) Implementing Unit', value: (r) => r.officeName },
    { key: 'continuing', header: '(3) Continuing', kind: 'amount', value: (r) => r.continuing },
    { key: 'current', header: '(4) Current', kind: 'amount', value: (r) => r.current },
    { key: 'apprTotal', header: '(5) Total', kind: 'amount', value: (r) => r.continuing + r.current },
    {
      key: 'allotPrev',
      header: `${n(6)}Previous periods`.trim(),
      kind: 'amount',
      value: (r) => r.allotmentPrevious,
    },
    {
      key: 'allotThis',
      header: `${n(7)}${periodLabel(period)}`.trim(),
      kind: 'amount',
      value: (r) => r.allotmentThis,
    },
    {
      key: 'allotTotal',
      header: '(8) Total Released',
      kind: 'amount',
      value: (r) => r.allotmentPrevious + r.allotmentThis,
    },
    {
      key: 'balanceAppr',
      header: '(9) Balance of Appropriation',
      kind: 'amount',
      value: (r) => r.continuing + r.current - (r.allotmentPrevious + r.allotmentThis),
    },
    { key: 'oblPrev', header: '(10) Previous Quarters', kind: 'amount', value: (r) => r.obligationPrevious },
    { key: 'oblThis', header: '(11) This Quarter', kind: 'amount', value: (r) => r.obligationThis },
    {
      key: 'oblTotal',
      header: '(12) Total Obligations',
      kind: 'amount',
      value: (r) => r.obligationPrevious + r.obligationThis,
    },
    {
      key: 'unobligated',
      header: '(13) Unobligated Allotment',
      kind: 'amount',
      value: (r) =>
        r.allotmentPrevious + r.allotmentThis - (r.obligationPrevious + r.obligationThis),
    },
  ];

  const loading = allotments.loading || obligations.loading || balances.loading;
  const error = allotments.error ?? obligations.error ?? balances.error;

  return (
    <ReportShell
      printLayout="landscape"
      tabs={<SectionTabs tabs={BUDGET_REPORT_TABS} />}
      meta={{
        title: 'Financial Report of Operations',
        fundLabel: fundLabel(fundCode),
        periodLabel: periodHeading(period, fiscalYear),
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Reports' }, { label: 'Financial Report of Operations' }]}
      rows={rows}
      exportColumns={exportColumns}
      filters={
        <>
          <PeriodPicker value={period} onChange={setPeriod} />
          <Field label="Office" className="w-64">
            <OfficePicker value={officeId} onChange={setOfficeId} />
          </Field>
        </>
      }
      footnote={
        <>
          LBAc Form No. 2, Budget Operations Manual for LGUs, 2023 Edition. Certified correct by the
          Local Budget Officer and submitted to the Local Finance Committee on or before the tenth
          day of the month following the quarter reported. The column numbers above are the
          manual&rsquo;s own. Releases and commitments are added up from the allotments and
          obligations by their own dates; the appropriation columns are the authority as it stands,
          which is what columns 3 and 4 ask for.
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
          {drift && (
            <Alert
              tone="error"
              title="The registry and the running balances disagree"
              className="mb-4 no-print"
            >
              Adding up the allotments and obligations for the whole year gives{' '}
              {drift.allotmentGap !== 0 && (
                <>
                  <strong>{formatPeso(Math.abs(drift.allotmentGap))}</strong>{' '}
                  {drift.allotmentGap > 0 ? 'more' : 'less'} allotment
                </>
              )}
              {drift.allotmentGap !== 0 && drift.obligatedGap !== 0 && ' and '}
              {drift.obligatedGap !== 0 && (
                <>
                  <strong>{formatPeso(Math.abs(drift.obligatedGap))}</strong>{' '}
                  {drift.obligatedGap > 0 ? 'more' : 'less'} obligations
                </>
              )}{' '}
              than the running balances hold. The two are maintained by different code on different
              occasions, so this is a real cross-check and not the same figure twice. This form goes
              to the Local Finance Committee — send me the difference before you submit it.
            </Alert>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="cbo-th" rowSpan={2}>
                    MFO/PPA (1)
                  </th>
                  <th className="cbo-th" rowSpan={2}>
                    Implementing Unit (2)
                  </th>
                  <th className="cbo-th text-center" colSpan={3}>
                    Appropriation
                  </th>
                  <th className="cbo-th text-center" colSpan={3}>
                    Allotment Released
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Balance of Appropriation (9)
                  </th>
                  <th className="cbo-th text-center" colSpan={3}>
                    Obligations Incurred
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Unobligated Allotment (13)
                  </th>
                </tr>
                <tr>
                  <th className="cbo-th text-right">Continuing (3)</th>
                  <th className="cbo-th text-right">Current (4)</th>
                  <th className="cbo-th text-right">Total (5)</th>
                  <th className="cbo-th text-right">Previous (6)</th>
                  <th className="cbo-th text-right">This Quarter (7)</th>
                  <th className="cbo-th text-right">Total (8)</th>
                  <th className="cbo-th text-right">Previous (10)</th>
                  <th className="cbo-th text-right">This Quarter (11)</th>
                  <th className="cbo-th text-right">Total (12)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const appropriation = r.continuing + r.current;
                  const allotment = r.allotmentPrevious + r.allotmentThis;
                  const obligation = r.obligationPrevious + r.obligationThis;
                  const unobligated = allotment - obligation;
                  return (
                    <tr key={r.key}>
                      <td className="cbo-td">
                        <span className="font-mono text-2xs text-slate-500">{r.fppCode}</span>{' '}
                        <span>{r.fppName}</span>
                        <span className="block text-2xs text-slate-400">{r.expenseClass}</span>
                      </td>
                      <td className="cbo-td text-slate-600">{r.officeName}</td>
                      <Amount value={r.continuing} />
                      <Amount value={r.current} />
                      <Amount value={appropriation} />
                      <Amount value={r.allotmentPrevious} />
                      <Amount value={r.allotmentThis} />
                      <Amount value={allotment} />
                      <Amount value={appropriation - allotment} />
                      <Amount value={r.obligationPrevious} />
                      <Amount value={r.obligationThis} />
                      <Amount value={obligation} />
                      <Amount value={unobligated} negative={unobligated < 0} />
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 font-semibold">
                  <td className="cbo-td border-b-0" colSpan={2}>
                    TOTAL
                  </td>
                  <Amount value={totals.continuing} foot />
                  <Amount value={totals.current} foot />
                  <Amount value={totals.continuing + totals.current} foot />
                  <Amount value={totals.allotmentPrevious} foot />
                  <Amount value={totals.allotmentThisPeriod} foot />
                  <Amount value={totals.allotmentTotal} foot />
                  <Amount value={totals.continuing + totals.current - totals.allotmentTotal} foot />
                  <Amount value={totals.obligationPrevious} foot />
                  <Amount value={totals.obligationThisPeriod} foot />
                  <Amount value={totals.obligationTotal} foot />
                  <Amount value={totals.allotmentTotal - totals.obligationTotal} foot />
                </tr>
              </tfoot>
            </table>
          </div>

          {rows.length === 0 && (
            <Alert tone="info" title="Nothing released or committed yet" className="mt-4">
              No allotment has been released and no obligation certified in {fiscalYear} for this
              fund up to the end of {periodLabel(period).toLowerCase()}.
            </Alert>
          )}
        </>
      )}
    </ReportShell>
  );
}

function Amount({
  value,
  negative,
  foot,
}: {
  value: Centavos;
  negative?: boolean;
  foot?: boolean;
}) {
  return (
    <td
      className={`cbo-td cbo-amount ${negative ? 'text-rose-700' : ''} ${foot ? 'border-b-0' : ''}`}
    >
      {formatPeso(value, { symbol: false, dash: !foot, parens: true })}
    </td>
  );
}
