import { useEffect, useMemo, useState } from 'react';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { ReportShell } from '@/components/ReportShell';
import { Field, DateInput, Select } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAda, useEmployees, usePayees } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import { fundLabel } from '../budget/Obligations';
import { PAYMENT_TAB_GROUPS, PAYMENT_CRUMBS } from './sections';
import {
  buildBankCredits,
  CREDIT_STATUS_LABEL,
  type BankCredit,
  type CreditStatus,
} from './bankCreditRows';

/**
 * Treasury > Checks and ADA > Reports > RADAI > Bank Credits.
 *
 * Patch 144 made it a register; patch 145 a REPORT in the form of the Claim
 * Sheet - seal and heading, filters for the bank account, the status and the
 * period, one ruled line per credit and the totals - so it can be printed and
 * filed with the bank's own report of the online posting.
 *
 * Every credit the advices asked the bank to make - one line per payee - and
 * whether the bank posted it online. A credit not posted is a trust liability
 * until a new voucher repays it.
 */
type Scope = '' | CreditStatus;

const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: '', label: 'All credits' },
  { value: 'POSTED', label: 'Posted' },
  { value: 'NOT_POSTED', label: 'Not posted' },
  { value: 'AWAITING', label: 'Awaiting posting' },
];

export default function BankCredits() {
  const { fiscalYear, fundCode } = useFilters();
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('');
  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);
  // Patch 180: the dates follow the fiscal year chosen at the top.
  useEffect(() => {
    setFrom(`${fiscalYear}-01-01`);
    setTo(`${fiscalYear}-12-31`);
  }, [fiscalYear]);

  const { data, loading } = useAda(bankAccountId ?? undefined);
  const payees = usePayees();
  const employees = useEmployees();

  const rows = useMemo(() => {
    const payeeById = new Map(payees.data.map((p) => [p.id, p]));
    const empById = new Map(employees.data.map((e) => [e.id, e]));
    const accountOf = (id: string | null | undefined) => {
      const p = id ? payeeById.get(id) : undefined;
      const e = p?.employeeId ? empById.get(p.employeeId) : undefined;
      return e?.bankAccountNumber || p?.bankAccountNumber || '';
    };
    return buildBankCredits(
      data.filter(
        (a) =>
          a.fiscalYear === fiscalYear &&
          a.fundCode === fundCode &&
          a.adaDate >= from &&
          a.adaDate <= to,
      ),
      accountOf,
    )
      .filter((r) => !scope || r.status === scope)
      .sort((a, b) => a.adaNo.localeCompare(b.adaNo) || a.lineNo - b.lineNo);
  }, [data, payees.data, employees.data, fiscalYear, fundCode, from, to, scope]);

  const total = rows.reduce((t, r) => t + r.amount, 0);
  const posted = rows.filter((r) => r.status === 'POSTED').reduce((t, r) => t + r.amount, 0);
  const notPosted = rows.filter((r) => r.status === 'NOT_POSTED').reduce((t, r) => t + r.amount, 0);
  const awaiting = total - posted - notPosted;

  const exportColumns: ExportColumn<BankCredit>[] = [
    { key: 'adaNo', header: 'ADA No.', value: (r) => r.adaNo },
    { key: 'radaiNo', header: 'RADAI No.', value: (r) => r.radaiNo },
    { key: 'account', header: 'ATM / Account No.', value: (r) => r.accountNumber },
    { key: 'payee', header: 'Payee', value: (r) => r.payeeName },
    { key: 'amount', header: 'Amount', kind: 'amount', value: (r) => r.amount },
    { key: 'posted', header: 'Posted online', value: (r) => r.postedDate },
    { key: 'status', header: 'Status', value: (r) => CREDIT_STATUS_LABEL[r.status] },
  ];

  if (loading || payees.loading || employees.loading)
    return <Spinner label="Reading the advices" />;

  return (
    <ReportShell
      /* Patch 150: A4 landscape, fitted to the width, the seal at the left. */
      printLayout="landscape"
      meta={{
        title: 'Bank Credits',
        fundLabel: fundLabel(fundCode),
        periodLabel: `Advices dated ${formatShortDate(from)} to ${formatShortDate(to)}${
          scope ? ` - ${SCOPES.find((s) => s.value === scope)?.label}` : ''
        }`,
      }}
      breadcrumbs={[...PAYMENT_CRUMBS, { label: 'Bank Credits' }]}
      tabs={<GroupedSectionTabs groups={PAYMENT_TAB_GROUPS} />}
      rows={rows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="Bank account" className="w-64">
            <BankAccountPicker
              value={bankAccountId}
              onChange={setBankAccountId}
              fundCode={fundCode}
            />
          </Field>
          <Field label="Status" className="w-56">
            <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={setFrom} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={setTo} />
          </Field>
        </>
      }
      footnote={
        <p>
          A credit not posted by the bank is taken up as a trust liability by the adjusting entry
          raised when the RADAI is marked posted online, and is repaid by a new voucher of the Trust
          liability kind.
        </p>
      }
    >
      {rows.length === 0 ? (
        <Alert tone="info" title="No credits match">
          No advice in this bank account and period has a credit at that stage.
        </Alert>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th
                className="border border-slate-400 px-2 py-1.5 text-right"
                style={{ width: '3rem' }}
              >
                No.
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '8rem' }}
              >
                ADA No.
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '6rem' }}
              >
                RADAI No.
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '8rem' }}
              >
                ATM / Account No.
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">Payee</th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-right"
                style={{ width: '7rem' }}
              >
                Amount
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '6rem' }}
              >
                Posted online
              </th>
              <th
                className="border border-slate-400 px-2 py-1.5 text-left"
                style={{ width: '9rem' }}
              >
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} style={{ breakInside: 'avoid' }}>
                <td className="border border-slate-400 px-2 py-1 text-right">{i + 1}</td>
                <td className="border border-slate-400 px-2 py-1 font-mono">{r.adaNo}</td>
                <td className="border border-slate-400 px-2 py-1 font-mono">{r.radaiNo}</td>
                <td className="border border-slate-400 px-2 py-1 font-mono">{r.accountNumber}</td>
                <td className="border border-slate-400 px-2 py-1">{r.payeeName}</td>
                <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                  {formatAmount(r.amount, false)}
                </td>
                <td className="border border-slate-400 px-2 py-1">
                  {r.postedDate ? formatShortDate(r.postedDate) : ''}
                </td>
                <td
                  className={`border border-slate-400 px-2 py-1 ${
                    r.status === 'NOT_POSTED' ? 'font-semibold text-amber-800' : ''
                  }`}
                >
                  {CREDIT_STATUS_LABEL[r.status]}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold">
              <td className="border border-slate-400 px-2 py-1.5 text-right" colSpan={5}>
                T O T A L &nbsp;&mdash;&nbsp; {rows.length} credit{rows.length === 1 ? '' : 's'}
              </td>
              <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(total, false)}
              </td>
              <td className="border border-slate-400" colSpan={2} />
            </tr>
            {[
              ['Posted', posted],
              ['Not posted - trust liabilities', notPosted],
              ['Awaiting posting', awaiting],
            ]
              .filter(([, v]) => (v as number) > 0)
              .map(([label, v]) => (
                <tr key={label as string}>
                  <td className="border border-slate-400 px-2 py-1 text-right" colSpan={5}>
                    {label}
                  </td>
                  <td className="border border-slate-400 px-2 py-1 text-right tabular-nums">
                    {formatAmount(v as number, false)}
                  </td>
                  <td className="border border-slate-400" colSpan={2} />
                </tr>
              ))}
          </tfoot>
        </table>
      )}
    </ReportShell>
  );
}
