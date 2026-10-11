import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReportShell } from '@/components/ReportShell';
import { Spinner } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { Field, Select, TextInput } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useCollections } from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import type { ExportColumn } from '@/lib/export';
import type { SystemSettings } from '@/types/system';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from '../treasury/sections';
import {
  buildAf56Abstract,
  type Af56AbstractRow,
  type Af56Receipt,
  type ShareRow,
  type TaxColumns,
} from './af56AbstractReport';

/**
 * Patch 175 - the Abstract of Real Property Tax Collections, from the
 * receipts on Accountable Form No. 56, in the office's worksheet layout:
 * one row per receipt, the basic tax and the SEF side by side, and the
 * sharing summary (Province / Municipal / Barangay) below. See
 * af56AbstractReport.ts.
 *
 * AF 56 receipts are General Fund collections (the SEF half is held as Due to
 * Other Funds), so this reads the General Fund whatever fund is chosen above.
 */

const amt = (v: number) => (v ? formatPeso(v, { symbol: false }) : '-');
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
const shortDate = (d: string) => {
  const [y, m, day] = d.split('-');
  return `${Number(m)}/${Number(day)}/${y}`;
};

const TAX_KEYS: Array<keyof TaxColumns> = [
  'prior',
  'current',
  'advance',
  'penalty',
  'discountCurrent',
  'discountAdvance',
  'total',
];

export default function RptAf56Abstract() {
  const { fiscalYear } = useFilters();
  const [fromDate, setFromDate] = useState(`${fiscalYear}-01-01`);
  const [toDate, setToDate] = useState(`${fiscalYear}-12-31`);
  const [officer, setOfficer] = useState('');
  useEffect(() => {
    setFromDate(`${fiscalYear}-01-01`);
    setToDate(`${fiscalYear}-12-31`);
  }, [fiscalYear]);

  const collections = useCollections(fiscalYear, 'GF');
  const settings = useDocument<SystemSettings>(COL.settings, 'general');
  const lgu = (settings.data?.municipality || 'Candoni').trim();

  const receipts = (collections.data ?? []) as unknown as Af56Receipt[];
  const officers = useMemo(
    () =>
      [
        ...new Set(
          receipts
            .filter((c) => c.rpt && c.orDate >= fromDate && c.orDate <= toDate)
            .map((c) => (c.collectingOfficerName ?? '').trim())
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [receipts, fromDate, toDate],
  );
  const a = useMemo(
    () => buildAf56Abstract({ receipts, fromDate, toDate, officer }),
    [receipts, fromDate, toDate, officer],
  );

  const exportColumns: ExportColumn<Af56AbstractRow>[] = [
    { key: 'date', header: 'OR Date', value: (r) => r.orDate },
    { key: 'or', header: 'OR No.', value: (r) => r.orNumber },
    { key: 'decl', header: 'Declarant', value: (r) => r.declarant },
    { key: 'mun', header: 'Municipality', value: () => lgu },
    { key: 'per', header: 'Period', value: (r) => r.period },
    {
      key: 'bp',
      header: 'Basic - Immediate & Prior Years',
      kind: 'amount',
      value: (r) => r.basic.prior,
    },
    { key: 'bc', header: 'Basic - Current Year', kind: 'amount', value: (r) => r.basic.current },
    { key: 'ba', header: 'Basic - Advance', kind: 'amount', value: (r) => r.basic.advance },
    { key: 'bpen', header: 'Basic - Penalty', kind: 'amount', value: (r) => r.basic.penalty },
    {
      key: 'bdc',
      header: 'Basic - Discount Current Year',
      kind: 'amount',
      value: (r) => r.basic.discountCurrent,
    },
    {
      key: 'bda',
      header: 'Basic - Discount Advance',
      kind: 'amount',
      value: (r) => r.basic.discountAdvance,
    },
    { key: 'bt', header: 'Total Basic Tax', kind: 'amount', value: (r) => r.basic.total },
    {
      key: 'sp',
      header: 'SEF - Immediate & Prior Years',
      kind: 'amount',
      value: (r) => r.sef.prior,
    },
    { key: 'sc', header: 'SEF - Current Year', kind: 'amount', value: (r) => r.sef.current },
    { key: 'sa', header: 'SEF - Advance', kind: 'amount', value: (r) => r.sef.advance },
    { key: 'spen', header: 'SEF - Penalty', kind: 'amount', value: (r) => r.sef.penalty },
    {
      key: 'sdc',
      header: 'SEF - Discount Current Year',
      kind: 'amount',
      value: (r) => r.sef.discountCurrent,
    },
    {
      key: 'sda',
      header: 'SEF - Discount Advance',
      kind: 'amount',
      value: (r) => r.sef.discountAdvance,
    },
    { key: 'st', header: 'Total SET', kind: 'amount', value: (r) => r.sef.total },
    { key: 'tot', header: 'Total Basic Tax and SET', kind: 'amount', value: (r) => r.total },
    { key: 'brgy', header: 'Barangay', value: (r) => r.barangays },
  ];

  const th = 'border border-slate-400 px-1 py-0.5 text-center font-semibold';
  const td = 'border border-slate-400 px-1 py-0.5';
  const tdn = `${td} text-right tabular-nums`;

  const shareTable = (
    title: string,
    block: { tax: ShareRow[]; penalty: ShareRow[]; discount: ShareRow[]; total: ShareRow },
    withBarangay: boolean,
  ) => {
    const cells = (r: ShareRow) => (
      <>
        <td className={tdn}>{amt(r.total)}</td>
        <td className={tdn}>{amt(r.province)}</td>
        <td className={tdn}>{amt(r.municipal)}</td>
        {withBarangay && <td className={tdn}>{amt(r.barangay)}</td>}
      </>
    );
    const group = (label: string, rows: ShareRow[]) => (
      <>
        <tr>
          <td className={`${td} font-semibold`} colSpan={withBarangay ? 5 : 4}>
            {label}
          </td>
        </tr>
        {rows.map((r) => (
          <tr key={`${label}-${r.label}`}>
            <td className={`${td} pl-5`}>{r.label}</td>
            {cells(r)}
          </tr>
        ))}
      </>
    );
    return (
      <table className="mb-5 w-full max-w-3xl border-collapse text-xs">
        <thead>
          <tr>
            <th className={`${th} text-left`}>{title}</th>
            <th className={th}>Total Collections</th>
            <th className={th}>Provincial Share ({withBarangay ? '35%' : '50%'})</th>
            <th className={th}>Municipal Share ({withBarangay ? '40%' : '50%'})</th>
            {withBarangay && <th className={th}>Barangay Share (25%)</th>}
          </tr>
        </thead>
        <tbody>
          {group(withBarangay ? 'BASIC TAX' : 'SPECIAL EDUCATION TAX', block.tax)}
          {group('Penalties', block.penalty)}
          {group('Discount', block.discount)}
          <tr className="font-semibold">
            <td className={td}>{block.total.label}</td>
            {cells(block.total)}
          </tr>
        </tbody>
      </table>
    );
  };

  return (
    <ReportShell
      printLayout="landscape"
      meta={{
        title: 'Abstract of Real Property Tax Collections (AF 56)',
        fundLabel: 'General Fund',
        periodLabel: `${longDate(fromDate)} to ${longDate(toDate)}${officer ? ` - Collecting Officer: ${officer}` : ''}`,
        preparedBy: 'Municipal Treasurer',
        certifiedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Abstract of RPT Collections' }]}
      tabs={<GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />}
      rows={a.rows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="From date">
            <TextInput
              type="date"
              value={fromDate}
              max={toDate}
              onChange={(e) => e.target.value && setFromDate(e.target.value)}
            />
          </Field>
          <Field label="To date">
            <TextInput
              type="date"
              value={toDate}
              min={fromDate}
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
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            From the receipts on Accountable Form No. 56. Basic tax: Province 35%, Municipality 40%,
            Barangay 25% (Local Government Code, Section 271); Special Education Tax: Province and
            Municipality 50% each (Section 272). Discounts are shared the same way. Each receipt was
            recorded with its own split, so a share here may differ by a centavo from the same
            percentage taken of the total - these are the figures in the ledger.
          </p>
          <p className="mt-1 no-print">
            Receipts recorded by account before AF 56 entry (patch 175):{' '}
            <Link className="text-brand-700 underline" to="/reports/rpt-abstract/ledger">
              the abstract drawn from the General Ledger
            </Link>
            .
          </p>
        </>
      }
    >
      {collections.loading ? (
        <Spinner label="Reading the receipts" />
      ) : a.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No AF 56 receipt from {longDate(fromDate)} to {longDate(toDate)}
          {officer ? ` by ${officer}` : ''}.
        </p>
      ) : (
        <>
          <p className="mb-1 text-xs font-semibold">LGU: {lgu}</p>
          <div className="mb-6 overflow-x-auto">
            <table className="w-full border-collapse text-[9px] leading-tight">
              <thead>
                <tr>
                  <th className={th} rowSpan={3}>
                    OR Date
                  </th>
                  <th className={th} rowSpan={3}>
                    OR No.
                  </th>
                  <th className={th} rowSpan={3}>
                    Declarant
                  </th>
                  <th className={th} rowSpan={3}>
                    Municipality
                  </th>
                  <th className={th} rowSpan={3}>
                    Period
                  </th>
                  <th className={th} colSpan={7}>
                    BASIC TAX
                  </th>
                  <th className={th} colSpan={7}>
                    SPECIAL EDUCATION TAX
                  </th>
                  <th className={th} rowSpan={3}>
                    TOTAL BASIC TAX AND SET
                  </th>
                </tr>
                <tr>
                  {[0, 1].map((i) => (
                    <FragmentHead
                      key={i}
                      th={th}
                      total={i === 0 ? 'TOTAL BASIC TAX' : 'TOTAL SET'}
                    />
                  ))}
                </tr>
                <tr>
                  {[0, 1].map((i) => (
                    <FragmentSub key={i} th={th} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr key={r.orNumber + r.orDate}>
                    <td className={td}>{shortDate(r.orDate)}</td>
                    <td className={td}>{r.orNumber}</td>
                    <td className={td}>{r.declarant}</td>
                    <td className={td}>{lgu}</td>
                    <td className={td}>{r.period}</td>
                    {TAX_KEYS.map((k) => (
                      <td
                        key={`b${k}`}
                        className={`${tdn} ${k === 'total' ? 'font-semibold' : ''}`}
                      >
                        {amt(r.basic[k])}
                      </td>
                    ))}
                    {TAX_KEYS.map((k) => (
                      <td
                        key={`s${k}`}
                        className={`${tdn} ${k === 'total' ? 'font-semibold' : ''}`}
                      >
                        {amt(r.sef[k])}
                      </td>
                    ))}
                    <td className={`${tdn} font-semibold`}>{amt(r.total)}</td>
                  </tr>
                ))}
                <tr className="font-bold">
                  <td className={`${td} text-center`} colSpan={5}>
                    TOTAL
                  </td>
                  {TAX_KEYS.map((k) => (
                    <td key={`tb${k}`} className={tdn}>
                      {amt(a.totals.basic[k])}
                    </td>
                  ))}
                  {TAX_KEYS.map((k) => (
                    <td key={`ts${k}`} className={tdn}>
                      {amt(a.totals.sef[k])}
                    </td>
                  ))}
                  <td className={tdn}>{amt(a.totals.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="break-inside-avoid">
            <p className="mb-1 text-xs font-semibold">LGU: {lgu}</p>
            {shareTable('Tax Revenue (Real Property Tax)', a.summary.basic, true)}
            {shareTable('SPECIAL EDUCATION TAX', a.summary.sef, false)}
          </div>

          {a.byBarangay.length > 0 && (
            <div className="break-inside-avoid">
              <p className="mb-1 text-xs font-semibold">
                Barangay share (25% of the basic tax), by barangay
              </p>
              <table className="w-full max-w-md border-collapse text-xs">
                <tbody>
                  {a.byBarangay.map((b) => (
                    <tr key={b.barangayName}>
                      <td className={td}>{b.barangayName}</td>
                      <td className={tdn}>{amt(b.share)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className={td}>Total</td>
                    <td className={tdn}>{amt(a.summary.basic.total.barangay)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </ReportShell>
  );
}

function FragmentHead({ th, total }: { th: string; total: string }) {
  return (
    <>
      <th className={th} rowSpan={2}>
        Immediate &amp; Prior Years
      </th>
      <th className={th} rowSpan={2}>
        Current Year
      </th>
      <th className={th} rowSpan={2}>
        Advance
      </th>
      <th className={th} rowSpan={2}>
        Penalty
      </th>
      <th className={th} colSpan={2}>
        Discount
      </th>
      <th className={th} rowSpan={2}>
        {total}
      </th>
    </>
  );
}

function FragmentSub({ th }: { th: string }) {
  return (
    <>
      <th className={th}>Current Year</th>
      <th className={th}>Advance</th>
    </>
  );
}
