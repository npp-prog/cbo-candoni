import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader, Card, Alert, Tabs } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useBankAccounts,
  useBankTransactions,
  useChecks,
  useDeposits,
  useReconciliations,
  useLedgerEntries,
} from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, periodRange, todayPh } from '@/lib/dates';
import { computeReconciliation } from '@/lib/accounting-rules';
import { parseStatementFile, readStatementHeaders, type ParsedStatementRow } from '@/lib/export';
import type { BankTransaction } from '@/types/treasury';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';

/**
 * Bank reconciliation.
 *
 * Three ideas hold this screen together.
 *
 *  1. The book balance is never typed. It is read from the General Ledger, and
 *     re-read server-side at finalisation. A reconciliation built against a
 *     hand-entered book balance reconciles the bank to a number somebody chose.
 *
 *  2. Deposits in transit and outstanding checks are derived from the open
 *     documents, not entered as adjustments. They are the deposits CFMS recorded
 *     that the bank has not credited, and the checks CFMS issued that the bank
 *     has not paid.
 *
 *  3. The difference must be exactly zero to finalise. Not "within tolerance".
 *     A one-centavo difference is a real error somewhere, and chasing it is
 *     what keeps the books worth trusting.
 */
export default function BankReconciliation() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole, user, profile } = useAuth();
  const toast = useToast();

  const banks = useBankAccounts(fundCode);
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [statementDate, setStatementDate] = useState(() => {
    const today = todayPh();
    const period = Number(today.slice(5, 7));
    return periodRange(Number(today.slice(0, 4)), period).to;
  });
  const [balancePerBank, setBalancePerBank] = useState<number | null>(null);
  const [tab, setTab] = useState<'statement' | 'openItems' | 'summary'>('statement');
  const [showImport, setShowImport] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reconciliationId, setReconciliationId] = useState<string | null>(null);

  useEffect(() => {
    if (!bankAccountId && banks.data.length === 1) setBankAccountId(banks.data[0].id);
  }, [banks.data, bankAccountId]);

  const bank = banks.data.find((b) => b.id === bankAccountId);
  const period = Number(statementDate.slice(5, 7));

  const transactions = useBankTransactions(bankAccountId);
  const ledger = useLedgerEntries(fiscalYear, fundCode, { accountCode: bank?.glAccountCode });
  const checks = useChecks(bankAccountId ?? undefined);
  const deposits = useDeposits(bankAccountId ?? undefined);
  const reconciliations = useReconciliations(fiscalYear, fundCode);

  // --- Derived figures -----------------------------------------------------

  const balancePerBooks = useMemo(
    () =>
      ledger.data
        .filter((e) => e.period <= period)
        .reduce((s, e) => s + (e.signedAmount ?? 0), 0),
    [ledger.data, period],
  );

  const outstandingChecks = useMemo(
    () => checks.data.filter((c) => ['RELEASED', 'SIGNED', 'PREPARED'].includes(c.status)),
    [checks.data],
  );
  const outstandingChecksTotal = outstandingChecks.reduce((s, c) => s + c.netAmount, 0);

  const depositsInTransit = useMemo(
    () => deposits.data.filter((d) => ['IN_TRANSIT', 'RECORDED'].includes(d.status)),
    [deposits.data],
  );
  const depositsInTransitTotal = depositsInTransit.reduce((s, d) => s + d.amount, 0);

  /**
   * Bank-originated items the municipality has not booked: charges and
   * interest that appear on the statement and need a journal entry.
   */
  const bookAdjustments = useMemo(() => {
    const charges = transactions.data
      .filter((t) => t.matchStatus === 'BANK_CHARGE')
      .reduce((s, t) => s + t.debit, 0);
    const interest = transactions.data
      .filter((t) => t.matchStatus === 'INTEREST_INCOME')
      .reduce((s, t) => s + t.credit, 0);
    return { charges, interest, net: interest - charges };
  }, [transactions.data]);

  const totals = computeReconciliation({
    balancePerBank: balancePerBank ?? 0,
    depositsInTransit: depositsInTransitTotal,
    outstandingChecks: outstandingChecksTotal,
    bankAdjustments: 0,
    balancePerBooks,
    bookAdjustments: bookAdjustments.net,
  });

  const unmatched = transactions.data.filter((t) => t.matchStatus === 'UNMATCHED');
  const suggested = transactions.data.filter((t) => t.matchStatus === 'SUGGESTED');

  const canFinalize = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  // --- Actions -------------------------------------------------------------

  const autoMatch = async () => {
    if (!bankAccountId) return;
    setBusy(true);
    try {
      const result = await engine.autoMatchBankTransactions({
        bankAccountId,
        reconciliationId: reconciliationId ?? '',
      });
      toast.success(
        'Matching complete',
        `${result.matched} matched outright, ${result.suggested} suggested for your review, ${result.unmatched} still unmatched.`,
      );
    } catch (err) {
      toast.error('Matching failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmMatch = async (transaction: BankTransaction, accept: boolean) => {
    try {
      await updateDoc(doc(db, COL.bankTransactions, transaction.id), {
        matchStatus: accept ? 'MATCHED' : 'UNMATCHED',
        matchMethod: 'MANUAL',
        ...(accept ? {} : { matchedType: null, matchedId: null, matchedRef: null }),
      });
    } catch (err) {
      toast.error('Could not update the match', err instanceof Error ? err.message : String(err));
    }
  };

  const classify = async (transaction: BankTransaction, matchStatus: string) => {
    try {
      await updateDoc(doc(db, COL.bankTransactions, transaction.id), { matchStatus });
    } catch (err) {
      toast.error('Could not classify the transaction', err instanceof Error ? err.message : String(err));
    }
  };

  const columns: Column<BankTransaction>[] = [
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (t) => t.transactionDate,
      cell: (t) => <span className="text-xs">{formatShortDate(t.transactionDate)}</span>,
    },
    {
      key: 'ref',
      header: 'Reference',
      width: '9rem',
      value: (t) => t.referenceNo ?? '',
      cell: (t) => <span className="font-mono text-xs text-slate-500">{t.referenceNo ?? '-'}</span>,
    },
    {
      key: 'description',
      header: 'Description',
      value: (t) => t.description,
      cell: (t) => (
        <span className="line-clamp-2 text-xs text-slate-700" title={t.description}>
          {t.description}
        </span>
      ),
    },
    {
      key: 'debit',
      header: 'Withdrawal',
      kind: 'amount',
      value: (t) => t.debit,
      cell: (t) => formatPeso(t.debit, { symbol: false, dash: true }),
    },
    {
      key: 'credit',
      header: 'Deposit',
      kind: 'amount',
      value: (t) => t.credit,
      cell: (t) => formatPeso(t.credit, { symbol: false, dash: true }),
    },
    {
      key: 'match',
      header: 'Matched to',
      value: (t) => t.matchedRef ?? '',
      cell: (t) =>
        t.matchedRef ? (
          <div className="text-xs">
            <span className="font-mono text-navy-800">{t.matchedRef}</span>
            <span className="block text-slate-500">
              {t.matchedType} {t.matchConfidence !== undefined && `- ${Math.round(t.matchConfidence * 100)}% confident`}
            </span>
          </div>
        ) : (
          <span className="text-xs text-slate-400">-</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '15rem',
      fixed: true,
      sortable: false,
      value: (t) => t.matchStatus,
      cell: (t) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={t.matchStatus} />
          {t.matchStatus === 'SUGGESTED' && (
            <>
              <Button size="sm" variant="primary" onClick={() => void confirmMatch(t, true)}>
                Accept
              </Button>
              <Button size="sm" onClick={() => void confirmMatch(t, false)}>
                Reject
              </Button>
            </>
          )}
          {t.matchStatus === 'UNMATCHED' && (
            <Select
              value=""
              onChange={(e) => e.target.value && void classify(t, e.target.value)}
              className="w-auto py-1 text-xs"
              aria-label="Classify"
            >
              <option value="">Classify...</option>
              <option value="BANK_CHARGE">Bank charge</option>
              <option value="INTEREST_INCOME">Interest income</option>
              <option value="ERROR">Bank error</option>
            </Select>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Bank Reconciliation"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Reconciliation' }, { label: 'Bank Reconciliation' }]}
        actions={
          <>
            <Button size="sm" onClick={() => setShowImport(true)} disabled={!bankAccountId}>
              Import statement
            </Button>
            <Button size="sm" loading={busy} onClick={() => void autoMatch()} disabled={!bankAccountId}>
              Match automatically
            </Button>
            {canFinalize && (
              <Button
                size="sm"
                variant="primary"
                disabled={!totals.reconciled || !bankAccountId}
                onClick={() => setConfirmFinalize(true)}
                title={totals.reconciled ? undefined : 'The reconciliation must balance to zero before it can be finalised.'}
              >
                Finalise
              </Button>
            )}
          </>
        }
      />

      <Card className="mb-4" bodyClassName="py-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Bank account" required className="lg:col-span-2">
            <BankAccountPicker value={bankAccountId} fundCode={fundCode} onChange={setBankAccountId} />
          </Field>
          <Field label="Statement date" required>
            <DateInput value={statementDate} onChange={setStatementDate} />
          </Field>
          <Field
            label="Balance per bank statement"
            required
            hint="The closing balance printed on the statement."
          >
            <AmountInput value={balancePerBank} onChange={setBalancePerBank} allowNegative />
          </Field>
        </div>
      </Card>

      {!bankAccountId ? (
        <Alert tone="info">
          Select a bank account to begin. Each account is reconciled separately, and an account
          belongs to exactly one fund.
        </Alert>
      ) : (
        <>
          <ReconciliationStatement
            balancePerBank={balancePerBank ?? 0}
            depositsInTransit={depositsInTransitTotal}
            depositsInTransitCount={depositsInTransit.length}
            outstandingChecks={outstandingChecksTotal}
            outstandingChecksCount={outstandingChecks.length}
            balancePerBooks={balancePerBooks}
            bankCharges={bookAdjustments.charges}
            interestIncome={bookAdjustments.interest}
            totals={totals}
          />

          <div className="mt-4">
            <Tabs
              tabs={[
                { id: 'statement', label: 'Bank statement', count: transactions.data.length },
                {
                  id: 'openItems',
                  label: 'Open items',
                  count: outstandingChecks.length + depositsInTransit.length,
                },
                { id: 'summary', label: 'Previous reconciliations', count: reconciliations.data.length },
              ]}
              active={tab}
              onChange={(t) => setTab(t as typeof tab)}
            />
          </div>

          <div className="mt-4">
            {tab === 'statement' && (
              <>
                {(unmatched.length > 0 || suggested.length > 0) && (
                  <Alert tone={unmatched.length > 0 ? 'warning' : 'info'} className="mb-3">
                    {suggested.length > 0 &&
                      `${suggested.length} proposed match${suggested.length === 1 ? '' : 'es'} awaiting your confirmation. `}
                    {unmatched.length > 0 &&
                      `${unmatched.length} statement line${unmatched.length === 1 ? '' : 's'} could not be matched - classify them as bank charges, interest or errors, or record the missing transaction in CFMS.`}
                  </Alert>
                )}

                <DataTable
                  rows={transactions.data}
                  columns={columns}
                  rowKey={(t) => t.id}
                  loading={transactions.loading}
                  error={transactions.error}
                  searchPlaceholder="Description, reference or amount"
                  emptyTitle="No statement lines imported"
                  emptyMessage="Import the bank statement as CSV or XLSX to begin reconciling."
                  emptyAction={
                    <Button variant="primary" onClick={() => setShowImport(true)}>
                      Import statement
                    </Button>
                  }
                  pageSize={50}
                  exportMeta={{
                    title: 'Bank Statement Reconciliation Worksheet',
                    fundLabel: fundLabel(fundCode),
                    periodLabel: `${bank?.bankName} - ${formatShortDate(statementDate)}`,
                  }}
                />
              </>
            )}

            {tab === 'openItems' && (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card
                  title="Outstanding checks"
                  subtitle={`${outstandingChecks.length} checks, ${formatPeso(outstandingChecksTotal)}`}
                  bodyClassName="p-0"
                >
                  <OpenItemList
                    items={outstandingChecks.map((c) => ({
                      id: c.id,
                      ref: c.checkNo,
                      name: c.payeeName,
                      date: c.checkDate,
                      amount: c.netAmount,
                      status: c.status,
                    }))}
                    emptyMessage="No checks are outstanding."
                  />
                </Card>

                <Card
                  title="Deposits in transit"
                  subtitle={`${depositsInTransit.length} deposits, ${formatPeso(depositsInTransitTotal)}`}
                  bodyClassName="p-0"
                >
                  <OpenItemList
                    items={depositsInTransit.map((d) => ({
                      id: d.id,
                      ref: d.depositSlipNo,
                      name: d.collectingOfficerName ?? d.rcdNo ?? '',
                      date: d.depositDate,
                      amount: d.amount,
                      status: d.status,
                    }))}
                    emptyMessage="No deposits are in transit."
                  />
                </Card>
              </div>
            )}

            {tab === 'summary' && (
              <Card title="Previous reconciliations" bodyClassName="p-0">
                {reconciliations.data.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-slate-500">
                    No reconciliation has been finalised for this fund and year.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {reconciliations.data.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-navy-900">
                            {r.bankName} - {formatShortDate(r.statementDate)}
                          </p>
                          <p className="text-xs text-slate-500">
                            Adjusted balance {formatPeso(r.adjustedBankBalance)}
                            {r.difference !== 0 && ` - difference ${formatPeso(r.difference)}`}
                          </p>
                        </div>
                        <StatusBadge status={r.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </>
      )}

      {showImport && bankAccountId && (
        <ImportDialog
          bankAccountId={bankAccountId}
          statementDate={statementDate}
          onClose={() => setShowImport(false)}
          onImported={(imported, skipped) => {
            setShowImport(false);
            toast.success(
              `${imported} statement lines imported`,
              skipped > 0
                ? `${skipped} duplicate rows were skipped - they had already been imported.`
                : undefined,
            );
          }}
        />
      )}

      <ConfirmDialog
        open={confirmFinalize}
        onCancel={() => setConfirmFinalize(false)}
        onConfirm={async () => {
          if (!bankAccountId || !user) return;
          setBusy(true);
          try {
            // The reconciliation record is created at finalisation, carrying
            // the derived figures; the book balance is re-read server-side.
            const id = await createDraft(
              COL.bankReconciliations,
              {
                fiscalYear,
                period,
                fundCode,
                bankAccountId,
                bankName: bank?.bankName ?? '',
                bankAccountNumber: bank?.accountNumber ?? '',
                statementDate,
                balancePerBank: balancePerBank ?? 0,
                depositsInTransit: depositsInTransitTotal,
                outstandingChecks: outstandingChecksTotal,
                bankAdjustments: 0,
                adjustedBankBalance: totals.adjustedBankBalance,
                balancePerBooks,
                bookAdjustments: bookAdjustments.net,
                adjustedBookBalance: totals.adjustedBookBalance,
                difference: totals.difference,
                adjustments: [],
                depositInTransitIds: depositsInTransit.map((d) => d.id),
                outstandingCheckIds: outstandingChecks.map((c) => c.id),
                status: 'DRAFT',
              },
              actorStamp({
                uid: user.uid,
                name: profile?.displayName ?? user.email ?? user.uid,
                position: profile?.position,
              }),
            );
            setReconciliationId(id);
            await engine.finalizeReconciliation({ reconciliationId: id });
            toast.success(
              'Reconciliation finalised',
              'The bank and the books agree. Matched checks, ADA and deposits have been marked cleared.',
            );
            setConfirmFinalize(false);
          } catch (err) {
            toast.error('The reconciliation was not finalised', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
        loading={busy}
        title="Finalise the reconciliation"
        confirmLabel="Finalise"
        variant="primary"
        message={
          <>
            <p>
              The adjusted bank balance and the adjusted book balance both come to{' '}
              <strong>{formatPeso(totals.adjustedBankBalance)}</strong>.
            </p>
            <p className="mt-2">
              Finalising marks the matched checks as cleared, the matched ADA as debited and the
              matched deposits as credited, so they no longer appear as open items next month.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The book balance is re-read from the General Ledger on the server. Any book-side
              adjustment that has not been journalised will cause the finalisation to be refused.
            </p>
          </>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReconciliationStatement({
  balancePerBank,
  depositsInTransit,
  depositsInTransitCount,
  outstandingChecks,
  outstandingChecksCount,
  balancePerBooks,
  bankCharges,
  interestIncome,
  totals,
}: {
  balancePerBank: Centavos;
  depositsInTransit: Centavos;
  depositsInTransitCount: number;
  outstandingChecks: Centavos;
  outstandingChecksCount: number;
  balancePerBooks: Centavos;
  bankCharges: Centavos;
  interestIncome: Centavos;
  totals: { adjustedBankBalance: Centavos; adjustedBookBalance: Centavos; difference: Centavos; reconciled: boolean };
}) {
  return (
    <Card title="Bank Reconciliation Statement">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Bank side</h3>
          <dl className="space-y-1.5">
            <Line label="Balance per bank statement" value={balancePerBank} />
            <Line
              label={`Add: deposits in transit (${depositsInTransitCount})`}
              value={depositsInTransit}
              sign="+"
            />
            <Line
              label={`Less: outstanding checks (${outstandingChecksCount})`}
              value={-outstandingChecks}
              sign="-"
            />
            <div className="border-t border-navy-800 pt-1.5">
              <Line label="Adjusted bank balance" value={totals.adjustedBankBalance} bold />
            </div>
          </dl>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Book side</h3>
          <dl className="space-y-1.5">
            <Line label="Balance per books (General Ledger)" value={balancePerBooks} />
            {interestIncome > 0 && <Line label="Add: interest income credited by bank" value={interestIncome} sign="+" />}
            {bankCharges > 0 && <Line label="Less: bank charges" value={-bankCharges} sign="-" />}
            <div className="border-t border-navy-800 pt-1.5">
              <Line label="Adjusted book balance" value={totals.adjustedBookBalance} bold />
            </div>
          </dl>
        </div>
      </div>

      <div
        className={`mt-5 rounded-md px-4 py-3 ${
          totals.reconciled ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-900'
        }`}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-sm font-medium">Difference</span>
          <span className="font-mono text-lg font-semibold tabular">
            {formatPeso(totals.difference)}
          </span>
        </div>
        <p className="mt-1 text-xs">
          {totals.reconciled
            ? 'The bank and the books agree. The reconciliation can be finalised.'
            : 'A reconciliation can only be finalised at a difference of exactly zero. Match the remaining statement lines, classify bank charges and interest, and journalise any book-side adjustment.'}
        </p>
      </div>

      {(bankCharges > 0 || interestIncome > 0) && (
        <Alert tone="warning" className="mt-4">
          Bank charges of {formatPeso(bankCharges)} and interest income of {formatPeso(interestIncome)}{' '}
          appear on the statement but are not yet in the books. Post a journal entry for them - the
          server refuses to finalise a reconciliation whose book-side adjustments have not reached
          the ledger.
        </Alert>
      )}
    </Card>
  );
}

function Line({
  label,
  value,
  bold,
  sign,
}: {
  label: string;
  value: Centavos;
  bold?: boolean;
  sign?: '+' | '-';
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={`text-sm ${bold ? 'font-medium text-navy-900' : 'text-slate-600'}`}>
        {sign && <span className="mr-1 text-slate-400">{sign}</span>}
        {label}
      </dt>
      <dd className={`font-mono text-sm tabular ${bold ? 'font-semibold text-navy-900' : 'text-navy-800'}`}>
        {formatPeso(Math.abs(value), { symbol: false })}
      </dd>
    </div>
  );
}

function OpenItemList({
  items,
  emptyMessage,
}: {
  items: Array<{ id: string; ref: string; name: string; date: string; amount: Centavos; status: string }>;
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-slate-500">{emptyMessage}</p>;
  }
  return (
    <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-navy-900">{item.ref}</p>
            <p className="truncate text-xs text-slate-500">
              {item.name} - {formatShortDate(item.date)}
            </p>
          </div>
          <StatusBadge status={item.status} />
          <span className="cbo-amount text-navy-800">{formatPeso(item.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Statement import.
 *
 * Bank export formats vary enough that a human has to look at the file and say
 * which column is which, so the mapping step is interactive. Parsing happens
 * in the browser; duplicate detection happens on the server, because
 * re-importing the same statement is the single most damaging mistake in
 * reconciliation and the check belongs where it cannot be bypassed.
 */
function ImportDialog({
  bankAccountId,
  statementDate,
  onClose,
  onImported,
}: {
  bankAccountId: string;
  statementDate: string;
  onClose: () => void;
  onImported: (imported: number, skipped: number) => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ParsedStatementRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [singleAmountColumn, setSingleAmountColumn] = useState(false);

  const onFile = async (file: File) => {
    try {
      const data = await file.arrayBuffer();
      const { headers: cols } = readStatementHeaders(data);
      setBuffer(data);
      setHeaders(cols);

      // Guess the mapping from common column names. A guess the user confirms
      // is far quicker than eight dropdowns from scratch.
      const guess = (candidates: string[]) =>
        cols.find((c) => candidates.some((k) => c.toLowerCase().replace(/[^a-z]/g, '').includes(k))) ?? '';

      setMapping({
        transactionDate: guess(['transactiondate', 'trandate', 'date', 'valuedate']),
        postingDate: guess(['postingdate', 'postdate']),
        referenceNo: guess(['reference', 'refno', 'chequeno', 'checkno']),
        description: guess(['description', 'particulars', 'narration', 'details']),
        debit: guess(['debit', 'withdrawal']),
        credit: guess(['credit', 'deposit']),
        amount: guess(['amount']),
        runningBalance: guess(['balance', 'runningbalance']),
      });
    } catch (err) {
      toast.error('Could not read the file', 'Check that it is a CSV or XLSX export from the bank.');
    }
  };

  const buildPreview = () => {
    if (!buffer) return;
    const { rows, warnings: w } = parseStatementFile(buffer, {
      transactionDate: mapping.transactionDate,
      postingDate: mapping.postingDate || undefined,
      referenceNo: mapping.referenceNo || undefined,
      description: mapping.description,
      ...(singleAmountColumn
        ? { amount: mapping.amount }
        : { debit: mapping.debit, credit: mapping.credit }),
      runningBalance: mapping.runningBalance || undefined,
    });
    setPreview(rows);
    setWarnings(w);
  };

  const submit = async () => {
    if (preview.length === 0) {
      toast.error('Nothing to import', 'Map the columns and build the preview first.');
      return;
    }
    setBusy(true);
    try {
      const result = await engine.importBankStatement({
        bankAccountId,
        statementDate,
        rows: preview,
      });
      onImported(result.imported, result.duplicatesSkipped);
    } catch (err) {
      toast.error('Import failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import a bank statement"
      description="CSV or XLSX, exported from the bank."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {headers.length > 0 && preview.length === 0 && (
            <Button onClick={buildPreview}>Build preview</Button>
          )}
          {preview.length > 0 && (
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              Import {preview.length} rows
            </Button>
          )}
        </>
      }
    >
      {headers.length === 0 ? (
        <div className="py-6 text-center">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
          <Button variant="primary" onClick={() => fileRef.current?.click()}>
            Choose a statement file
          </Button>
          <p className="mt-3 text-xs text-slate-500">
            The file is read in your browser. Only the parsed rows are sent, and rows already
            imported are detected and skipped on the server.
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            Confirm which column is which. CFMS has guessed from the column names.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <MapField label="Transaction date" required value={mapping.transactionDate} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, transactionDate: v }))} />
            <MapField label="Description" required value={mapping.description} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, description: v }))} />
            <MapField label="Reference number" value={mapping.referenceNo} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, referenceNo: v }))} />
            <MapField label="Posting date" value={mapping.postingDate} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, postingDate: v }))} />

            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-navy-800">
                <input
                  type="checkbox"
                  checked={singleAmountColumn}
                  onChange={(e) => setSingleAmountColumn(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                This statement uses a single signed amount column rather than separate debit and
                credit columns
              </label>
            </div>

            {singleAmountColumn ? (
              <MapField label="Amount (negative is a withdrawal)" required value={mapping.amount} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, amount: v }))} />
            ) : (
              <>
                <MapField label="Withdrawal / debit" value={mapping.debit} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, debit: v }))} />
                <MapField label="Deposit / credit" value={mapping.credit} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, credit: v }))} />
              </>
            )}

            <MapField label="Running balance" value={mapping.runningBalance} headers={headers} onChange={(v) => setMapping((m) => ({ ...m, runningBalance: v }))} />
          </div>

          {preview.length > 0 && (
            <div className="mt-5">
              <p className="cbo-label">Preview - first five of {preview.length} rows</p>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="cbo-th">Date</th>
                    <th className="cbo-th">Description</th>
                    <th className="cbo-th text-right">Withdrawal</th>
                    <th className="cbo-th text-right">Deposit</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 5).map((row, i) => (
                    <tr key={i}>
                      <td className="cbo-td text-xs">{formatShortDate(row.transactionDate)}</td>
                      <td className="cbo-td text-xs">{row.description.slice(0, 60)}</td>
                      <td className="cbo-td cbo-amount">{formatPeso(row.debit, { symbol: false, dash: true })}</td>
                      <td className="cbo-td cbo-amount">{formatPeso(row.credit, { symbol: false, dash: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {warnings.length > 0 && (
            <Alert tone="warning" className="mt-4" title={`${warnings.length} rows skipped`}>
              <ul className="list-inside list-disc space-y-0.5">
                {warnings.slice(0, 5).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}
        </>
      )}
    </Modal>
  );
}

function MapField({
  label,
  value,
  headers,
  onChange,
  required,
}: {
  label: string;
  value: string;
  headers: string[];
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <Field label={label} required={required}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not in this file</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );
}
