import type { ActorStamp, Centavos, Id, IsoDate, IsoTimestamp } from './common';

/**
 * Primary reports: the Liquidating Officer's and the Treasurer's own layer.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO LEVELS AT ALL
 * ---------------------------------------------------------------------------
 * Six collectors take money in a day. Each of them is personally accountable
 * for the receipts they issued, so each files their own Report of Collections
 * and Deposits - in this system that is the RCD you already have, and it is the
 * SECONDARY. But the municipality does not have six cash positions; it has one.
 * Somebody has to receive those six remittances, account for the lot, and put
 * the money in the bank.
 *
 * That is the PRIMARY. It gathers secondaries, it is signed by the Liquidating
 * Officer or the Treasurer rather than by a collector, and it is the document
 * the cash register moves on.
 *
 * ---------------------------------------------------------------------------
 * WHAT CLOSING MEANS
 * ---------------------------------------------------------------------------
 * A primary is OPEN while collectors are still remitting into it, and CLOSED
 * when the officer signs for the total. Closing is the event that matters:
 * it draws the report number, freezes the secondaries it covers so none can be
 * quietly altered afterwards, and - once the Cash in Local Treasury register
 * exists - is what posts the day's line to it.
 *
 * Reopening is possible and is recorded with a reason and a count, because a
 * report that has been reopened four times is telling an auditor something
 * about the office that the current figures cannot.
 * ---------------------------------------------------------------------------
 */

export const PRIMARY_REPORT_TYPES = ['COLLECTION', 'CONSOLIDATED', 'DEPOSIT'] as const;
export type PrimaryReportType = (typeof PRIMARY_REPORT_TYPES)[number];

export const PRIMARY_REPORT_TYPE_LABELS: Record<PrimaryReportType, string> = {
  COLLECTION: 'Collection',
  CONSOLIDATED: 'Consolidated Collection',
  DEPOSIT: 'Deposit',
};

export const PRIMARY_REPORT_TYPE_HINTS: Record<PrimaryReportType, string> = {
  COLLECTION:
    'One collecting officer’s remittances for the day, received by the Liquidating Officer.',
  CONSOLIDATED:
    'Several collectors’ reports gathered into one. The collectors appear in Section A.2.',
  DEPOSIT:
    'Money banked. It names the collection reports it liquidates, and is reconciled against their total.',
};

export const PRIMARY_REPORT_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'] as const;
export type PrimaryReportStatus = (typeof PRIMARY_REPORT_STATUSES)[number];

/** One check making up a deposit. */
export interface DepositCheck {
  checkNo: string;
  payor: string;
  amount: Centavos;
}

/** One online or fund-transfer receipt making up a deposit. */
export interface DepositOnline {
  referenceNo: string;
  particulars: string;
  amount: Centavos;
}

/**
 * How a deposit was made up.
 *
 * Kept as three tenders rather than one figure because the bank credits them
 * on different days: cash the same day, a check when it clears, a transfer when
 * it lands. Reconciliation has to be able to match them separately.
 */
export interface PrimaryDepositDetail {
  bankAccountId: Id;
  bankName: string;
  bankAccountNumber: string;
  cash: Centavos;
  checks: DepositCheck[];
  online: DepositOnline[];
  /** cash + checks + online. */
  total: Centavos;
}

export interface PrimaryReport {
  id: Id;
  fiscalYear: number;
  fundCode: string;

  /** Drawn on closing, not before: a draft must not consume a number. */
  primaryNo?: string;
  reportDate: IsoDate;
  reportType: PrimaryReportType;

  /** The Liquidating Officer, or the Treasurer on a deposit. */
  accountableOfficerId: Id;
  accountableOfficerName: string;
  accountableOfficerPosition?: string;

  /** The secondary RCDs this report gathers. Empty on a deposit. */
  rcdIds: Id[];
  /**
   * For a deposit: the collection primaries this deposit liquidates. Naming
   * them is what allows the over/short check, and what stops one day's
   * collections being claimed by two different deposits.
   */
  coveredPrimaryIds: Id[];

  /** Collections gathered, or cash banked. */
  totalAmount: Centavos;
  deposit?: PrimaryDepositDetail;

  status: PrimaryReportStatus;
  closedBy?: ActorStamp;
  reopenedCount?: number;
  lastReopenReason?: string;
  cancelledBy?: ActorStamp;
  cancelReason?: string;

  remarks?: string;
  createdBy: ActorStamp;
  createdAt: IsoTimestamp;
}

/**
 * How a deposit stands against the reports it claims to liquidate.
 *
 * A difference is not an error - a deposit may deliberately cover part of a
 * day, and a collector may remit late - but it is always worth saying out
 * loud, because the one case that matters looks exactly like the innocent ones
 * until somebody adds it up.
 */
export interface DepositReconciliation {
  depositTotal: Centavos;
  coveredTotal: Centavos;
  difference: Centavos;
  verdict: 'RECONCILED' | 'OVER' | 'SHORT' | 'EMPTY';
  message: string;
}

export function reconcileDeposit(
  depositTotal: Centavos,
  coveredTotal: Centavos,
): DepositReconciliation {
  const difference = depositTotal - coveredTotal;
  if (depositTotal === 0) {
    return {
      depositTotal,
      coveredTotal,
      difference,
      verdict: 'EMPTY',
      message: 'Enter the cash, checks or online receipts that make up this deposit.',
    };
  }
  if (difference === 0) {
    return {
      depositTotal,
      coveredTotal,
      difference,
      verdict: 'RECONCILED',
      message: 'The deposit matches the collection reports it covers, exactly.',
    };
  }
  return {
    depositTotal,
    coveredTotal,
    difference,
    verdict: difference > 0 ? 'OVER' : 'SHORT',
    message:
      difference > 0
        ? 'The deposit is larger than the reports it covers. Either a report is missing from the list, or money from another day is in this deposit.'
        : 'The reports it covers are larger than the deposit. Some of the collections have not been banked.',
  };
}
