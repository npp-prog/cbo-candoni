import { useMemo, useState } from 'react';
import { Combobox, type Option } from './Combobox';
import { NewPayeeModal } from './NewPayeeModal';
import { useAuth } from '@/auth/AuthProvider';
import { PAYEE_CREATOR_ROLES } from '@/lib/payees';
import {
  useAccounts,
  useBankAccounts,
  useEmployees,
  useOffices,
  usePayees,
  useAvailableObligations,
} from '@/data/queries';
import { isBudgetChargeable } from '@/lib/chartOfAccounts';
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
  budgetChargeable,
}: {
  value: string | null;
  onChange: (code: string | null, account: { code: string; name: string } | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  /**
   * Restrict to what a budget charge may be spent on.
   *
   * Named for the question, not for the account class, because the answer is
   * not one class: an expense account, or one of the capitalisable assets
   * Capital Outlay is charged to. It was called `expenseOnly` and did what
   * the name said, which is why a Capital Outlay obligation could not be
   * encoded.
   */
  budgetChargeable?: boolean;
}) {
  const { data, loading } = useAccounts(true);

  const options = useMemo<Option[]>(
    () =>
      data
        /*
         * `expenseOnly` means "what a budget charge may be spent on", not
         * "accountClass === EXPENSE".
         *
         * The Revised Chart of Accounts has NO Capital Outlay expense
         * account: Capital Outlay is charged to the asset acquired - a
         * building, a vehicle, software. Filtering to expense accounts meant
         * a Capital Outlay obligation could not be encoded at all, which
         * nobody discovered because the chart had not been loaded yet.
         */
        .filter((a) => (budgetChargeable ? isBudgetChargeable(a.code, a.name) : true))
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
    [data, budgetChargeable],
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
  allowAdd,
}: {
  value: string | null;
  onChange: (id: string | null, payee: { id: string; name: string; tin?: string; address?: string } | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  /**
   * Offer to add the payee here, in a window over the document, when nothing
   * matches what was typed.
   *
   * On by default on the screens where a document is being ENCODED, and off
   * where a payee is only being searched for - a report filter has no business
   * creating master data, and the button there would only ever be a misclick.
   */
  allowAdd?: boolean;
}) {
  const { data, loading } = usePayees();
  const { hasRole } = useAuth();

  /**
   * Whatever was typed when nothing matched - which seeds the name field, so
   * a clerk who has already typed "Negros Hardware" does not type it twice.
   * `null` means the window is closed. An empty string is a legitimate value:
   * the picker was opened and the button pressed without typing anything.
   */
  const [adding, setAdding] = useState<string | null>(null);

  // The security rules refuse the write otherwise, and a button that fails
  // when pressed is worse than one that was never offered.
  const mayAdd = hasRole(...PAYEE_CREATOR_ROLES);

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

  const offerAdd = Boolean(allowAdd) && mayAdd && !disabled;

  return (
    <>
      <Combobox
        id={id}
        options={options}
        value={value}
        loading={loading}
        disabled={disabled}
        invalid={invalid}
        placeholder="Payee name"
        emptyMessage={
          offerAdd
            ? 'No payee matches.'
            : 'No payee matches. Add them under Master Data.'
        }
        onAdd={offerAdd ? (typed) => setAdding(typed) : undefined}
        addLabel="Add a new payee"
        onChange={(v, opt) => {
          const payee = data.find((p) => p.id === v);
          onChange(v, payee ? { id: payee.id, name: payee.name, tin: payee.tin, address: payee.address } : null);
        }}
      />

      {adding !== null && (
        <NewPayeeModal
          initialName={adding}
          existing={data}
          onClose={() => setAdding(null)}
          onCreated={(payee) => {
            setAdding(null);
            onChange(payee.id, payee);
          }}
        />
      )}
    </>
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
        //
        // The General Ledger account is shown because WITHOUT IT NOTHING CAN
        // BE DRAWN ON THIS ACCOUNT - no check, no advice, no report - and
        // until now the only way to discover that was to fill in a whole form
        // and be refused at the end of it. An account that is not mapped says
        // so here, where the account is chosen.
        detail: [
          maskAccount(b.accountNumber),
          b.accountName,
          b.fundCode,
          b.glAccountCode ? `GL ${b.glAccountCode}` : 'NO GENERAL LEDGER ACCOUNT',
        ].join(' - '),
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
