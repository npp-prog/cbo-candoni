import type {
  AuditStamps,
  Centavos,
  FiscalYear,
  Id,
  IsoDate,
  PeriodNo,
} from './common';
import type {
  MatchStatus,
  RcdStatus,
  TreasuryReportStatus,
  TreasuryReportType,
} from './enums';

/**
 * Treasury, collections, deposits and bank reconciliation.
 *
 * The revenue chain mirrors the expenditure chain:
 *   Collection -> Official Receipt -> RCD -> Deposit -> JEV -> Bank credit
 * and reconciliation is what proves the chain closed.
 */

// ---------------------------------------------------------------------------
// collections/{id}
// ---------------------------------------------------------------------------

export type RevenueSource =
  | 'REAL_PROPERTY_TAX'
  | 'BUSINESS_TAX'
  | 'FEES_AND_CHARGES'
  | 'COMMUNITY_TAX'
  | 'MARKET'
  | 'ECONOMIC_ENTERPRISE'
  | 'OTHER_LOCAL_REVENUE'
  | 'NATIONAL_TAX_ALLOTMENT'
  | 'OTHER_NG_TRANSFER'
  | 'TRUST_RECEIPT'
  | 'OTHER';

export interface CollectionLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  amount: Centavos;
  particulars?: string;
}

export interface Collection extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  /** Official Receipt / accountable form actually issued. */
  orNumber: string;
  orDate: IsoDate;
  accountableFormId?: Id;

  collectingOfficerId: Id;
  collectingOfficerName: string;

  revenueSource: RevenueSource;
  payorName: string;
  payorTin?: string;

  lines: CollectionLine[];
  totalAmount: Centavos;

  paymentForm: 'CASH' | 'CHECK' | 'ONLINE' | 'CARD';
  /** For collections received by check. */
  checkNo?: string;
  checkBank?: string;
  checkDate?: IsoDate;

  /** Set when this collection is included in an RCD. */
  rcdId?: Id;
  rcdNo?: string;
  /** Set when the RCD's deposit is recorded. */
  depositId?: Id;

  status: 'ISSUED' | 'IN_RCD' | 'DEPOSITED' | 'CANCELLED';
  cancelledReason?: string;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// rcds/{id}   (Report of Collections and Deposits)
// ---------------------------------------------------------------------------

export interface RcdAccountSummary {
  accountCode: string;
  accountName: string;
  amount: Centavos;
}

export interface Rcd extends Partial<AuditStamps> {
  id: Id;
  rcdNo: string;
  rcdDate: IsoDate;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  collectingOfficerId: Id;
  collectingOfficerName: string;

  /** Range of accountable forms covered by this report. */
  orNumberFrom: string;
  orNumberTo: string;
  collectionIds: Id[];

  accountSummary: RcdAccountSummary[];
  totalCollections: Centavos;
  totalDeposits: Centavos;
  /** totalCollections - totalDeposits; must reach zero or be explained. */
  undepositedAmount: Centavos;

  depositIds: Id[];

  status: RcdStatus;
  jevId?: Id;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// deposits/{id}
// ---------------------------------------------------------------------------

export interface Deposit extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  depositDate: IsoDate;
  bankAccountId: Id;
  bankName: string;
  bankAccountNumber: string;

  depositSlipNo: string;
  referenceNo?: string;
  amount: Centavos;

  rcdId?: Id;
  rcdNo?: string;
  collectingOfficerId?: Id;
  collectingOfficerName?: string;

  /** Set by bank reconciliation once the credit appears on the statement. */
  bankTransactionId?: Id;
  creditedDate?: IsoDate;

  status: 'RECORDED' | 'IN_TRANSIT' | 'CREDITED' | 'CANCELLED';
  jevId?: Id;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// accountableForms/{id}
// ---------------------------------------------------------------------------

export interface AccountableForm extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: FiscalYear;
  /** e.g. "Official Receipt (Accountable Form 51)" or "Community Tax Certificate". */
  formType: string;
  formCode: string;
  serialFrom: string;
  serialTo: string;

  accountableOfficerId: Id;
  accountableOfficerName: string;

  /** Quantities in pieces, not centavos. */
  beginningBalance: number;
  received: number;
  issued: number;
  cancelled: number;
  /** beginningBalance + received - issued - cancelled */
  endingBalance: number;

  asOfDate: IsoDate;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// bankTransactions/{id}   (imported statement lines)
// ---------------------------------------------------------------------------

export interface BankTransaction {
  id: Id;
  fiscalYear: FiscalYear;
  fundCode: string;
  bankAccountId: Id;

  transactionDate: IsoDate;
  postingDate?: IsoDate;
  referenceNo?: string;
  description: string;
  /** Movement on the bank's books: debit reduces the municipality's balance. */
  debit: Centavos;
  credit: Centavos;
  runningBalance?: Centavos;

  /** Reconciliation state. */
  matchStatus: MatchStatus;
  matchedType?: 'CHECK' | 'ADA' | 'DEPOSIT' | 'COLLECTION' | 'PAYROLL' | 'OTHER';
  matchedId?: Id;
  matchedRef?: string;
  matchConfidence?: number;
  matchMethod?: 'EXACT_AMOUNT_REF' | 'CHECK_NO' | 'ADA_NO' | 'DEPOSIT_REF' | 'AMOUNT_DATE' | 'PAYEE' | 'MANUAL';

  reconciliationId?: Id;
  importBatchId: Id;
  importedAt: string;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// bankReconciliations/{id}
// ---------------------------------------------------------------------------

export interface ReconciliationAdjustment {
  lineNo: number;
  kind: 'BANK_CHARGE' | 'INTEREST_INCOME' | 'BANK_ERROR' | 'BOOK_ERROR' | 'OTHER';
  description: string;
  /** Signed: positive increases the balance, negative decreases it. */
  amount: Centavos;
  side: 'BANK' | 'BOOK';
  /** A book-side adjustment must end up as a JEV before the recon is final. */
  jevId?: Id;
  bankTransactionId?: Id;
}

export interface BankReconciliation extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;
  bankAccountId: Id;
  bankName: string;
  bankAccountNumber: string;

  statementDate: IsoDate;

  /** Bank side. */
  balancePerBank: Centavos;
  depositsInTransit: Centavos;
  outstandingChecks: Centavos;
  bankAdjustments: Centavos;
  adjustedBankBalance: Centavos;

  /** Book side, taken from the General Ledger, not typed in. */
  balancePerBooks: Centavos;
  bookAdjustments: Centavos;
  adjustedBookBalance: Centavos;

  /** adjustedBankBalance - adjustedBookBalance. Must be 0 to finalise. */
  difference: Centavos;

  adjustments: ReconciliationAdjustment[];
  depositInTransitIds: Id[];
  outstandingCheckIds: Id[];

  status: 'DRAFT' | 'IN_PROGRESS' | 'FOR_REVIEW' | 'FINALIZED' | 'REOPENED';
  finalizedAt?: string;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// Cash position (derived, cached for the dashboard)
// ---------------------------------------------------------------------------

export interface CashPosition {
  id: Id;
  fiscalYear: FiscalYear;
  fundCode: string;
  bankAccountId: Id;
  bankName: string;
  bankAccountNumber: string;
  glAccountCode: string;
  /** Balance per General Ledger. */
  bookBalance: Centavos;
  /** Last reconciled bank balance, with its date. */
  lastBankBalance?: Centavos;
  lastReconciledOn?: IsoDate;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// treasuryReports/{id}
// ---------------------------------------------------------------------------

/**
 * One document covered by a treasury report.
 *
 * Denormalised deliberately. The report is a statutory document that must
 * print exactly as it was certified, years later, even if a check is
 * subsequently cancelled or a payee is renamed in master data. So the number,
 * the date, the payee and the amount are copied onto the report at the moment
 * it is certified, and `sourceId` is kept only so the two can still be
 * navigated between.
 */
export interface TreasuryReportLine {
  /** The covered document: a check, an ADA, a collection, a payroll. */
  sourceId: Id;
  /** Its own number - check number, ADA number, OR number, payroll number. */
  sourceNo: string;
  date: IsoDate;
  payeeName?: string;
  particulars?: string;
  /**
   * What the report reports. For a check, ADA or receipt that is the face
   * amount; for a payroll on an RCDisb it is the **net** - the cash that
   * actually left the disbursing officer's hands.
   */
  amount: Centavos;

  /**
   * RCDisb only: the payroll's gross and total deductions, carried onto the
   * report so it prints as the office writes it - gross, deductions, net.
   *
   *     gross - deductions = amount
   *
   * They are context for the reader, not inputs to the entry. The RCDisb
   * liquidates a cash advance, so the only figure the journal entry needs is
   * the net that was actually paid out.
   */
  gross?: Centavos;
  deductions?: Centavos;

  /** Set for a cancelled check so the report still foots but excludes it. */
  excluded?: boolean;
}

/** A line of the accounting entry the report proposes. */
export interface TreasuryReportEntryLine {
  accountCode: string;
  accountName: string;
  debit: Centavos;
  credit: Centavos;
  particulars?: string;
}

/**
 * treasuryReports/{id} - RCI, RADAI, RCD and RCDisb.
 *
 * The handover between two offices, made into a record. Treasury certifies;
 * Accounting journalizes. The JEV is raised from the report as a whole, which
 * is both how the offices actually work and what makes the Check Disbursements
 * Journal agree with the check register: one journal entry per report, footing
 * to the report's total.
 */
export interface TreasuryReport extends Partial<AuditStamps> {
  id: Id;
  reportType: TreasuryReportType;
  /** Assigned when certified, so a draft cannot consume a number. */
  reportNo?: string;
  reportDate: IsoDate;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  /** The bank account drawn on. Set for RCI and RADAI. */
  bankAccountId?: Id;
  bankName?: string;
  bankAccountNumber?: string;

  /**
   * The accountable officer the report belongs to: the collecting officer for
   * an RCD, the disbursing or payroll officer for an RCDisb, the Treasurer for
   * an RCI or RADAI.
   */
  accountableOfficerId?: Id;
  accountableOfficerName?: string;

  /** Inclusive serial range covered, for the printed heading. */
  serialFrom?: string;
  serialTo?: string;

  lines: TreasuryReportLine[];
  /** Cash paid or collected. On an RCDisb this is the net, not the gross. */
  totalAmount: Centavos;

  /** RCDisb only: the payroll figures behind the net, for the printed report. */
  totalGross?: Centavos;
  totalDeductions?: Centavos;

  /**
   * The accounting entry this report proposes. Built by the engine from the
   * covered documents when the report is certified, and adjustable by the
   * Accountant before it is journalized - the Accountant owns the entry, the
   * Treasurer owns the list.
   */
  entry: TreasuryReportEntryLine[];

  status: TreasuryReportStatus;

  certifiedAt?: string;
  /** The JEV raised from this report. Set once, when journalized. */
  jevId?: Id;
  jevNo?: string;
  journalizedAt?: string;

  remarks?: string;
  cancelledReason?: string;
}
