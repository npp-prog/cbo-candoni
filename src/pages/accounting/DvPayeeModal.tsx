import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { AmountInput, Field, Select, TextInput } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Layout';
import { useToast } from '@/components/ui/Toast';
import { PayeePicker } from '@/components/pickers';
import { addPayeeToMaster } from '@/components/pickers/NewPayeeModal';
import { useAuth } from '@/auth/AuthProvider';
import { formatPeso } from '@/lib/money';
import { findPayeeDuplicates, missingPayeeFields, type PayeeLike } from '@/lib/payees';
import { PAYEE_TYPES } from '@/types/enums';
import type { DvPayeeRow } from './DvPayeesCard';

/**
 * "Add a payee" on a voucher for several payees. Patch 139.
 *
 * One window for the whole of a payee's line: who they are - picked from the
 * master list, or typed in as a new payee and saved to the master list on the
 * spot - their ATM / account number and their share of the net. "Add and
 * next" keeps the window open for the following payee, so a list keyed by hand
 * is keyed in one sitting.
 *
 * A new payee is saved with the account number entered here, so the next
 * voucher that pays them finds it.
 */
export function DvPayeeModal({
  existing,
  listedIds,
  remaining,
  accountOf,
  mayCreate,
  onAdd,
  onClose,
}: {
  /** The payee master list (for the duplicate check of a new payee). */
  existing: PayeeLike[];
  /** Payees already on this voucher. */
  listedIds: string[];
  /** The net not yet shared out among the payees listed. */
  remaining: number;
  /** The account number on a payee's master record (employee's first). */
  accountOf: (payeeId: string) => string;
  /** May this user add to the payee master list. */
  mayCreate: boolean;
  onAdd: (row: DvPayeeRow) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const [mode, setMode] = useState<'LIST' | 'NEW'>('LIST');
  const [payeeId, setPayeeId] = useState<string | null>(null);
  const [payeeName, setPayeeName] = useState('');
  const [name, setName] = useState('');
  const [payeeType, setPayeeType] = useState<string>('EMPLOYEE');
  const [tin, setTin] = useState('');
  const [address, setAddress] = useState('');
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState<number | null>(remaining > 0 ? remaining : null);
  const [left, setLeft] = useState(remaining);
  const [saving, setSaving] = useState(false);

  const duplicates = useMemo(
    () => (mode === 'NEW' ? findPayeeDuplicates({ name, tin }, existing) : []),
    [mode, name, tin, existing],
  );
  const already = payeeId ? listedIds.includes(payeeId) : false;

  const pick = (id: string | null, label: string) => {
    setMode('LIST');
    setPayeeId(id);
    setPayeeName(label);
    if (id) setAccount(accountOf(id));
  };

  const reset = (stillLeft: number) => {
    setPayeeId(null);
    setPayeeName('');
    setName('');
    setTin('');
    setAddress('');
    setAccount('');
    setLeft(stillLeft);
    setAmount(stillLeft > 0 ? stillLeft : null);
  };

  const add = async (next: boolean) => {
    const problems: string[] = [];
    if (mode === 'LIST' && !payeeId) problems.push('choose the payee');
    if (mode === 'NEW') {
      const missing = missingPayeeFields({ name, payeeType });
      if (missing.length) problems.push(`enter the ${missing.join(' and ').toLowerCase()}`);
    }
    if (!account.trim()) problems.push('enter the ATM / account number');
    if (!(amount && amount > 0)) problems.push('enter the share');
    if (problems.length) {
      toast.error('Not yet complete', `Please ${problems.join(', ')}.`);
      return;
    }
    if (already) {
      toast.error('Already on this voucher', `${payeeName} is listed. Change their share there.`);
      return;
    }

    let row: DvPayeeRow;
    if (mode === 'NEW') {
      if (!user) return;
      setSaving(true);
      try {
        const created = await addPayeeToMaster(
          { name, payeeType, tin, address, bankAccountNumber: account },
          {
            uid: user.uid,
            name: profile?.displayName ?? user.email ?? user.uid,
            position: profile?.position,
          },
        );
        row = {
          payeeId: created.id,
          payeeName: created.name,
          accountNumber: account.trim(),
          amount: amount ?? 0,
        };
        toast.success('Payee added', `${created.name} is on the master list and on this voucher.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          'Could not add the payee',
          message.includes('permission')
            ? 'Your account is not allowed to add a payee. Ask the Accountant, the Budget Officer or the Treasurer.'
            : message,
        );
        return;
      } finally {
        setSaving(false);
      }
    } else {
      row = {
        payeeId,
        payeeName,
        accountNumber: account.trim(),
        amount: amount ?? 0,
        accountDiffers: Boolean(
          payeeId && accountOf(payeeId) && accountOf(payeeId).trim() !== account.trim(),
        ),
      };
    }

    onAdd(row);
    if (next) reset(left - (amount ?? 0));
    else onClose();
  };

  const tab = (m: 'LIST' | 'NEW', label: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setMode(m)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        mode === m ? 'bg-navy-800 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {label}
    </button>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a payee"
      description="Who is paid, the account the bank credits, and their share of the net. Nothing on the voucher is lost."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button loading={saving} onClick={() => void add(true)}>
            Add and next
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void add(false)}>
            Add
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tab('LIST', 'On the master list')}
        {tab('NEW', 'New payee', !mayCreate)}
        {!mayCreate && (
          <span className="text-2xs text-slate-500">
            Only the Accountant, the Budget Officer or the Treasurer can add a new payee.
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {mode === 'LIST' ? (
          <Field label="Payee" required htmlFor="dvp-payee" className="sm:col-span-2">
            <PayeePicker
              id="dvp-payee"
              value={payeeId}
              onChange={(v, p) => pick(v, p?.name ?? '')}
            />
            {already && (
              <p className="mt-1 text-2xs text-rose-700">
                Already on this voucher - change their share in the list instead.
              </p>
            )}
          </Field>
        ) : (
          <>
            {duplicates.length > 0 && (
              <Alert
                tone="warning"
                className="sm:col-span-2"
                title={
                  duplicates[0].matchedOn === 'TIN'
                    ? 'A payee with this TIN is already on file'
                    : 'A payee with this name is already on file'
                }
              >
                <ul className="space-y-1">
                  {duplicates.map(({ payee, matchedOn }) => (
                    <li key={payee.id} className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="font-medium underline"
                        onClick={() => pick(payee.id, payee.name)}
                      >
                        Use {payee.name}
                      </button>
                      <span className="text-2xs">
                        {matchedOn === 'TIN' ? `same TIN - ${payee.tin}` : 'same name'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <Field label="Name" required htmlFor="dvp-name" className="sm:col-span-2">
              <TextInput
                id="dvp-name"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder="As it should print on the list of payees"
              />
            </Field>
            <Field label="Type" required htmlFor="dvp-type">
              <Select
                id="dvp-type"
                value={payeeType}
                onChange={(e) => setPayeeType(e.target.value)}
              >
                {PAYEE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="TIN" htmlFor="dvp-tin" hint="Leave blank if not known.">
              <TextInput
                id="dvp-tin"
                value={tin}
                onChange={(e) => setTin(e.target.value)}
                placeholder="000-000-000-000"
                className="font-mono"
              />
            </Field>
            <Field label="Address" htmlFor="dvp-address" className="sm:col-span-2">
              <TextInput
                id="dvp-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
          </>
        )}

        <Field
          label="ATM / account number"
          required
          htmlFor="dvp-account"
          hint={
            mode === 'NEW'
              ? 'Saved to the new payee record as well.'
              : 'Filled from the payee record where it has one.'
          }
        >
          <TextInput
            id="dvp-account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field
          label="Share of the net"
          required
          htmlFor="dvp-amount"
          hint={`Not yet shared out: ${formatPeso(left, { symbol: false })}`}
        >
          <AmountInput id="dvp-amount" value={amount} onChange={(v) => setAmount(v)} />
        </Field>
      </div>
    </Modal>
  );
}
