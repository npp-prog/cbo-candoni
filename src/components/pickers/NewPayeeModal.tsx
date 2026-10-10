import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, Select } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Layout';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { upsertMaster, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { PAYEE_TYPES } from '@/types/enums';
import { findPayeeDuplicates, missingPayeeFields, type PayeeLike } from '@/lib/payees';
import { employeeMirror } from '@/lib/names';

/**
 * Add a payee without leaving the document being encoded.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * A clerk half way through an Obligation Request finds the supplier is not on
 * file. Before this, the only route was Master Data - which meant abandoning
 * the OBR, going to another screen, and coming back to start again.
 *
 * Nobody does that. What they do instead is put the supplier in under whatever
 * name the form will accept and carry on, and the municipality ends up with
 * "ABC", "abc trading" and "ABC Trdg" attached to three posted obligations,
 * where they can no longer be merged.
 *
 * So this opens over the document rather than replacing it. Closing it - by
 * Cancel, by Escape, by saving - leaves the OBR exactly as it was, with the
 * new payee selected if one was created.
 *
 * ---------------------------------------------------------------------------
 * ONLY THE FIELDS A PAYMENT CANNOT WAIT FOR
 * ---------------------------------------------------------------------------
 * Name, type, TIN and address. The bank details, contact number and email are
 * NOT here: they are needed when the payee is first paid by ADA, not when the
 * obligation is raised, and asking for them now is the interruption all over
 * again. They are filled in under Master Data > Payees, which the modal says.
 */
/**
 * Saves a new payee to the master list. Shared by this window and, from patch
 * 139, the "Add a payee" window of a voucher for several payees. Blank
 * optional fields are left out rather than written blank: an empty TIN reads
 * as "we checked and there is none", and nobody checked.
 */
export async function addPayeeToMaster(
  fields: {
    name: string;
    payeeType: string;
    tin?: string;
    address?: string;
    bankAccountNumber?: string;
    /** Patch 159: an employee's own details, for a name of type Employee. */
    employee?: Record<string, string>;
  },
  actor: { uid: string; name: string; position?: string },
): Promise<{
  id: string;
  name: string;
  tin?: string;
  address?: string;
  bankAccountNumber?: string;
  /** False when the employee record could not be written (see below). */
  employeeSaved?: boolean;
}> {
  const id = crypto.randomUUID();
  const tin = (fields.tin ?? '').trim();
  const address = (fields.address ?? '').trim();
  const bankAccountNumber = (fields.bankAccountNumber ?? '').trim();
  const payee = {
    id,
    name: fields.name.trim(),
    payeeType: fields.payeeType,
    ...(tin ? { tin } : {}),
    ...(address ? { address } : {}),
    ...(bankAccountNumber ? { bankAccountNumber } : {}),
    active: true,
  };
  const employee =
    fields.payeeType === 'EMPLOYEE' && fields.employee
      ? Object.fromEntries(
          Object.entries(fields.employee)
            .map(([k, v]) => [k, String(v ?? '').trim()])
            .filter(([, v]) => v),
        )
      : null;
  await upsertMaster(COL.payees, id, { ...payee, ...(employee ?? {}) }, actorStamp(actor));
  /*
   * Patch 159: an employee added here is an employee everywhere at once - the
   * employee record (same id) is written too, so the officer pickers offer
   * them. Only Master Data writers may write employee records; for anyone
   * else the Name is saved with the details on it, and the record is made
   * the next time the Name is saved under Master Data > Names.
   */
  let employeeSaved: boolean | undefined;
  if (employee) {
    try {
      const mirror = employeeMirror({ ...payee, ...employee }, id);
      await upsertMaster(COL.employees, mirror.id, mirror.data, actorStamp(actor));
      await upsertMaster(COL.payees, id, { employeeId: mirror.id }, actorStamp(actor));
      employeeSaved = true;
    } catch {
      employeeSaved = false;
    }
  }
  return {
    employeeSaved,
    id,
    name: payee.name,
    tin: tin || undefined,
    address: address || undefined,
    bankAccountNumber: bankAccountNumber || undefined,
  };
}

export function NewPayeeModal({
  initialName,
  initialTin = '',
  initialAccountNumber,
  initialPayeeType,
  existing,
  onClose,
  onCreated,
}: {
  /** Whatever had been typed into the picker. */
  initialName: string;
  /** Patch 138: from an uploaded list of payees. */
  initialTin?: string;
  /**
   * Patch 138: the ATM / bank account from an uploaded list of payees. When
   * given (even blank), the window asks for it and saves it to the master
   * record - the payee is about to be paid by ADA.
   */
  initialAccountNumber?: string;
  initialPayeeType?: string;
  /** The payees already on file, for the duplicate check. */
  existing: PayeeLike[];
  onClose: () => void;
  onCreated: (payee: {
    id: string;
    name: string;
    tin?: string;
    address?: string;
    bankAccountNumber?: string;
  }) => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const [name, setName] = useState(initialName);
  const [payeeType, setPayeeType] = useState<string>(initialPayeeType ?? 'SUPPLIER');
  const [tin, setTin] = useState(initialTin);
  const askAccount = initialAccountNumber !== undefined;
  const [bankAccountNumber, setBankAccountNumber] = useState(initialAccountNumber ?? '');
  const [address, setAddress] = useState('');
  /* Patch 159: the employee details, for a name of type Employee. */
  const [emp, setEmp] = useState<Record<string, string>>({});
  const setE = (k: string, v: string) => setEmp((e) => ({ ...e, [k]: v }));
  const isEmployee = payeeType === 'EMPLOYEE';
  const [saving, setSaving] = useState(false);

  const duplicates = useMemo(
    () => findPayeeDuplicates({ name, tin }, existing),
    [name, tin, existing],
  );

  const save = async () => {
    const missing = missingPayeeFields({ name, payeeType });
    if (isEmployee) {
      for (const [k, label] of [
        ['employeeNumber', 'Employee number'],
        ['lastName', 'Last name'],
        ['firstName', 'First name'],
        ['employmentType', 'Employment type'],
      ])
        if (!emp[k]?.trim()) missing.push(label);
    }
    if (missing.length > 0) {
      toast.error('Incomplete', `Required: ${missing.join(', ')}.`);
      return;
    }
    if (!user) return;

    setSaving(true);
    try {
      const created = await addPayeeToMaster(
        { name, payeeType, tin, address, bankAccountNumber, employee: isEmployee ? emp : undefined },
        {
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        },
      );
      if (created.employeeSaved === false) {
        toast.success(
          'Name added',
          'The employee details are on the Name. Ask the Accountant or the Treasurer to open it under Master Data > Names and save it, so it is offered as an officer too.',
        );
      } else {
        toast.success(
          'Name added',
          'Complete the bank and contact details under Master Data > Names before paying them by ADA.',
        );
      }
      onCreated(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        'Could not add the payee',
        message.includes('permission')
          ? 'Your account is not allowed to add a payee. Ask the Accountant, the Budget Officer or the Treasurer to add them under Master Data.'
          : message,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a payee"
      description="This is saved to Master Data and selected on the document you are encoding. Nothing you have entered is lost."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Add and select
          </Button>
        </>
      }
    >
      {duplicates.length > 0 && (
        <Alert
          tone="warning"
          title={
            duplicates[0].matchedOn === 'TIN'
              ? 'A payee with this TIN is already on file'
              : 'A payee with this name is already on file'
          }
          className="mb-4"
        >
          <p>
            {duplicates[0].matchedOn === 'TIN'
              ? 'Two records under one TIN are one taxpayer, whatever each is called. Adding this would split their payment history in two.'
              : 'Check whether this is the same one before adding a second record. Once an obligation is posted against each, they cannot be merged.'}
          </p>
          <ul className="mt-2 space-y-1">
            {duplicates.map(({ payee, matchedOn }) => (
              <li key={payee.id} className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() =>
                    onCreated({ id: payee.id, name: payee.name, tin: payee.tin })
                  }
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required htmlFor="new-payee-name" className="sm:col-span-2">
          <TextInput
            id="new-payee-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="As it should print on the voucher"
          />
        </Field>

        <Field label="Type" required htmlFor="new-payee-type">
          <Select
            id="new-payee-type"
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

        <Field
          label="TIN"
          htmlFor="new-payee-tin"
          hint="Leave blank if it is not on the invoice. It can be added later."
        >
          <TextInput
            id="new-payee-tin"
            value={tin}
            onChange={(e) => setTin(e.target.value)}
            placeholder="000-000-000-000"
            className="font-mono"
          />
        </Field>

        {askAccount && (
          <Field
            label="ATM / bank account number"
            htmlFor="new-payee-account"
            className="sm:col-span-2"
            hint="The account the bank credits on an ADA. Saved to the payee's record."
          >
            <TextInput
              id="new-payee-account"
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
              className="font-mono"
            />
          </Field>
        )}

        <Field label="Address" htmlFor="new-payee-address" className="sm:col-span-2">
          <TextInput
            id="new-payee-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>

        {/* Patch 159: an employee is entered once, with their employee details. */}
        {isEmployee && (
          <>
            <Field label="Employee number" required htmlFor="new-emp-no">
              <TextInput
                id="new-emp-no"
                className="font-mono"
                value={emp.employeeNumber ?? ''}
                onChange={(e) => setE('employeeNumber', e.target.value)}
              />
            </Field>
            <Field label="Employment type" required htmlFor="new-emp-type">
              <Select
                id="new-emp-type"
                value={emp.employmentType ?? ''}
                onChange={(e) => setE('employmentType', e.target.value)}
              >
                <option value="">Choose</option>
                <option value="PERMANENT">Permanent</option>
                <option value="CASUAL">Casual</option>
                <option value="JOB_ORDER">Job Order</option>
                <option value="CONTRACT_OF_SERVICE">Contract of Service</option>
                <option value="ELECTIVE">Elective</option>
                <option value="COTERMINOUS">Coterminous</option>
              </Select>
            </Field>
            <Field label="Last name" required htmlFor="new-emp-last">
              <TextInput
                id="new-emp-last"
                value={emp.lastName ?? ''}
                onChange={(e) => setE('lastName', e.target.value)}
              />
            </Field>
            <Field label="First name" required htmlFor="new-emp-first">
              <TextInput
                id="new-emp-first"
                value={emp.firstName ?? ''}
                onChange={(e) => setE('firstName', e.target.value)}
              />
            </Field>
            <Field label="Middle name" htmlFor="new-emp-middle">
              <TextInput
                id="new-emp-middle"
                value={emp.middleName ?? ''}
                onChange={(e) => setE('middleName', e.target.value)}
              />
            </Field>
            <Field label="Position" htmlFor="new-emp-position">
              <TextInput
                id="new-emp-position"
                value={emp.position ?? ''}
                onChange={(e) => setE('position', e.target.value)}
              />
            </Field>
          </>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Bank details, contact number and email are entered under Master Data &rsaquo; Names. They
        are needed before this payee is paid by ADA or LDDAP, not before the obligation is raised.
      </p>
    </Modal>
  );
}
