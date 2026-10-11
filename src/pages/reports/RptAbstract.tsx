import { useEffect, useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { Field, Select, TextInput } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useCollections, useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { monthName } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from '../treasury/sections';
import { fundLabel } from '../budget/Obligations';
import {
  BASIS,
  buildRptAbstract,
  buildRptSchedule,
  type RptCollection,
  type RptAbstractMonth,
  type RptAbstractRow,
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
  /*
   * Patch 169: a From date and a To date, and the collecting officer, in
   * place of the From and Through months.
   */
  const [fromDate, setFromDate] = useState(`${fiscalYear}-01-01`);
  const [toDate, setToDate] = useState(`${fiscalYear}-12-31`);
  const [officer, setOfficer] = useState('');
  useEffect(() => {
    setFromDate(`${fiscalYear}-01-01`);
    setToDate(`${fiscalYear}-12-31`);
  }, [fiscalYear]);
  const fromPeriod = Number(fromDate.slice(5, 7)) || 1;
  const throughPeriod = Math.max(fromPeriod, Number(toDate.slice(5, 7)) || 12);
  const rangeLabel = `${longDate(fromDate)} to ${longDate(toDate)}`;

  const ledger = useLedgerEntries(fiscalYear, fundCode, { throughPeriod });

  /*
   * The receipts behind the schedule.
   *
   * Scoped to the fund on the filter, like everything else on this page. The
   * Special Education Fund is recognised in its own books (GAM Volume I,
   * Section 108), so the SEF columns fill when the Special Education Fund is
   * selected and the basic columns when the General Fund is. One receipt
   * collects both (Section 113), but CFMS records a collection against one
   * fund, so each half appears on the fund it was recorded in.
   */
  const collections = useCollections(fiscalYear, fundCode);

  /** The collecting officers who issued a receipt in the range. */
  const officers = useMemo(
    () =>
      [
        ...new Set(
          (collections.data ?? [])
            .filter((c) => c.orDate >= fromDate && c.orDate <= toDate)
            .map((c) => (c.collectingOfficerName ?? '').trim())
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [collections.data, fromDate, toDate],
  );

  const schedule = useMemo(
    () =>
      buildRptSchedule({
        // Patch 175: AF 56 receipts are on their own abstract.
        collections: (collections.data ?? [])
          .filter((c) => !c.rpt)
          .filter((c) => !officer || (c.collectingOfficerName ?? '').trim() === officer) as unknown as RptCollection[],
        fromDate,
        toDate,
      }),
    [collections.data, fromDate, toDate, officer],
  );

  const data = useMemo(
    () =>
      buildRptAbstract({
        entries: (ledger.data ?? []) as unknown as RptLedgerEntry[],
        fromPeriod,
        throughPeriod,
        fromDate,
        toDate,
      }),
    [ledger.data, fromPeriod, throughPeriod, fromDate, toDate],
  );

  const exportColumns: ExportColumn<RptAbstractMonth>[] = [
    { key: 'month', header: 'Month', value: (m) => monthName(m.period) },
    { key: 'basic', header: 'Basic RPT', kind: 'amount', value: (m) => m.basicGross },
    { key: 'basicDisc', header: 'Less: Discount', kind: 'amount', value: (m) => m.basicDiscount },
    { key: 'sef', header: 'Special Education Fund', kind: 'amount', value: (m) => m.sefGross },
    { key: 'sefDisc', header: 'Less: Discount', kind: 'amount', value: (m) => m.sefDiscount },
    { key: 'pen', header: 'Fines and Penalties', kind: 'amount', value: (m) => m.penalties },
  ];

  /** One officer's abstract: the receipts he issued, for the export. */
  const receiptColumns: ExportColumn<RptAbstractRow>[] = [
    { key: 'date', header: 'Date', value: (r) => r.orDate },
    { key: 'or', header: 'O.R. No.', value: (r) => r.orNumber },
    { key: 'payor', header: 'Taxpayer', value: (r) => r.payorName },
    { key: 'period', header: 'Period covered', value: (r) => r.periodCovered },
    { key: 'bc', header: 'Basic - current', kind: 'amount', value: (r) => r.basicCurrent },
    { key: 'bp', header: 'Basic - preceding', kind: 'amount', value: (r) => r.basicPreceding },
    { key: 'pen', header: 'Penalties', kind: 'amount', value: (r) => r.penalties },
    { key: 'sc', header: 'SEF - current', kind: 'amount', value: (r) => r.sefCurrent },
    { key: 'sp', header: 'SEF - preceding', kind: 'amount', value: (r) => r.sefPreceding },
    { key: 'total', header: 'Total', kind: 'amount', value: (r) => r.total },
    { key: 'brgy', header: 'Barangay', value: (r) => r.barangayName ?? '' },
    { key: 'share', header: 'Barangay share', kind: 'amount', value: (r) => r.barangayShare },
  ];

  const nothing = officer
    ? schedule.rows.length === 0
    : data.basic.gross === 0 && data.sef.gross === 0 && data.penalties === 0;

  return (
    <ReportShell
      printLayout="landscape"
      meta={{
        title: 'Abstract of Real Property Tax Collections',
        fundLabel: fundLabel(fundCode),
        periodLabel: officer ? `${rangeLabel} - Collecting Officer: ${officer}` : rangeLabel,
        preparedBy: 'Municipal Accountant',
        certifiedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Abstract of RPT Collections' }]}
      tabs={<GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />}
      rows={(officer ? schedule.rows : data.months) as Array<RptAbstractRow | RptAbstractMonth>}
      exportColumns={
        (officer ? receiptColumns : exportColumns) as unknown as ExportColumn<
          RptAbstractRow | RptAbstractMonth
        >[]
      }
      filters={
        <>
          <Field label="From date">
            <TextInput
              type="date"
              value={fromDate}
              min={`${fiscalYear}-01-01`}
              max={toDate}
              onChange={(e) => e.target.value && setFromDate(e.target.value)}
            />
          </Field>
          <Field label="To date">
            <TextInput
              type="date"
              value={toDate}
              min={fromDate}
              max={`${fiscalYear}-12-31`}
              onChange={(e) => e.target.value && setToDate(e.target.value)}
            />
          </Field>
          <Field label="Collecting officer">
            <Select value={officer} onChange={(e) => setOfficer(e.target.value)}>
              <option value="">All collecting officers</option>
              {officers.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
              {officer && !officers.includes(officer) && <option value={officer}>{officer}</option>}
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
          No real property tax was collected in the {fundLabel(fundCode)} from {rangeLabel}
          {officer ? ` by ${officer}` : ''}.
        </p>
      ) : (
        <>
          {(schedule.withoutBarangay > 0 || schedule.withoutTaxYear > 0) && (
            <Alert tone="warning" title="Some receipts leave a column blank" className="mb-4">
              {schedule.withoutBarangay > 0 && (
                <p>
                  {schedule.withoutBarangay} receipt
                  {schedule.withoutBarangay === 1 ? '' : 's'} carrying basic real property tax name
                  no barangay, so {formatPeso(schedule.withoutBarangayAmount)} of barangay share is
                  on the form without an owner. The barangay is set on the receipt, in Treasury
                  &rarr; Collections &mdash; and it is the barangay the <em>property</em> stands in,
                  not the one the payor lives in.
                </p>
              )}
              {schedule.withoutTaxYear > 0 && (
                <p className={schedule.withoutBarangay > 0 ? 'mt-1' : ''}>
                  {schedule.withoutTaxYear} receipt
                  {schedule.withoutTaxYear === 1 ? '' : 's'} do not say which tax year they settle.
                  They are shown under the current year, which is the common case, but a payment on
                  an arrear belongs in the preceding-year column.
                </p>
              )}
            </Alert>
          )}

          <section className="mb-6">
            <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
              Abstract of collections
            </h3>
            {schedule.rows.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">
                No reported receipt in this period carries real property tax.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      <th className="cbo-th">Date</th>
                      <th className="cbo-th">O.R. No.</th>
                      <th className="cbo-th">Taxpayer</th>
                      <th className="cbo-th">Period covered</th>
                      <th className="cbo-th text-right">Basic &mdash; current</th>
                      <th className="cbo-th text-right">Basic &mdash; preceding</th>
                      <th className="cbo-th text-right">Penalties</th>
                      <th className="cbo-th text-right">SEF &mdash; current</th>
                      <th className="cbo-th text-right">SEF &mdash; preceding</th>
                      <th className="cbo-th text-right">Total</th>
                      <th className="cbo-th">Barangay</th>
                      <th className="cbo-th text-right">Barangay share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.rows.map((r) => (
                      <tr key={r.orNumber}>
                        <td className="cbo-td font-mono">{r.orDate}</td>
                        <td className="cbo-td font-mono">{r.orNumber}</td>
                        <td className="cbo-td">{r.payorName}</td>
                        <td className="cbo-td">
                          {r.periodCovered || <span className="text-amber-700">not stated</span>}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(r.basicCurrent, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(r.basicPreceding, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(r.penalties, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(r.sefCurrent, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(r.sefPreceding, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount font-medium">
                          {formatPeso(r.total, { symbol: false })}
                        </td>
                        <td className="cbo-td">
                          {r.barangayName ||
                            (r.barangayMissing ? (
                              <span className="text-amber-700">not stated</span>
                            ) : (
                              '—'
                            ))}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(r.barangayShare, { symbol: false })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-semibold">
                      <td className="cbo-td" colSpan={4}>
                        Total
                      </td>
                      <td className="cbo-td cbo-amount">
                        {formatPeso(schedule.totals.basicCurrent, { symbol: false })}
                      </td>
                      <td className="cbo-td cbo-amount">
                        {formatPeso(schedule.totals.basicPreceding, { symbol: false })}
                      </td>
                      <td className="cbo-td cbo-amount">
                        {formatPeso(schedule.totals.penalties, { symbol: false })}
                      </td>
                      <td className="cbo-td cbo-amount">
                        {formatPeso(schedule.totals.sefCurrent, { symbol: false })}
                      </td>
                      <td className="cbo-td cbo-amount">
                        {formatPeso(schedule.totals.sefPreceding, { symbol: false })}
                      </td>
                      <td className="cbo-td cbo-amount">
                        {formatPeso(schedule.totals.total, { symbol: false })}
                      </td>
                      <td className="cbo-td" />
                      <td className="cbo-td cbo-amount">
                        {formatPeso(schedule.totals.barangayShare, { symbol: false })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          {schedule.byBarangay.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
                Due to each barangay
              </h3>
              <table className="w-full border-collapse">
                <tbody>
                  {schedule.byBarangay.map((b) => (
                    <tr key={b.barangayName}>
                      <td className="cbo-td">{b.barangayName}</td>
                      <td className="cbo-td cbo-amount w-44">
                        {formatPeso(b.share, { symbol: false })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                This is the list Section 68 says the abstract exists to produce: what each barangay
                is owed out of the basic real property tax, ready to remit.
              </p>
            </section>
          )}

          {officer ? (
            <Alert tone="info" className="mb-4">
              The sharing between the municipality, the province and the barangays, and the check
              against Due to LGUs, are drawn from the General Ledger, which does not record who
              collected. They are shown when All collecting officers is chosen. The receipts above
              and the barangay shares are this officer&rsquo;s alone.
            </Alert>
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
                    Section 44 shares fines and penalties on the same basis as the tax they arose
                    from &mdash; but the basic tax and the Special Education Fund share differently,
                    and the chart carries a single account, 40105020, for the penalties on both.
                    CFMS cannot tell which part of this figure belongs to which tax, so it is left
                    unallocated rather than put through one of the two rates. The Treasurer&rsquo;s
                    own register is what splits it.
                  </Alert>
                )}
              </section>

              <section className="mb-6">
                <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
                  Summary
                </h3>
                <Line label="Retained by the Municipality of Candoni" amount={data.totalOwn} />
                <Line
                  label="Due to the Province and the barangays"
                  amount={data.totalToRemit}
                  strong
                />
              </section>

              <Alert tone={data.dueToLgusDifference === 0 ? 'success' : 'warning'} className="mb-4">
                {data.dueToLgusDifference === 0 ? (
                  <p>
                    Due to LGUs (20201070) moved by {formatPeso(data.dueToLgusMovement)} in this
                    period, which is exactly the share computed above. The sharing entry has been
                    drawn for everything this abstract covers.
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
                        <td className="cbo-td cbo-amount">
                          {formatPeso(m.basicGross, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(m.basicDiscount, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(m.sefGross, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(m.sefDiscount, { symbol: false })}
                        </td>
                        <td className="cbo-td cbo-amount">
                          {formatPeso(m.penalties, { symbol: false })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

/** 2026-01-05 -> January 5, 2026 */
function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? `${monthName(m)} ${d}, ${y}` : iso;
}

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
              <td className="cbo-td cbo-amount">
                {formatPeso(r.discountShare, { symbol: false })}
              </td>
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
