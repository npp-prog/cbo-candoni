import { useMemo, useState } from 'react';
import { UnpostedEntriesNote } from '@/components/UnpostedEntriesNote';
import { ReturnLink } from '@/components/ui/BackButton';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { AccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAccounts, useLedgerEntries } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { REPORT_TAB_GROUPS } from '@/layout/sections';

interface SlRow {
  id: string;
  entryDate: string;
  jevId: string;
  jevNo: string;
  referenceNo?: string | null;
  particulars?: string | null;
  debit: Centavos;
  credit: Centavos;
  runningBalance: Centavos;
}

/**
 * The subsidiary ledger.
 *
 * A control account - Accounts Payable, Advances to Officers and Employees,
 * Due to BIR - carries one balance in the General Ledger, made up of many
 * individual balances underneath. This screen breaks a control account down by
 * its subsidiary and shows one subsidiary's movement in detail.
 *
 * The check that matters is at the top: the sum of the subsidiary balances
 * must equal the control account's balance in the General Ledger. If it does
 * not, an entry was posted to the control account without a subsidiary
 * reference, and the schedule of payables will not agree with the statement.
 */
export default function SubsidiaryLedger() {
  const { fiscalYear, fundCode } = useFilters();
  const accounts = useAccounts(false);
  const [accountCode, setAccountCode] = useState<string | null>(null);
  const [subsidiaryId, setSubsidiaryId] = useState<string>('');

  const ledger = useLedgerEntries(fiscalYear, fundCode, { accountCode: accountCode ?? undefined });
  const account = accounts.data.find((a) => a.code === accountCode);

  /** Every subsidiary with movement on this control account, with its balance. */
  const subsidiaries = useMemo(() => {
    const map = new Map<string, { id: string; name: string; balance: Centavos; entries: number }>();
    let unassigned = 0;

    for (const e of ledger.data) {
      if (!e.subsidiaryId) {
        unassigned += e.signedAmount ?? 0;
        continue;
      }
      const entry = map.get(e.subsidiaryId) ?? {
        id: e.subsidiaryId,
        name: e.subsidiaryName ?? e.subsidiaryId,
        balance: 0,
        entries: 0,
      };
      entry.balance += e.signedAmount ?? 0;
      entry.entries++;
      map.set(e.subsidiaryId, entry);
    }

    return {
      list: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)),
      unassigned,
    };
  }, [ledger.data]);

  const controlBalance = ledger.data.reduce((s, e) => s + (e.signedAmount ?? 0), 0);
  const subsidiaryTotal = subsidiaries.list.reduce((s, x) => s + x.balance, 0);
  const agrees = controlBalance === subsidiaryTotal + subsidiaries.unassigned;

  const rows = useMemo<SlRow[]>(() => {
    if (!subsidiaryId) return [];
    let running = 0;
    return ledger.data
      .filter((e) => e.subsidiaryId === subsidiaryId)
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
      .map((e) => {
        running += e.signedAmount ?? 0;
        return {
          id: e.id,
          entryDate: e.entryDate,
          jevId: e.jevId,
          jevNo: e.jevNo,
          referenceNo: e.referenceNo,
          particulars: e.particulars,
          debit: e.debit,
          credit: e.credit,
          runningBalance: running,
        };
      });
  }, [ledger.data, subsidiaryId]);

  const chosen = subsidiaries.list.find((s) => s.id === subsidiaryId);

  const exportColumns: ExportColumn<SlRow>[] = [
    { key: 'date', header: 'Date', kind: 'date', value: (r) => r.entryDate },
    { key: 'jev', header: 'JEV No.', value: (r) => r.jevNo },
    { key: 'ref', header: 'Reference', value: (r) => r.referenceNo ?? '' },
    { key: 'particulars', header: 'Particulars', value: (r) => r.particulars ?? '' },
    { key: 'debit', header: 'Debit', kind: 'amount', value: (r) => r.debit },
    { key: 'credit', header: 'Credit', kind: 'amount', value: (r) => r.credit },
    { key: 'balance', header: 'Balance', kind: 'amount', value: (r) => r.runningBalance },
  ];

  return (
    <ReportShell
      tabs={<GroupedSectionTabs groups={REPORT_TAB_GROUPS} />}
      meta={{
        title: 'Subsidiary Ledger',
        fundLabel: fundLabel(fundCode),
        periodLabel: [account ? `${account.code} - ${account.name}` : null, chosen?.name, `fiscal year ${fiscalYear}`]
          .filter(Boolean)
          .join(' - '),
        preparedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Subsidiary Ledger' }]}
      rows={rows}
      exportColumns={subsidiaryId ? exportColumns : undefined}
      filters={
        <>
          <Field label="Control account" className="min-w-[22rem]">
            <AccountPicker
              value={accountCode}
              onChange={(code) => {
                setAccountCode(code);
                setSubsidiaryId('');
              }}
            />
          </Field>
          <Field label="Subsidiary" className="min-w-[18rem]">
            <Select value={subsidiaryId} onChange={(e) => setSubsidiaryId(e.target.value)} disabled={!accountCode}>
              <option value="">All subsidiaries (summary)</option>
              {subsidiaries.list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} - {formatPeso(Math.abs(s.balance))}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
    >
      {!accountCode ? (
        <Alert tone="info">
          Choose a control account - Accounts Payable, Advances to Officers and Employees, Due to
          BIR and so on - to see the balances that make it up.
        </Alert>
      ) : ledger.loading ? (
        <Spinner label="Reading the ledger" />
      ) : (
        <>
          {!agrees && (
            <Alert tone="error" className="mb-4" title="The subsidiary ledger does not agree with the control account">
              The control account balance is {formatPeso(controlBalance)} but the subsidiary
              balances total {formatPeso(subsidiaryTotal + subsidiaries.unassigned)}. Entries have
              been posted to this control account without a subsidiary reference.
            </Alert>
          )}

          {subsidiaries.unassigned !== 0 && (
            <Alert tone="warning" className="mb-4">
              {formatPeso(Math.abs(subsidiaries.unassigned))} has been posted to this control
              account without naming a subsidiary. Those entries cannot appear on any schedule of
              payables or receivables; identify them in the General Ledger and correct them with an
              adjusting entry.
            </Alert>
          )}

          {!subsidiaryId ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="cbo-th">Subsidiary</th>
                  <th className="cbo-th w-24 text-right">Entries</th>
                  <th className="cbo-th w-44 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {subsidiaries.list.map((s) => (
                  <tr key={s.id}>
                    <td className="cbo-td">
                      <button
                        onClick={() => setSubsidiaryId(s.id)}
                        className="text-left text-sm text-brand-700 hover:underline no-print"
                      >
                        {s.name}
                      </button>
                      <span className="hidden text-sm print:inline">{s.name}</span>
                    </td>
                    <td className="cbo-td text-right font-mono text-sm tabular">{s.entries}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(s.balance, { symbol: false, parens: true })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 font-semibold">
                  <td className="cbo-td border-b-0">
                    Total - {subsidiaries.list.length} subsidiaries
                  </td>
                  <td className="cbo-td border-b-0" />
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(subsidiaryTotal, { symbol: false, parens: true })}
                  </td>
                </tr>
                <tr className="font-medium">
                  <td className="cbo-td border-b-0" colSpan={2}>
                    Control account balance per General Ledger
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(controlBalance, { symbol: false, parens: true })}
                  </td>
                </tr>
              </tfoot>
            </table>
          ) : rows.length === 0 ? (
            <div className="py-8">
              <p className="text-center text-sm text-slate-500">No entries for this subsidiary.</p>
              <UnpostedEntriesNote fiscalYear={fiscalYear} fundCode={fundCode} className="mt-4" />
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="cbo-th w-24">Date</th>
                  <th className="cbo-th w-32">JEV No.</th>
                  <th className="cbo-th w-28">Reference</th>
                  <th className="cbo-th">Particulars</th>
                  <th className="cbo-th w-36 text-right">Debit</th>
                  <th className="cbo-th w-36 text-right">Credit</th>
                  <th className="cbo-th w-40 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="cbo-td text-xs">{formatShortDate(r.entryDate)}</td>
                    <td className="cbo-td">
                      <ReturnLink to={`/accounting/general-transactions/${r.jevId}`} className="font-mono text-xs text-brand-700 hover:underline">
                        {r.jevNo}
                      </ReturnLink>
                    </td>
                    <td className="cbo-td font-mono text-xs text-slate-500">{r.referenceNo ?? '-'}</td>
                    <td className="cbo-td text-xs">{r.particulars}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(r.debit, { symbol: false, dash: true })}</td>
                    <td className="cbo-td cbo-amount">{formatPeso(r.credit, { symbol: false, dash: true })}</td>
                    <td className="cbo-td cbo-amount font-medium">
                      {formatPeso(r.runningBalance, { symbol: false, parens: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </ReportShell>
  );
}
