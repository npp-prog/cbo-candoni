import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ReportShell } from '@/components/ReportShell';
import { PeriodPicker } from '@/components/PeriodPicker';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field } from '@/components/ui/Field';
import { OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAllotments, useBudgetBalances, useObligations } from '@/data/queries';
import { periodHeading, periodRange, type ReportPeriod } from '@/lib/reportPeriods';
import { fppLabel } from '@/lib/fppCodes';
import { formatPeso } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import { RAAO_FORMS, buildRaao, totalRaao, type RaaoSection, type RaaoSheet } from './raao';
import { RAAO_SLUGS, RegistryTabs } from './registryTabs';
import { fundLabel } from './Obligations';

/**
 * The four statutory registries, GAM Appendices 19 to 22.
 *
 * One screen, because the four instruction sheets are identical apart from the
 * title. The class comes off the route.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DEFAULTS TO A MONTH
 * ---------------------------------------------------------------------------
 * Every other register in CBO opens on the year to date, and this one does
 * not. The form is headed "For the Month of ____" and instruction 7 is about
 * carrying one month's totals onto the next month's first line: it is a
 * monthly book. Opening it on the year would show a sheet with no brought
 * forward figure at all and quietly change what the form means.
 *
 * The other periods are still offered - the quarter and the year are what
 * anyone actually wants when checking a figure - but the month is what prints.
 */
export default function Raao() {
  const { slug } = useParams();
  const klass = RAAO_SLUGS[slug ?? ''];

  const { fiscalYear, fundCode } = useFilters();
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [period, setPeriod] = useState<ReportPeriod>(() => ({
    mode: 'MONTHLY',
    // The month CBO is in, when the fiscal year is the current one. Opening a
    // past year on "September" because today is September would show an empty
    // sheet and look broken, so an old year opens on January.
    index: Number(todayPh().slice(0, 4)) === fiscalYear ? Number(todayPh().slice(5, 7)) : 1,
  }));

  const balances = useBudgetBalances(fiscalYear, fundCode, officeId);
  const allotments = useAllotments(fiscalYear, fundCode);
  const obligations = useObligations(fiscalYear, fundCode);

  const range = periodRange(period, fiscalYear);

  const sheets = useMemo(() => {
    if (!klass) return [];
    return buildRaao({
      expenseClass: klass,
      allotments: allotments.data,
      obligations: obligations.data,
      appropriations: balances.data,
      from: range.from,
      to: range.to,
      officeId,
    });
  }, [klass, allotments.data, obligations.data, balances.data, range.from, range.to, officeId]);

  const totals = useMemo(() => totalRaao(sheets), [sheets]);

  if (!klass) {
    return (
      <Alert tone="error" title="No such registry">
        The address names a registry that does not exist. The four are Personal Services, MOOE,
        Capital Outlay and Financial Expenses.
      </Alert>
    );
  }

  const form = RAAO_FORMS[klass];
  const loading = balances.loading || allotments.loading || obligations.loading;

  /**
   * The export is one flat row per register line, not the printed shape.
   * A spreadsheet of a form with two sections and a footing every month is
   * unusable; a spreadsheet of the lines is what gets filtered and totalled.
   */
  const exportRows = sheets.flatMap((s) => [
    ...s.budget.entries.map((e) => ({ sheet: s, section: 'A. Budget', e })),
    ...s.actual.entries.map((e) => ({ sheet: s, section: 'B. Actual', e })),
  ]);

  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: 'office', header: 'Office', value: (r) => r.sheet.officeName },
    { key: 'fpp', header: 'F.P.P.', value: (r) => r.sheet.fppCode },
    { key: 'fppName', header: 'F.P.P. Name', value: (r) => r.sheet.fppName },
    { key: 'section', header: 'Section', value: (r) => r.section },
    { key: 'date', header: 'Date', value: (r) => r.e.date },
    { key: 'ref', header: 'Reference', value: (r) => r.e.reference },
    { key: 'particulars', header: 'Particulars', value: (r) => r.e.particulars },
    { key: 'amount', header: 'Amount', kind: 'amount', value: (r) => r.e.amount },
  ];

  return (
    <ReportShell
      meta={{
        title: form.title,
        fundLabel: fundLabel(fundCode),
        periodLabel: periodHeading(period, fiscalYear),
        preparedBy: '',
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Registry', to: '/budget/registry' }]}
      tabs={<RegistryTabs active={klass} />}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={
        <>
          <PeriodPicker value={period} onChange={setPeriod} />
          <Field label="Office" className="w-72">
            <OfficePicker value={officeId} onChange={setOfficeId} />
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            <strong>{form.acronym}</strong> - GAM for Local Government Units, Appendix{' '}
            {form.appendix}. Maintained by the Accounting Unit.
          </p>
          {/*
            Said here and not left to be discovered. The manual's reference
            column is headed "Reference/CAFOA No.", and the CAFOA is suspended -
            so what is in that column is an Obligation Request number. An
            auditor who reads the column head and the entry will ask.
          */}
          <p className="mt-1">
            The reference in Section B is the Obligation Request number. The manual names the CAFOA
            there; the CAFOA (Appendix 28) is suspended and CBO does not raise one.
          </p>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : sheets.length === 0 ? (
        <Alert tone="info" title="Nothing on this registry yet">
          No appropriation, allotment or obligation of this class was found for{' '}
          {periodHeading(period, fiscalYear).toLowerCase()}.
        </Alert>
      ) : (
        <>
          <RegistryTotals totals={totals} count={sheets.length} />
          {sheets.map((s) => (
            <Sheet key={`${s.officeId}__${s.fppCode}`} sheet={s} period={period} />
          ))}
        </>
      )}
    </ReportShell>
  );
}

function RegistryTotals({
  totals,
  count,
}: {
  totals: ReturnType<typeof totalRaao>;
  count: number;
}) {
  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        All {count} {count === 1 ? 'sheet' : 'sheets'} of this registry
      </p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Appropriation" value={totals.appropriation} />
        <Figure label="Allotments to date" value={totals.allotmentToDate} />
        <Figure label="Obligations to date" value={totals.obligationToDate} />
        <Figure label="Unobligated balance" value={totals.unobligatedBalance} emphasis />
      </dl>
    </div>
  );
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={`tabular font-mono ${
          emphasis ? 'font-semibold text-navy-900' : 'text-navy-800'
        } ${value < 0 ? 'text-rose-600' : ''}`}
      >
        {formatPeso(value)}
      </dd>
    </div>
  );
}

/** One Function/Program/Project: one sheet of the registry. */
function Sheet({ sheet, period }: { sheet: RaaoSheet; period: ReportPeriod }) {
  const codes = sheet.accountCodes;

  return (
    <section className="mb-8 break-inside-avoid">
      <header className="mb-2 border-b border-slate-300 pb-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <div>
            <p className="text-sm font-semibold text-navy-900">
              {/*
                Both halves of the code, always. `fppLabel` gives back the code
                unchanged when Annex A does not list it, which is the honest
                answer for a locally numbered project.
              */}
              F.P.P.: {fppLabel(sheet.fppCode)}
            </p>
            <p className="text-xs text-slate-500">
              {sheet.officeName}
              {sheet.fppName && sheet.fppName !== sheet.fppCode ? ` - ${sheet.fppName}` : ''}
            </p>
          </div>
          <p className="text-xs text-slate-500">
            Appropriation{' '}
            <span className="tabular font-mono text-navy-900">
              {formatPeso(sheet.appropriation)}
            </span>
          </p>
        </div>
      </header>

      <SectionTable
        title="A. Budget"
        amountHeader="Amount of Allotment"
        section={sheet.budget}
        codes={codes}
        period={period}
      />
      <SectionTable
        title="B. Actual"
        amountHeader="Amount of Obligation"
        section={sheet.actual}
        codes={codes}
        period={period}
      />

      <p className="mt-2 text-right text-sm">
        <span className="text-slate-600">Unobligated balance of allotment: </span>
        <span
          className={`tabular font-mono font-semibold ${
            sheet.unobligatedBalance < 0 ? 'text-rose-600' : 'text-navy-900'
          }`}
        >
          {formatPeso(sheet.unobligatedBalance)}
        </span>
      </p>
    </section>
  );
}

function SectionTable({
  title,
  amountHeader,
  section,
  codes,
  period,
}: {
  title: string;
  amountHeader: string;
  section: RaaoSection;
  codes: string[];
  period: ReportPeriod;
}) {
  const monthly = period.mode === 'MONTHLY';

  return (
    <div className="mb-3 overflow-x-auto">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-navy-800">{title}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-300 text-left text-slate-600">
            <th className="cbo-th" style={{ width: '6rem' }}>
              Date
            </th>
            <th className="cbo-th" style={{ width: '9rem' }}>
              Reference
            </th>
            <th className="cbo-th">Particulars</th>
            <th className="cbo-th text-right" style={{ width: '9rem' }}>
              {amountHeader}
            </th>
            {codes.map((c) => (
              <th key={c} className="cbo-th text-right font-mono" style={{ width: '8rem' }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/*
            Instruction 7: the previous months' totals on the first line. It is
            shown even when it is zero, because a blank first line and a zero
            first line say different things - the second says the register was
            looked at and there was nothing there.
          */}
          <FootingRow
            label={monthly ? 'Total for the previous months' : 'Total brought forward'}
            amount={section.broughtForward}
            byAccount={section.broughtForwardByAccount}
            codes={codes}
          />

          {section.entries.map((e, i) => (
            <tr key={`${e.reference}-${e.date}-${i}`} className="border-b border-slate-100">
              <td className="cbo-td font-mono">{e.date}</td>
              <td className="cbo-td font-mono">{e.reference || '-'}</td>
              <td className="cbo-td">{e.particulars}</td>
              <td className="cbo-td cbo-amount">{formatPeso(e.amount)}</td>
              {codes.map((c) => (
                <td key={c} className="cbo-td cbo-amount">
                  {e.byAccount[c] ? formatPeso(e.byAccount[c]) : ''}
                </td>
              ))}
            </tr>
          ))}

          <FootingRow
            label={monthly ? 'Total for the month' : 'Total for the period'}
            amount={section.thisPeriod}
            byAccount={section.thisPeriodByAccount}
            codes={codes}
            rule
          />
          <FootingRow
            label="Accumulated total to date"
            amount={section.toDate}
            byAccount={section.toDateByAccount}
            codes={codes}
            rule
            emphasis
          />
        </tbody>
      </table>
    </div>
  );
}

function FootingRow({
  label,
  amount,
  byAccount,
  codes,
  rule,
  emphasis,
}: {
  label: string;
  amount: number;
  byAccount: Record<string, number>;
  codes: string[];
  rule?: boolean;
  emphasis?: boolean;
}) {
  return (
    <tr
      className={`${rule ? 'border-t border-slate-300' : 'border-b border-slate-100'} ${
        emphasis ? 'font-semibold text-navy-900' : 'text-slate-600'
      }`}
    >
      <td className="cbo-td" colSpan={3}>
        {label}
      </td>
      <td className="cbo-td cbo-amount">{formatPeso(amount)}</td>
      {codes.map((c) => (
        <td key={c} className="cbo-td cbo-amount">
          {byAccount[c] ? formatPeso(byAccount[c]) : ''}
        </td>
      ))}
    </tr>
  );
}
