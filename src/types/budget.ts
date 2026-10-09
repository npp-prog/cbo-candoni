import type { ActKind, SourceSection } from '@/lib/budgetActs';
import type {
  ActorStamp,
  AuditStamps,
  Centavos,
  FiscalYear,
  Id,
  IsoDate,
} from './common';
import type { ExpenseClass, ObligationStatus } from './enums';
import type { RealignmentInstrument } from '@/lib/accounting-rules';

/**
 * Budget module documents.
 *
 * The budget control chain is:
 *
 *   Appropriation  (authority to spend, enacted by the Sanggunian)
 *     -> Allotment   (release of that authority to an office)
 *       -> Obligation  (a commitment charged against a release)
 *         -> Disbursement (actual payment)
 *
 * Two hard invariants are enforced server-side, never in the browser:
 *   total allotments  <= revised appropriation      (per budget line)
 *   total obligations <= total allotments released  (per budget line)
 */

/**
 * The dimensions that together identify one budget line. Appropriations,
 * allotments and obligations all carry this same key so that balances can be
 * aggregated without joins - the shape of Firestore rewards this.
 */
export interface BudgetKey {
  fiscalYear: FiscalYear;
  fundCode: string;
  officeId: Id;
  responsibilityCenterId?: Id;
  programId?: Id;
  projectId?: Id;
  activityId?: Id;
  /**
   * The Function, Programme or Project the Sanggunian appropriated to.
   *
   * This is what the budget is actually charged against, and it is the key
   * that lets one line be followed from the ordinance through the obligation
   * and the JEV to the Statement of Comparison of Budget and Actual Amounts.
   *
   * It is an object code from the Revised Chart of Accounts when the
   * appropriation was made by object of expenditure - which is how personnel
   * services and routine maintenance are enacted - and a programme code from
   * the FPP masterlist when it was made by project. Both are codes; which kind
   * it is decides only where the name comes from.
   */
  fppCode: string;
  /**
   * The object of expenditure, where the ordinance named one.
   *
   * EMPTY on a project line, and that is not a gap to be filled in later.
   * A third of the lines of the FY2025 ordinance - every capital outlay and
   * every special programme - were appropriated by project, with no object
   * code at all. The object becomes known when the obligation is raised, which
   * is the right time to know it and is how the appropriation was enacted.
   *
   * Budget control therefore operates at the level the appropriation was made
   * at: an obligation against a project draws down the project, an obligation
   * against an object code draws down that object.
   */
  accountCode: string;
}

/**
 * A deterministic string form of the budget key, used as the document id of the
 * running balance record so that concurrent obligations against the same line
 * contend on a single document and cannot both pass the balance check.
 */
export function budgetKeyId(k: BudgetKey): string {
  return [
    k.fiscalYear,
    k.fundCode,
    k.officeId,
    k.responsibilityCenterId ?? '-',
    k.programId ?? '-',
    k.projectId ?? '-',
    k.activityId ?? '-',
    k.fppCode || '-',
    // A project line has no object code. It takes the same placeholder as the
    // other absent dimensions rather than an empty segment, so that the id
    // stays readable and two adjacent separators never mean two different
    // things.
    k.accountCode || '-',
  ].join('__');
}

// ---------------------------------------------------------------------------
// appropriations/{id}
// ---------------------------------------------------------------------------

/**
 * ---------------------------------------------------------------------------
 * AN AUGMENTATION BEING PREPARED
 * ---------------------------------------------------------------------------
 * An augmentation moves savings from one budget line to another within a
 * single expense class, under the Local Chief Executive's omnibus authority.
 * Until patch 103 it was posted the moment the form was submitted: the lines
 * landed APPROVED, the allotment moved with them, and there was no state in
 * which the Budget Officer could read back what they had typed before it
 * became authority.
 *
 * A draft is therefore ONE DOCUMENT HOLDING THE WHOLE SET, not a row per line.
 * The shape is the point. An augmentation is only valid as a set - the amounts
 * come to zero, every line is in the same expense class, and the allotment
 * moves peso for peso - so a draft made of loose rows could be approved
 * halfway, which is the one outcome that must be impossible. One document
 * cannot be half-approved.
 *
 * Nothing here touches a balance. The draft is the office's own working paper;
 * the engine is what posts, and it runs every check at that moment and not
 * before.
 */
export interface AugmentationDraftLine {
  lineNo: number;
  officeId: string | null;
  /** The office NAME is what is sent: the engine resolves by code, name or short name. */
  officeName: string;
  /** The chosen budget line's balance document id, so the form can reopen on it. */
  lineId: string | null;
  fppCode: string;
  fppName: string;
  sector: string;
  serviceSector: string;
  accountCode: string;
  accountName: string;
  expenseClass: string;
  /** Centavos. Negative on the line giving up savings, positive on the one receiving. */
  amount: number;
  particulars: string;
}

export interface AugmentationDraft extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: number;
  fundCode: string;
  /**
   * Which of the two acts. Since patch 112 a REALIGNMENT is prepared here as
   * well, before it is posted - the office asked for it. The collection keeps
   * its older name; it holds both.
   */
  instrument: 'AUGMENTATION' | 'REALIGNMENT';
  /** UPLOAD when the engine wrote it from a file, rather than the form. */
  source?: 'UPLOAD';
  importFileName?: string | null;
  /** The authority of the Local Chief Executive, and its date. */
  authorityReference: string;
  authorityDate: IsoDate;
  lines: AugmentationDraftLine[];
  /**
   * DRAFT is the only status a client may write. There is no POSTED: once the
   * engine has posted the set, the Appropriation Ledger is the record and the
   * draft is deleted. A draft that survives a successful posting is harmless -
   * approving it again is refused by the engine, which keys on the reference.
   */
  status: 'DRAFT';
}

/**
 * ---------------------------------------------------------------------------
 * AN ALLOTMENT RELEASE ORDER, PREPARED AND AWAITING APPROVAL
 * ---------------------------------------------------------------------------
 * Since patch 110 an ARO is not released when it is entered. It is saved here,
 * moves nothing, and is released when the Budget Officer approves it - by
 * `approveAro`, which reads THIS document inside the transaction that releases
 * it, so what is approved is exactly what was prepared.
 *
 * Kept after approval, marked APPROVED with its ARO number, as the record of
 * who prepared the order and so an uploaded file cannot be prepared twice. Only
 * the engine can write APPROVED; a browser can only ever write DRAFT.
 */
export interface AroDraftLine {
  /** The budget balance document id - how the order form reopens on the line. */
  balanceId: string;
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  accountCode: string;
  accountName: string;
  amount: Centavos;
  forLaterRelease: Centavos;
}

export interface AroDraft extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: number;
  fundCode: string;
  expenseClass: ExpenseClass;
  purpose: string;
  date: IsoDate;
  lines: AroDraftLine[];
  status: 'DRAFT' | 'APPROVED';
  /** Set by the engine on approval, with `approvedBy` from AuditStamps. */
  aroNo?: string;
  /** Set when the order was filled from an uploaded file. */
  source?: 'UPLOAD';
  reference?: string;
  importFileName?: string | null;
}

export type AppropriationKind =
  | 'ORIGINAL'
  | 'SUPPLEMENTAL'
  | 'CONTINUING'
  | 'REALIGNMENT'
  | 'TRANSFER'
  | 'ADJUSTMENT';

export interface Appropriation extends BudgetKey, Partial<AuditStamps> {
  id: Id;
  /** Denormalised for display and export. */
  officeName: string;
  /** The office or function code as the ordinance writes it, e.g. 1011. */
  officeCode?: string;
  /** Empty on a project line, where the ordinance named no object. */
  accountName: string;
  /** Denormalised so a report can be cut by FPP without reading master data. */
  fppName: string;
  /**
   * The sector as the ordinance writes it - one of the nine in the FY2025
   * appropriation, from "General Public Services" to "Allocation for Senior
   * Citizens and PWD".
   */
  sector: string;
  /**
   * The sector whose service this line actually delivers.
   *
   * Set only where `sector` names a funding source rather than a service: the
   * 20% Development Fund and the LDRRMF are a quarter of the municipality's
   * budget between them, and a road built out of the 20% fund is economic
   * services however it was paid for. The SRE has four expenditure buckets and
   * neither of those two is one of them, so a project under either must say
   * which service it delivers or it cannot be reported.
   */
  serviceSector?: string;
  programName?: string;
  projectName?: string;
  activityName?: string;
  expenseClass: ExpenseClass;

  kind: AppropriationKind;
  /**
   * Where this line came from, when it came from a file.
   *
   * Written by `importBudgetLines` on every posted line and absent on one
   * recorded through the form. It is on the type because the detail panel
   * shows it: an officer asking "where did this figure come from" on a line
   * nobody remembers typing is asking exactly this, and the answer was in the
   * document all along without being in the type.
   */
  importReference?: string | null;
  importLineNo?: number | null;
  importFileName?: string | null;
  /**
   * Which instrument a REALIGNMENT was made under. Meaningless on any other
   * kind.
   *
   * SUPPLEMENTAL is a re-appropriation of savings through a supplemental
   * budget, Section 321 of the Local Government Code: an ordinance of the
   * Sanggunian, which may move authority across expense classes.
   *
   * AUGMENTATION is Section 336: no ordinance of its own is needed where the
   * annual budget's General Provisions carry the omnibus authority, and the
   * price of that is that it may only move savings within the same expense
   * class. The two are identical in the books and are not the same act in law,
   * which is why the instrument is recorded rather than inferred.
   */
  instrument?: RealignmentInstrument;
  /** Ordinance or authority that enacted this appropriation. */
  authorityReference?: string;
  authorityDate?: IsoDate;
  /**
   * Signed amount. ORIGINAL/SUPPLEMENTAL/CONTINUING are positive; REALIGNMENT
   * and TRANSFER come in pairs of equal magnitude and opposite sign so that the
   * total across a fund remains unchanged.
   */
  amount: Centavos;
  particulars?: string;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  postedAt?: string;
}

// ---------------------------------------------------------------------------
// ordinances/{id}   (the appropriation ordinance as a document of its own)
// ---------------------------------------------------------------------------

/**
 * The ordinance an appropriation was enacted by, as a document. Patch 119.
 *
 * ---------------------------------------------------------------------------
 * WHY A RECORD OF ITS OWN, WHEN THE LINES ALREADY NAME IT
 * ---------------------------------------------------------------------------
 * Every appropriation line carries its authority reference, and that is
 * still what ties a line to its ordinance. What the lines cannot carry is
 * the ordinance's own paper - the scanned ordinance, attached once - nor a
 * place to stand before any line has been typed. This record is both: the
 * header the lines are recorded under, and the thing the file is attached to.
 *
 * It holds no money and no status. What it has enacted is read from its
 * lines: all approved, some still draft, or nothing recorded yet.
 *
 * Its id is made from the year, the fund, the kind and the number, so the
 * same ordinance cannot be recorded twice.
 */
/**
 * An act of appropriation - an ordinance, an augmentation order, or a
 * certification of continuing appropriations. Stored in `ordinances` (the
 * name it had in patch 119, when ordinances were the only kind).
 */
export interface Ordinance extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: number;
  fundCode: string;
  kind: ActKind;
  /** Kept by the attachments panel. The engine counts the documents itself. */
  attachmentCount?: number;
  /** The ordinance or resolution number, as the authority reference is written on its lines. */
  reference: string;
  date: IsoDate;
  /** What it is, in the office's words: "Annual Budget FY 2026". */
  title?: string;
}

/**
 * A source of financing, encoded. Patch 123.
 *
 * 1.0 New Revenue Sources and 2.0 Excess Collection finance supplemental
 * budgets; Continuing finances continuing appropriations. Encoded inside an
 * act (actId set: that act's) or on the Sources tab (actId null: open to
 * any act of the kind it finances). Written only by the engine.
 */
export interface FundingSource extends Partial<AuditStamps> {
  id: Id;
  fiscalYear: number;
  fundCode: string;
  section: SourceSection;
  particulars: string;
  accountCode?: string | null;
  accountName?: string | null;
  amount: Centavos;
  actId?: string | null;
  /** The act's reference, for the list - the id is what links. */
  actReference?: string | null;
}

// ---------------------------------------------------------------------------
// allotments/{id}
// ---------------------------------------------------------------------------

export interface Allotment extends BudgetKey, Partial<AuditStamps> {
  id: Id;
  allotmentNo: string;
  /**
   * The Allotment Release Order this line was released on, where it came from
   * one. Lines sharing a number are one order and print as one document.
   */
  aroNo?: string;
  aroPurpose?: string;
  /**
   * The part of this line's appropriation deliberately withheld from release.
   * The Budget Operations Manual's "For Later Release" column.
   */
  forLaterRelease?: Centavos;
  allotmentDate: IsoDate;
  officeName: string;
  accountName: string;
  fppName: string;
  sector?: string;
  serviceSector?: string;
  expenseClass: ExpenseClass;
  /** Positive for a release, negative for a withdrawal of allotment. */
  amount: Centavos;
  particulars?: string;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  postedAt?: string;
  /**
   * Present on the release of an amount an order held back, written by
   * `releaseHeldAllotment`. Such a line carries the ORDER's number so it can
   * be traced to it, but it is not a line OF the order: the register shows it
   * on its own row, dated when it was released. See allotmentRegister.ts.
   */
  releasedFromHeld?: {
    allotmentId: Id;
    collections?: Centavos;
    estimate?: Centavos;
    reason?: string;
  };
}

// ---------------------------------------------------------------------------
// obligations/{id}   (Obligation Request and Status - OBR)
// ---------------------------------------------------------------------------

export interface ObligationLine extends BudgetKey {
  lineNo: number;
  officeName: string;
  /**
   * The object of expenditure being committed.
   *
   * Required here even when the appropriation was made by project and carries
   * none. This is the moment the object becomes known, and the JEV raised from
   * this obligation needs it: the account code says what kind of expense it
   * is, the FPP says which line of the budget it was charged to, and on a
   * project line those are not the same question.
   */
  accountName: string;
  fppName: string;
  /**
   * The object code the APPROPRIATION carries, which is empty on a project
   * line. Held separately from `accountCode` above - the object being
   * committed now - because the two differ on every project line, and the
   * budget balance is keyed on this one.
   */
  appropriatedAccountCode?: string;
  /**
   * The Trust Fund programme this line utilises.
   *
   * Present only in the Trust Fund, where there is no appropriation and no
   * allotment: the programme the money was received under is what the
   * commitment is checked against, and it takes the place of the FPP and the
   * budget key on a General Fund line.
   */
  trustProgramId?: Id;
  trustProgramName?: string;
  sector?: string;
  serviceSector?: string;
  expenseClass: ExpenseClass;
  programName?: string;
  projectName?: string;
  activityName?: string;
  amount: Centavos;
  particulars?: string;
}

export interface Obligation extends Partial<AuditStamps> {
  id: Id;
  obrNo: string;
  obrDate: IsoDate;
  fiscalYear: FiscalYear;
  fundCode: string;

  payeeId: Id;
  /** "Juan Dela Cruz, et al." when the request is for several payees (patch 138). */
  payeeName: string;
  payeeTin?: string;
  /** Patch 138: a group request. The list of payees is kept on the voucher. */
  severalPayees?: boolean;

  officeId: Id;
  officeName: string;
  responsibilityCenterId?: Id;

  particulars: string;
  lines: ObligationLine[];
  /** Sum of `lines[].amount`, recomputed and re-verified server-side. */
  totalAmount: Centavos;

  status: ObligationStatus;

  /**
   * Amounts consumed by downstream documents. Maintained only by Cloud
   * Functions so the registry can never drift from the vouchers.
   */
  /**
   * What approved VOUCHERS have drawn. The old name is kept; it is the
   * figure that stops two vouchers drawing the same money, not a
   * disbursement.
   */
  disbursedAmount: Centavos;
  /** totalAmount - disbursedAmount; what is still open to a voucher. */
  unpaidAmount: Centavos;
  /**
   * Patch 121: what checks and ADAs have paid. THIS is the disbursement -
   * the registry's Disbursements column is the obligations' paidAmount spread
   * over their lines. Absent on an obligation written before the patch until
   * the administrator runs the repair.
   */
  paidAmount?: Centavos;

  /**
   * Set when an authorised administrator deliberately obligated beyond the
   * available allotment. Recorded on the document itself, not only in the audit
   * log, so it is visible on the face of the OBR and on the SAOB.
   */
  override?: {
    by: ActorStamp;
    reason: string;
    availableAtOverride: Centavos;
    amountExceeded: Centavos;
  };

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
  remarks?: string;
  certifiedAt?: string;
  cancelledReason?: string;
}

// ---------------------------------------------------------------------------
// budgetBalances/{budgetKeyId}
// ---------------------------------------------------------------------------

/**
 * The running balance per budget line. Written exclusively by Cloud Functions
 * inside the same transaction that writes the appropriation, allotment or
 * obligation, so the four totals are always mutually consistent.
 *
 * This document is a *cache for control and display*. It is rebuildable at any
 * time by replaying the source documents, and a scheduled function verifies it
 * nightly. The source documents remain the record of truth.
 */
export interface BudgetBalance extends BudgetKey {
  id: Id;
  officeName: string;
  accountName: string;
  fppName: string;
  sector?: string;
  serviceSector?: string;
  expenseClass: ExpenseClass;

  appropriationOriginal: Centavos;
  appropriationSupplemental: Centavos;
  appropriationContinuing: Centavos;
  appropriationAdjustments: Centavos;
  /** Sum of all appropriation components. */
  appropriationRevised: Centavos;

  allotmentReleased: Centavos;
  /**
   * Appropriation held back from release. Not a reduction of the
   * appropriation — the Sanggunian's figure stands — but it is not available.
   */
  forLaterRelease: Centavos;
  /** appropriationRevised - forLaterRelease - allotmentReleased */
  availableAppropriation: Centavos;

  obligated: Centavos;
  /** allotmentReleased - obligated */
  availableAllotment: Centavos;

  disbursed: Centavos;
  /** obligated - disbursed */
  unpaidObligations: Centavos;

  updatedAt: string;
}

/** Rolled-up figures shown on the dashboard, one document per fund + year. */
export interface BudgetSummary {
  id: Id;
  fiscalYear: FiscalYear;
  fundCode: string;
  appropriationRevised: Centavos;
  allotmentReleased: Centavos;
  obligated: Centavos;
  disbursed: Centavos;
  availableAllotment: Centavos;
  /** obligated / appropriationRevised, 0-1. Computed, stored for speed. */
  utilizationRate: number;
  updatedAt: string;
}

/**
 * One line of the budget year's estimated receipts.
 *
 * LBP Form No. 1, "Budget of Expenditures and Sources of Financing", section
 * II. Certified by the Local Treasurer, the Local Budget Officer, the Local
 * Planning and Development Coordinator and the Local Accountant as "reasonably
 * projected as collectible for the Budget Year".
 *
 * Not an appropriation and not an authority to spend: an estimate of what will
 * come in. It is here rather than beside the appropriations because the
 * ordinance does not enact it - which is exactly why CFMS had no budget column
 * for receipts on any statement until this existed.
 */
export interface EstimatedReceipt {
  /** `{fiscalYear}__{fundCode}__{accountCode}` - one line per account. */
  id: Id;
  fiscalYear: FiscalYear;
  fundCode: string;
  accountCode: string;
  accountName: string;
  /** LBP Form No. 1's three-way split. Two statutory limits rest on it. */
  incomeClass: 'REGULAR' | 'NON_REGULAR' | 'NON_INCOME';
  q1: Centavos;
  q2: Centavos;
  q3: Centavos;
  q4: Centavos;
  /** q1 + q2 + q3 + q4. Stored so a list can be sorted and totalled without
   *  adding four fields on every row, and recomputed on every write. */
  annual: Centavos;
  /** The wording of LBP Form No. 1 where the account name is not the form's. */
  particulars?: string;
  /** What the figures were loaded from, where they came from a file. */
  sourceFile?: string;
  updatedAt: string;
  updatedBy?: { uid: Id; name: string };
}

/**
 * A Trust Fund programme.
 *
 * Money received for a stated purpose from a source that keeps the right to
 * ask for it back, with an approved work and financial plan. The programmed
 * amount is the ceiling a Funding Utilization Request is checked against — the
 * part the released allotment plays in the General Fund.
 *
 * Owned by the Accounting office rather than the Budget Office: there is no
 * ordinance behind it and nothing for the Budget Officer to release.
 *
 * Deliberately NOT keyed to a fiscal year. Trust money does not expire with
 * the budget year, and a programme that had to be re-entered every January
 * would end up recorded twice with two different balances.
 */
export interface TrustProgram {
  id: Id;
  programCode: string;
  programName: string;
  /** The agency or person the money came from. */
  sourceAgency: string;
  /** The MOA, deed or advice it arrived under. */
  reference: string;
  /**
   * The Revised Chart of Accounts code the trust liability sits in.
   *
   * GAM Appendix 18 heads the Registry of Special Trust Fund with "Account -
   * Code assigned in the RCA". Optional, and stated by the Accountant: a
   * programme's liability account is a classification decision, and nothing in
   * CFMS can derive it from the source agency or the purpose.
   */
  accountCode?: string;
  /** When the programme started, for sorting and reporting. Not a control. */
  startYear?: FiscalYear;

  /** The ceiling. Every utilisation is checked against it. */
  programmed: Centavos;
  /** What the source has remitted, as the Accountant states it. Kept beside
   *  the worked figure below rather than replaced by it: a programme usually
   *  exists before its collections do. Reported, never controlled on. */
  received: Centavos;
  /** The same thing worked out of the receipts: every Trust Fund collection
   *  line carrying this programme, summed by postRcd inside the transaction
   *  that posts the RCD. Nothing else writes it. */
  receivedPosted: Centavos;
  /** received - receivedPosted. Derived. */
  receiptDrift: Centavos;
  /** Committed by a certified FURS. Maintained only by Cloud Functions. */
  utilised: Centavos;
  /** Paid out on an approved voucher. Maintained only by Cloud Functions. */
  disbursed: Centavos;
  /** programmed - utilised */
  availableToUtilise: Centavos;
  /** utilised - disbursed */
  unpaidUtilisations: Centavos;

  status: 'ACTIVE' | 'CLOSED';
  notes?: string;
  updatedAt: string;
  updatedBy?: { uid: Id; name: string };
}
