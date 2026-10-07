import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { PAYMENT_TAB_GROUPS, PAYMENT_CRUMBS } from '../treasury/sections';
import { Field, DateInput } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useChecks } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { toNumber } from '@/lib/serials';
import { fundLabel } from '../budget/Obligations';

/**
 * Report of Cancelled Checks.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPORT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * A cancelled check is not an absence. It is a numbered form the municipality
 * was issued, wrote on, and destroyed - and the serial has to be accounted for
 * exactly like one that was paid. An office that can show every check it drew,
 * including the spoiled ones and why, has nothing to explain; an office with a
 * gap in its check numbers has to explain it from memory, months later.
 *
 * So this report is read by number, not by amount. The serial column is sorted
 * on the numeric value of the check number rather than its text, and gaps
 * between the cancelled serials are not flagged here - they are, correctly,
 * the checks that were actually paid.
 * ---------------------------------------------------------------------------
 */
export default function CancelledChecks() {
  const { fiscalYear, fundCode } = useFilters();
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);

  const { data: checks, loading } = useChecks(bankAccountId ?? undefined, 'CANCELLED');

  const rows = useMemo(
    () =>
      checks
        .filter(
          (c) =>
            c.fiscalYear === fiscalYear &&
            c.fundCode === fundCode &&
            c.checkDate >= from &&
            c.checkDate <= to,
        )
        .sort((a, b) => {
          const na = toNumber(a.checkNo);
          const nb = toNumber(b.checkNo);
          if (na !== null && nb !== null) return na - nb;
          return a.checkNo.localeCompare(b.checkNo);
        }),
    [checks, fiscalYear, fundCode, from, to],
  );

  const total = rows.reduce((s, c) => s + c.netAmount, 0);

  if (loading) return <Spinner label="Reading the check register" />;

  return (
    <ReportShell
      meta={{
        title: 'Report of Cancelled Checks',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the period ${formatShortDate(from)} to ${formatShortDate(to)}`,
        preparedBy: 'Municipal Treasurer’s Office',
        certifiedBy: 'Municipal Treasurer',
      }}
      breadcrumbs={[...PAYMENT_CRUMBS, { label: 'Cancelled Checks' }]}
      tabs={<GroupedSectionTabs groups={PAYMENT_TAB_GROUPS} />}
      rows={rows}
      exportColumns={[
        { key: 'checkNo', header: 'Check Serial No.', value: (c) => c.checkNo },
        { key: 'checkDate', header: 'Date', value: (c) => c.checkDate, kind: 'date' },
        { key: 'bankName', header: 'Bank', value: (c) => c.bankName },
        { key: 'dvNo', header: 'DV / Payroll No.', value: (c) => c.dvNo },
        { key: 'payeeName', header: 'Payee', value: (c) => c.payeeName },
        { key: 'reason', header: 'Reason for Cancellation', value: (c) => c.cancelledReason ?? '' },
        { key: 'netAmount', header: 'Amount', value: (c) => c.netAmount, kind: 'amount' },
      ]}
      filters={
        <>
          <Field label="Bank account" className="w-64">
            <BankAccountPicker value={bankAccountId} onChange={setBankAccountId} fundCode={fundCode} />
          </Field>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={setFrom} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={setTo} />
          </Field>
        </>
      }
      footnote="A cancelled check keeps its place on the Report of Checks Issued, at nil, so the run of serials on that report has no hole in it. This report is where the reason lives."
    >
      {rows.length === 0 ? (
        <Alert tone="success" title="No checks were cancelled in this period">
          Every check drawn between those dates is still standing.
        </Alert>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-2 py-1.5 text-left" style={{ width: '8rem' }}>
                Check Serial No.
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left" style={{ width: '7rem' }}>
                Date
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">Bank / Account</th>
              <th className="border border-slate-400 px-2 py-1.5 text-left" style={{ width: '9rem' }}>
                DV / Payroll No.
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">Payee</th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">Reason for Cancellation</th>
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '8rem' }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="border border-slate-400 px-2 py-1 font-mono">{c.checkNo}</td>
                <td className="border border-slate-400 px-2 py-1 whitespace-nowrap">
                  {formatShortDate(c.checkDate)}
                </td>
                <td className="border border-slate-400 px-2 py-1">
                  {c.bankName}
                  <span className="block text-2xs text-slate-500">{c.bankAccountNumber}</span>
                </td>
                <td className="border border-slate-400 px-2 py-1 font-mono">{c.dvNo}</td>
                <td className="border border-slate-400 px-2 py-1">{c.payeeName}</td>
                <td className="border border-slate-400 px-2 py-1">
                  {c.cancelledReason ?? <span className="italic text-slate-400">No reason recorded</span>}
                  {c.replacedByCheckId && (
                    <span className="block text-2xs text-slate-500">Replaced by a later check</span>
                  )}
                </td>
                <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                  {formatAmount(c.netAmount, false)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold">
              <td className="border border-slate-400 px-2 py-1.5 text-right" colSpan={6}>
                T O T A L &nbsp;&mdash;&nbsp; {rows.length} check{rows.length === 1 ? '' : 's'}
              </td>
              <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(total, false)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportShell>
  );
}
