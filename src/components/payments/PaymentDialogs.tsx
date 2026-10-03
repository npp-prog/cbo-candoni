import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Layout';
import { Field, TextInput, DateInput, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker } from '@/components/pickers';
import { useAdaNumbers } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { clearingObjection, CLEARING_OVERRIDE_MIN_LENGTH } from '@/lib/clearing';
import { todayPh } from '@/lib/dates';

/**
 * Drawing a check and preparing an advice.
 *
 * These lived on the Accounting voucher screen. They are Treasury acts - the
 * Accountant approves a payment, the Treasurer makes one - so they live here,
 * in a module of their own, and are used from TREASURY > DISBURSEMENTS.
 *
 * Nothing about what either one does has changed. The clearing-house check on
 * the payee, the uniqueness of the check number, the reserved ADA numbers: all
 * of it is as it was, and all of it is still decided on the server.
 */

export function IssueCheckDialog({
  dvId,
  fundCode,
  netAmount,
  payeeName,
  defaultBankAccountId,
  onClose,
  onIssued,
}: {
  dvId: string;
  fundCode: string;
  netAmount: number;
  payeeName: string;
  defaultBankAccountId: string | null;
  onClose: () => void;
  onIssued: (checkNo: string) => void;
}) {
  const toast = useToast();
  const [bankAccountId, setBankAccountId] = useState(defaultBankAccountId);
  const [checkNo, setCheckNo] = useState('');
  const [checkDate, setCheckDate] = useState(todayPh());
  const [acknowledgement, setAcknowledgement] = useState('');
  const [busy, setBusy] = useState(false);

  // The same rule the server decides with, so the warning and the refusal
  // cannot disagree. See src/lib/clearing.ts.
  const objection = clearingObjection(payeeName);
  const acknowledged = acknowledgement.trim().length >= CLEARING_OVERRIDE_MIN_LENGTH;

  const issue = async () => {
    if (!bankAccountId || !checkNo.trim()) {
      toast.error('Incomplete', 'A bank account and check number are required.');
      return;
    }
    if (objection && !acknowledged) {
      toast.error(
        'The bank will return this check',
        'Say in writing why the office is drawing it anyway.',
      );
      return;
    }
    setBusy(true);
    try {
      const result = await engine.issueCheck({
        dvId,
        bankAccountId,
        checkNo: checkNo.trim(),
        checkDate,
        payeeAcknowledgement: objection ? acknowledgement.trim() : undefined,
      });
      onIssued(result.checkNo);
    } catch (err) {
      // The uniqueness constraint lives in the database, so a clash is
      // reported from the server rather than guessed at here.
      toast.error('The check was not issued', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Issue a check"
      description={`${payeeName} - ${formatPeso(netAmount)}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={objection ? 'danger' : 'success'}
            loading={busy}
            disabled={Boolean(objection) && !acknowledged}
            onClick={() => void issue()}
          >
            {objection ? 'Issue anyway' : 'Issue check'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {objection && (
          <Alert tone="error" title="The clearing house will refuse this payee">
            <p>
              The payee is <strong>{payeeName}</strong>. {objection.message}
            </p>
            <Field
              label="Why the office is drawing it anyway"
              className="mt-3"
              hint="At least fifteen characters. Recorded against the check as a critical audit event."
            >
              <TextInput
                value={acknowledgement}
                onChange={(e) => setAcknowledgement(e.target.value)}
                placeholder="Approved by the Treasurer for petty cash replenishment"
              />
            </Field>
          </Alert>
        )}

        <Field label="Bank account" required htmlFor="checkBank">
          <BankAccountPicker
            id="checkBank"
            value={bankAccountId}
            fundCode={fundCode}
            onChange={setBankAccountId}
          />
        </Field>

        <Field
          label="Check number"
          required
          htmlFor="checkNo"
          hint="Must be unique within the bank account. The database enforces this, so a duplicate is refused outright."
        >
          <TextInput
            id="checkNo"
            value={checkNo}
            onChange={(e) => setCheckNo(e.target.value)}
            placeholder="0001234"
            className="font-mono"
          />
        </Field>

        <Field label="Check date" required htmlFor="checkDate">
          <DateInput id="checkDate" value={checkDate} onChange={setCheckDate} />
        </Field>
      </div>
    </Modal>
  );
}

export function PrepareAdaDialog({
  dvId,
  fiscalYear,
  fundCode,
  netAmount,
  payeeName,
  defaultBankAccountId,
  onClose,
  onPrepared,
}: {
  dvId: string;
  fiscalYear: number;
  fundCode: string;
  netAmount: number;
  payeeName: string;
  defaultBankAccountId: string | null;
  onClose: () => void;
  onPrepared: (adaNo: string) => void;
}) {
  const toast = useToast();
  const [bankAccountId, setBankAccountId] = useState(defaultBankAccountId);
  const [adaDate, setAdaDate] = useState(todayPh());
  const [reservationId, setReservationId] = useState('');
  const [busy, setBusy] = useState(false);

  const adaNumbers = useAdaNumbers(fiscalYear, fundCode);
  const reserved = useMemo(
    () => adaNumbers.data.filter((r) => r.state === 'RESERVED'),
    [adaNumbers.data],
  );

  const prepare = async () => {
    if (!bankAccountId) {
      toast.error('Incomplete', 'Select the bank account the ADA is drawn on.');
      return;
    }
    setBusy(true);
    try {
      const result = await engine.issueAda({
        dvId,
        bankAccountId,
        adaDate,
        reservationId: reservationId || undefined,
      });
      onPrepared(result.adaNo);
    } catch (err) {
      toast.error('The ADA was not prepared', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Prepare Advice to Debit Account"
      description={`${payeeName} - ${formatPeso(netAmount)}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="success" loading={busy} onClick={() => void prepare()}>
            Prepare ADA
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Bank account" required htmlFor="adaBank">
          <BankAccountPicker
            id="adaBank"
            value={bankAccountId}
            fundCode={fundCode}
            onChange={setBankAccountId}
          />
        </Field>

        <Field label="ADA date" required htmlFor="adaDate">
          <DateInput id="adaDate" value={adaDate} onChange={setAdaDate} />
        </Field>

        {reserved.length > 0 && (
          <Field
            label="Use a reserved number"
            htmlFor="adaReservation"
            hint="Leave this as the next number unless the office reserved one for this batch. Using a reservation is the only thing that stops it becoming a gap to explain later."
          >
            <Select
              id="adaReservation"
              value={reservationId}
              onChange={(e) => setReservationId(e.target.value)}
            >
              <option value="">Draw the next number</option>
              {reserved.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.adaNo}
                  {r.note ? ` - ${r.note}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
