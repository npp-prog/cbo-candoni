import type {
  ActorStamp,
  AuditStamps,
  Centavos,
  FiscalYear,
  Id,
  IsoDate,
} from './common';
import type { ExpenseClass, ObligationStatus } from './enums';

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
    k.accountCode,
  ].join('__');
}

// ---------------------------------------------------------------------------
// appropriations/{id}
// ---------------------------------------------------------------------------

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
  accountName: string;
  programName?: string;
  projectName?: string;
  activityName?: string;
  expenseClass: ExpenseClass;

  kind: AppropriationKind;
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
// allotments/{id}
// ---------------------------------------------------------------------------

export interface Allotment extends BudgetKey, Partial<AuditStamps> {
  id: Id;
  allotmentNo: string;
  allotmentDate: IsoDate;
  officeName: string;
  accountName: string;
  expenseClass: ExpenseClass;
  /** Positive for a release, negative for a withdrawal of allotment. */
  amount: Centavos;
  particulars?: string;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  postedAt?: string;
}

// ---------------------------------------------------------------------------
// obligations/{id}   (Obligation Request and Status - OBR)
// ---------------------------------------------------------------------------

export interface ObligationLine extends BudgetKey {
  lineNo: number;
  officeName: string;
  accountName: string;
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
  payeeName: string;
  payeeTin?: string;

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
  disbursedAmount: Centavos;
  /** totalAmount - disbursedAmount; an unpaid obligation balance. */
  unpaidAmount: Centavos;

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
  expenseClass: ExpenseClass;

  appropriationOriginal: Centavos;
  appropriationSupplemental: Centavos;
  appropriationContinuing: Centavos;
  appropriationAdjustments: Centavos;
  /** Sum of all appropriation components. */
  appropriationRevised: Centavos;

  allotmentReleased: Centavos;
  /** appropriationRevised - allotmentReleased */
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
