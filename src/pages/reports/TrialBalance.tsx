import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAccounts, useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { monthName } from '@/lib/dates';
import { checkTrialBalance } from '@/lib/accounting-rules';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';

interface TbRow {
  accountCode: string;
  accountName: string;
  accountClass: string;
  debit: Centavos;
  credit: Centavos;
}

/**
 * The trial balance.
 *
 * Built by summing posted ledger entries. Nothing here is stored: change a
 * posting and this changes with it, which is the point.
 *
 * If the two columns ever fail to foot, that is not a rounding problem to be
 * smoothed over - ledger entries can only be written by the posting function,
 * so a difference means data was altered outside CBO. The warning says so
 * plainly rather than offering to "adjust".
 */
export default function TrialBalance() {
  const { fiscalYear, fundCode, period } = useFilters();
  const [throughPeriod, setThroughPeriod] = useState<number>(period ?? 12);
  const [variant, setVariant] = useState<'MONTHLY' | 'CUMULATIVE'>('CUMULATIVE');

  const accounts = useAccounts(false);
  const ledger = useLedgerEntries(fiscalYear, fundCode, { throughPeriod });

  const rows = useMemo<TbRow[]>(() => {
    const entries = ledger.data.filter((e) =>
      variant === 'MONTHLY' ? e.period === throughPeriod : e.period <= throughPeriod,
    );

    const map = new Map<string, TbRow>();
    for (const e of entries) {
      const row = map.get(e.accountCode) ?? {
        accountCode: e.accountCode,
        accountName: e.accountName,
        accountClass: accounts.data.find((a) => a.code === e.accountCode)?.accountClass ?? '',
        debit: 0,
        credit: 0,
      };
      row.debit += e.debit ?? 0;
      row.credit += e.credit ?? 0;
      map.set(e.accountCode, row);
    }

    return [...map.values()]
      .filter((r) => r.debit !== 0 || r.credit !== 0)
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }, [ledger.data, throughPeriod, variant, accounts.data]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }),
        { debit: 0, credit: 0 },
      ),
    [rows],
  );

  const check = checkTrialBalance(rows);

  const exportColumns: ExportColumn<TbRow>[] = [
    { key: 'code', header: 'Account Code', value: (r) => r.accountCode },
    { key: 'name', header: 'Account Title', value: (r) => r.accountName },
    { key: 'debit', header: 'Debit', kind: 'amount', value: (r) => r.debit },
    { key: 'credit', header: 'Credit', kind: 'amount', value: (r) => r.credit },
  ];

  return (
    <ReportShell
      meta={{
        title: variant === 'MONTHLY' ? 'Trial Balance' : 'Trial Balance (Cumulative)',
        fundLabel: fundLabel(fundCode),
        periodLabel:
          variant === 'MONTHLY'
            ? `For the month of ${monthName(throughPeriod)} ${fiscalYear}`
            : `As at ${monthName(throughPeriod)} ${fiscalYear}`,
        preparedBy: 'Municipal Accountant',
        certifiedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Trial Balance' }]}
      rows={rows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="Through period">
            <Select value={throughPeriod} onChange={(e) => setThroughPeriod(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Basis">
            <Select value={variant} onChange={(e) => setVariant(e.target.value as typeof variant)}>
              <option value="CUMULATIVE">Cumulative to date</option>
              <option value="MONTHLY">This month only</option>
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          Prepared from posted journal entries in the General Ledger. {rows.length} accounts carry a
          movement in the period selected.
        </>
      }
    >
      {!check.ok && (
        <Alert tone="error" className="mb-4" title="The General Ledger does not foot">
          {check.violations[0].message} Ledger entries can only be written by the posting function,
          so a difference here means data was altered outside CBO. Report this to the system
          administrator before relying on any report.
        </Alert>
      )}

      {ledger.loading ? (
        <Spinner label="Reading the General Ledger" />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No journal entries have been posted for the {fundLabel(fundCode)} in this period.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="cbo-th w-28">Account code</th>
              <th className="cbo-th">Account title</th>
              <th className="cbo-th w-40 text-right">Debit</th>
              <th className="cbo-th w-40 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountCode}>
                <td className="cbo-td font-mono text-xs text-slate-600">{r.accountCode}</td>
                <td className="cbo-td">{r.accountName}</td>
                <td className="cbo-td cbo-amount">{formatPeso(r.debit, { symbol: false, dash: true })}</td>
                <td className="cbo-td cbo-amount">{formatPeso(r.credit, { symbol: false, dash: true })}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy-800 font-semibold">
              <td className="cbo-td border-b-0" colSpan={2}>
                Total
              </td>
              <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.debit, { symbol: false })}</td>
              <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.credit, { symbol: false })}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportShell>
  );
}
