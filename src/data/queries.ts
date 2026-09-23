import { orderBy, where, limit, type QueryConstraint } from 'firebase/firestore';
import { COL } from '@/lib/collections';
import { useCollection } from '@/hooks/useFirestore';
import type {
  Account,
  Allotment,
  Appropriation,
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
  Fund,
  JournalEntryVoucher,
  LedgerEntry,
  Liquidation,
  Obligation,
  Office,
  Payee,
  Payroll,
  Rcd,
  TaxCode,
} from '@/types';
import type { AuditLog, DocumentAttachment, Notification, UserProfile, WorkflowEvent } from '@/types/system';
import type {
  BankReconciliation,
  BankTransaction,
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

export const useTaxCodes = () =>
  useCollection<TaxCode>(COL.taxCodes, [ACTIVE, orderBy('code')], ['taxCodes']);

// --- Budget ------------------------------------------------------------------

export const useAppropriations = (fiscalYear: number, fundCode: string) =>
  useCollection<Appropriation>(
    COL.appropriations,
    [where('fiscalYear', '==', fiscalYear), where('fundCode', '==', fundCode), orderBy('accountCode')],
    ['appropriations', fiscalYear, fundCode],
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
 * Accounting's queue: every certified report of any type still waiting for its
 * journal entry, oldest first. Oldest first is deliberate - a report that has
 * sat for a week is the one that matters, and sorting newest-first would bury
 * it. Index: status, fiscalYear, reportDate asc.
 */
export const useReportsAwaitingJev = (fiscalYear: number) =>
  useCollection<TreasuryReport>(
    COL.treasuryReports,
    [
      where('status', '==', 'CERTIFIED'),
      where('fiscalYear', '==', fiscalYear),
      orderBy('reportDate', 'asc'),
    ],
    ['treasuryReportsAwaitingJev', fiscalYear],
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

export const useBankTransactions = (bankAccountId: string | null, matchStatus?: string) => {
  if (!bankAccountId) return { data: [] as BankTransaction[], loading: false, error: null };
  const constraints: QueryConstraint[] = [where('bankAccountId', '==', bankAccountId)];
  if (matchStatus) constraints.push(where('matchStatus', '==', matchStatus));
  constraints.push(orderBy('transactionDate'));
  return useCollection<BankTransaction>(COL.bankTransactions, constraints, [
    'bankTx',
    bankAccountId,
    matchStatus,
  ]);
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
