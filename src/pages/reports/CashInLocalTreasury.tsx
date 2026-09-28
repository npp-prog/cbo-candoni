import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Field, DateInput } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { usePrimaryReports } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { PRIMARY_REPORT_TYPE_LABELS, type PrimaryReport } from '@/types/primaryReports';
import { fundLabel } from '../budget/Obligations';

/**
 * Cash in Local Treasury.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REGISTER IS COMPUTED AND NOT KEPT
 * ---------------------------------------------------------------------------
 * The office's own version of this book is written up by hand, one line per
 * report, and it is the line that drifts. A primary is reopened and corrected;
 * the register keeps the old figure. A deposit is withdrawn; the register still
 * shows the money banked. By the time anybody notices, the balance has been
 * wrong for a fortnight and nobody can say from when.
 *
 * So nothing is posted here. The register IS the closed primary reports, read
 * in order: a closed collection report is a debit, a closed deposit is a
 * credit, and the balance is the running difference. Reopen a primary and the
 * line leaves this page by itself, because the line was never anything but
 * that primary.
 *
 * ---------------------------------------------------------------------------
 * THE SORT ORDER IS PART OF THE CONTROL
 * ---------------------------------------------------------------------------
 * Within one date, collections come before deposits. This is not cosmetic:
 * money is received before any of it is banked, so a same-day deposit sorted
 * ahead of its collection would dip the running balance below zero and make the
 * Treasurer appear to have banked money they had not yet taken in. The register
 * would foot correctly at the end of the day and be wrong in the middle of it,
 * which is the worst of both.
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

/** Collections before deposits on the same date. See the note above. */
function order(a: PrimaryReport, b: PrimaryReport): number {
  if (a.reportDate !== b.reportDate) return a.reportDate.localeCompare(b.reportDate);
  const aDeposit = a.reportType === 'DEPOSIT' ? 1 : 0;
  const bDeposit = b.reportType === 'DEPOSIT' ? 1 : 0;
  if (aDeposit !== bDeposit) return aDeposit - bDeposit;
  return (a.primaryNo ?? '').localeCompare(b.primaryNo ?? '');
}

export default function CashInLocalTreasury() {
  const { fiscalYear, fundCode } = useFilters();
  const { data: primaries, loading } = usePrimaryReports(fiscalYear, fundCode);

  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);

  const closed = useMemo(
    () => primaries.filter((p) => p.status === 'CLOSED').sort(order),
    [primaries],
  );

  const toRow = (p: PrimaryReport): Row => {
    const isDeposit = p.reportType === 'DEPOSIT';
    return {
      key: p.id,
      date: p.reportDate,
      particulars: isDeposit
        ? `Deposited — ${p.deposit?.bankName ?? 'depository bank'}`
        : `Collections received — ${p.accountableOfficerName}`,
      primaryRef: p.primaryNo ?? '',
      secondaryRef: isDeposit
        ? primaries
            .filter((x) => p.coveredPrimaryIds.includes(x.id))
            .map((x) => x.primaryNo)
            .filter(Boolean)
            .join(', ')
        : `${p.rcdIds.length} report${p.rcdIds.length === 1 ? '' : 's'}`,
      debit: isDeposit ? 0 : p.totalAmount,
      credit: isDeposit ? p.totalAmount : 0,
    };
  };

  /** Everything closed before the period opens, folded into one line. */
  const broughtForward = useMemo(
    () =>
      closed
        .filter((p) => p.reportDate < from)
        .reduce((bal, p) => bal + (p.reportType === 'DEPOSIT' ? -p.totalAmount : p.totalAmount), 0),
    [closed, from],
  );

  const rows = useMemo(
    () => closed.filter((p) => p.reportDate >= from && p.reportDate <= to).map(toRow),
    // toRow closes over `primaries`, which changes with the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closed, from, to, primaries],
  );

  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }),
    { debit: 0, credit: 0 },
  );
  const closing = broughtForward + totals.debit - totals.credit;

  if (loading) return <Spinner label="Reading the primary reports" />;

  let running = broughtForward;

  return (
    <ReportShell
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
            Every line is a closed primary report. Nothing is posted to this register and nothing
            can be typed on it &mdash; reopen a primary and its line leaves the page by itself,
            because the line was never anything but that report.
          </p>
          <p className="mt-1">
            Within one date, collections are listed before deposits: money is received before any of
            it is banked, and a deposit sorted ahead of its collection would dip the balance below
            what the Treasurer actually held.
          </p>
        </>
      }
    >
      {closed.length === 0 ? (
        <Alert tone="info" title="No primary report has been closed yet">
          The register fills itself as reports are closed under{' '}
          <strong>Treasury &rsaquo; Primary Reports</strong>. An open report is still changing, so it
          is deliberately not here.
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
                Primary Ref.
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left" style={{ width: '11rem' }}>
                Covering
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '8rem' }}>
                Collections
                <span className="block text-2xs font-normal text-slate-500">Debit</span>
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '8rem' }}>
                Deposits
                <span className="block text-2xs font-normal text-slate-500">Credit</span>
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '9rem' }}>
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
          More has been banked than was taken in. Either a collection report has not been closed, or
          a deposit covers collections from outside this period. Both show up as a negative balance
          and neither is ignorable.
        </Alert>
      )}
    </ReportShell>
  );
}
