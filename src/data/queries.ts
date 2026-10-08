import { orderBy, where, limit, type QueryConstraint } from 'firebase/firestore';
import { COL } from '@/lib/collections';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import type {
  Account,
  Allotment,
  Appropriation,
  AugmentationDraft,
  AroDraft,
  Ada,
  BankAccount,
  BudgetBalance,
  BudgetSummary,
  CashAdvance,
  Check,
  Collection as CollectionRecord,
  Deposit,
  DisbursementVoucher,
  Employee,
  EstimatedReceipt,
  TrustProgram,
  Fund,
  JournalEntryVoucher,
  LedgerEntry,
  Liquidation,
  Obligation,
  Office,
  Program,
  Intermediary,
  Payee,
  Payroll,
  Rcd,
  TaxCode,
} from '@/types';
import type { AuditLog, DocumentAttachment, Notification, UserProfile, WorkflowEvent } from '@/types/system';
import type { PrimaryReport } from '@/types/primaryReports';
import type { AdaNumberRecord } from '@/types/adaNumbers';
import type { BankLedger, BankLedgerEntry } from '@/types/bankLedger';
import type {
  AccountableFormMovement,
  AccountableFormType,
  Raaf,
} from '@/types/accountableForms';
import type {
  BankReconciliation,
  BankTransaction,
  RevenueCode,
  TreasuryImport,
  TreasuryReport,
} from '@/types/treasury';
import type { TreasuryReportType } from '@/types/enums';

/**
 * Query definitions, one place.
 *
 * Every composite query here has a matching entry in `firestore.indexes.json`.
 * Keeping them together means a query added without its index is caught in
 * review rather than at runtime, where it surfaces as a failed-precondition
 * error in front of a user.
 */

// --- Master data -------------------------------------------------------------

const ACTIVE = where('active', '==', true);

export const useFunds = () =>
  useCollection<Fund>(COL.funds, [ACTIVE, orderBy('sortOrder')], ['funds']);

export const useAccounts = (postableOnly = true) =>
  useCollection<Account>(
    COL.accounts,
    postableOnly
      ? [ACTIVE, where('postable', '==', true), orderBy('code')]
      : [ACTIVE, orderBy('code')],
    ['accounts', postableOnly],
  );

export const useOffices = () =>
  useCollection<Office>(COL.offices, [ACTIVE, orderBy('sortOrder')], ['offices']);

/** The barangays, for the real property tax share that follows the property. */
export const useBarangays = () =>
  useCollection<{ id: string; code: string; name: string; sortOrder?: number }>(
    COL.barangays,
    [ACTIVE, orderBy('sortOrder')],
    ['barangays'],
  );

/**
 * Every active budget programme, whatever year it belongs to.
 *
 * Deliberately NOT filtered by fiscal year in the query, and the reason is a
 * Firestore limitation rather than a preference: a programme created before
 * patch 86 has no `fiscalYear` field at all, and Firestore cannot match a
 * field that is absent. A query filtered by year would hide exactly the
 * records the office most needs to find and sort out, and would hide them
 * silently.
 *
 * The list is small - an ordinance names a hundred or two - so the screen
 * splits it by year itself, and the ones with no year get their own section
 * instead of disappearing.
 */
export const usePrograms = () =>
  useCollection<Program>(COL.programs, [ACTIVE, orderBy('code')], ['programs']);

/** GCash, Maya, a bank's portal - whoever collects on the municipality's behalf. */
export const useIntermediaries = () =>
  useCollection<Intermediary>(COL.intermediaries, [ACTIVE, orderBy('name')], ['intermediaries']);

export const usePayees = () =>
  useCollection<Payee>(COL.payees, [ACTIVE, orderBy('name')], ['payees']);

export const useEmployees = () =>
  useCollection<Employee>(COL.employees, [ACTIVE, orderBy('displayName')], ['employees']);

export const useBankAccounts = (fundCode?: string) =>
  useCollection<BankAccount>(
    COL.bankAccounts,
    fundCode ? [ACTIVE, where('fundCode', '==', fundCode)] : [ACTIVE],
    ['bankAccounts', fundCode],
  );

/** The Treasurer's revenue codes and the COA account each one posts to. */
export const useRevenueCodes = () =>
  useCollection<RevenueCode>(COL.revenueCodes, [orderBy('code')], ['revenueCodes']);

export const useTaxCodes = () =>
  useCollection<TaxCode>(COL.taxCodes, [ACTIVE, orderBy('code')], ['taxCodes']);

// --- Budget ------------------------------------------------------------------

export const useAppropriations = (fiscalYear: number, fundCode: string) =>
  useCollection<Appropriation>(
    COL.appropriations,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('accountCode')],
    ['appropriations', fiscalYear, fundCode],
  );

/**
 * The augmentations prepared but not yet posted.
 *
 * Ordered newest first: a draft is a working paper, and the one being worked on
 * is the one made most recently. There are rarely more than a handful.
 */
export const useAugmentationDrafts = (fiscalYear: number, fundCode: string) =>
  useCollection<AugmentationDraft>(
    COL.augmentationDrafts,
    [
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      orderBy('authorityDate', 'desc'),
    ],
    ['augmentationDrafts', fiscalYear, fundCode],
  );

/**
 * Allotment Release Orders prepared for the Budget Officer, and the ones
 * already approved from them. The screen shows the prepared ones; the approved
 * ones are the record of who prepared what.
 */
export const useAroDrafts = (fiscalYear: number, fundCode: string) =>
  useCollection<AroDraft>(
    COL.aroDrafts,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('date', 'desc')],
    ['aroDrafts', fiscalYear, fundCode],
  );

export const useAllotments = (fiscalYear: number, fundCode: string) =>
  useCollection<Allotment>(
    COL.allotments,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('allotmentDate', 'desc')],
    ['allotments', fiscalYear, fundCode],
  );

export const useObligations = (fiscalYear: number, fundCode: string, status?: string) =>
  useCollection<Obligation>(
    COL.obligations,
    status
      ? [
          where('fiscalYear', '==', fiscalYear),
          where('fundCode', '==', fundCode),
          where('status', '==', status),
          orderBy('obrDate', 'desc'),
        ]
      : [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('obrDate', 'desc')],
    ['obligations', fiscalYear, fundCode, status],
  );

/**
 * Obligations available to draw a voucher against: certified, not cancelled,
 * and with an unpaid balance remaining. This is what makes "an approved OBR is
 * automatically selectable in a DV" true rather than aspirational.
 */
export const useAvailableObligations = (fiscalYear: number, fundCode: string) =>
  useCollection<Obligation>(
    COL.obligations,
    [
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      where('unpaidAmount', '>', 0),
      orderBy('unpaidAmount', 'desc'),
    ],
    ['availableObligations', fiscalYear, fundCode],
  );

export const useBudgetBalances = (fiscalYear: number, fundCode: string, officeId?: string | null) =>
  useCollection<BudgetBalance>(
    COL.budgetBalances,
    officeId
      ? [
          where('fiscalYear', '==', fiscalYear),
          where('fundCode', '==', fundCode),
          where('officeId', '==', officeId),
          orderBy('accountCode'),
        ]
      : [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('officeId'), orderBy('accountCode')],
    ['budgetBalances', fiscalYear, fundCode, officeId],
  );

/**
 * The budget year's estimated receipts for one fund - LBP Form No. 1, II.
 *
 * The financing side of the budget. The appropriation ordinance carries only
 * expenditure, so this is the only place a budget figure for receipts exists.
 */
export const useEstimatedReceipts = (fiscalYear: number, fundCode: string) =>
  useCollection<EstimatedReceipt>(
    COL.estimatedReceipts,
    [
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      orderBy('accountCode'),
    ],
    ['estimatedReceipts', fiscalYear, fundCode],
  );

/**
 * The Trust Fund programmes.
 *
 * Not filtered by fiscal year: trust money does not expire with the budget,
 * and a programme received in November is spent over the following year.
 */
export const useTrustPrograms = (activeOnly = false) =>
  useCollection<TrustProgram>(
    COL.trustPrograms,
    activeOnly
      ? [where('status', '==', 'ACTIVE'), orderBy('programCode')]
      : [orderBy('programCode')],
    ['trustPrograms', activeOnly],
  );

export const useBudgetSummary = (fiscalYear: number, fundCode: string) =>
  useCollection<BudgetSummary>(
    COL.budgetSummaries,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode)],
    ['budgetSummary', fiscalYear, fundCode],
  );

/** Budget lines in trouble: overspent allotment or overspent appropriation. */
export const useBudgetAlerts = (fiscalYear: number, fundCode: string) =>
  useCollection<BudgetBalance>(
    COL.budgetBalances,
    [
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      where('availableAllotment', '<', 0),
      orderBy('availableAllotment'),
      limit(50),
    ],
    ['budgetAlerts', fiscalYear, fundCode],
  );

// --- Accounting --------------------------------------------------------------

export const useDisbursementVouchers = (fiscalYear: number, fundCode: string, status?: string) => {
  const constraints: QueryConstraint[] = [
    where('fiscalYear', '==', fiscalYear),
    where('fundCode', '==', fundCode),
  ];
  if (status) constraints.push(where('status', '==', status));
  constraints.push(orderBy('dvDate', 'desc'));
  return useCollection<DisbursementVoucher>(COL.disbursementVouchers, constraints, [
    'dvs',
    fiscalYear,
    fundCode,
    status,
  ]);
};

export const useJevs = (fiscalYear: number, fundCode: string, status?: string) => {
  const constraints: QueryConstraint[] = [
    where('fiscalYear', '==', fiscalYear),
    where('fundCode', '==', fundCode),
  ];
  if (status) constraints.push(where('status', '==', status));
  constraints.push(orderBy('jevDate', 'desc'));
  return useCollection<JournalEntryVoucher>(COL.jevs, constraints, ['jevs', fiscalYear, fundCode, status]);
};

export const useChecks = (bankAccountId?: string, status?: string) => {
  const constraints: QueryConstraint[] = [];
  if (bankAccountId) constraints.push(where('bankAccountId', '==', bankAccountId));
  if (status) constraints.push(where('status', '==', status));
  constraints.push(orderBy('checkDate', 'desc'));
  return useCollection<Check>(COL.checks, constraints, ['checks', bankAccountId, status]);
};

export const useAda = (bankAccountId?: string, status?: string) => {
  const constraints: QueryConstraint[] = [];
  if (bankAccountId) constraints.push(where('bankAccountId', '==', bankAccountId));
  if (status) constraints.push(where('status', '==', status));
  constraints.push(orderBy('adaDate', 'desc'));
  return useCollection<Ada>(COL.ada, constraints, ['ada', bankAccountId, status]);
};

export const usePayrolls = (fiscalYear: number, fundCode: string) =>
  useCollection<Payroll>(
    COL.payrolls,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('periodFrom', 'desc')],
    ['payrolls', fiscalYear, fundCode],
  );

export const useCashAdvances = (fiscalYear: number, outstandingOnly = true) =>
  useCollection<CashAdvance>(
    COL.cashAdvances,
    outstandingOnly
      ? [
          where('fiscalYear', '==', fiscalYear),
          where('status', 'in', ['OUTSTANDING', 'PARTIALLY_LIQUIDATED']),
          orderBy('dueDate'),
        ]
      : [where('fiscalYear', '==', fiscalYear), orderBy('dateGranted', 'desc')],
    ['cashAdvances', fiscalYear, outstandingOnly],
  );

export const useLiquidations = (fiscalYear: number) =>
  useCollection<Liquidation>(
    COL.liquidations,
    [where('fiscalYear', '==', fiscalYear), orderBy('liquidationDate', 'desc')],
    ['liquidations', fiscalYear],
  );

// --- General Ledger ----------------------------------------------------------

/**
 * Ledger entries for a fund and year, up to a period.
 *
 * Deliberately scoped: every report built on this reads a period's worth of
 * entries, never the whole ledger. A municipality's annual ledger runs to tens
 * of thousands of rows and pulling it into the browser to compute a monthly
 * trial balance would be both slow and pointless.
 */
export const useLedgerEntries = (
  fiscalYear: number,
  fundCode: string,
  opts: { throughPeriod?: number; accountCode?: string; book?: string } = {},
) => {
  const constraints: QueryConstraint[] = [
    where('fiscalYear', '==', fiscalYear),
    where('fundCode', '==', fundCode),
  ];

  if (opts.accountCode) {
    constraints.push(where('accountCode', '==', opts.accountCode), orderBy('entryDate'));
  } else if (opts.book) {
    constraints.push(where('book', '==', opts.book), orderBy('entryDate'), orderBy('jevNo'));
  } else if (opts.throughPeriod !== undefined) {
    constraints.push(where('period', '<=', opts.throughPeriod), orderBy('period'), orderBy('accountCode'));
  } else {
    constraints.push(orderBy('entryDate'));
  }

  return useCollection<LedgerEntry>(COL.ledgerEntries, constraints, [
    'ledger',
    fiscalYear,
    fundCode,
    opts.throughPeriod,
    opts.accountCode,
    opts.book,
  ]);
};

// --- Treasury ----------------------------------------------------------------

export const useCollections = (fiscalYear: number, fundCode: string) =>
  useCollection<CollectionRecord>(
    COL.collections,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('orDate', 'desc')],
    ['collections', fiscalYear, fundCode],
  );

export const useUndepositedCollections = (fundCode: string) =>
  useCollection<CollectionRecord>(
    COL.collections,
    [where('fundCode', '==', fundCode), where('status', 'in', ['ISSUED', 'IN_RCD']), orderBy('orDate')],
    ['undeposited', fundCode],
  );

/** The opening balance and buffer for one bank account and year. */
export const useBankLedger = (fiscalYear: number, bankAccountId: string | null) =>
  useDocument<BankLedger>(
    COL.bankLedgers,
    bankAccountId ? `${fiscalYear}__${bankAccountId}` : null,
  );

/**
 * The entries only the bank originates, for one account and year.
 * Index: bankAccountId, fiscalYear, entryDate asc.
 */
export const useBankLedgerEntries = (fiscalYear: number, bankAccountId: string | null) =>
  useCollection<BankLedgerEntry>(
    COL.bankLedgerEntries,
    bankAccountId
      ? [
          where('bankAccountId', '==', bankAccountId),
          where('fiscalYear', '==', fiscalYear),
          orderBy('entryDate'),
        ]
      : [where('bankAccountId', '==', '__none__')],
    ['bankLedgerEntries', fiscalYear, bankAccountId],
  );

/**
 * Every ADA number whose fate is not an ordinary issue, for one fund and year.
 * Index: fiscalYear, fundCode, adaNo asc.
 */
export const useAdaNumbers = (fiscalYear: number, fundCode: string) =>
  useCollection<AdaNumberRecord>(
    COL.adaNumbers,
    [
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      orderBy('adaNo'),
    ],
    ['adaNumbers', fiscalYear, fundCode],
  );

/**
 * The Liquidating Officer's primary reports for a fund and year, newest first.
 * Index: fiscalYear, fundCode, reportDate desc.
 */
export const usePrimaryReports = (fiscalYear: number, fundCode: string) =>
  useCollection<PrimaryReport>(
    COL.primaryReports,
    [
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      orderBy('reportDate', 'desc'),
    ],
    ['primaryReports', fiscalYear, fundCode],
  );

/**
 * The stock ledger for one fiscal year, newest movement first.
 *
 * Not filtered by fund: a booklet of receipts is not bought for the General
 * Fund, it is bought for the office, and the same booklet collects into
 * whichever fund the payor happens to be paying.
 * Index: fiscalYear, movementDate desc.
 */
export const useFormMovements = (fiscalYear: number) =>
  useCollection<AccountableFormMovement>(
    COL.accountableFormMovements,
    [where('fiscalYear', '==', fiscalYear), orderBy('movementDate', 'desc')],
    ['formMovements', fiscalYear],
  );

/** The accountable form types, as master data. */
export const useAccountableFormTypes = () =>
  useCollection<AccountableFormType>(
    COL.accountableFormTypes,
    [ACTIVE, orderBy('sortOrder')],
    ['accountableFormTypes'],
  );

/** Reports of accountability for a fiscal year. Index: fiscalYear, periodTo desc. */
export const useRaafReports = (fiscalYear: number) =>
  useCollection<Raaf>(
    COL.raafReports,
    [where('fiscalYear', '==', fiscalYear), orderBy('periodTo', 'desc')],
    ['raafReports', fiscalYear],
  );

export const useRcds = (fiscalYear: number, fundCode: string) =>
  useCollection<Rcd>(
    COL.rcds,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('rcdDate', 'desc')],
    ['rcds', fiscalYear, fundCode],
  );

/**
 * The treasury reports of one type for a fiscal year and fund: the RCI list,
 * the RADAI list, and so on. Index: reportType, fiscalYear, fundCode,
 * reportDate desc.
 */
export const useTreasuryReports = (
  reportType: TreasuryReportType,
  fiscalYear: number,
  fundCode: string,
) =>
  useCollection<TreasuryReport>(
    COL.treasuryReports,
    [
      where('reportType', '==', reportType),
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      orderBy('reportDate', 'desc'),
    ],
    ['treasuryReports', reportType, fiscalYear, fundCode],
  );

/**
 * Every treasury report that has reached Accounting - the ones still waiting
 * for their journal entry and the ones already journalized.
 *
 * ---------------------------------------------------------------------------
 * WHY THE JOURNALIZED ONES ARE HERE TOO
 * ---------------------------------------------------------------------------
 * This was the queue and nothing else: a report left it the moment its entry
 * was posted, and there was then no screen in Accounting that would show it
 * again. "Which RCDs did the Treasurer send us in March" could not be answered
 * from Accounting at all - the reports were still in Treasury's own registers,
 * but an accountant does not go looking for a received document in the sending
 * office's menu.
 *
 * Drafts are NOT here. A draft report has not been certified, so it has not
 * been sent, and Accounting showing it would be Accounting reading another
 * office's unfinished work. Cancelled ones are out for the same reason: a
 * report withdrawn before journalizing never arrived.
 *
 * Oldest first is deliberate - a report that has sat for a week is the one
 * that matters, and sorting newest-first would bury it. The `in` filter is
 * served by the same index the single-status query used: status, fiscalYear,
 * reportDate asc.
 */
export const useReportsAwaitingJev = (fiscalYear: number) =>
  useCollection<TreasuryReport>(
    COL.treasuryReports,
    [
      where('status', 'in', ['CERTIFIED', 'JOURNALIZED']),
      where('fiscalYear', '==', fiscalYear),
      orderBy('reportDate', 'asc'),
    ],
    ['treasuryReportsReceived', fiscalYear],
  );

/**
 * The uploaded RCI and RADAI files for a fiscal year and fund, newest first.
 *
 * Kept as a list rather than folded into the report screen because an upload
 * outlives the report it made: rows that were set aside by hand are read back
 * months later, when somebody asks why the books show one payment fewer than
 * the Treasurer's file did. Index: importType, fiscalYear, fundCode,
 * uploadedAt desc.
 */
export const useTreasuryImports = (
  importType: 'RCI' | 'RADAI',
  fiscalYear: number,
  fundCode: string,
) =>
  useCollection<TreasuryImport>(
    COL.treasuryImports,
    [
      where('importType', '==', importType),
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      orderBy('uploadedAt', 'desc'),
    ],
    ['treasuryImports', importType, fiscalYear, fundCode],
  );

/**
 * Vouchers a payment can still be drawn against: approved, in this fund, with
 * no check or ADA recorded yet. Used when a held upload row is linked by hand.
 * The "no payment yet" part is filtered in the browser - Firestore cannot ask
 * for the absence of two different fields in one query - so this is a
 * convenience, and the engine checks it again before it writes anything.
 */
export const useUnpaidVouchers = (fiscalYear: number, fundCode: string) =>
  useCollection<DisbursementVoucher>(
    COL.disbursementVouchers,
    [
      where('fiscalYear', '==', fiscalYear),
      where('fundCode', '==', fundCode),
      where('status', '==', 'APPROVED'),
      orderBy('dvDate', 'desc'),
    ],
    ['unpaidVouchers', fiscalYear, fundCode],
  );

export const useDeposits = (bankAccountId?: string, status?: string) => {
  const constraints: QueryConstraint[] = [];
  if (bankAccountId) constraints.push(where('bankAccountId', '==', bankAccountId));
  if (status) constraints.push(where('status', '==', status));
  constraints.push(orderBy('depositDate', 'desc'));
  return useCollection<Deposit>(COL.deposits, constraints, ['deposits', bankAccountId, status]);
};

// --- Reconciliation ----------------------------------------------------------

/**
 * The imported statement lines for one bank account.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NULL IS HANDLED BY THE PATH AND NOT BY AN EARLY RETURN
 * ---------------------------------------------------------------------------
 * This used to read:
 *
 *     if (!bankAccountId) return { data: [], loading: false, error: null };
 *     ...
 *     return useCollection(...)
 *
 * which looks harmless and is not. It is a HOOK called conditionally: with no
 * bank account chosen the function returns having called nothing, and with one
 * chosen it calls useCollection, which calls several hooks of its own. React
 * matches hooks between renders by position, so the render where the account
 * arrives has more hooks than the render before it - and React's answer to
 * that is to throw and unmount the whole tree.
 *
 * WHAT IT LOOKED LIKE. Bank Reconciliation auto-selects the bank account when
 * the fund has exactly one, which Candoni's General Fund does. So the page
 * rendered with no account, the effect chose the only one, the next render
 * called more hooks, and the screen went WHITE - no error, no message, nothing
 * in the interface to report. It was unopenable.
 *
 * `useCollection` has always accepted a null path and returned an empty,
 * settled result for it - `useWorkflowHistory` has used it that way since it
 * was written. Passing null is the same answer with the hook called every
 * time.
 */
export const useBankTransactions = (bankAccountId: string | null, matchStatus?: string) => {
  const constraints: QueryConstraint[] = [where('bankAccountId', '==', bankAccountId ?? '')];
  if (matchStatus) constraints.push(where('matchStatus', '==', matchStatus));
  constraints.push(orderBy('transactionDate'));
  // Null path, not an early return: nothing is read until an account is
  // chosen, and the hook is called either way.
  return useCollection<BankTransaction>(
    bankAccountId ? COL.bankTransactions : null,
    constraints,
    ['bankTx', bankAccountId, matchStatus],
  );
};

export const useReconciliations = (fiscalYear: number, fundCode: string) =>
  useCollection<BankReconciliation>(
    COL.bankReconciliations,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('statementDate', 'desc')],
    ['recons', fiscalYear, fundCode],
  );

// --- System ------------------------------------------------------------------

export const useWorkflowHistory = (entityType: string, entityId: string | null) =>
  useCollection<WorkflowEvent>(
    entityId ? COL.workflowHistory : null,
    [where('entityType', '==', entityType), where('entityId', '==', entityId ?? ''), orderBy('at')],
    ['workflow', entityType, entityId],
  );

export const useAttachments = (entityType: string, entityId: string | null) =>
  useCollection<DocumentAttachment>(
    entityId ? COL.documents : null,
    [
      where('entityType', '==', entityType),
      where('entityId', '==', entityId ?? ''),
      where('active', '==', true),
      orderBy('version', 'desc'),
    ],
    ['attachments', entityType, entityId],
  );

export const useAuditLogs = (filters: { entityId?: string; entityType?: string; severity?: string }) => {
  const constraints: QueryConstraint[] = [];
  if (filters.entityType && filters.entityId) {
    constraints.push(
      where('entityType', '==', filters.entityType),
      where('entityId', '==', filters.entityId),
      orderBy('at'),
    );
  } else if (filters.severity) {
    constraints.push(where('severity', '==', filters.severity), orderBy('at', 'desc'), limit(200));
  } else {
    constraints.push(orderBy('at', 'desc'), limit(200));
  }
  return useCollection<AuditLog>(COL.auditLogs, constraints, [
    'audit',
    filters.entityType,
    filters.entityId,
    filters.severity,
  ]);
};

export const useNotifications = (uid: string | null) =>
  useCollection<Notification>(
    uid ? COL.notifications : null,
    [where('recipientUid', '==', uid ?? ''), where('read', '==', false), orderBy('createdAt', 'desc'), limit(50)],
    ['notifications', uid],
  );

export const useUsers = () =>
  useCollection<UserProfile>(COL.users, [orderBy('displayName')], ['users']);
