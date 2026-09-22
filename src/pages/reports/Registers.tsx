import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReportShell } from '@/components/ReportShell';
import { Spinner, Alert } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/Badge';
import { useFilters } from '@/context/FilterContext';
import {
  useDisbursementVouchers,
  useJevs,
  useChecks,
  useAda,
  useRcds,
  useObligations,
  useLedgerEntries,
  useAccounts,
} from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate, agingBucket, AGING_LABELS, todayPh } from '@/lib/dates';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';

type RegisterId =
  | 'dv'
  | 'jev'
  | 'check'
  | 'ada'
  | 'rcd'
  | 'obr'
  | 'payables'
  | 'receivables';

const REGISTERS: Array<{ id: RegisterId; label: string }> = [
  { id: 'dv', label: 'Disbursement Voucher Register' },
  { id: 'jev', label: 'Journal Entry Voucher Register' },
  { id: 'check', label: 'Check Register' },
  { id: 'ada', label: 'ADA Register' },
  { id: 'rcd', label: 'RCD Register' },
  { id: 'obr', label: 'Obligation Registry' },
  { id: 'payables', label: 'Schedule of Accounts Payable' },
  { id: 'receivables', label: 'Schedule of Accounts Receivable' },
];

/**
 * The registers.
 *
 * Six of these are simple chronological listings of a document type. The two
 * schedules are different: they are derived from the subsidiary detail of the
 * payables and receivables control accounts in the General Ledger, aged by
 * transaction date, so a schedule always agrees with the statement it supports.
 */
export default function Registers() {
  const { fiscalYear, fundCode } = useFilters();
  const [register, setRegister] = useState<RegisterId>('dv');

  const dvs = useDisbursementVouchers(fiscalYear, fundCode);
  const jevs = useJevs(fiscalYear, fundCode);
  const checks = useChecks();
  const ada = useAda();
  const rcds = useRcds(fiscalYear, fundCode);
  const obligations = useObligations(fiscalYear, fundCode);
  const accounts = useAccounts(false);
  const ledger = useLedgerEntries(fiscalYear, fundCode);

  const title = REGISTERS.find((r) => r.id === register)!.label;

  return (
    <ReportShell
      meta={{
        title,
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the fiscal year ${fiscalYear}`,
        preparedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Registers' }]}
      filters={
        <Field label="Register" className="min-w-[22rem]">
          <Select value={register} onChange={(e) => setRegister(e.target.value as RegisterId)}>
            {REGISTERS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      }
    >
      {register === 'dv' && (
        <SimpleRegister
          loading={dvs.loading}
          rows={dvs.data.map((d) => ({
            id: d.id,
            to: `/accounting/disbursements/${d.id}`,
            ref: d.dvNo ?? 'Draft',
            date: d.dvDate,
            party: d.payeeName,
            particulars: d.particulars,
            amount: d.netAmount,
            status: d.status,
          }))}
          amountHeader="Net amount"
        />
      )}

      {register === 'jev' && (
        <SimpleRegister
          loading={jevs.loading}
          rows={jevs.data.map((j) => ({
            id: j.id,
            to: `/accounting/others/${j.id}`,
            ref: j.jevNo,
            date: j.jevDate,
            party: j.payeeName ?? j.sourceType,
            particulars: j.particulars,
            amount: j.totalDebit,
            status: j.status,
          }))}
          amountHeader="Total"
        />
      )}

      {register === 'check' && (
        <SimpleRegister
          loading={checks.loading}
          rows={checks.data
            .filter((c) => c.fiscalYear === fiscalYear && c.fundCode === fundCode)
            .map((c) => ({
              id: c.id,
              to: `/accounting/checks`,
              ref: c.checkNo,
              date: c.checkDate,
              party: c.payeeName,
              particulars: `${c.bankName} - DV ${c.dvNo}`,
              amount: c.netAmount,
              status: c.status,
            }))}
          amountHeader="Amount"
        />
      )}

      {register === 'ada' && (
        <SimpleRegister
          loading={ada.loading}
          rows={ada.data
            .filter((a) => a.fiscalYear === fiscalYear && a.fundCode === fundCode)
            .map((a) => ({
              id: a.id,
              to: `/accounting/ada`,
              ref: a.adaNo,
              date: a.adaDate,
              party: a.payeeName,
              particulars: `${a.bankName} - DV ${a.dvNo}`,
              amount: a.amount,
              status: a.status,
            }))}
          amountHeader="Amount"
        />
      )}

      {register === 'rcd' && (
        <SimpleRegister
          loading={rcds.loading}
          rows={rcds.data.map((r) => ({
            id: r.id,
            to: `/treasury/rcd`,
            ref: r.rcdNo ?? 'Draft',
            date: r.rcdDate,
            party: r.collectingOfficerName,
            particulars: `OR ${r.orNumberFrom} to ${r.orNumberTo}`,
            amount: r.totalCollections,
            status: r.status,
          }))}
          amountHeader="Collections"
        />
      )}

      {register === 'obr' && (
        <SimpleRegister
          loading={obligations.loading}
          rows={obligations.data.map((o) => ({
            id: o.id,
            to: `/budget/obligations/${o.id}`,
            ref: o.obrNo ?? 'Draft',
            date: o.obrDate,
            party: o.payeeName,
            particulars: `${o.officeName} - ${o.particulars}`,
            amount: o.totalAmount,
            status: o.status,
          }))}
          amountHeader="Obligated"
        />
      )}

      {(register === 'payables' || register === 'receivables') && (
        <Schedule
          kind={register}
          ledger={ledger.data}
          accounts={accounts.data}
          loading={ledger.loading}
        />
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

interface SimpleRow {
  id: string;
  to: string;
  ref: string;
  date: string;
  party: string;
  particulars: string;
  amount: Centavos;
  status: string;
}

function SimpleRegister({
  rows,
  loading,
  amountHeader,
}: {
  rows: SimpleRow[];
  loading: boolean;
  amountHeader: string;
}) {
  const total = rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + r.amount, 0);

  if (loading) return <Spinner label="Loading the register" />;
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">Nothing recorded for this fund and year.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="cbo-th w-28">Reference</th>
            <th className="cbo-th w-24">Date</th>
            <th className="cbo-th">Payee / party</th>
            <th className="cbo-th">Particulars</th>
            <th className="cbo-th w-36 text-right">{amountHeader}</th>
            <th className="cbo-th w-28">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="cbo-td">
                <Link to={r.to} className="font-mono text-xs text-brand-700 hover:underline no-print">
                  {r.ref}
                </Link>
                <span className="hidden font-mono text-xs print:inline">{r.ref}</span>
              </td>
              <td className="cbo-td text-xs">{formatShortDate(r.date)}</td>
              <td className="cbo-td text-sm">{r.party}</td>
              <td className="cbo-td">
                <span className="line-clamp-1 text-xs text-slate-600">{r.particulars}</span>
              </td>
              <td className="cbo-td cbo-amount">{formatPeso(r.amount, { symbol: false })}</td>
              <td className="cbo-td">
                <StatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy-800 font-semibold">
            <td className="cbo-td border-b-0" colSpan={4}>
              Total - {rows.length} records
            </td>
            <td className="cbo-td cbo-amount border-b-0">{formatPeso(total, { symbol: false })}</td>
            <td className="cbo-td border-b-0" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * Schedule of payables or receivables, aged.
 *
 * Built from the subsidiary detail of the relevant control accounts in the
 * General Ledger rather than from the source documents, so it agrees with the
 * Statement of Financial Position by construction.
 */
function Schedule({
  kind,
  ledger,
  accounts,
  loading,
}: {
  kind: 'payables' | 'receivables';
  ledger: Array<{
    accountCode: string;
    accountName: string;
    subsidiaryId?: string | null;
    subsidiaryName?: string | null;
    signedAmount: number;
    entryDate: string;
  }>;
  accounts: Array<{ code: string; fsClassification: string }>;
  loading: boolean;
}) {
  const today = todayPh();

  const relevantCodes = useMemo(() => {
    const wanted = kind === 'payables' ? ['CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY'] : ['CURRENT_ASSET'];
    return new Set(
      accounts
        .filter((a) => wanted.includes(a.fsClassification))
        .filter((a) => (kind === 'payables' ? a.code.startsWith('2') : a.code.startsWith('103')))
        .map((a) => a.code),
    );
  }, [accounts, kind]);

  const rows = useMemo(() => {
    const map = new Map<
      string,
      { account: string; accountName: string; party: string; balance: number; oldest: string }
    >();

    for (const e of ledger) {
      if (!relevantCodes.has(e.accountCode)) continue;
      const key = `${e.accountCode}__${e.subsidiaryId ?? 'unassigned'}`;
      const row = map.get(key) ?? {
        account: e.accountCode,
        accountName: e.accountName,
        party: e.subsidiaryName ?? 'Not identified',
        balance: 0,
        oldest: e.entryDate,
      };
      row.balance += e.signedAmount;
      if (e.entryDate < row.oldest) row.oldest = e.entryDate;
      map.set(key, row);
    }

    return [...map.values()]
      .map((r) => ({
        ...r,
        // Payables are credit-normal, so a negative signed balance is what is
        // owed. Present it as a positive figure.
        presented: kind === 'payables' ? -r.balance : r.balance,
        bucket: agingBucket(r.oldest, today),
      }))
      .filter((r) => r.presented !== 0)
      .sort((a, b) => b.presented - a.presented);
  }, [ledger, relevantCodes, kind, today]);

  const total = rows.reduce((s, r) => s + r.presented, 0);

  if (loading) return <Spinner label="Reading the ledger" />;

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        No {kind === 'payables' ? 'payables' : 'receivables'} balances in the General Ledger for
        this fund and year.
      </p>
    );
  }

  return (
    <>
      <Alert tone="info" className="mb-4">
        Derived from the subsidiary detail of the {kind === 'payables' ? 'liability' : 'receivable'}{' '}
        control accounts in the General Ledger, so this schedule agrees with the Statement of
        Financial Position. Ageing is from the date of the oldest entry against each party.
      </Alert>

      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="cbo-th">Account</th>
            <th className="cbo-th">Party</th>
            <th className="cbo-th w-28">Oldest entry</th>
            <th className="cbo-th w-32">Age</th>
            <th className="cbo-th w-40 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="cbo-td">
                <span className="font-mono text-xs text-slate-500">{r.account}</span>{' '}
                <span className="text-sm">{r.accountName}</span>
              </td>
              <td className="cbo-td text-sm">{r.party}</td>
              <td className="cbo-td text-xs">{formatShortDate(r.oldest)}</td>
              <td className="cbo-td text-xs">{AGING_LABELS[r.bucket]}</td>
              <td className="cbo-td cbo-amount">{formatPeso(r.presented, { symbol: false, parens: true })}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy-800 font-semibold">
            <td className="cbo-td border-b-0" colSpan={4}>
              Total - {rows.length} balances
            </td>
            <td className="cbo-td cbo-amount border-b-0">{formatPeso(total, { symbol: false })}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}
