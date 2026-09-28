import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Field, DateInput, TextInput } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { useRcds } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { fundLabel } from '../budget/Obligations';

/**
 * Summary of Reports of Collection and Deposit - the transmittal.
 *
 * This is the covering sheet that travels with a month's RCDs from the
 * Treasurer's office to Accounting: one line per report, the collection and the
 * deposit side by side, and a receiving signature at the foot. Its whole
 * purpose is to be the thing both offices point at when one says a report was
 * sent and the other says it never arrived, so the blank ruled rows and the
 * "Date Received" line are part of the document rather than decoration.
 *
 * Cancelled reports are left off: a transmittal lists what is being handed
 * over, and a cancelled report is not.
 */
export default function RcdTransmittal() {
  const { fiscalYear, fundCode } = useFilters();
  const { data: rcds, loading } = useRcds(fiscalYear, fundCode);

  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);
  const [transmittalNo, setTransmittalNo] = useState('');
  const [transmittalDate, setTransmittalDate] = useState(`${fiscalYear}-01-01`);

  const rows = useMemo(
    () =>
      rcds
        .filter((r) => r.rcdDate >= from && r.rcdDate <= to && r.status !== 'CANCELLED')
        .sort((a, b) => a.rcdDate.localeCompare(b.rcdDate) || a.rcdNo.localeCompare(b.rcdNo)),
    [rcds, from, to],
  );

  const totals = rows.reduce(
    (acc, r) => ({
      collections: acc.collections + r.totalCollections,
      deposits: acc.deposits + r.totalDeposits,
    }),
    { collections: 0, deposits: 0 },
  );

  /** At least eight ruled rows, as on the paper form. */
  const blanks = Math.max(0, 8 - rows.length);

  if (loading) return <Spinner label="Reading the reports" />;

  return (
    <ReportShell
      meta={{
        title: 'Summary of Reports of Collection and Deposit',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For collection / deposit dated ${formatShortDate(from)} to ${formatShortDate(to)}`,
      }}
      breadcrumbs={[{ label: 'Treasury', to: '/treasury' }, { label: 'RCD Transmittal' }]}
      filters={
        <>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={setFrom} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={setTo} />
          </Field>
          <Field label="Transmittal number" className="w-48">
            <TextInput
              value={transmittalNo}
              onChange={(e) => setTransmittalNo(e.target.value.toUpperCase())}
              placeholder="MTOGF07202602"
            />
          </Field>
          <Field label="Transmittal date" className="w-40">
            <DateInput value={transmittalDate} onChange={setTransmittalDate} />
          </Field>
        </>
      }
      footnote="Cancelled reports are not listed. A report appears here whether or not its collections have been deposited in full; the two amount columns are what the receiving office checks against."
    >
      <div className="mb-3 flex justify-end gap-6 text-xs">
        <p>
          <span className="text-slate-500">Transmittal Number: </span>
          <span className="font-mono font-semibold">{transmittalNo || '—'}</span>
        </p>
        <p>
          <span className="text-slate-500">Transmittal Date: </span>
          <span className="font-semibold">{formatShortDate(transmittalDate)}</span>
        </p>
      </div>

      {rows.length === 0 ? (
        <Alert tone="info" title="No reports in this period">
          Nothing was reported between those dates in the {fundLabel(fundCode)}.
        </Alert>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-2 py-1.5 text-left" style={{ width: '7rem' }}>
                Date
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">Particulars</th>
              <th className="border border-slate-400 px-2 py-1.5 text-left" style={{ width: '9rem' }}>
                Reference
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '8rem' }}>
                Collection
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '8rem' }}>
                Deposit
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-center" style={{ width: '5rem' }}>
                Officer
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="border border-slate-400 px-2 py-1 whitespace-nowrap">
                  {formatShortDate(r.rcdDate)}
                </td>
                <td className="border border-slate-400 px-2 py-1">
                  Collection &mdash; {fundLabel(fundCode)}
                  <span className="block text-2xs text-slate-500">{r.collectingOfficerName}</span>
                </td>
                <td className="border border-slate-400 px-2 py-1 font-mono">{r.rcdNo}</td>
                <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                  {formatAmount(r.totalCollections, false)}
                </td>
                <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                  {r.totalDeposits ? formatAmount(r.totalDeposits, false) : ''}
                </td>
                <td className="border border-slate-400 px-2 py-1" />
              </tr>
            ))}
            {Array.from({ length: blanks }, (_, i) => (
              <tr key={`b-${i}`}>
                {Array.from({ length: 6 }, (_, j) => (
                  <td key={j} className="border border-slate-400 px-2 py-[9px]">
                    &nbsp;
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold">
              <td className="border border-slate-400 px-2 py-1.5 text-right" colSpan={3}>
                T O T A L
              </td>
              <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(totals.collections, false)}
              </td>
              <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(totals.deposits, false)}
              </td>
              <td className="border border-slate-400 px-2 py-1.5" />
            </tr>
          </tfoot>
        </table>
      )}

      <div className="mt-10 grid gap-8 sm:grid-cols-2">
        <div>
          <p className="text-2xs uppercase tracking-wide text-slate-500">Prepared by</p>
          <p className="mt-8 border-t border-slate-500 pt-1 text-center text-xs font-semibold">&nbsp;</p>
          <p className="text-center text-2xs text-slate-500">Municipal Treasurer&rsquo;s Office</p>
        </div>
        <div>
          <p className="text-2xs uppercase tracking-wide text-slate-500">Received by</p>
          <p className="mt-8 border-t border-slate-500 pt-1 text-center text-xs font-semibold">&nbsp;</p>
          <p className="text-center text-2xs text-slate-500">Municipal Accounting Office</p>
          <p className="mt-3 text-2xs text-slate-500">
            Date received: <span className="inline-block w-32 border-b border-slate-400" />
          </p>
        </div>
      </div>
    </ReportShell>
  );
}
