import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { monthName } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { COLLECTION_TABS, COLLECTION_CRUMBS } from '../treasury/sections';
import { fundLabel } from '../budget/Obligations';
import {
  BASIS,
  buildRptAbstract,
  type RptAbstractMonth,
  type RptLedgerEntry,
  type RptTaxBlock,
} from './rptAbstractReport';

/**
 * The Abstract of Real Property Tax Collections, GAM Appendix 45.
 *
 * GAM Volume I, Section 68 puts this in the Accountant's hands, not the
 * Treasurer's, and says what it is for: to facilitate the distribution and
 * remittance of the shares of the government units concerned. The arithmetic
 * and the citations are in rptAbstract.ts.
 */
export default function RptAbstract() {
  const { fiscalYear, fundCode } = useFilters();
  const [fromPeriod, setFromPeriod] = useState(1);
  const [throughPeriod, setThroughPeriod] = useState(12);

  const ledger = useLedgerEntries(fiscalYear, fundCode, { throughPeriod });

  const data = useMemo(
    () =>
      buildRptAbstract({
        entries: (ledger.data ?? []) as unknown as RptLedgerEntry[],
        fromPeriod,
        throughPeriod,
      }),
    [ledger.data, fromPeriod, throughPeriod],
  );

  const exportColumns: ExportColumn<RptAbstractMonth>[] = [
    { key: 'month', header: 'Month', value: (m) => monthName(m.period) },
    { key: 'basic', header: 'Basic RPT', kind: 'amount', value: (m) => m.basicGross },
    { key: 'basicDisc', header: 'Less: Discount', kind: 'amount', value: (m) => m.basicDiscount },
    { key: 'sef', header: 'Special Education Fund', kind: 'amount', value: (m) => m.sefGross },
    { key: 'sefDisc', header: 'Less: Discount', kind: 'amount', value: (m) => m.sefDiscount },
    { key: 'pen', header: 'Fines and Penalties', kind: 'amount', value: (m) => m.penalties },
  ];

  const nothing =
    data.basic.gross === 0 && data.sef.gross === 0 && data.penalties === 0;

  return (
    <ReportShell
      meta={{
        title: 'Abstract of Real Property Tax Collections',
        fundLabel: fundLabel(fundCode),
        periodLabel: `${monthName(fromPeriod)} to ${monthName(throughPeriod)} ${fiscalYear}`,
        preparedBy: 'Municipal Accountant',
        certifiedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Abstract of RPT Collections' }]}
      tabs={<SectionTabs tabs={COLLECTION_TABS} />}
      rows={data.months}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="From">
            <Select value={fromPeriod} onChange={(e) => setFromPeriod(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Through">
            <Select value={throughPeriod} onChange={(e) => setThroughPeriod(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            GAM Volume I, Section 68: the Accountant maintains this abstract &ldquo;to facilitate
            the distribution and remittance of the shares of the different government units
            concerned in the real property tax collections&rdquo;. It is drawn from the General
            Ledger, so it cannot disagree with the books.
          </p>
          <p className="mt-1">
            The sharing is not Candoni&rsquo;s to set. The basic tax is shared 40 per cent to the
            municipality, 35 to the province and 25 to the barangays (Section 69); the Special
            Education Fund is &ldquo;divided equally between the provincial and municipal school
            boards&rdquo; (Section 109), which is why the barangays have no share of it. Both are
            the rules for a municipality within a province. The discount follows the tax, because
            Section 43 apportions it on the same sharing.
          </p>
        </>
      }
    >
      {ledger.loading ? (
        <Spinner label="Reading the General Ledger" />
      ) : nothing ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No real property tax was collected in the {fundLabel(fundCode)} between{' '}
          {monthName(fromPeriod)} and {monthName(throughPeriod)} {fiscalYear}.
        </p>
      ) : (
        <>
          <TaxBlock block={data.basic} />
          <TaxBlock block={data.sef} />

          <section className="mb-6">
            <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
              Fines and Penalties on Property Taxes
            </h3>
            <Line label="Collected in the period" amount={data.penalties} />
            {data.penalties !== 0 && (
              <Alert tone="warning" className="mt-2">
                Section 44 shares fines and penalties on the same basis as the tax they arose from
                &mdash; but the basic tax and the Special Education Fund share differently, and the
                chart carries a single account, 40105020, for the penalties on both. CFMS cannot
                tell which part of this figure belongs to which tax, so it is left unallocated
                rather than put through one of the two rates. The Treasurer&rsquo;s own register is
                what splits it.
              </Alert>
            )}
          </section>

          <section className="mb-6">
            <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
              Summary
            </h3>
            <Line label="Retained by the Municipality of Candoni" amount={data.totalOwn} />
            <Line label="Due to the Province and the barangays" amount={data.totalToRemit} strong />
          </section>

          <Alert tone={data.dueToLgusDifference === 0 ? 'success' : 'warning'} className="mb-4">
            {data.dueToLgusDifference === 0 ? (
              <p>
                Due to LGUs (20201070) moved by {formatPeso(data.dueToLgusMovement)} in this period,
                which is exactly the share computed above. The sharing entry has been drawn for
                everything this abstract covers.
              </p>
            ) : (
              <>
                <p className="font-medium">The sharing entry does not match this abstract.</p>
                <p className="mt-1">
                  This abstract puts {formatPeso(data.totalToRemit)} beyond Candoni&rsquo;s own
                  share, while Due to LGUs (20201070) moved by{' '}
                  {formatPeso(data.dueToLgusMovement)} &mdash; a difference of{' '}
                  {formatPeso(Math.abs(data.dueToLgusDifference))}.{' '}
                  {data.dueToLgusDifference < 0
                    ? 'That is share collected and not yet recognised as owing. Draw the journal voucher debiting the revenue accounts and crediting Due to LGUs.'
                    : 'More has been recognised as owing than this abstract accounts for. Some of it may relate to a period outside the range above, or to something other than real property tax.'}
                </p>
              </>
            )}
          </Alert>

          <Alert tone="info">
            <p>
              <strong>The barangay share is a total, not a list.</strong> Section 271 of the Local
              Government Code gives the 25 per cent to the barangay where the property stands, and a
              collection in CFMS records the payor and the receipt but not the property &mdash; so
              there is nothing here to group by. The {formatPeso(
                data.basic.rows.find((r) => r.label === 'Barangays')?.netShare ?? 0,
              )}{' '}
              above is right in total; which barangay each peso belongs to has to come from the
              Treasurer&rsquo;s Real Property Tax Account Register. Recording the barangay on the
              collection is the change that would let CFMS print the list.
            </p>
          </Alert>

          <section className="mt-6">
            <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
              Month by month
            </h3>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="cbo-th">Month</th>
                  <th className="cbo-th text-right">Basic RPT</th>
                  <th className="cbo-th text-right">Less: Discount</th>
                  <th className="cbo-th text-right">Special Education Fund</th>
                  <th className="cbo-th text-right">Less: Discount</th>
                  <th className="cbo-th text-right">Fines and Penalties</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={m.period}>
                    <td className="cbo-td">{monthName(m.period)}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(m.basicGross, { symbol: false })}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(m.basicDiscount, { symbol: false })}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(m.sefGross, { symbol: false })}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(m.sefDiscount, { symbol: false })}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(m.penalties, { symbol: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

function TaxBlock({ block }: { block: RptTaxBlock }) {
  if (block.gross === 0 && block.discount === 0) return null;

  return (
    <section className="mb-6">
      <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
        {block.title}
      </h3>

      <Line label="Tax earned in the period" amount={block.gross} />
      <Line label="Less: discount allowed" amount={block.discount} />
      <Line label="Net collectible" amount={block.net} strong />

      <table className="mt-3 w-full border-collapse">
        <thead>
          <tr>
            <th className="cbo-th">Share of</th>
            <th className="cbo-th text-right">Rate</th>
            <th className="cbo-th text-right">Of the tax</th>
            <th className="cbo-th text-right">Of the discount</th>
            <th className="cbo-th text-right">Net share</th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r) => (
            <tr key={r.label}>
              <td className="cbo-td">
                {r.label}
                {r.own && <span className="ml-2 text-2xs uppercase text-slate-400">retained</span>}
              </td>
              <td className="cbo-td cbo-amount">{(r.rate / (BASIS / 100)).toFixed(0)}%</td>
              <td className="cbo-td cbo-amount">{formatPeso(r.grossShare, { symbol: false })}</td>
              <td className="cbo-td cbo-amount">{formatPeso(r.discountShare, { symbol: false })}</td>
              <td className="cbo-td cbo-amount font-medium">
                {formatPeso(r.netShare, { symbol: false })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Line({ label, amount, strong }: { label: string; amount: Centavos; strong?: boolean }) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1 pl-4 ${
        strong ? 'border-t border-slate-300 font-medium' : ''
      }`}
    >
      <span className="text-sm text-navy-800">{label}</span>
      <span className="w-44 text-right font-mono text-sm tabular text-navy-900">
        {formatPeso(amount, { symbol: false, parens: true })}
      </span>
    </div>
  );
}
