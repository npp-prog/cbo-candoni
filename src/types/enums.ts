/**
 * Controlled vocabularies used across CFMS.
 *
 * These are `as const` objects rather than TypeScript `enum`s so that the exact
 * string is what lands in Firestore. A Firestore document written today must
 * still be readable after a refactor; numeric enum ordinals are not stable
 * under reordering and have no meaning to an auditor reading raw data.
 */

// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

/**
 * The three statutory funds every LGU maintains. Additional funds (e.g. a
 * specific trust fund or an economic enterprise fund) are configurable by the
 * administrator as `funds` documents; these codes are only the seeded defaults.
 * Each fund keeps its own complete set of books.
 */
export const FUND_CODES = {
  GENERAL: 'GF',
  SPECIAL_EDUCATION: 'SEF',
  TRUST: 'TF',
} as const;

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export const ACCOUNT_CLASSES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

export const NORMAL_BALANCES = ['DEBIT', 'CREDIT'] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/** Where the account lands on the face of the financial statements. */
export const FS_CLASSIFICATIONS = [
  'CURRENT_ASSET',
  'NON_CURRENT_ASSET',
  'CURRENT_LIABILITY',
  'NON_CURRENT_LIABILITY',
  'NET_ASSETS_EQUITY',
  'REVENUE',
  'EXPENSE',
  'NON_FINANCIAL_ITEM',
] as const;
export type FsClassification = (typeof FS_CLASSIFICATIONS)[number];

/** Cash-flow statement classification, per PPSAS 2. */
export const CASH_FLOW_CLASSES = [
  'OPERATING',
  'INVESTING',
  'FINANCING',
  'NON_CASH',
] as const;
export type CashFlowClass = (typeof CASH_FLOW_CLASSES)[number];

/**
 * Expense classification used throughout budgeting (DBM/COA terminology).
 * PS = Personnel Services, MOOE = Maintenance and Other Operating Expenses,
 * FE = Financial Expenses, CO = Capital Outlay.
 */
export const EXPENSE_CLASSES = ['PS', 'MOOE', 'FE', 'CO'] as const;
export type ExpenseClass = (typeof EXPENSE_CLASSES)[number];

// ---------------------------------------------------------------------------
// Transaction statuses
// ---------------------------------------------------------------------------

export const OBLIGATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'BUDGET_REVIEWED',
  'CERTIFIED',
  'RETURNED',
  'CANCELLED',
  'OBLIGATED',
  /**
   * A voucher has been raised and approved against it - and nothing has been
   * paid.
   *
   * This status exists because the obligation used to go straight to PAID when
   * the Accountant approved the voucher, which is a day or a week before any
   * money leaves. The Budget Office reading its registry saw obligations
   * marked paid against which no check had been drawn, and the unpaid
   * obligations figure - the one that says what the municipality still owes -
   * was understated by every voucher in Treasury's hands.
   *
   * It becomes PAID when the check is drawn or the advice prepared.
   */
  'WITH_DV',
  'PAID',
  'CLOSED',
] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export const DV_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'REVIEWED',
  'CERTIFIED',
  'APPROVED',
  'RETURNED',
  'CANCELLED',
  'PAID',
  'CLOSED',
] as const;
export type DvStatus = (typeof DV_STATUSES)[number];

/**
 * What kind of thing a disbursement voucher pays.
 *
 * OBLIGATED pays an expenditure and draws on a certified Obligation Request.
 * TRUST_LIABILITY settles money the municipality is only holding - retention,
 * a bidder's bond, a remittance of something withheld - which was never
 * appropriated and has no obligation behind it.
 */
export const DV_CATEGORIES = ['OBLIGATED', 'TRUST_LIABILITY'] as const;
export type DvCategory = (typeof DV_CATEGORIES)[number];

export const DV_CATEGORY_LABELS: Record<DvCategory, string> = {
  OBLIGATED: 'Obligated',
  TRUST_LIABILITY: 'Trust Liability',
};

export const DV_CATEGORY_HINTS: Record<DvCategory, string> = {
  OBLIGATED:
    'Pays an expenditure. Must draw on a certified Obligation Request, which consumed a released allotment.',
  TRUST_LIABILITY:
    'Settles money the municipality is holding for somebody else - retention, a bidder\'s bond, premiums or tax withheld and now remitted. No Obligation Request, and no expense may be debited.',
};


export const JEV_STATUSES = [
  'DRAFT',
  'FOR_REVIEW',
  'REVIEWED',
  'APPROVED',
  'POSTED',
  'REVERSED',
  'CANCELLED',
] as const;
export type JevStatus = (typeof JEV_STATUSES)[number];

/**
 * What raised a journal entry.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LIST AND NOT A TYPE WRITTEN OUT IN PLACE
 * ---------------------------------------------------------------------------
 * CFMS has to answer one question about every entry: did a document raise it,
 * or did the Accountant write it? Other Transactions shows the second kind and
 * the Journal Entries Register shows both, so the answer decides which screen
 * an entry appears on.
 *
 * A union typed into the interface cannot be read at run time, so each screen
 * would have had to carry its own copy of the list - and the copy that was
 * forgotten when a new source type arrived would have hidden entries from the
 * screen that was supposed to show them, silently.
 */
export const JEV_SOURCE_TYPES = [
  // Raised by a document somewhere else in CFMS.
  'DV',
  'CHECK',
  'ADA',
  'RCI',
  'RADAI',
  'RCD',
  'RCDISB',
  'PAYROLL',
  'LIQUIDATION',
  // Written in Accounting itself.
  'BANK_ADJUSTMENT',
  'ADJUSTING',
  'CLOSING',
  'REVERSING',
  'PRIOR_PERIOD',
  'OPENING',
  'MANUAL',
] as const;
export type JevSourceType = (typeof JEV_SOURCE_TYPES)[number];

export const JEV_SOURCE_LABELS: Record<JevSourceType, string> = {
  DV: 'Disbursement Voucher',
  CHECK: 'Check',
  ADA: 'ADA',
  RCI: 'Report of Checks Issued',
  RADAI: 'Report of ADA Issued',
  RCD: 'Report of Collections and Deposits',
  RCDISB: 'Report of Cash Disbursement',
  PAYROLL: 'Payroll',
  LIQUIDATION: 'Liquidation Report',
  BANK_ADJUSTMENT: 'Bank Adjustment',
  ADJUSTING: 'Adjusting Entry',
  CLOSING: 'Closing Entry',
  REVERSING: 'Reversing Entry',
  PRIOR_PERIOD: 'Prior Period Adjustment',
  OPENING: 'Opening Balance',
  MANUAL: 'Manual Entry',
};

export const CHECK_STATUSES = [
  'PREPARED',
  'FOR_SIGNATURE',
  'SIGNED',
  'RELEASED',
  'CLEARED',
  'CANCELLED',
  'STALE',
  'REPLACED',
] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const ADA_STATUSES = [
  'DRAFT',
  'PREPARED',
  'SUBMITTED',
  'DEBITED',
  'REJECTED',
  'CANCELLED',
] as const;
export type AdaStatus = (typeof ADA_STATUSES)[number];

/**
 * Treasury reports.
 *
 * Four reports, one mechanism. The Treasurer's office prepares documents all
 * day - checks, ADA, official receipts, cash payrolls - and then batches them
 * into a report which is certified and forwarded to Accounting. Accounting
 * raises ONE journal entry voucher from the report, not one per document:
 *
 *   RCI      Report of Checks Issued          the checks drawn in the period
 *   RADAI    Report of ADA Issued             the advices sent to the bank
 *   RCD      Report of Collections and Deposits
 *   RCDISB   Report of Cash Disbursement      cash paid out, e.g. a cash payroll
 *
 * They differ only in what they cover and what entry they propose, which is
 * why they share a collection, a status flow and a pair of engine functions
 * rather than having four of each.
 */
export const TREASURY_REPORT_TYPES = ['RCI', 'RADAI', 'RCD', 'RCDISB'] as const;
export type TreasuryReportType = (typeof TREASURY_REPORT_TYPES)[number];

export const TREASURY_REPORT_LABELS: Record<TreasuryReportType, string> = {
  RCI: 'Report of Checks Issued',
  RADAI: 'Report of ADA Issued',
  RCD: 'Report of Collections and Deposits',
  RCDISB: 'Report of Cash Disbursement',
};

export const TREASURY_REPORT_SHORT: Record<TreasuryReportType, string> = {
  RCI: 'RCI',
  RADAI: 'RADAI',
  RCD: 'RCD',
  RCDISB: 'RCDisb',
};

/**
 * DRAFT        Treasury is still adding documents to it.
 * CERTIFIED    The Treasurer has certified it and forwarded it to Accounting.
 *              The covered documents are locked to this report from here on.
 * JOURNALIZED  Accounting has raised and posted its JEV. Terminal.
 * CANCELLED    Withdrawn before journalizing; the documents are released.
 */
export const TREASURY_REPORT_STATUSES = ['DRAFT', 'CERTIFIED', 'JOURNALIZED', 'CANCELLED'] as const;
export type TreasuryReportStatus = (typeof TREASURY_REPORT_STATUSES)[number];

export const RCD_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'VERIFIED',
  'POSTED',
  'CANCELLED',
] as const;
export type RcdStatus = (typeof RCD_STATUSES)[number];

export const PAYROLL_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'REVIEWED',
  'APPROVED',
  'PAID',
  'RETURNED',
  'CANCELLED',
] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const LIQUIDATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'REVIEWED',
  'APPROVED',
  'POSTED',
  'RETURNED',
  'CANCELLED',
] as const;
export type LiquidationStatus = (typeof LIQUIDATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Document / transaction types (drive numbering, storage paths and registries)
// ---------------------------------------------------------------------------

export const DOC_TYPES = [
  'OBR',
  'DV',
  'JEV',
  'CHECK',
  'ADA',
  'RCD',
  'LIQ',
  'PAYROLL',
  'ALLOT',
  'APPROP',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Which book a posted JEV lands in. Drives the journal reports. */
export const JOURNAL_BOOKS = [
  'GENERAL_JOURNAL',
  'CASH_DISBURSEMENTS_JOURNAL',
  'CHECK_DISBURSEMENTS_JOURNAL',
  'ADA_DISBURSEMENTS_JOURNAL',
  'CASH_RECEIPTS_JOURNAL',
  'PROCUREMENT_RECEIVED_JOURNAL',
] as const;
export type JournalBook = (typeof JOURNAL_BOOKS)[number];

export const PAYEE_TYPES = [
  'EMPLOYEE',
  'SUPPLIER',
  'CONTRACTOR',
  'GOVERNMENT_AGENCY',
  'BARANGAY',
  'NGO_PO',
  'OTHER',
] as const;
export type PayeeType = (typeof PAYEE_TYPES)[number];

/**
 * How a payment left the treasury.
 *
 * No longer recorded on the disbursement voucher. Accounting does not know
 * which way the Treasurer will pay, and recording a guess there put payables in
 * the wrong journal. The answer is established by the report the payment turns
 * up on - the RCI for a check, the RADAI for an ADA - and the list survives for
 * bank reconciliation, which has to say what kind of item it matched.
 */
export const PAYMENT_METHODS = ['CHECK', 'ADA', 'CASH', 'LDDAP'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYROLL_TYPES = [
  'REGULAR',
  'JOB_ORDER',
  'CONTRACT_OF_SERVICE',
  'HONORARIUM',
  'OVERTIME',
  'SALARY_DIFFERENTIAL',
  'TERMINAL_LEAVE',
  'ALLOWANCES',
  'OTHER',
] as const;
export type PayrollType = (typeof PAYROLL_TYPES)[number];

export const CASH_ADVANCE_TYPES = [
  'TRAVEL',
  'SPECIAL_ACTIVITY',
  'PETTY_CASH',
  'PAYROLL',
  'FUND_TRANSFER',
  'OTHER',
] as const;
export type CashAdvanceType = (typeof CASH_ADVANCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Accounting period control
// ---------------------------------------------------------------------------

export const PERIOD_STATUSES = [
  'OPEN',
  'TEMPORARILY_LOCKED',
  'CLOSED',
  'REOPENED',
] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

export const MATCH_STATUSES = [
  'MATCHED',
  'PARTIALLY_MATCHED',
  'SUGGESTED',
  'UNMATCHED',
  'BANK_CHARGE',
  'INTEREST_INCOME',
  'ERROR',
  'OUTSTANDING_CHECK',
  'DEPOSIT_IN_TRANSIT',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

// ---------------------------------------------------------------------------
// Display labels. Kept beside the vocabularies so a new status can never be
// added without someone deciding what a user should see.
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  BUDGET_REVIEWED: 'Budget Reviewed',
  REVIEWED: 'Reviewed',
  FOR_REVIEW: 'For Review',
  CERTIFIED: 'Certified',
  APPROVED: 'Approved',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
  OBLIGATED: 'Obligated',
  // Raised on a voucher, and not yet paid. The distinction matters: an
  // obligation with a voucher in Accounting is still money the municipality
  // owes.
  WITH_DV: 'With DV',
  POSTED: 'Posted',
  REVERSED: 'Reversed',
  PAID: 'Paid',
  CLOSED: 'Closed',
  PREPARED: 'Prepared',
  FOR_SIGNATURE: 'For Signature',
  SIGNED: 'Signed',
  RELEASED: 'Released',
  CLEARED: 'Cleared',
  STALE: 'Stale',
  REPLACED: 'Replaced',
  DEBITED: 'Debited',
  REJECTED: 'Rejected',
  VERIFIED: 'Verified',
  OPEN: 'Open',
  TEMPORARILY_LOCKED: 'Temporarily Locked',
  REOPENED: 'Reopened',
};

export const EXPENSE_CLASS_LABELS: Record<ExpenseClass, string> = {
  PS: 'Personnel Services',
  MOOE: 'Maintenance and Other Operating Expenses',
  FE: 'Financial Expenses',
  CO: 'Capital Outlay',
};

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  OBR: 'Obligation Request and Status',
  DV: 'Disbursement Voucher',
  JEV: 'Journal Entry Voucher',
  CHECK: 'Check',
  ADA: 'Advice to Debit Account',
  RCD: 'Report of Collections and Deposits',
  LIQ: 'Liquidation Report',
  PAYROLL: 'Payroll',
  ALLOT: 'Allotment Release',
  APPROP: 'Appropriation',
};
