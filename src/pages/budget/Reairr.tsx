import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { PeriodPicker } from '@/components/PeriodPicker';
import { Alert, Spinner } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { useEstimatedReceipts } from '@/data/queries';
import { useCollectionReports } from '@/data/useCollectionReports';
import { periodHeading, periodRange, type ReportPeriod } from '@/lib/reportPeriods';
import { formatPeso } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import { buildReairr, type ReairrEntry } from './reairrReport';
import { fundLabel } from './Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { BUDGET_MONITORING_TABS } from '@/layout/sections';

/**
 * Registry of Estimated and Actual Income/Revenues and Receipts.
 * GAM for LGUs, Appendix 23.
 *
 * The statutory book for the Estimated Receipts module. Section A is the
 * ordinance's income estimates; Section B is what the Treasury reported
 * collecting, one line per Report of Collections and Deposits.
 *
 * The two sections are footed differently on purpose - see the note at the
 * head of reairr.ts.
 */
export default function Reairr() {
  const { fiscalYear, fundCode } = useFilters();
  const [period, setPeriod] = useState<ReportPeriod>(() => ({
    mode: 'MONTHLY',
    index: Number(todayPh().slice(0, 4)) === fiscalYear ? Number(todayPh().slice(5, 7)) : 1,
  }));

  const estimates = useEstimatedReceipts(fiscalYear, fundCode);
  const rcds = useCollectionReports(fiscalYear, fundCode);

  const range = periodRange(period, fiscalYear);

  const registry = useMemo(
    () =>
      buildReairr({
        estimates: estimates.data,
        rcds: rcds.data,
        from: range.from,
        to: range.to,
        estimateParticulars: `Income estimates on record for ${fiscalYear}`,
      }),
    [estimates.data, rcds.data, range.from, range.to, fiscalYear],
  );

  const loading = estimates.loading || rcds.loading;
  const codes = registry.accountCodes;

  const exportRows = [
    ...registry.estimates.map((e) => ({ section: 'A. Estimates', e })),
    ...registry.collections.map((e) => ({ section: 'B. Actual Collections', e })),
  ];

  const exportColumns: ExportColumn<{ section: string; e: ReairrEntry }>[] = [
    { key: 'section', header: 'Section', value: (r) => r.section },
    { key: 'date', header: 'Date', value: (r) => r.e.date },
    { key: 'ref', header: 'Reference No.', value: (r) => r.e.reference },
    { key: 'particulars', header: 'Particulars', value: (r) => r.e.particulars },
    { key: 'amount', header: 'Amount', kind: 'amount', value: (r) => r.e.amount },
  ];

  return (
    <ReportShell
      printLayout="landscape"
      tabs={<SectionTabs tabs={BUDGET_MONITORING_TABS} />}
      meta={{
        title: 'Registry of Estimated and Actual Income/Revenues and Receipts',
        fundLabel: fundLabel(fundCode),
        periodLabel: periodHeading(period, fiscalYear),
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Registry of Income' }]}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={<PeriodPicker value={period} onChange={setPeriod} />}
      footnote={
        <>
          <p>
            <strong>REAIRR</strong> - GAM for Local Government Units, Appendix 23. Maintained by the
            Accounting Unit.
          </p>
          {/*
            The asymmetry is the thing a reader will query, so it is answered
            on the page rather than only in the code.
          */}
          <p className="mt-1">
            Section A carries the whole year&apos;s estimate whatever period is chosen. An estimate
            is authority for the year, not something that happened in a month, and the Local
            Finance Committee certifies no monthly figure. Section B is cut to the period, and
            accumulated, as instruction 3 requires.
          </p>
          <p className="mt-1">
            Section B lists one line per Report of Collections and Deposits (and per Report of
            e-Collections and Deposits), which is the document instruction 1 names. A report counts
            once Accounting has journalized it, so this registry agrees with the General Ledger.
            Drafts, reports still awaiting their journal entry, and cancelled ones are not counted.
          </p>
        </>
      }
    >
      {!loading && rcds.waiting.count > 0 && (
        <Alert tone="info" title="Certified, not yet journalized" className="mb-4 no-print">
          {rcds.waiting.count === 1 ? 'One report' : `${rcds.waiting.count} reports`} (
          {rcds.waiting.numbers.join(', ') || 'no number yet'}) totalling{' '}
          {formatPeso(rcds.waiting.total)} {rcds.waiting.count === 1 ? 'is' : 'are'} with
          Accounting. {rcds.waiting.count === 1 ? 'It is' : 'They are'} counted here once the journal
          entry is posted.
        </Alert>
      )}
      {loading ? (
        <Spinner />
      ) : rcds.error ? (
        <Alert tone="error" title="The collections could not be read">
          {rcds.error}
        </Alert>
      ) : codes.length === 0 ? (
        <Alert tone="info" title="Nothing on this registry yet">
          No income estimate has been loaded for {fiscalYear} and no Report of Collections and
          Deposits has been submitted up to {periodHeading(period, fiscalYear).toLowerCase()}.
        </Alert>
      ) : (
        <>
          <Section
            title="A. Income/Revenues and Receipts Estimates"
            amountHeader="Estimate"
            entries={registry.estimates}
            codes={codes}
            names={registry.accountNames}
            footings={[
              {
                label: 'Total estimates for the year',
                amount: registry.estimateTotal,
                byAccount: registry.estimateByAccount,
                emphasis: true,
              },
            ]}
          />

          <Section
            title="B. Actual Collections"
            amountHeader="Collections"
            entries={registry.collections}
            codes={codes}
            names={registry.accountNames}
            leading={{
              label: 'Total to date, previous months',
              amount: registry.collectionsBroughtForward,
              byAccount: registry.collectionsBroughtForwardByAccount,
            }}
            footings={[
              {
                label: 'Total amount for the period',
                amount: registry.collectionsThisPeriod,
                byAccount: registry.collectionsThisPeriodByAccount,
              },
              {
                label: 'Cumulative total to date',
                amount: registry.collectionsToDate,
                byAccount: registry.collectionsToDateByAccount,
                emphasis: true,
              },
            ]}
          />

          {/*
            Not on the GAM form. It is the subtraction every reader of the two
            sections performs anyway, and doing it here means it is done the
            same way every time - and it is the figure a supplemental budget is
            argued from.
          */}
          <Section
            title="Estimate not yet realised"
            amountHeader="Balance"
            entries={[]}
            codes={codes}
            names={registry.accountNames}
            footings={[
              {
                label: 'Estimate less collections to date',
                amount: registry.shortfall,
                byAccount: registry.shortfallByAccount,
                emphasis: true,
              },
            ]}
          />
          <p className="mt-2 text-xs text-slate-500">
            A negative balance is income collected beyond what the ordinance estimated. It is not an
            error, and it is the evidence a supplemental budget rests on.
          </p>
        </>
      )}
    </ReportShell>
  );
}

interface Footing {
  label: string;
  amount: number;
  byAccount: Record<string, number>;
  emphasis?: boolean;
}

function Section({
  title,
  amountHeader,
  entries,
  codes,
  names,
  leading,
  footings,
}: {
  title: string;
  amountHeader: string;
  entries: ReairrEntry[];
  codes: string[];
  names: Record<string, string>;
  leading?: Footing;
  footings: Footing[];
}) {
  return (
    <div className="mb-6 overflow-x-auto">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-navy-800">{title}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-300 text-left text-slate-600">
            <th className="cbo-th" style={{ width: '6rem' }}>
              Date
            </th>
            <th className="cbo-th" style={{ width: '9rem' }}>
              Reference No.
            </th>
            <th className="cbo-th">Particulars</th>
            <th className="cbo-th text-right" style={{ width: '9rem' }}>
              {amountHeader}
            </th>
            {codes.map((c) => (
              <th key={c} className="cbo-th text-right" style={{ width: '9rem' }}>
                <span className="block font-mono">{c}</span>
                <span className="block text-2xs font-normal text-slate-400">{names[c] ?? ''}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {leading && <FootingRow {...leading} codes={codes} />}
          {entries.map((e, i) => (
            <tr key={`${e.reference}-${e.date}-${i}`} className="border-b border-slate-100">
              <td className="cbo-td font-mono">{e.date || '-'}</td>
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
          {footings.map((f) => (
            <FootingRow key={f.label} {...f} codes={codes} rule />
          ))}
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
}: Footing & { codes: string[]; rule?: boolean }) {
  return (
    <tr
      className={`${rule ? 'border-t border-slate-300' : 'border-b border-slate-100'} ${
        emphasis ? 'font-semibold text-navy-900' : 'text-slate-600'
      }`}
    >
      <td className="cbo-td" colSpan={3}>
        {label}
      </td>
      <td className={`cbo-td cbo-amount ${amount < 0 ? 'text-rose-600' : ''}`}>
        {formatPeso(amount)}
      </td>
      {codes.map((c) => (
        <td
          key={c}
          className={`cbo-td cbo-amount ${(byAccount[c] ?? 0) < 0 ? 'text-rose-600' : ''}`}
        >
          {byAccount[c] ? formatPeso(byAccount[c]) : ''}
        </td>
      ))}
    </tr>
  );
}
