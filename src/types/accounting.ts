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
  AdaStatus,
  CashAdvanceType,
  CashFlowClass,
  CheckStatus,
  DvCategory,
  DvStatus,
  JevSourceType,
  JevStatus,
  JournalBook,
  LiquidationStatus,
  PayrollStatus,
  PayrollType,
} from './enums';

/**
 * Accounting module documents.
 *
 * The one rule that governs this file: the General Ledger is the single source
 * of truth. Every balance that appears on a financial statement is derived from
 * `ledgerEntries`, which are written only by the JEV posting function. No
 * document here stores a statement balance of its own.
 */

// ---------------------------------------------------------------------------
// disbursementVouchers/{id}
// ---------------------------------------------------------------------------

/** One accounting distribution line of a DV. */
export interface DvAccountLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  /**
   * The budget line this expense is charged to, carried from the obligation.
   *
   * A voucher that draws on an obligation inherits the FPP of the obligation
   * line it draws on, and this is where it comes from. Empty on a voucher with
   * no obligation behind it - a refund, a trust disbursement - which is the
   * honest answer rather than an FPP chosen to fill the column.
   */
  fppCode?: string;
  fppName?: string;
  /** Exactly one of debit/credit is non-zero on any given line. */
  debit: Centavos;
  credit: Centavos;
  officeId?: Id;
  responsibilityCenterId?: Id;
  /** Subsidiary ledger reference, e.g. a payee for Accounts Payable. */
  subsidiaryType?: 'PAYEE' | 'EMPLOYEE' | 'OFFICE' | 'PROJECT' | 'BANK_ACCOUNT' | 'TAX_CODE';
  subsidiaryId?: Id;
  subsidiaryName?: string;
  particulars?: string;
}

/** A withholding tax or other deduction taken out of the gross amount. */
export interface DvDeduction {
  lineNo: number;
  /** Tax code id when statutory, or a free-form label for "other deductions". */
  taxCodeId?: Id;
  code: string;
  description: string;
  /** Liability account credited. */
  accountCode: string;
  accountName: string;
  /** Base the rate was applied to, kept so the computation can be re-checked. */
  base: Centavos;
  rate?: number;
  amount: Centavos;
}

/** One of several payees on a voucher. Patch 138. */
export interface DvPayee {
  lineNo: number;
  /** Null only on a draft, for a name not yet on the master list; refused at submission. */
  payeeId: Id | null;
  payeeName: string;
  /** The ATM / bank account the bank credits, as at the voucher. */
  accountNumber: string;
  /** Their share of the net amount, in centavos. */
  amount: Centavos;
}

export interface DisbursementVoucher extends Partial<AuditStamps> {
  id: Id;
  dvNo: string;
  dvDate: IsoDate;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  /**
   * What this voucher pays, and the reason the next two fields are optional.
   *
   * OBLIGATED pays an expenditure and must draw on an Obligation Request.
   * TRUST_LIABILITY settles money the municipality is only holding and must
   * not. Before this field existed, a voucher with no obligation simply went
   * through, and nothing told a deliberate trust settlement apart from an
   * obligation somebody forgot to attach.
   */
  dvCategory?: DvCategory;

  /** The obligation this voucher draws against. Required when OBLIGATED. */
  obligationId?: Id;
  obrNo?: string;

  officeId: Id;
  officeName: string;
  responsibilityCenterId?: Id;

  payeeId: Id;
  /** "Juan Dela Cruz, et al." when the voucher pays several payees (patch 138). */
  payeeName: string;
  payeeTin?: string;
  payeeAddress?: string;
  /**
   * Patch 138 - "Payee, et al." One voucher, several payees, paid by ONE ADA
   * into each payee's own account. The header payee is the first of them and
   * the name carries ", et al."; the list is the payees and what each is paid
   * (their share of the net). The entry credits Accounts Payable per payee,
   * the ADA carries the list, and the bank file has a row per payee.
   */
  severalPayees?: boolean;
  payees?: DvPayee[];

  particulars: string;

  /**
   * Money computation. Enforced server-side:
   *   grossAmount - totalDeductions = netAmount
   * and the accounting lines must balance to the same figures.
   */
  grossAmount: Centavos;
  deductions: DvDeduction[];
  totalDeductions: Centavos;
  netAmount: Centavos;

  accountLines: DvAccountLine[];

  /**
   * The bank account the payment is expected to be drawn on, where Accounting
   * knows it. A hint for the Treasurer, not a decision: the voucher records
   * that a payable is owed, and which way the money left is established by the
   * report the payment turns up on - the RCI for a check, the RADAI for an ADA.
   */
  bankAccountId?: Id;
  checkId?: Id;
  checkNo?: string;
  adaId?: Id;
  adaNo?: string;

  status: DvStatus;
  /** The entry this voucher raised. Set when the voucher is approved. */
  jevId?: Id;
  /**
   * The entry's journal number, and the moment it was posted.
   *
   * Since patch 85 both are set at APPROVAL, because approving a voucher now
   * posts its entry in the same act. They used to be set later, when the
   * Accountant pressed Post on a second screen - which meant the General
   * Ledger lagged the vouchers by however long that took.
   *
   * Either one empty on an approved voucher means it was approved before
   * patch 85 and its entry is still waiting to be posted by hand.
   */
  jevNo?: string | null;
  jevPostedAt?: string | null;

  /**
   * Approved and in the books, and Accounting has not sent it to Treasury yet.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NOT JUST "APPROVED"
   * ---------------------------------------------------------------------------
   * Approval says the claim is proper. Sending it says the municipality is
   * ready to pay it, and those are different statements - a voucher can be
   * perfectly proper and still be one the office wants to hold for cash, for a
   * supplier query, or to release with a batch.
   *
   * Until this split there was only one way to hold a voucher back: not
   * approve it. Which meant the books waited on a cash decision, and the
   * Accountant's approval was being used to say something it does not mean.
   *
   * Written true by `approveDv`, false by `forwardDvToTreasury`. ABSENT on
   * every voucher approved before patch 85, which is what keeps those in the
   * Treasurer's queue instead of making them vanish from it. See
   * `src/lib/paymentQueue.ts`.
   */
  awaitingTransferToTreasury?: boolean | null;
  /** Who sent it over, and when. */
  forwardedToTreasury?: ActorStamp | null;

  attachmentCount: number;
  /**
   * When the supporting documents were closed, and by whom.
   *
   * Written by the engine only - by lockAttachments when an officer closes
   * them, and by certifyObligation, because the certificate says that officer
   * saw those papers. Once set it is never cleared: a closing that could be
   * reopened would prove nothing about what was closed.
   */
  attachmentsLockedAt?: string;
  attachmentsLockedBy?: ActorStamp;
  /** Document types the workflow requires before this DV may be submitted. */
  requiredAttachmentsMissing?: string[];

  remarks?: string;
  returnedReason?: string;
  cancelledReason?: string;
  /** Currently assigned to, for the workflow inbox. */
  assignedToRole?: string;
}

// ---------------------------------------------------------------------------
// jevs/{id}   and   ledgerEntries/{id}
// ---------------------------------------------------------------------------

/** One correction made to a posted entry, kept on the entry itself. */
export interface JevCorrection {
  at: string;
  by: { uid: Id; name: string; position?: string | null };
  reason: string;
  /** What the entry said before this correction. */
  previous: {
    jevDate: IsoDate;
    particulars: string;
    totalDebit: Centavos;
    lineCount: number;
  };
}

export interface JevLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  debit: Centavos;
  credit: Centavos;
  /**
   * The Function, Programme or Project this line is charged to.
   *
   * ---------------------------------------------------------------------------
   * WHY THE LEDGER CARRIES IT AS WELL AS THE ACCOUNT CODE
   * ---------------------------------------------------------------------------
   * They answer different questions, and on a third of the FY2025 ordinance
   * they are different values. The account code says what KIND of expense this
   * is - fuel, supplies, salaries - and it is what the Trial Balance and the
   * financial statements are built from. The FPP says which LINE OF THE BUDGET
   * it was charged to, and it is what the Statement of Comparison of Budget and
   * Actual Amounts and the SRE are built from.
   *
   * On a line appropriated by object of expenditure the two coincide. On a
   * project line the appropriation names the project and the voucher names the
   * fuel, and matching actual against appropriation by account code would find
   * nothing for exactly the project lines the Sanggunian and the public ask
   * about.
   *
   * Empty on an entry that is not budget expenditure at all: a collection, a
   * deposit, a bank charge, an opening balance. Those are real entries with no
   * budget line behind them, and an FPP invented for them would foot into the
   * SCBAA as spending that never happened.
   * ---------------------------------------------------------------------------
   */
  fppCode?: string;
  fppName?: string;
  officeId?: Id;
  officeName?: string;
  responsibilityCenterId?: Id;
  subsidiaryType?: 'PAYEE' | 'EMPLOYEE' | 'OFFICE' | 'PROJECT' | 'BANK_ACCOUNT' | 'TAX_CODE';
  subsidiaryId?: Id;
  subsidiaryName?: string;
  cashFlowClass?: CashFlowClass;
  particulars?: string;
}

export interface JournalEntryVoucher extends Partial<AuditStamps> {
  id: Id;
  jevNo: string;
  jevDate: IsoDate;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  /** Which book this entry belongs to; drives the journal reports. */
  book: JournalBook;

  /** What generated this JEV. */
  sourceType: JevSourceType;
  sourceId?: Id;
  referenceNo?: string;

  payeeId?: Id;
  payeeName?: string;
  particulars: string;

  lines: JevLine[];
  /**
   * Every correction made to this entry AFTER it was posted, oldest first.
   *
   * Written by the engine (amendPostedJev), only while the month is open, and
   * never removed. The ledger says what the books say now; this says what they
   * said before and who changed it. An entry corrected twice carries both.
   */
  corrections?: JevCorrection[];

  /**
   * The amount the source document was signed for, where this entry no longer
   * agrees with it.
   *
   * ---------------------------------------------------------------------------
   * WHAT IT MEANS WHEN THIS IS SET
   * ---------------------------------------------------------------------------
   * An entry raised by a disbursement voucher or a certified treasury report
   * takes its total from that document. CFMS used to refuse an amendment that
   * changed it. It no longer does - the Municipal Accountant asked for the
   * amount to be correctable like everything else - so the disagreement has to
   * be visible instead of prevented.
   *
   * This is the figure on the paper. `totalDebit` is what the ledger now
   * carries. While the two differ the entry and the document both say so on
   * their face, and the correction is in the audit trail as a CRITICAL event.
   *
   * Null, or absent, means the entry and its document agree - which includes
   * an entry corrected back to the signed figure, and every entry written in
   * Accounting, which has no signed document behind it at all.
   */
  signedTotal?: Centavos | null;

  totalDebit: Centavos;
  totalCredit: Centavos;

  status: JevStatus;
  postedAt?: string;

  /** When this JEV reverses another, and when it has itself been reversed. */
  reversesJevId?: Id;
  reversedByJevId?: Id;

  cancelledReason?: string;
  remarks?: string;
}

/**
 * ledgerEntries/{id} - the General Ledger itself.
 *
 * One immutable document per posted JEV line. Nothing in CFMS updates or deletes
 * a ledger entry: a correction is a new JEV. Security rules deny all client
 * writes to this collection; only the posting function may create them.
 */
export interface LedgerEntry {
  id: Id;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;
  entryDate: IsoDate;

  jevId: Id;
  jevNo: string;
  jevLineNo: number;
  book: JournalBook;

  accountCode: string;
  accountName: string;
  /** The budget line this entry is charged to; empty where there is none. */
  fppCode?: string;
  fppName?: string;
  /** Signed amount in centavos: positive = debit, negative = credit. Storing a
   *  single signed figure makes trial-balance aggregation a single sum. */
  signedAmount: Centavos;
  debit: Centavos;
  credit: Centavos;

  officeId?: Id;
  officeName?: string;
  responsibilityCenterId?: Id;
  subsidiaryType?: string;
  subsidiaryId?: Id;
  subsidiaryName?: string;
  cashFlowClass?: CashFlowClass;
  /**
   * When this item arose, if that differs from `entryDate`. Set on opening
   * balances so a payable carried forward from the previous system ages from
   * the date it was incurred rather than the date the books were converted.
   * Aging reports read this first and fall back to `entryDate`.
   */
  agingDate?: IsoDate;

  sourceType: string;
  sourceId?: Id;
  referenceNo?: string;
  payeeId?: Id;
  payeeName?: string;
  particulars?: string;

  postedAt: string;
  postedByUid: Id;
  /** True for the mirror entry created by a reversing JEV. */
  isReversal: boolean;
}

// ---------------------------------------------------------------------------
// checks/{id}
// ---------------------------------------------------------------------------

export interface Check extends Partial<AuditStamps> {
  id: Id;
  checkNo: string;
  checkDate: IsoDate;
  fiscalYear: FiscalYear;
  fundCode: string;

  bankAccountId: Id;
  bankName: string;
  bankAccountNumber: string;

  dvId: Id;
  dvNo: string;
  payeeId: Id;
  payeeName: string;
  particulars: string;

  grossAmount: Centavos;
  totalDeductions: Centavos;
  /** The face value of the check: gross less deductions. */
  netAmount: Centavos;


  /**
   * The Report of Checks Issued that covers this check.
   *
   * A check reaches the General Ledger through its report, not on its own: the
   * Treasurer batches the checks into an RCI, and Accounting raises one JEV
   * from the report. Set when that report is certified, and the check cannot
   * then be cancelled without withdrawing the report first.
   */
  treasuryReportId?: Id;
  treasuryReportNo?: string;

  status: CheckStatus;
  dateReleased?: IsoDate;
  releasedToName?: string;
  releasedToPosition?: string;
  /** Set by bank reconciliation when the check appears on a bank statement. */
  clearedDate?: IsoDate;
  bankTransactionId?: Id;

  /**
   * Set when the check was drawn to a payee the clearing house refuses, with
   * the written decision to draw it anyway. The register marks these.
   */
  clearingObjection?: string | null;
  clearingAcknowledgement?: string | null;

  cancelledReason?: string;
  replacedByCheckId?: Id;
  replacesCheckId?: Id;
}

// ---------------------------------------------------------------------------
// ada/{id}   (Advice to Debit Account)
// ---------------------------------------------------------------------------

export interface Ada extends Partial<AuditStamps> {
  id: Id;
  adaNo: string;
  adaDate: IsoDate;
  fiscalYear: FiscalYear;
  fundCode: string;

  bankAccountId: Id;
  bankName: string;
  bankAccountNumber: string;

  dvId: Id;
  dvNo: string;
  payeeId: Id;
  payeeName: string;
  particulars: string;
  amount: Centavos;
  /** Patch 138: the voucher's payees, copied when the advice is issued. */
  payees?: DvPayee[];

  /**
   * The Report of ADA Issued that covers this advice. The ADA reaches the
   * General Ledger through its report, not on its own.
   */
  treasuryReportId?: Id;
  treasuryReportNo?: string;

  status: AdaStatus;
  /** Patch 143: shown as "Posted online" - the date the bank posted it. */
  dateSubmittedToBank?: IsoDate;
  bankReferenceNo?: string;
  dateDebited?: IsoDate;
  bankTransactionId?: Id;

  /**
   * Patch 143. The credits the bank did NOT post online, as the Treasury
   * recorded them when marking the advice posted. Each became a trust
   * liability (adjusting entry `notPostedJevId`) to be repaid by a new voucher.
   */
  notPosted?: DvPayee[];
  notPostedAmount?: Centavos;
  notPostedJevId?: Id;
  postedOnlineBy?: { uid: string; name: string; position?: string | null; at: string };

  rejectedReason?: string;
  cancelledReason?: string;
}

// ---------------------------------------------------------------------------
// payrolls/{id}
// ---------------------------------------------------------------------------

/**
 * payrolls/{id} - one payroll, in total.
 *
 * A payroll is recorded as a lumpsum: the gross for the office and the period,
 * the total deductions withheld, and the net payable. It is not an employee
 * register, and it does not break the deductions down.
 *
 * That is a deliberate narrowing on both counts. The payroll register - who was
 * paid what - is prepared in the office that owns it, and a second copy here
 * would only give the municipality two sets of figures to keep in step. The
 * deductions are split by account on the disbursement voucher that recognises
 * the payroll; by the time the cash is disbursed and reported on an RCDisb, the
 * only figure the entry needs is the net.
 */
export interface Payroll extends Partial<AuditStamps> {
  id: Id;
  payrollNo: string;
  payrollType: PayrollType;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  periodFrom: IsoDate;
  periodTo: IsoDate;
  officeId: Id;
  officeName: string;

  obligationId?: Id;
  obrNo?: string;
  dvId?: Id;
  dvNo?: string;

  /** What the payroll covers, e.g. "Regular employees, Office of the Mayor". */
  particulars?: string;

  totalGross: Centavos;
  /** All deductions withheld, as one figure. */
  totalDeductions: Centavos;
  totalNet: Centavos;
  /** How many people the payroll covers. Recorded for the report heading only. */
  employeeCount?: number;

  /** The RCDisb that reported this payroll. Set when that report is certified. */
  treasuryReportId?: Id;
  treasuryReportNo?: string;

  status: PayrollStatus;
  jevId?: Id;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// cashAdvances/{id} and liquidations/{id}
// ---------------------------------------------------------------------------

export interface CashAdvance extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: FiscalYear;
  fundCode: string;
  caType: CashAdvanceType;

  dvId: Id;
  dvNo: string;
  accountableOfficerId: Id;
  accountableOfficerName: string;
  officeId: Id;
  officeName: string;

  dateGranted: IsoDate;
  amountGranted: Centavos;
  purpose: string;
  /** Statutory liquidation deadline, computed from caType and dateGranted. */
  dueDate: IsoDate;

  /** Maintained by the liquidation posting function only. */
  amountLiquidated: Centavos;
  amountRefunded: Centavos;
  /** amountGranted - amountLiquidated - amountRefunded */
  outstandingBalance: Centavos;

  status: 'OUTSTANDING' | 'PARTIALLY_LIQUIDATED' | 'FULLY_LIQUIDATED' | 'WRITTEN_OFF';
  glAccountCode: string;
  /*
   * Patch 133. An advance read off the General Ledger (src/lib/advances.ts)
   * rather than stored in `cashAdvances`: the id is the ledger entry that
   * granted it, amountLiquidated is everything credited against it (oldest
   * advance first), and there is no due date because the ledger records none.
   */
  source?: 'LEDGER';
  jevNo?: string;
  glAccountName?: string;
  subsidiaryType?: string | null;
}

export interface LiquidationLine {
  lineNo: number;
  date: IsoDate;
  particulars: string;
  accountCode: string;
  accountName: string;
  amount: Centavos;
  orNumber?: string;
  supplierName?: string;
}

export interface Liquidation extends Partial<AuditStamps> {
  id: Id;
  liquidationNo: string;
  liquidationDate: IsoDate;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;

  cashAdvanceId: Id;
  dvNo: string;
  /** Patch 133: an advance read off the General Ledger; cashAdvanceId is then its ledger entry. */
  advanceSource?: 'LEDGER';
  advanceAccountCode?: string;
  advanceAccountName?: string;
  advanceSubsidiaryType?: string | null;
  accountableOfficerId: Id;
  accountableOfficerName: string;
  officeId: Id;
  officeName: string;

  dateGranted: IsoDate;
  amountGranted: Centavos;
  purpose: string;

  lines: LiquidationLine[];
  amountLiquidated: Centavos;
  /** Cash returned by the officer. */
  refundAmount: Centavos;
  /** Where the officer spent more than advanced and is owed the difference. */
  reimbursementAmount: Centavos;
  outstandingBalance: Centavos;

  status: LiquidationStatus;
  jevId?: Id;
  /** Patch 137: drawn when the report is saved; the entry is posted under it at approval. */
  jevNo?: string;
  jevNoDrawnAt?: string;
  remarks?: string;

  attachmentCount?: number;
  /** Document types the workflow requires before this report may be posted. */
  requiredAttachmentsMissing?: string[];
  /** See the note on the disbursement voucher. Engine-written. */
  attachmentsLockedAt?: string;
  attachmentsLockedBy?: ActorStamp;
}

// ---------------------------------------------------------------------------
// accountingPeriods/{fiscalYear}_{period}
// ---------------------------------------------------------------------------

export interface AccountingPeriod {
  id: Id;
  fiscalYear: FiscalYear;
  period: PeriodNo;
  fundCode: string;
  status: 'OPEN' | 'TEMPORARILY_LOCKED' | 'CLOSED' | 'REOPENED';
  closedBy?: ActorStamp;
  reopenedBy?: ActorStamp;
  reopenReason?: string;
  closedAt?: string;
  reopenedAt?: string;
}
