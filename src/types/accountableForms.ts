import type { ActorStamp, Id, IsoDate, IsoTimestamp } from './common';

/**
 * Accountable forms: custody of the municipality's numbered paper.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING TRACKED, AND WHY IT IS NOT INVENTORY
 * ---------------------------------------------------------------------------
 * An unused Official Receipt has no value in the books. The moment an officer
 * writes on it, it becomes evidence that the municipality received money, and
 * from then on its absence is a question the officer has to answer. That is
 * why accountable forms are not carried as supplies: what is audited is not how
 * many the office has but WHICH SERIALS each officer holds, and a quantity that
 * agrees while the serials do not is exactly the shape of a missing booklet.
 *
 * So every record here is a movement of a SERIAL RANGE between custodies, and
 * every balance is derived by subtracting those ranges rather than kept as a
 * number that could be corrected by hand.
 *
 * ---------------------------------------------------------------------------
 * THE TWO KINDS OF ACCOUNTABLE OFFICER
 * ---------------------------------------------------------------------------
 * The Treasurer receives forms from the Bureau of Treasury and issues them to
 * collecting officers. A collecting officer receives them from the Treasurer
 * and issues them to payors. The COA form is the same in both cases, and the
 * only difference is what the word "issued" means - so the report carries a
 * `basis` saying which of the two it is, and the engine reads a different
 * source for the issued column accordingly.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// accountableFormTypes/{code}
// ---------------------------------------------------------------------------

/**
 * A kind of accountable form, as master data.
 *
 * The booklet size belongs here rather than in a constant because the cash
 * ticket is not bound in fifties and the report has to break its ranges where
 * the paper actually breaks.
 */
export interface AccountableFormType {
  id: Id;
  /** Short code used everywhere else, e.g. "AF51". */
  code: string;
  /** Full name, e.g. "Accountable Form No. 51 - Official Receipt". */
  name: string;
  /** How the form is named on a printed COA report, e.g. "ACCT. FORM NO. 51". */
  printedAs: string;
  /** Serials per booklet. 50 for the Official Receipt. */
  bookletSize: number;
  /** The width serials are written at, so computed ones pad to match. */
  serialLength: number;
  /**
   * Set for forms that carry a face value, such as the cash ticket, where the
   * officer is accountable for money as well as paper. Held in centavos.
   */
  unitValue?: number;
  active: boolean;
  sortOrder?: number;
}

// ---------------------------------------------------------------------------
// accountableFormMovements/{id}
// ---------------------------------------------------------------------------

export const FORM_MOVEMENT_KINDS = [
  'RECEIPT',
  'ISSUE',
  'RETURN',
  'SPOILED',
  'CANCELLED',
] as const;
export type FormMovementKind = (typeof FORM_MOVEMENT_KINDS)[number];

export const FORM_MOVEMENT_LABELS: Record<FormMovementKind, string> = {
  RECEIPT: 'Received into stock',
  ISSUE: 'Issued to an officer',
  RETURN: 'Returned to stock',
  SPOILED: 'Spoiled',
  CANCELLED: 'Cancelled',
};

/**
 * One movement of a serial range.
 *
 * `custodianId` is who holds the forms AFTER the movement: the stock itself for
 * a receipt or a return, the receiving officer for an issue, nobody for a
 * spoiled or cancelled range. Reading the movements for a form and folding them
 * in date order reconstructs every officer's custody at any date, which is what
 * makes a RAAF for a past month reproducible rather than a snapshot that has to
 * be trusted.
 */
export interface AccountableFormMovement {
  id: Id;
  fiscalYear: number;
  formCode: string;
  formName: string;
  kind: FormMovementKind;
  movementDate: IsoDate;

  serialFrom: string;
  serialTo: string;
  quantity: number;

  /** Who holds the range after this movement. Null when it leaves custody. */
  custodianId: Id | null;
  custodianName: string | null;
  /** Who held it before, on an issue, a return or a transfer. */
  fromCustodianId?: Id | null;
  fromCustodianName?: string | null;

  /** Requisition or delivery reference for a receipt. */
  sourceRef?: string;
  /** Face value per form, copied from the type at the time of the movement. */
  unitValue?: number;
  totalValue?: number;

  remarks?: string;
  createdBy: ActorStamp;
  createdAt: IsoTimestamp;
  /** A movement is never deleted; a wrong one is voided and re-entered. */
  voided?: boolean;
  voidReason?: string;
}

// ---------------------------------------------------------------------------
// raafReports/{id}
// ---------------------------------------------------------------------------

export const RAAF_STATUSES = ['DRAFT', 'CERTIFIED', 'CANCELLED'] as const;
export type RaafStatus = (typeof RAAF_STATUSES)[number];

export const RAAF_BASES = ['CUSTODIAN', 'COLLECTING_OFFICER'] as const;
/**
 * Which meaning of "issued" this report uses.
 *
 * CUSTODIAN - the Treasurer's own report: issued means handed to a collecting
 * officer, and is read from the movement ledger.
 *
 * COLLECTING_OFFICER - a collector's report: issued means written out to a
 * payor, and is read from the receipts actually encoded in Collections. This is
 * the one that ties the paper to the money, because the same serials appear on
 * the RCD and in the revenue accounts.
 */
export type RaafBasis = (typeof RAAF_BASES)[number];

export interface RaafSerialRange {
  from: string;
  to: string;
  qty: number;
}

export interface RaafLine {
  formCode: string;
  formName: string;
  printedAs: string;
  unitValue?: number;

  beginningQty: number;
  beginningRanges: RaafSerialRange[];
  receiptQty: number;
  receiptRanges: RaafSerialRange[];
  issuedQty: number;
  issuedRanges: RaafSerialRange[];
  withdrawnQty: number;
  withdrawnRanges: RaafSerialRange[];
  endingQty: number;
  endingRanges: RaafSerialRange[];

  /** Set when the line does not foot. The report cannot be certified with one. */
  discrepancy?: string | null;
  /** Serials issued twice, and holes in the run, for the officer to explain. */
  duplicates?: Array<{ serial: string; times: number }>;
  gaps?: Array<{ after: string; before: string; missing: number }>;
}

/**
 * Report of Accountability for Accountable Forms.
 *
 * One officer, one month. It is prepared by the engine rather than typed: every
 * figure on it is derived from the movement ledger and, for a collecting
 * officer, from the receipts encoded in Collections. An officer cannot file a
 * RAAF that disagrees with the receipts they issued, which is the entire point.
 */
export interface Raaf {
  id: Id;
  fiscalYear: number;
  /** Drawn on certification, not before. */
  raafNo?: string;
  basis: RaafBasis;

  officerId: Id;
  officerName: string;
  officerPosition?: string;
  officeId?: Id;
  officeName?: string;

  /** The month reported, as a date range so a partial period is possible. */
  periodFrom: IsoDate;
  periodTo: IsoDate;
  periodLabel: string;

  status: RaafStatus;
  lines: RaafLine[];

  /** Set when any line does not foot; blocks certification. */
  hasDiscrepancy: boolean;

  preparedBy: ActorStamp;
  certifiedBy?: ActorStamp;
  cancelledBy?: ActorStamp;
  cancelReason?: string;
  remarks?: string;
  createdAt: IsoTimestamp;
}
