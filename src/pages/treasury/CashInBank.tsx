import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, TextArea, Select, DateInput, AmountInput } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useAda,
  useBankAccounts,
  useBankLedger,
  useBankLedgerEntries,
  useChecks,
  useDeposits,
} from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso, formatAmount } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import {
  BANK_LEDGER_INFLOW,
  BANK_LEDGER_KINDS,
  BANK_LEDGER_KIND_HINTS,
  BANK_LEDGER_KIND_LABELS,
  type BankLedgerEntry,
  type BankLedgerKind,
  type BankLedgerRow,
} from '@/types/bankLedger';
import { fundLabel } from '../budget/Obligations';

/**
 * Cash in Bank - the running book for one account.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TYPED HERE, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Almost every line on this page is read from somewhere else: the checks the
 * office released, the ADA it submitted, the deposits it recorded. Those are
 * shown greyed and cannot be touched, because CBO already holds them and a
 * second copy typed into a bank book is exactly how two records of one payment
 * come to disagree - the check is cancelled in one place, stands in the other,
 * and the reconciliation absorbs the difference without anybody deciding to.
 *
 * What is keyed is the handful of things only the bank originates: interest,
 * a service charge, the withholding on that interest, a national tax allotment
 * landing. Those exist nowhere else in CBO, and that is the whole test for
 * whether something belongs on the form.
 * ---------------------------------------------------------------------------
 */

const SOURCE_LABEL: Record<BankLedgerRow['source'], string> = {
  MANUAL: 'Keyed',
  DEPOSIT: 'Deposit register',
  CHECK: 'Check register',
  ADA: 'ADA register',
};

export default function CashInBank() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data: banks } = useBankAccounts(fundCode);
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const account = banks.find((b) => b.id === bankAccountId) ?? null;

  const ledger = useBankLedger(fiscalYear, bankAccountId);
  const { data: entries, loading } = useBankLedgerEntries(fiscalYear, bankAccountId);
  const { data: deposits } = useDeposits(bankAccountId ?? undefined);
  const { data: checks } = useChecks(bankAccountId ?? undefined);
  const { data: adas } = useAda(bankAccountId ?? undefined);

  const [adding, setAdding] = useState(false);
  const [openingForm, setOpeningForm] = useState(false);
  const [voiding, setVoiding] = useState<BankLedgerEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const canKey = can('treasury', 'create');
  const canSetOpening = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'MUNICIPAL_ACCOUNTANT');

  const beginning = ledger.data?.beginningBalance ?? 0;
  const buffer = ledger.data?.buffer ?? 0;

  /**
   * The book, merged from its four sources and put in date order.
   *
   * Only money that has actually left or reached the account is here: a check
   * still with the signatories has not moved, and neither has a deposit slip
   * that was recorded but not posted.
   */
  const rows = useMemo<BankLedgerRow[]>(() => {
    if (!bankAccountId) return [];
    const out: BankLedgerRow[] = [];

    for (const e of entries) {
      if (e.voided) continue;
      const inflow = BANK_LEDGER_INFLOW[e.kind];
      out.push({
        key: `m-${e.id}`,
        date: e.entryDate,
        particulars: e.particulars,
        reference: e.referenceNo ?? '',
        deposit: inflow ? e.amount : 0,
        withdrawal: inflow ? 0 : e.amount,
        source: 'MANUAL',
        entryId: e.id,
      });
    }

    for (const d of deposits) {
      if (d.fiscalYear !== fiscalYear) continue;
      if (d.status !== 'IN_TRANSIT' && d.status !== 'CREDITED') continue;
      out.push({
        key: `d-${d.id}`,
        date: d.depositDate,
        particulars: `Deposit — ${d.collectingOfficerName ?? d.rcdNo ?? 'collections'}`,
        reference: d.depositSlipNo,
        deposit: d.amount,
        withdrawal: 0,
        source: 'DEPOSIT',
      });
    }

    for (const c of checks) {
      if (c.fiscalYear !== fiscalYear) continue;
      if (c.status !== 'RELEASED' && c.status !== 'CLEARED') continue;
      out.push({
        key: `c-${c.id}`,
        date: c.checkDate,
        particulars: `Check — ${c.payeeName}`,
        reference: c.checkNo,
        deposit: 0,
        withdrawal: c.netAmount,
        source: 'CHECK',
      });
    }

    for (const a of adas) {
      if (a.fiscalYear !== fiscalYear) continue;
      if (a.status !== 'SUBMITTED' && a.status !== 'DEBITED') continue;
      out.push({
        key: `a-${a.id}`,
        date: a.adaDate,
        particulars: `ADA — ${a.payeeName}`,
        reference: a.adaNo,
        deposit: 0,
        withdrawal: a.amount,
        source: 'ADA',
      });
    }

    // Money in before money out on the same date, so the running balance never
    // dips below what the account actually held at any point in the day.
    return out.sort(
      (x, y) => x.date.localeCompare(y.date) || y.deposit - x.deposit || x.key.localeCompare(y.key),
    );
  }, [bankAccountId, entries, deposits, checks, adas, fiscalYear]);

  const totals = rows.reduce(
    (acc, r) => ({ deposit: acc.deposit + r.deposit, withdrawal: acc.withdrawal + r.withdrawal }),
    { deposit: 0, withdrawal: 0 },
  );
  const book = beginning + totals.deposit - totals.withdrawal;
  const available = book - buffer;

  let running = beginning;

  return (
    <div>
      <PageHeader
        title="Cash in Bank"
        subtitle={`${fundLabel(fundCode)} — fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Treasury', to: '/treasury' }, { label: 'Cash in Bank' }]}
        actions={
          <>
            {canSetOpening && bankAccountId && (
              <Button variant="secondary" onClick={() => setOpeningForm(true)}>
                Opening balance
              </Button>
            )}
            {canKey && bankAccountId && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                Record a bank entry
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3 no-print">
        <Field label="Bank account" className="max-w-md">
          <BankAccountPicker value={bankAccountId} onChange={setBankAccountId} fundCode={fundCode} />
        </Field>
      </div>

      {!bankAccountId ? (
        <Alert tone="info" title="Choose a bank account">
          This book runs one account at a time, because that is how the bank statement arrives.
        </Alert>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Stat label="Balance per books" value={book} strong />
            <Stat label="Less: buffer held back" value={-buffer} muted />
            <Stat label="Available to commit" value={available} strong warn={available < 0} />
          </div>

          {ledger.loading || loading ? (
            <Spinner label="Reading the book" />
          ) : (
            <Card
              title={`${account?.bankName ?? ''} ${account?.accountNumber ?? ''}`}
              subtitle="Checks, ADA and deposits are read from their own registers and cannot be edited here."
              bodyClassName="p-0 overflow-x-auto"
            >
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border-b border-slate-300 px-2 py-2 text-left" style={{ width: '7rem' }}>
                      Date
                    </th>
                    <th className="border-b border-slate-300 px-2 py-2 text-left">Particulars</th>
                    <th className="border-b border-slate-300 px-2 py-2 text-left" style={{ width: '9rem' }}>
                      Reference
                    </th>
                    <th className="border-b border-slate-300 px-2 py-2 text-right" style={{ width: '8rem' }}>
                      Deposit
                    </th>
                    <th className="border-b border-slate-300 px-2 py-2 text-right" style={{ width: '8rem' }}>
                      Withdrawal
                    </th>
                    <th className="border-b border-slate-300 px-2 py-2 text-right" style={{ width: '9rem' }}>
                      Balance
                    </th>
                    <th className="border-b border-slate-300 px-2 py-2" style={{ width: '9rem' }} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr className="bg-slate-50 font-medium">
                    <td className="px-2 py-1.5">{fiscalYear}-01-01</td>
                    <td className="px-2 py-1.5 italic" colSpan={4}>
                      Beginning balance
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {formatAmount(beginning, false)}
                    </td>
                    <td />
                  </tr>

                  {rows.map((r) => {
                    running += r.deposit - r.withdrawal;
                    const derived = r.source !== 'MANUAL';
                    return (
                      <tr key={r.key} className={derived ? 'bg-slate-50/40' : undefined}>
                        <td className="px-2 py-1.5 whitespace-nowrap">{formatShortDate(r.date)}</td>
                        <td className={`px-2 py-1.5 ${derived ? 'text-slate-600' : ''}`}>
                          {r.particulars}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-2xs">{r.reference}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {r.deposit ? formatAmount(r.deposit, false) : ''}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {r.withdrawal ? formatAmount(r.withdrawal, false) : ''}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                          {formatAmount(running, false)}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {derived ? (
                            <span className="text-2xs text-slate-400">{SOURCE_LABEL[r.source]}</span>
                          ) : (
                            canKey && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setVoiding(entries.find((e) => e.id === r.entryId) ?? null)
                                }
                              >
                                Void
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-100 font-bold">
                    <td className="px-2 py-2 text-right" colSpan={3}>
                      TOTALS
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatAmount(totals.deposit, false)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatAmount(totals.withdrawal, false)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatAmount(book, false)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </Card>
          )}

          {entries.some((e) => e.voided) && (
            <Card title="Voided entries" className="mt-5" bodyClassName="p-0">
              <div className="divide-y divide-slate-100">
                {entries
                  .filter((e) => e.voided)
                  .map((e) => (
                    <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-xs">
                      <span className="w-24 shrink-0 text-slate-500">
                        {formatShortDate(e.entryDate)}
                      </span>
                      <Badge tone="rose">Void</Badge>
                      <span className="flex-1">{e.particulars}</span>
                      <span className="tabular-nums text-slate-500">{formatPeso(e.amount)}</span>
                      <span className="w-full text-2xs text-slate-500">{e.voidReason}</span>
                    </div>
                  ))}
              </div>
            </Card>
          )}
        </>
      )}

      {adding && bankAccountId && (
        <EntryForm
          fiscalYear={fiscalYear}
          bankAccountId={bankAccountId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            toast.success('Entry recorded');
          }}
        />
      )}

      {openingForm && bankAccountId && (
        <OpeningForm
          fiscalYear={fiscalYear}
          bankAccountId={bankAccountId}
          beginning={beginning}
          buffer={buffer}
          onClose={() => setOpeningForm(false)}
          onSaved={() => {
            setOpeningForm(false);
            toast.success('Opening balance set');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(voiding)}
        onCancel={() => setVoiding(null)}
        title="Void the entry"
        confirmLabel="Void it"
        variant="danger"
        requireReason
        reasonLabel="Why this entry should not stand"
        loading={busy}
        message="The entry stays in the book, marked void, with the reason beside it. It stops counting towards the balance from the moment it is voided."
        onConfirm={async (reason) => {
          if (!voiding) return;
          setBusy(true);
          try {
            await engine.voidBankLedgerEntry({ entryId: voiding.id, reason: reason ?? '' });
            toast.success('Entry voided');
            setVoiding(null);
          } catch (err) {
            toast.error('Could not void the entry', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  strong,
  muted,
  warn,
}: {
  label: string;
  value: number;
  strong?: boolean;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        warn ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'
      }`}
    >
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`mt-0.5 tabular-nums ${strong ? 'text-lg font-semibold' : 'text-sm'} ${
          warn ? 'text-rose-700' : muted ? 'text-slate-500' : 'text-navy-900'
        }`}
      >
        {formatPeso(value)}
      </p>
    </div>
  );
}

function EntryForm({
  fiscalYear,
  bankAccountId,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  bankAccountId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<BankLedgerKind>('INTEREST');
  const [entryDate, setEntryDate] = useState(todayPh());
  const [referenceNo, setReferenceNo] = useState('');
  const [particulars, setParticulars] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!particulars.trim()) {
      return toast.error('Incomplete', 'Describe the entry, so the book reads a year from now.');
    }
    if (!amount || amount <= 0) {
      return toast.error(
        'Enter a positive amount',
        'Whether it adds or subtracts is decided by the kind of entry, not by a minus sign.',
      );
    }
    setBusy(true);
    try {
      await engine.recordBankLedgerEntry({
        fiscalYear,
        bankAccountId,
        entryDate,
        kind,
        referenceNo: referenceNo.trim() || undefined,
        particulars: particulars.trim(),
        amount,
        remarks: remarks.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      toast.error('The entry was not recorded', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a bank entry"
      description="Only what the bank originates. Checks, ADA and deposits come from their own registers."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind" required hint={BANK_LEDGER_KIND_HINTS[kind]} className="sm:col-span-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value as BankLedgerKind)}>
            {BANK_LEDGER_KINDS.map((k) => (
              <option key={k} value={k}>
                {BANK_LEDGER_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Date" required>
          <DateInput value={entryDate} onChange={setEntryDate} />
        </Field>

        <Field label="Amount" required hint="Always positive.">
          <AmountInput value={amount} onChange={setAmount} />
        </Field>

        <Field label="Reference" hint="What the statement calls it, so reconciliation can match it.">
          <TextInput value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
        </Field>

        <Field label="Particulars" required>
          <TextInput
            value={particulars}
            onChange={(e) => setParticulars(e.target.value)}
            placeholder="Interest credited for the quarter"
          />
        </Field>

        <Field label="Remarks" className="sm:col-span-2">
          <TextArea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function OpeningForm({
  fiscalYear,
  bankAccountId,
  beginning,
  buffer,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  bankAccountId: string;
  beginning: number;
  buffer: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [balance, setBalance] = useState<number | null>(beginning);
  const [hold, setHold] = useState<number | null>(buffer);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title="Opening balance and buffer"
      description={`For fiscal year ${fiscalYear}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await engine.setBankLedgerOpening({
                  fiscalYear,
                  bankAccountId,
                  beginningBalance: balance ?? 0,
                  buffer: hold ?? 0,
                });
                onSaved();
              } catch (err) {
                toast.error('Not saved', err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Balance at the start of the year"
          hint="The bank's own figure on 1 January, not the book balance."
        >
          <AmountInput value={balance} onChange={setBalance} />
        </Field>

        <Field
          label="Buffer held back"
          hint="A maintaining balance, or an amount the office keeps back deliberately. It reduces what may be committed."
        >
          <AmountInput value={hold} onChange={setHold} />
        </Field>

        <Alert tone="info" title="The buffer is not a movement">
          It never appears as a line in the book and never reaches the bank reconciliation &mdash; a
          figure the bank has never heard of does not belong there. It only reduces the amount shown
          as available to commit.
        </Alert>

        {beginning !== 0 && (
          <Alert tone="warning" title="Restating an opening balance moves everything below it">
            Every balance in the book shifts by the difference. The change is recorded in the audit
            trail with both figures.
          </Alert>
        )}
      </div>
    </Modal>
  );
}
