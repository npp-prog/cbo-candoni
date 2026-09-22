/**
 * CBO shared primitives.
 *
 * MONEY REPRESENTATION
 * --------------------
 * Every monetary value in CBO is stored as an integer number of centavos
 * (`Centavos`), never as a floating-point peso amount. ₱1,234,567.89 is stored
 * as 123456789. This is not stylistic: IEEE-754 doubles cannot represent 0.1
 * exactly, so a trial balance built from float pesos will eventually fail to
 * foot by a centavo and an auditor will (correctly) reject it. Conversion to a
 * display string happens only at the edge, in `formatPeso`.
 */

/** An integer number of centavos. 100 centavos = ₱1.00. */
export type Centavos = number;

/** ISO-8601 calendar date, `YYYY-MM-DD`, in Philippine local time. */
export type IsoDate = string;

/** ISO-8601 instant with timezone, e.g. `2026-09-21T09:15:00+08:00`. */
export type IsoTimestamp = string;

/** Firestore document id. */
export type Id = string;

/** Fiscal year as a four-digit number, e.g. 2026. */
export type FiscalYear = number;

/** Accounting period, 1-12 for January-December; 13 is reserved for adjusting. */
export type PeriodNo = number;

/**
 * Who performed an action. Denormalised deliberately: an audit record must
 * still read correctly in ten years even if the user document is later renamed
 * or the employee has left the municipality.
 */
export interface ActorStamp {
  uid: Id;
  name: string;
  position?: string;
  at: IsoTimestamp;
}

/** Standard bookkeeping fields carried by every transaction document. */
export interface AuditStamps {
  createdBy: ActorStamp;
  updatedBy?: ActorStamp;
  submittedBy?: ActorStamp;
  reviewedBy?: ActorStamp;
  certifiedBy?: ActorStamp;
  approvedBy?: ActorStamp;
  postedBy?: ActorStamp;
  cancelledBy?: ActorStamp;
}

/**
 * CBO never hard-deletes a financial record. A document is either cancelled
 * (a business act, with reason and audit trail) or, for master data only,
 * soft-deleted by setting `active: false`.
 */
export interface SoftDeletable {
  active: boolean;
  deactivatedBy?: ActorStamp;
  deactivationReason?: string;
}

export interface PagedResult<T> {
  rows: T[];
  hasMore: boolean;
  cursor?: string;
}

/** Result shape returned by every Cloud Function callable in CBO. */
export interface EngineResult<T = unknown> {
  ok: true;
  data: T;
}

export interface EngineError {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
}
