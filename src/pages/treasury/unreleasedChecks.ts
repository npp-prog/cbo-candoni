import type { Centavos, IsoDate } from '@/types/common';

/**
 * The Schedule of Unreleased Checks.
 *
 * GAM for LGUs, Appendix 42.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR, WHICH IS NOT OBVIOUS FROM THE TITLE
 * ---------------------------------------------------------------------------
 * Instruction 1: "This report shall be prepared by the Treasurer for
 * submission to the Accounting Unit at the end of the year. A JV shall be
 * prepared to record the entry for the RESTORATION OF CASH equivalent to the
 * unreleased checks and recognition of the appropriate payable/liability
 * accounts."
 *
 * So this is not a list for the Treasurer's convenience. A check that has been
 * drawn and written into the books has already been taken out of cash; if it
 * was never handed to the payee, the money is still in the bank and the
 * liability is still owed. At year end that has to be put back, and this
 * schedule is the evidence for the journal voucher that does it.
 *
 * Which is why it is prepared PER BANK ACCOUNT - instruction 1 again, "This
 * report shall be prepared for each bank account which shall be the basis for
 * the preparation of JV". One JV per account, one sheet per JV.
 *
 * ---------------------------------------------------------------------------
 * "UNRELEASED AS AT A DATE" IS NOT THE SAME AS "UNRELEASED NOW"
 * ---------------------------------------------------------------------------
 * The obvious implementation - list the checks whose status is not RELEASED -
 * answers the wrong question. The report is dated, and it is often prepared
 * weeks after the date it covers. A check drawn in December and handed over in
 * January was unreleased ON 31 DECEMBER, and the JV that restores cash at
 * 31 December must include it.
 *
 * So a check counts when it was drawn on or before the date AND either it is
 * still sitting undrawn-on today, or it was released after the date. The
 * release date is recorded, so that second test can actually be made.
 *
 * ---------------------------------------------------------------------------
 * A CANCELLED CHECK IS NOT AUTOMATICALLY OFF THE SCHEDULE
 * ---------------------------------------------------------------------------
 * Patch 45 left out every cancelled, stale and replaced check, and said CBO
 * does not record WHEN a check was cancelled so the as-at test could not be
 * made. That was wrong, and it was wrong because the claim was never checked:
 * every cancellation writes a `cancelledBy` stamp carrying the moment it
 * happened.
 *
 * So the test can be made, and it matters. A check cancelled in February was
 * a live unreleased check on 31 December, and the journal voucher that
 * restores cash at 31 December has to include it. Leaving it out understated
 * the restoration by its face value.
 *
 * Staleness is the same question asked differently. `markStaleChecks` sweeps
 * checks that are PREPARED, SIGNED or RELEASED and past their validity, and
 * the status it writes overwrites what they were. What survives is
 * `dateReleased`: a stale check that carries none was never released, and its
 * money never left the bank. Going stale does not hand it to the payee, so it
 * belongs on the schedule exactly as an unsigned check does.
 *
 * ---------------------------------------------------------------------------
 * A REPLACED CHECK IS STILL LEFT OUT, AND FOR A REASON
 * ---------------------------------------------------------------------------
 * Not an omission. When a check is replaced, the replacement stands in its
 * place and is itself on this schedule if it is unreleased. Counting both
 * would restore the same money twice - the one error on this form that would
 * put a false figure straight into the general ledger through the year-end
 * journal voucher.
 */

/** Drawn, and not yet in the payee's hands. */
export const NOT_YET_RELEASED = new Set(['PREPARED', 'FOR_SIGNATURE', 'SIGNED']);

/** Released at some point: these count only if released AFTER the as-at date. */
export const RELEASED_STATUSES = new Set(['RELEASED', 'CLEARED']);

/**
 * Past its validity. Whether it belongs here is decided by `dateReleased`, not
 * by the status - going stale does not put a check in the payee's hands.
 */
export const STALE_STATUS = 'STALE';

export interface SucCheck {
  id: string;
  checkNo: string;
  checkDate: IsoDate;
  fundCode: string;
  bankAccountId: string;
  bankName: string;
  bankAccountNumber: string;
  dvId: string;
  dvNo: string;
  payeeName: string;
  particulars: string;
  netAmount: Centavos;
  status: string;
  dateReleased?: IsoDate;
  /**
   * The day the cancellation was recorded, from the `cancelledBy` stamp.
   * A check cancelled after the as-at date was live on that date.
   */
  cancelledAt?: IsoDate;
}

export interface SucRow {
  checkDate: IsoDate;
  checkNo: string;
  dvNo: string;
  /** The obligation the DV was charged to. See the note on the CAFOA below. */
  obrNo: string;
  payeeName: string;
  natureOfPayment: string;
  amount: Centavos;
  /**
   * True when the check has since been handed over, after the as-at date.
   *
   * It still belongs on the schedule - it was unreleased on the date - but a
   * reader looking at the register today would not find it there, and being
   * told why saves the query.
   */
  releasedLater: boolean;
  dateReleased?: IsoDate;
  /** Cancelled after the date, so live and unreleased on it. */
  cancelledLater: boolean;
  /** Past its validity and never released. The money is still in the bank. */
  staleUnreleased: boolean;
}

export interface SucSheet {
  bankAccountId: string;
  bankName: string;
  bankAccountNumber: string;
  fundCode: string;
  rows: SucRow[];
  total: Centavos;
}

export function buildUnreleasedChecks(input: {
  checks: SucCheck[];
  /** The date the schedule is struck at - usually 31 December. */
  asOf: IsoDate;
  /** DV id to obligation number, for the reference column. */
  obrByDv?: Record<string, string>;
  bankAccountId?: string | null;
}): SucSheet[] {
  const sheets = new Map<string, SucSheet>();

  for (const c of input.checks) {
    if (input.bankAccountId && c.bankAccountId !== input.bankAccountId) continue;
    // Not yet drawn at the date: it is not this schedule's business.
    if (c.checkDate > input.asOf) continue;

    // Never released, and still sitting in the Treasury.
    const stillUnreleased = NOT_YET_RELEASED.has(c.status);

    // Released, but not until after the date this schedule is struck at.
    const releasedLater =
      RELEASED_STATUSES.has(c.status) && !!c.dateReleased && c.dateReleased > input.asOf;

    // Cancelled since - but it was a live unreleased check on the date, unless
    // it had already been released by then. A cancellation with no recorded
    // moment is treated as already cancelled: that is the safe way round,
    // because the alternative restores cash the municipality may not hold.
    const cancelledLater =
      c.status === 'CANCELLED' &&
      !!c.cancelledAt &&
      c.cancelledAt > input.asOf &&
      (!c.dateReleased || c.dateReleased > input.asOf);

    // Stale, and never released at all. Going stale does not hand the check
    // over; the money is still in the bank.
    const staleUnreleased =
      c.status === STALE_STATUS && (!c.dateReleased || c.dateReleased > input.asOf);

    if (!stillUnreleased && !releasedLater && !cancelledLater && !staleUnreleased) continue;

    const sheet =
      sheets.get(c.bankAccountId) ??
      ({
        bankAccountId: c.bankAccountId,
        bankName: c.bankName,
        bankAccountNumber: c.bankAccountNumber,
        fundCode: c.fundCode,
        rows: [],
        total: 0,
      } satisfies SucSheet);

    sheet.rows.push({
      checkDate: c.checkDate,
      checkNo: c.checkNo,
      dvNo: c.dvNo,
      obrNo: input.obrByDv?.[c.dvId] ?? '',
      payeeName: c.payeeName,
      natureOfPayment: c.particulars,
      // The face value of the check, which is what the bank still holds and
      // what the journal voucher restores - never the gross of the voucher.
      amount: c.netAmount,
      releasedLater,
      dateReleased: c.dateReleased,
      cancelledLater,
      staleUnreleased,
    });
    sheet.total += c.netAmount;
    sheets.set(c.bankAccountId, sheet);
  }

  return [...sheets.values()]
    .map((s) => ({
      ...s,
      rows: [...s.rows].sort(
        (a, b) => a.checkDate.localeCompare(b.checkDate) || a.checkNo.localeCompare(b.checkNo),
      ),
    }))
    .sort(
      (a, b) =>
        a.bankName.localeCompare(b.bankName) ||
        a.bankAccountNumber.localeCompare(b.bankAccountNumber),
    );
}

/** Every sheet's total: the amount of cash the year-end journal voucher restores. */
export function totalUnreleased(sheets: SucSheet[]): Centavos {
  return sheets.reduce((s, sheet) => s + sheet.total, 0);
}
