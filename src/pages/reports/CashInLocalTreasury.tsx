import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Field, DateInput } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { useTreasuryReports } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { TreasuryReport } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { CASH_BOOK_TABS } from '@/layout/sections';

/**
 * Cash in Local Treasury.
 *
 * ---------------------------------------------------------------------------
 * PATCH 177: READ FROM THE RCDs
 * ---------------------------------------------------------------------------
 * The primary reports are no longer kept, so the register is the Reports of
 * Collections and Deposits themselves. Every certified (or journalized) RCD of
 * the fund is one line:
 *
 *   Debit   the collections it reports - its receipts, the lines not set aside;
 *   Credit  the deposits it reports.
 *
 * Remittances received (section A.2 of a liquidating officer's RCD) are NOT a
 * debit: the collector's own RCD already brought that money into the
 * treasury, and the remittance only moves it from one officer to another
 * inside it. Counting it again would double the cash.
 *
 * Nothing is posted here and nothing can be typed. Cancel or withdraw an RCD
 * and its line leaves the page by itself.
 *
 * ---------------------------------------------------------------------------
 * THE SORT ORDER IS PART OF THE CONTROL
 * ---------------------------------------------------------------------------
 * Date, then report number. An RCD's own collections and deposits are on one
 * line, so a same-day deposit never shows ahead of the money it banked.
 * ---------------------------------------------------------------------------
 */

interface Row {
  key: string;
  date: string;
  particulars: string;
  primaryRef: string;
  secondaryRef: string;
  debit: number;
  credit: number;
}

const REPORTED = new Set(['CERTIFIED', 'JOURNALIZED']);

function collectionsOf(r: TreasuryReport): number {
  return (r.lines ?? []).filter((l) => !l.excluded).reduce((s, l) => s + (l.amount || 0), 0);
}

function depositsOf(r: TreasuryReport): number {
  return (r.deposits ?? []).reduce((s, d) => s + (d.amount || 0), 0);
}

function order(a: TreasuryReport, b: TreasuryReport): number {
  return (
    a.reportDate.localeCompare(b.reportDate) || (a.reportNo ?? '').localeCompare(b.reportNo ?? '')
  );
}

export default function CashInLocalTreasury() {
  const { fiscalYear, fundCode } = useFilters();
  const { data: rcds, loading } = useTreasuryReports('RCD', fiscalYear, fundCode);

  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);

  const closed = useMemo(() => rcds.filter((r) => REPORTED.has(r.status)).sort(order), [rcds]);

  const toRow = (r: TreasuryReport): Row => {
    const receipts = (r.lines ?? []).filter((l) => !l.excluded).length;
    const deposits = r.deposits?.length ?? 0;
    return {
      key: r.id,
      date: r.reportDate,
      particulars:
        receipts > 0
          ? `Collections${deposits > 0 ? ' and deposits' : ''} - ${r.accountableOfficerName ?? 'collecting officer'}`
          : `Deposited - ${r.accountableOfficerName ?? 'depository bank'}`,
      primaryRef: r.reportNo ?? '',
      secondaryRef: [
        receipts ? `${receipts} receipt${receipts === 1 ? '' : 's'}` : '',
        deposits ? `${deposits} deposit${deposits === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(', '),
      debit: collectionsOf(r),
      credit: depositsOf(r),
    };
  };

  /** Everything closed before the period opens, folded into one line. */
  const broughtForward = useMemo(
    () =>
      closed
        .filter((r) => r.reportDate < from)
        .reduce((bal, r) => bal + collectionsOf(r) - depositsOf(r), 0),
    [closed, from],
  );

  const rows = useMemo(
    () =>
      closed
        .filter((r) => r.reportDate >= from && r.reportDate <= to)
        .map(toRow)
        .filter((r) => r.debit !== 0 || r.credit !== 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closed, from, to],
  );

  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }),
    { debit: 0, credit: 0 },
  );
  const closing = broughtForward + totals.debit - totals.credit;

  if (loading) return <Spinner label="Reading the RCDs" />;

  let running = broughtForward;

  return (
    <ReportShell
      tabs={<SectionTabs tabs={CASH_BOOK_TABS} />}
      meta={{
        title: 'Cash in Local Treasury',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the period ${formatShortDate(from)} to ${formatShortDate(to)}`,
        preparedBy: 'Municipal Treasurer’s Office',
        certifiedBy: 'Municipal Treasurer',
      }}
      breadcrumbs={[{ label: 'Treasury', to: '/treasury' }, { label: 'Cash in Local Treasury' }]}
      filters={
        <>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={setFrom} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={setTo} />
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            Every line is a certified Report of Collections and Deposits (RCD): its collections are
            the debit, its deposits the credit. Nothing is posted to this register and nothing can
            be typed on it.
          </p>
          <p className="mt-1">
            Remittances received from collectors are not a debit - the collector&apos;s own RCD
            already brought the money in; the remittance only moves it to another officer.
          </p>
        </>
      }
    >
      {closed.length === 0 ? (
        <Alert tone="info" title="No RCD has been certified yet">
          The register fills itself as RCDs are certified under{' '}
          <strong>Treasury &rsaquo; Collections and Deposits</strong>. A draft is still changing, so
          it is deliberately not here.
        </Alert>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '7rem' }}
              >
                Date
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">Particulars</th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '9rem' }}
              >
                RCD No.
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '11rem' }}
              >
                Covering
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-right"
                style={{ width: '8rem' }}
              >
                Collections
                <span className="block text-2xs font-normal text-slate-500">Debit</span>
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-right"
                style={{ width: '8rem' }}
              >
                Deposits
                <span className="block text-2xs font-normal text-slate-500">Credit</span>
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-right"
                style={{ width: '9rem' }}
              >
                Balance
              </th>
            </tr>
          </thead>

          <tbody>
            <tr className="bg-slate-50 font-medium">
              <td className="border border-slate-400 px-2 py-1">{formatShortDate(from)}</td>
              <td className="border border-slate-400 px-2 py-1 italic" colSpan={3}>
                Balance forwarded
              </td>
              <td className="border border-slate-400 px-2 py-1" />
              <td className="border border-slate-400 px-2 py-1" />
              <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                {formatAmount(broughtForward, false)}
              </td>
            </tr>

            {rows.map((r) => {
              running += r.debit - r.credit;
              return (
                <tr key={r.key}>
                  <td className="border border-slate-400 px-2 py-1 whitespace-nowrap">
                    {formatShortDate(r.date)}
                  </td>
                  <td className="border border-slate-400 px-2 py-1">{r.particulars}</td>
                  <td className="border border-slate-400 px-2 py-1 font-mono">{r.primaryRef}</td>
                  <td className="border border-slate-400 px-2 py-1 font-mono text-2xs text-slate-500">
                    {r.secondaryRef}
                  </td>
                  <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                    {r.debit ? formatAmount(r.debit, false) : ''}
                  </td>
                  <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                    {r.credit ? formatAmount(r.credit, false) : ''}
                  </td>
                  <td className="border border-slate-400 px-2 py-1 text-right tabular-nums font-medium">
                    {formatAmount(running, false)}
                  </td>
                </tr>
              );
            })}
          </tbody>

          <tfoot>
            <tr className="bg-slate-100 font-bold">
              <td className="border border-slate-400 px-2 py-1.5 text-right" colSpan={4}>
                T O T A L S
              </td>
              <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(totals.debit, false)}
              </td>
              <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(totals.credit, false)}
              </td>
              <td className="border-2 border-slate-500 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(closing, false)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      {closing < 0 && (
        <Alert tone="error" title="The balance is negative" className="mt-4">
          More has been banked than was taken in. Either an RCD of collections has not been
          certified, or a deposit covers collections from outside this period. Both show up as a
          negative balance and neither is ignorable.
        </Alert>
      )}
    </ReportShell>
  );
}
