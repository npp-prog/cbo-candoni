import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
import { buildBrs, type Brs } from '@/lib/brs';
import { downloadBrs } from '@/lib/brsXlsx';
import { useEntity } from '@/data/useEntity';
import { BrsPrintSheet, bankShortName } from './BrsPrintSheet';
import { parseStatementFile, readStatementHeaders, type ParsedStatementRow } from '@/lib/export';
import type { BankTransaction } from '@/types/treasury';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { RECONCILIATION_TABS } from '@/layout/sections';

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
  const entity = useEntity();
  /*
   * The BRS sheet is mounted only for its own Print, so the Print of the
   * statement-lines table below still prints that table.
   */
  const [printingBrs, setPrintingBrs] = useState(false);
  const printBrs = () => {
    flushSync(() => setPrintingBrs(true));
    const done = () => {
      setPrintingBrs(false);
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };
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

  /*
   * Patch 163: the open items are those of the statement's month or earlier -
   * the ledger is read through that month, so a check written after it is not
   * yet in the book balance either.
   */
  const asOf = `${statementDate.slice(0, 7)}-31`;
  const outstandingChecks = useMemo(
    () =>
      checks.data.filter(
        (c) => ['RELEASED', 'SIGNED', 'PREPARED'].includes(c.status) && c.checkDate <= asOf,
      ),
    [checks.data, asOf],
  );

  const depositsInTransit = useMemo(
    // Patch 159: only a deposit in the BOOKS can be in transit - one recorded
    // but not yet booked by its RCD is on neither side yet.
    () =>
      deposits.data.filter(
        (d) => ['IN_TRANSIT', 'RECORDED'].includes(d.status) && !!d.jevId && d.depositDate <= asOf,
      ),
    [deposits.data, asOf],
  );

  /*
   * Patch 163 - the Bank Reconciliation Statement in the office's format:
   * Book and Bank columns, the six lines of reconciling items, and a
   * schedule behind each (src/lib/brs.ts).
   */
  const brs: Brs = useMemo(
    () =>
      buildBrs({
        statementDate,
        bankShortName: bankShortName(bank?.bankName ?? ''),
        lguShortName: 'LGU',
        bookBalance: balancePerBooks,
        bankBalance: balancePerBank ?? 0,
        checks: outstandingChecks.map((c) => ({
          date: c.checkDate,
          ref: c.checkNo,
          name: c.payeeName,
          amount: c.netAmount,
        })),
        deposits: depositsInTransit.map((d) => ({
          date: d.depositDate,
          ref: d.depositSlipNo,
          name: d.collectingOfficerName ?? d.rcdNo ?? '',
          amount: d.amount,
        })),
        statementLines: transactions.data
          .filter((t) => ['BANK_CHARGE', 'INTEREST_INCOME', 'ERROR'].includes(t.matchStatus))
          .map((t) => ({
            date: t.transactionDate,
            ref: t.referenceNo ?? '',
            description: t.description,
            debit: t.debit,
            credit: t.credit,
            kind: t.matchStatus as 'BANK_CHARGE' | 'INTEREST_INCOME' | 'ERROR',
          })),
      }),
    [statementDate, bank?.bankName, balancePerBooks, balancePerBank, outstandingChecks, depositsInTransit, transactions.data],
  );
  const outstandingChecksTotal = brs.outstandingChecks;
  const depositsInTransitTotal = brs.depositsInTransit;
  const memos = brs.lines.find((l) => l.key === 'MEMOS_NOT_TAKEN_UP')!;
  const bookAdjustments = {
    charges: -memos.items.filter((i) => i.amount < 0).reduce((t, i) => t + i.amount, 0),
    interest: memos.items.filter((i) => i.amount > 0).reduce((t, i) => t + i.amount, 0),
    net: brs.bookAdjustments,
  };

  const totals = {
    adjustedBankBalance: brs.adjustedBank,
    adjustedBookBalance: brs.adjustedBook,
    difference: brs.difference,
    reconciled: brs.difference === 0,
  };

  const brsHeader = {
    entityName: entity.headingLines[1],
    statementDate,
    bankName: bank?.bankName ?? '',
    branch: bank?.branch ?? '',
    fundLabel: fundLabel(fundCode),
    accountNumber: bank?.accountNumber ?? '',
    preparedBy: {
      name: entity.bookkeeper.name || profile?.displayName || '',
      position: entity.bookkeeper.position || profile?.position || '',
    },
    certifiedBy: entity.municipalAccountant,
  };

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
              {t.matchedType === 'COLLECTION'
                ? 'E-COLLECTION'
                : t.matchedType === 'ERCD'
                  ? 'eRCD'
                  : t.matchedType}{' '}
              {t.matchConfidence !== undefined && `- ${Math.round(t.matchConfidence * 100)}% confident`}
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
              className="w-auto py-1.5"
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
            <Button size="sm" onClick={() => downloadBrs(brs, brsHeader)} disabled={!bankAccountId}>
              BRS Excel
            </Button>
            <Button size="sm" onClick={printBrs} disabled={!bankAccountId}>
              Print BRS
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

      <SectionTabs tabs={RECONCILIATION_TABS} />

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
          {printingBrs && <BrsPrintSheet brs={brs} header={brsHeader} />}
          <ReconciliationStatement
            brs={brs}
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
                  label: 'Schedules',
                  count: brs.lines.reduce((t, l) => t + l.items.length, 0),
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
              <div className="space-y-4">
                {brs.lines.map((l, i) => (
                  <Card
                    key={l.key}
                    title={`${i + 1}. ${l.label}`}
                    subtitle={`${l.column === 'BOOK' ? 'Book' : 'Bank'} - ${l.items.length} item${
                      l.items.length === 1 ? '' : 's'
                    }, ${formatPeso(l.amount)}`}
                    bodyClassName="p-0"
                  >
                    <ScheduleTable line={l} />
                  </Card>
                ))}
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
                bankAdjustments: brs.bankAdjustments,
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
  brs,
  bankCharges,
  interestIncome,
  totals,
}: {
  brs: Brs;
  bankCharges: Centavos;
  interestIncome: Centavos;
  totals: { adjustedBankBalance: Centavos; adjustedBookBalance: Centavos; difference: Centavos; reconciled: boolean };
}) {
  const fig = (v: number | null) =>
    v === null ? '' : v === 0 ? '-' : v < 0 ? `(${formatPeso(-v, { symbol: false })})` : formatPeso(v, { symbol: false });
  const TD = 'px-3 py-1.5 text-right font-mono tabular';
  return (
    <Card title="Bank Reconciliation Statement" subtitle={`For the Month of ${brs.monthLabel}`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-xs uppercase tracking-wider text-slate-500">
              <th className="px-3 py-1.5 text-left font-semibold">Particular</th>
              <th className="w-40 px-3 py-1.5 text-right font-semibold">Book</th>
              <th className="w-40 px-3 py-1.5 text-right font-semibold">Bank</th>
              <th className="w-56 px-3 py-1.5 text-left font-semibold">Explanatory Note</th>
            </tr>
          </thead>
          <tbody>
            <tr className="font-medium text-navy-900">
              <td className="px-3 py-1.5">Unadjusted Balances</td>
              <td className={TD}>{fig(brs.bookBalance)}</td>
              <td className={TD}>{fig(brs.bankBalance)}</td>
              <td />
            </tr>
            <tr>
              <td className="px-3 pt-2 text-slate-600" colSpan={4}>
                Reconciling Items:
              </td>
            </tr>
            {brs.lines.map((l) => (
              <tr key={l.key} className="text-slate-700">
                <td className="py-1 pl-8 pr-3">{l.label}</td>
                <td className={TD}>{l.column === 'BOOK' ? fig(l.amount) : ''}</td>
                <td className={TD}>{l.column === 'BANK' ? fig(l.amount) : ''}</td>
                <td className="px-3 py-1 text-xs text-slate-500">{l.note}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-navy-800 font-semibold text-navy-900">
              <td className="px-3 py-1.5">Adjusted Balances</td>
              <td className={TD}>{fig(totals.adjustedBookBalance)}</td>
              <td className={TD}>{fig(totals.adjustedBankBalance)}</td>
              <td />
            </tr>
          </tbody>
        </table>
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
            : 'A reconciliation can only be finalised at a difference of exactly zero. Match the remaining statement lines, classify bank charges, interest and bank errors, and journalise any book-side adjustment.'}
        </p>
      </div>

      {(bankCharges > 0 || interestIncome > 0) && (
        <Alert tone="warning" className="mt-4">
          Bank debit memos of {formatPeso(bankCharges)} and credit memos of {formatPeso(interestIncome)}{' '}
          appear on the statement but are not yet in the books. Post a journal entry for them - the
          server refuses to finalise a reconciliation whose book-side adjustments have not reached
          the ledger.
        </Alert>
      )}
    </Card>
  );
}

function ScheduleTable({ line }: { line: Brs['lines'][number] }) {
  const fig = (v: number) =>
    v < 0 ? `(${formatPeso(-v, { symbol: false })})` : formatPeso(v, { symbol: false });
  if (line.items.length === 0) {
    return <p className="px-4 py-4 text-sm text-slate-500">None.</p>;
  }
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wider text-slate-500">
            <th className="w-28 px-3 py-1.5 text-left font-semibold">Date</th>
            <th className="w-36 px-3 py-1.5 text-left font-semibold">Reference No</th>
            <th className="px-3 py-1.5 text-left font-semibold">Name</th>
            <th className="w-36 px-3 py-1.5 text-right font-semibold">Amount</th>
            <th className="px-3 py-1.5 text-left font-semibold">Remarks</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {line.items.map((it, i) => (
            <tr key={`${it.ref}-${i}`}>
              <td className="px-3 py-1.5 text-xs">{formatShortDate(it.date)}</td>
              <td className="px-3 py-1.5 font-mono text-xs">{it.ref || '-'}</td>
              <td className="px-3 py-1.5 text-xs">{it.name}</td>
              <td className="px-3 py-1.5 text-right font-mono text-xs tabular">{fig(it.amount)}</td>
              <td className="px-3 py-1.5 text-xs text-slate-500">{it.remarks}</td>
            </tr>
          ))}
          <tr className="font-semibold text-navy-900">
            <td colSpan={3} className="px-3 py-1.5 text-right text-xs">
              Subtotal
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-xs tabular">{fig(line.amount)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
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
