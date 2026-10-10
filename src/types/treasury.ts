import type {
  ActorStamp,
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

export const REVENUE_SOURCES = [
  { value: 'REAL_PROPERTY_TAX', label: 'Real Property Tax' },
  { value: 'BUSINESS_TAX', label: 'Business Taxes' },
  { value: 'FEES_AND_CHARGES', label: 'Fees and Charges' },
  { value: 'COMMUNITY_TAX', label: 'Community Tax' },
  { value: 'MARKET', label: 'Market Collections' },
  { value: 'ECONOMIC_ENTERPRISE', label: 'Economic Enterprise' },
  { value: 'OTHER_LOCAL_REVENUE', label: 'Other Local Revenue' },
  { value: 'NATIONAL_TAX_ALLOTMENT', label: 'National Tax Allotment' },
  { value: 'OTHER_NG_TRANSFER', label: 'Other National Government Transfer' },
  { value: 'TRUST_RECEIPT', label: 'Trust Receipt' },
  { value: 'OTHER', label: 'Other Collections' },
] as const;

export type RevenueSource = (typeof REVENUE_SOURCES)[number]['value'];

/**
 * revenueCodes/{code} - the Treasurer's revenue codes, and where each posts.
 *
 * The MTO codes revenue far more finely than the COA chart does. This is the
 * join between the two, and it carries both halves of the answer: which COA
 * account the money is credited to, and which heading it appears under on the
 * collections report.
 */
export interface RevenueCode {
  id: Id;
  /** As the abstract writes it - 4020214001, 40601010D/S, 40202160-1. */
  code: string;
  description: string;
  /** The Chart of Accounts entry this revenue is credited to. */
  accountCode: string;
  revenueSource?: RevenueSource;
  active?: boolean;
}

export interface CollectionLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  amount: Centavos;
  particulars?: string;
  /**
   * The trust programme this money was received under. Trust Fund only.
   *
   * The Trust Fund's money is not the municipality's: it arrived for a stated
   * purpose from a source that keeps the right to ask for it back, and the
   * programme is what names that purpose. Carrying it on the receipt is what
   * lets the Registry of Special Trust Fund report a Receipt side worked out
   * of the receipts instead of a figure somebody typed.
   *
   * Optional, and deliberately so. A collection recorded before the programme
   * exists would otherwise have nowhere to go, and refusing it would stop the
   * Treasury taking money in. What is unattributed is listed by name on the
   * registry rather than quietly left out of it.
   */
  trustProgramId?: Id;
  trustProgramName?: string;
  /**
   * Patch 158: the subsidiary ledger account the line is kept under - asked
   * for on a non-revenue line (a receivable or a payable) and on a revenue
   * account the chart says has a subsidiary ledger. Carried into the RCD entry.
   */
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
  /**
   * Which tax year this payment settles. Real property tax only.
   *
   * GAM Appendix 45 splits both the basic tax and the Special Education Fund
   * into a current-year and a preceding-year column, because a payment on an
   * arrear is not this year's collection even though it arrives this year.
   * Nothing in a receipt says which it is - the Treasurer knows from the Real
   * Property Tax Account Register - so it is asked for on the receipt.
   */
  rptTaxYear?: 'CURRENT' | 'PRECEDING';
  /**
   * The barangay the property stands in. Real property tax only.
   *
   * Section 271 of the Local Government Code gives the barangay share of the
   * basic tax to the barangay where the property is located, NOT to the one
   * the payor lives in. So it cannot be derived from the payor, and the
   * abstract cannot say which barangay is owed what without it.
   */
  barangayId?: Id;
  barangayName?: string;
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

  /**
   * Which of COA Circular 2021-014's three reports this collection belongs on.
   *
   * ---------------------------------------------------------------------------
   * WHY AN e-COLLECTION IS A COLLECTION AND NOT ITS OWN RECORD
   * ---------------------------------------------------------------------------
   * It was tempting to give online money a collection of its own. It would have
   * been wrong. Money paid through GCash hits the same revenue accounts as money
   * paid at the counter, is deposited to the same bank, and appears in the same
   * Cashbook, the same Abstract of Collections and the same Statement of
   * Receipts and Expenditures.
   *
   * A second collection would have meant every one of those reports reading two
   * places - and the day one of them was written to read only the first, the
   * online money would have vanished from it silently. That is the fault the
   * office asked to avoid when it said all online collections should be
   * presented together.
   *
   * So this is a collection with a kind. Absent on a cash receipt, which is the
   * ordinary case and reads as "no electronic report".
   *
   *   AR     an intermediary collected and issued its own Acknowledgement
   *          Receipt (Annex E)
   *   EOR    our collecting officer issued an electronic Official Receipt
   *          (Annex F)
   *   DIRECT a payor paid straight into the bank account (Annex G)
   */
  eCollectionKind?: 'AR' | 'EOR' | 'DIRECT';

  /**
   * Who held the money: GCash, Maya, Land Bank's portal.
   *
   * Named on Annexes E and F. Absent on a DIRECT deposit, where there is no
   * intermediary - the payor paid the municipality's bank account itself.
   */
  intermediaryId?: Id;
  intermediaryName?: string;

  /**
   * Two columns the e-collection forms carry and the cash receipt does not.
   *
   * The responsibility centre is the office the collection is credited to, and
   * it is the first consumer CFMS has for an office's own function code. The
   * PREXC/PAP is the programme the collection relates to, which for an LGU is
   * the Function/Programme/Project code.
   */
  responsibilityCenterCode?: string;
  prexcPap?: string;

  /**
   * The treasury report that claimed this collection, written by
   * `certifyTreasuryReport`.
   *
   * It has been written on collections since treasury reports were first
   * certified - the RCD claims its receipts through exactly this field, and it
   * is what stops one receipt reaching the ledger on two reports. It was
   * simply never declared on the client type, because no screen read it back
   * until the e-collection register needed to show what had been reported and
   * what had not.
   */
  treasuryReportId?: Id;
  treasuryReportNo?: string;
  treasuryReportType?: TreasuryReportType;
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
  /** Patch 158: the payroll whose unexpended advance this receipt refunds. */
  refundForPayrollId?: Id | null;
  refundForPayrollNo?: string | null;
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

  /**
   * The primary report that gathered this one, set when that primary is
   * closed and cleared if it is reopened or cancelled. While it is set, this
   * report is accounted for by another document and must not be altered.
   */
  primaryReportId?: Id | null;
  primaryReportNo?: string | null;

  status: RcdStatus;
  jevId?: Id;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// deposits/{id}
// ---------------------------------------------------------------------------

/**
 * Patch 160 - collectionRemittances/{id}: money a collecting officer handed
 * to the Liquidating Officer (for Collection). Applied to the collector's
 * cash receipts in accountable-form series order - see src/lib/remittances.ts.
 */
export interface CollectionRemittance extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: FiscalYear;
  fundCode: string;
  remittanceDate: IsoDate;
  collectingOfficerId: Id | null;
  collectingOfficerName: string;
  liquidatingOfficerId: Id | null;
  liquidatingOfficerName: string;
  amount: Centavos;
  referenceNo?: string | null;
  remarks?: string | null;
  status: 'RECORDED' | 'CANCELLED';
  cancelReason?: string | null;
  /** Patch 161: the collector's RCD this remittance turns over. */
  collectorReportId?: Id | null;
  collectorReportNo?: string | null;
  /** Patch 161: the Liquidating Officer's RCD that reports it (Section A.2). */
  liquidatingReportId?: Id | null;
  liquidatingReportNo?: string | null;
}

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

  /**
   * The receipts this slip banked.
   *
   * A deposit used to point at an RCD, and from the day the Report of
   * Collections and Deposits became a treasury report that list was empty - so
   * every deposit was recorded linked to nothing and no deposit could be
   * traced to the money it banked.
   *
   * It points at the RECEIPTS now, which is what "deposited intact" means and
   * what the officer has in front of them. The RCD claims the same receipts
   * separately, through `treasuryReportId`; the two facts are independent and
   * both true.
   */
  collectionIds?: Id[];

  /** Kept for deposits recorded before the link moved to the receipts. */
  rcdId?: Id;
  rcdNo?: string;
  collectingOfficerId?: Id;
  collectingOfficerName?: string;

  /** Patch 157: the RCD that reported this deposit. Set when it is certified. */
  treasuryReportId?: Id;
  treasuryReportNo?: string;
  treasuryReportType?: string;

  /** Set by bank reconciliation once the credit appears on the statement. */
  bankTransactionId?: Id;
  creditedDate?: IsoDate;

  status: 'RECORDED' | 'IN_TRANSIT' | 'CREDITED' | 'CANCELLED';
  jevId?: Id;
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
  /** Patch 159: COLLECTION (an e-collection) and ERCD (an eRCD credited as one batch). */
  matchedType?: 'CHECK' | 'ADA' | 'RADAI' | 'DEPOSIT' | 'COLLECTION' | 'ERCD' | 'PAYROLL' | 'OTHER';
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
  /**
   * The payee record, where the report knows which one it was.
   *
   * The name alone was kept until patch 85, deliberately: a report prints as
   * it was certified years later, and a denormalised name cannot be changed
   * out from under it by someone renaming a payee.
   *
   * The id is here as well now, and only for the journal entry. The entry
   * settles Accounts Payable one creditor at a time, and a subsidiary ledger
   * is kept by RECORD, not by name - two suppliers with similar names would
   * otherwise be merged into one subsidiary account by a guess. Absent on a
   * report loaded from a bank file, which has names and no ids; the entry
   * then leaves those lines without a subsidiary rather than guessing.
   */
  /*
   * Null, not absent, where there is none.
   *
   * A collection has no payee id and no particulars of its own, so for an RCD
   * and for the e-collection reports these are legitimately empty - and
   * Firestore rejects a document containing `undefined`, taking the whole
   * report with it. Null says "this line has no payee id"; undefined said
   * nothing and lost the Treasurer the form.
   */
  payeeId?: Id | null;
  payeeName?: string | null;
  /** Patch 138: an ADA paying several payees - one bank row and one payable line each. */
  payees?: Array<{ payeeId: Id; payeeName: string; accountNumber: string; amount: Centavos }>;
  particulars?: string | null;
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
  /**
   * The subsidiary ledger the line belongs to. An RCI credits Cash in Bank,
   * which is a control account kept per bank account; an RCDisb settles an
   * advance held by a named officer. Without this the entry posts to the
   * control account and the subsidiary ledger cannot be made to agree with it.
   */
  subsidiaryType?: string;
  subsidiaryId?: Id;
  subsidiaryName?: string;
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
   * Patch 157 - RCD only: the deposits it accounts for (Section B). An RCD
   * may carry collections only, deposits only, or both. Deposits are booked
   * when they are recorded; the RCD reports them, so they are not in its
   * entry.
   */
  deposits?: Array<{
    sourceId: Id;
    depositSlipNo?: string;
    date?: IsoDate;
    bankName?: string;
    bankAccountNumber?: string;
    amount: Centavos;
  }>;
  totalDeposits?: Centavos;
  /**
   * Patch 159: the deposits this RCD's entry books (Dr Cash in Bank / Cr Cash
   * - Local Treasury) - every one not posted on its own before. Set when the
   * report is certified.
   */
  /**
   * Patch 161: Section A.2 - the collectors' remittances this (Liquidating
   * Officer's) RCD reports as received. No entry: they move accountability.
   */
  remittances?: Array<{
    sourceId: Id;
    collectorName: string;
    collectorReportNo?: string | null;
    date: IsoDate;
    amount: Centavos;
  }>;
  totalRemittances?: Centavos;
  /** Patch 161: set when the RCD's entry is reversed (deposits released). */
  reversedByJevNo?: string | null;
  depositsBookedTotal?: Centavos;

  /**
   * The accounting entry this report proposes. Built by the engine from the
   * covered documents when the report is certified, and adjustable by the
   * Accountant before it is journalized - the Accountant owns the entry, the
   * Treasurer owns the list.
   */
  entry: TreasuryReportEntryLine[];

  status: TreasuryReportStatus;

  certifiedAt?: string;
  /**
   * Patch 143. Null while certified but not yet forwarded to Accounting; a
   * date once forwarded. Absent on reports certified before patch 143, which
   * were forwarded in the same act.
   */
  forwardedAt?: string | null;
  forwardedBy?: { uid: string; name: string; position?: string | null; at: string } | null;
  /** Patch 144 (RADAI): the bank's online posting, recorded by postRadaiOnline. */
  postedOnlineAt?: string;
  postedOnlineDate?: string;
  bankReferenceNo?: string | null;
  notPostedAmount?: number;
  notPostedJevId?: string | null;
  /** The JEV raised from this report. Set once, when journalized. */
  jevId?: Id;
  jevNo?: string;
  journalizedAt?: string;

  remarks?: string;
  cancelledReason?: string;

  /**
   * When the supporting documents were closed, and by whom. Engine-written.
   * See src/lib/attachmentTypes.ts.
   */
  attachmentsLockedAt?: string;
  attachmentsLockedBy?: ActorStamp;

  /** The CSV upload this report was built from, when it came from one. */
  importId?: Id;
  /**
   * Rows of that upload still waiting to be dealt with by hand. Kept on the
   * report itself so certification can refuse in one field read: a report whose
   * upload still has unmatched rows does not cover everything on the paper it
   * was made from, and certifying it would forward a report that foots to less
   * than the Treasurer signed.
   */
  pendingRowCount?: number;
}

// ---------------------------------------------------------------------------
// treasuryImports/{id}
// ---------------------------------------------------------------------------

/**
 * Why a row of an uploaded RCI or RADAI could not be turned into a payment.
 *
 * Each of these is a real disagreement between the Treasurer's file and the
 * books, and each has a different answer. They are kept apart rather than
 * collapsed into one "error" so that the person resolving them is told what is
 * actually wrong instead of being sent to look.
 */
export type ImportRowReason =
  | 'NO_DV_NUMBER'
  | 'DV_NOT_FOUND'
  | 'DV_NOT_APPROVED'
  | 'DV_ALREADY_PAID'
  | 'FUND_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'NO_SERIAL'
  | 'DUPLICATE_SERIAL';

export const IMPORT_ROW_REASON_LABELS: Record<ImportRowReason, string> = {
  NO_DV_NUMBER: 'No DV number in the file',
  DV_NOT_FOUND: 'No such DV in CFMS',
  DV_NOT_APPROVED: 'The DV is not approved',
  DV_ALREADY_PAID: 'The DV already has a payment',
  FUND_MISMATCH: 'The DV belongs to another fund',
  AMOUNT_MISMATCH: 'The amount differs from the DV',
  NO_SERIAL: 'No check number in the file',
  DUPLICATE_SERIAL: 'That check number is already used',
};

/**
 * MATCHED   Linked to a voucher; a check or ADA was created and it is on the report.
 * PENDING   Held for manual handling. It is not on the report and not in the books.
 * MANUAL    Dealt with outside CFMS and deliberately set aside, with a reason.
 */
export type ImportRowStatus = 'MATCHED' | 'PENDING' | 'MANUAL';

export interface TreasuryImportRow {
  lineNo: number;
  /** As read from the file, before any matching. */
  date: IsoDate;
  /** Check serial number. Blank on a RADAI, where one ADA covers every row. */
  serialNo?: string;
  dvNo: string;
  /** Obligation Request number. The Treasurer's file may head this "CAFOA". */
  obrNo?: string;
  payeeName?: string;
  particulars?: string;
  responsibilityCenter?: string;
  amount: Centavos;

  status: ImportRowStatus;
  reason?: ImportRowReason;
  /** What the mismatch actually was, in figures, for the person resolving it. */
  detail?: string;
  note?: string;

  /** Set once matched: the voucher, and the check or ADA raised against it. */
  dvId?: Id;
  sourceId?: Id;
  sourceNo?: string;

  resolvedAt?: string;
  resolvedByName?: string;
}

/**
 * treasuryImports/{id} - one uploaded RCI or RADAI file.
 *
 * The upload is kept whole, rows that matched beside rows that did not. That is
 * deliberate: the file is the Treasurer's statement of what was paid, and a
 * record that silently dropped the rows CFMS could not place would leave nobody
 * able to answer why the report totals less than the paper.
 *
 * An unmatched row is held, never rejected. Rejecting the whole file because
 * one voucher was encoded late means the other forty rows wait on it, and the
 * office learns to stop uploading.
 */
export interface TreasuryImport {
  id: Id;
  importType: 'RCI' | 'RADAI';
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;
  reportDate: IsoDate;

  bankAccountId: Id;
  bankName: string;
  bankAccountNumber: string;
  /** RADAI: the single ADA number the whole batch was sent to the bank under. */
  adaNo?: string;

  fileName?: string;
  treasuryReportId: Id;
  treasuryReportNo?: string;

  rows: TreasuryImportRow[];
  rowCount: number;
  matchedCount: number;
  pendingCount: number;

  /** What the file said, and what CFMS was able to place against vouchers. */
  fileTotal: Centavos;
  matchedTotal: Centavos;
  pendingTotal: Centavos;

  status: 'PENDING' | 'COMPLETE' | 'CANCELLED';
  uploadedAt: string;
  uploadedByName?: string;
}
