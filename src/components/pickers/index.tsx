import { useMemo } from 'react';
import { Combobox, type Option } from './Combobox';
import {
  useAccounts,
  useBankAccounts,
  useEmployees,
  useOffices,
  usePayees,
  useAvailableObligations,
} from '@/data/queries';
import { EXPENSE_CLASS_LABELS } from '@/types/enums';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';

/**
 * Domain pickers.
 *
 * Each one loads its own master data and presents it the way the people using
 * that field think about it: accounts by code, payees by name with the TIN
 * visible because a clerk checks it against the invoice, obligations by OBR
 * number with the remaining balance shown because that is the figure that
 * decides whether this OBR can carry the voucher.
 */

export function AccountPicker({
  value,
  onChange,
  disabled,
  invalid,
  id,
  expenseOnly,
}: {
  value: string | null;
  onChange: (code: string | null, account: { code: string; name: string } | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  expenseOnly?: boolean;
}) {
  const { data, loading } = useAccounts(true);

  const options = useMemo<Option[]>(
    () =>
      data
        .filter((a) => (expenseOnly ? a.accountClass === 'EXPENSE' : true))
        .map((a) => ({
          value: a.code,
          code: a.code,
          label: a.name,
          detail: [
            a.accountClass,
            a.expenseClass ? EXPENSE_CLASS_LABELS[a.expenseClass] : null,
            a.isControl ? 'Control account - posts through its subsidiary ledger' : null,
          ]
            .filter(Boolean)
            .join(' - '),
        })),
    [data, expenseOnly],
  );

  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      loading={loading}
      disabled={disabled}
      invalid={invalid}
      placeholder="Account code or name"
      emptyMessage="No account matches. Only active, postable accounts appear here - check Postable is ticked in the Chart of Accounts."
      onChange={(v, opt) => onChange(v, opt ? { code: opt.value, name: opt.label } : null)}
    />
  );
}

export function PayeePicker({
  value,
  onChange,
  disabled,
  invalid,
  id,
}: {
  value: string | null;
  onChange: (id: string | null, payee: { id: string; name: string; tin?: string; address?: string } | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}) {
  const { data, loading } = usePayees();

  const options = useMemo<Option[]>(
    () =>
      data.map((p) => ({
        value: p.id,
        code: p.code,
        label: p.name,
        detail: [p.payeeType.replace(/_/g, ' '), p.tin ? `TIN ${p.tin}` : 'No TIN on file'].join(' - '),
      })),
    [data],
  );

  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      loading={loading}
      disabled={disabled}
      invalid={invalid}
      placeholder="Payee name"
      emptyMessage="No payee matches. Add them under Master Data."
      onChange={(v, opt) => {
        const payee = data.find((p) => p.id === v);
        onChange(v, payee ? { id: payee.id, name: payee.name, tin: payee.tin, address: payee.address } : null);
      }}
    />
  );
}

export function OfficePicker({
  value,
  onChange,
  disabled,
  invalid,
  id,
  restrictTo,
}: {
  value: string | null;
  onChange: (id: string | null, office: { id: string; name: string } | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  /** A department user only sees their own office. */
  restrictTo?: string[];
}) {
  const { data, loading } = useOffices();

  const options = useMemo<Option[]>(
    () =>
      data
        .filter((o) => !restrictTo?.length || restrictTo.includes(o.id))
        .map((o) => ({ value: o.id, code: o.code, label: o.name })),
    [data, restrictTo],
  );

  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      loading={loading}
      disabled={disabled}
      invalid={invalid}
      placeholder="Office"
      onChange={(v, opt) => onChange(v, opt ? { id: opt.value, name: opt.label } : null)}
    />
  );
}

export function EmployeePicker({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string | null;
  onChange: (id: string | null, employee: { id: string; name: string; employeeNumber: string } | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const { data, loading } = useEmployees();

  const options = useMemo<Option[]>(
    () =>
      data.map((e) => ({
        value: e.id,
        code: e.employeeNumber,
        label: e.displayName,
        detail: [e.position, e.officeName].filter(Boolean).join(' - '),
      })),
    [data],
  );

  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      loading={loading}
      disabled={disabled}
      placeholder="Employee"
      onChange={(v) => {
        const emp = data.find((e) => e.id === v);
        onChange(v, emp ? { id: emp.id, name: emp.displayName, employeeNumber: emp.employeeNumber } : null);
      }}
    />
  );
}

export function BankAccountPicker({
  value,
  onChange,
  fundCode,
  disabled,
  id,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  fundCode?: string;
  disabled?: boolean;
  id?: string;
}) {
  const { data, loading } = useBankAccounts(fundCode);

  const options = useMemo<Option[]>(
    () =>
      data.map((b) => ({
        value: b.id,
        label: `${b.bankName}${b.branch ? ` - ${b.branch}` : ''}`,
        // The account number is shown masked; a clerk needs the last digits to
        // tell two accounts apart, not the whole number on screen all day.
        detail: `${maskAccount(b.accountNumber)} - ${b.accountName} - ${b.fundCode}`,
      })),
    [data],
  );

  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      loading={loading}
      disabled={disabled}
      placeholder="Bank account"
      emptyMessage={
        fundCode
          ? `No bank account is configured for the ${fundCode} fund.`
          : 'No bank accounts configured.'
      }
      onChange={(v) => onChange(v)}
    />
  );
}

/**
 * Obligations a voucher can be drawn against.
 *
 * This is what makes the specification's "an approved OBR should automatically
 * be selectable in a Disbursement Voucher" real: the list is already filtered
 * to obligations with an unpaid balance, and each shows how much of it remains.
 */
export function ObligationPicker({
  value,
  onChange,
  fiscalYear,
  fundCode,
  disabled,
  id,
}: {
  value: string | null;
  onChange: (
    id: string | null,
    obligation: {
      id: string;
      obrNo: string;
      payeeId: string;
      payeeName: string;
      officeId: string;
      officeName: string;
      particulars: string;
      unpaidAmount: number;
      lines: Array<{ accountCode: string; accountName: string; amount: number }>;
    } | null,
  ) => void;
  fiscalYear: number;
  fundCode: string;
  disabled?: boolean;
  id?: string;
}) {
  const { data, loading } = useAvailableObligations(fiscalYear, fundCode);

  const options = useMemo<Option[]>(
    () =>
      data
        .filter((o) => o.status === 'OBLIGATED')
        .map((o) => ({
          value: o.id,
          code: o.obrNo,
          label: o.payeeName,
          detail: `${formatPeso(o.unpaidAmount)} unpaid of ${formatPeso(o.totalAmount)} - ${formatShortDate(o.obrDate)} - ${o.particulars?.slice(0, 50) ?? ''}`,
        })),
    [data],
  );

  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      loading={loading}
      disabled={disabled}
      placeholder="OBR number"
      emptyMessage="No certified obligation with an unpaid balance for this fund and year."
      onChange={(v) => {
        const obr = data.find((o) => o.id === v);
        onChange(
          v,
          obr
            ? {
                id: obr.id,
                obrNo: obr.obrNo,
                payeeId: obr.payeeId,
                payeeName: obr.payeeName,
                officeId: obr.officeId,
                officeName: obr.officeName,
                particulars: obr.particulars,
                unpaidAmount: obr.unpaidAmount,
                lines: (obr.lines ?? []).map((l) => ({
                  accountCode: l.accountCode,
                  accountName: l.accountName,
                  amount: l.amount,
                })),
              }
            : null,
        );
      }}
    />
  );
}

function maskAccount(accountNumber: string): string {
  if (accountNumber.length <= 4) return accountNumber;
  return `****${accountNumber.slice(-4)}`;
}

export { Combobox };
export type { Option };
