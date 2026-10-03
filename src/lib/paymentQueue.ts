import type { Centavos, Id, IsoDate } from '@/types/common';

/**
 * Which approved vouchers are waiting for the Treasurer, and in what order.
 *
 * ---------------------------------------------------------------------------
 * WHY A VOUCHER IS PAID FROM TREASURY AND NOT FROM ACCOUNTING
 * ---------------------------------------------------------------------------
 * The Accountant approves a voucher. The Treasurer pays it. Those are two
 * officers and two acts, and the second is the one that moves money out of the
 * municipality.
 *
 * CFMS used to offer Issue check and Prepare ADA on the Accounting voucher
 * screen, which put the act of drawing a check in the hands of whoever had the
 * voucher open. That is not a small interface convenience: it is the point in
 * the chain where the segregation between approving a payment and making one
 * stops being visible. The buttons are gone from Accounting. An approved
 * voucher now appears here, in Treasury, and is paid from here.
 */
export interface PayableVoucher {
  id: Id;
  dvNo: string;
  dvDate: IsoDate;
  payeeName: string;
  particulars: string;
  netAmount: Centavos;
  status: string;
  /** Set once a check has been drawn against it. */
  checkId?: Id | null;
  /** Set once an advice has been prepared against it. */
  adaId?: Id | null;
}

/**
 * Statuses a voucher can be in and still be owed to somebody.
 *
 * APPROVED is the ordinary one. PAID is here for a voucher whose record says
 * it is paid while carrying neither a check nor an advice - which, under the
 * rules CFMS enforces now, cannot happen: a voucher is set to PAID by the act
 * of drawing the instrument, in the same transaction.
 *
 * It could happen before. Posting the journal entry used to set the voucher to
 * PAID, so an entry posted by the Accountant took the voucher out of this
 * queue with nothing drawn against it, and the Treasurer simply could not see
 * a voucher nobody had paid. Those vouchers are still in the database, and the
 * queue has to show them or they are owed to a supplier and invisible.
 */
const UNPAID_STATUSES = new Set<string>(['APPROVED', 'PAID']);

/**
 * Owed, and nothing drawn against it yet.
 *
 * A voucher that already has a check or an advice is NOT shown. It has been
 * paid once; offering it again is offering to pay it twice, and the server
 * would refuse but the Treasurer should never be put in front of the button.
 *
 * Note what is NOT a condition: whether the journal entry has been posted.
 * Posting writes the books and paying moves the money; they are two officers'
 * acts and neither waits for the other.
 */
export function awaitingPayment<T extends PayableVoucher>(vouchers: T[]): T[] {
  return vouchers
    .filter((v) => UNPAID_STATUSES.has(v.status))
    .filter((v) => !v.checkId && !v.adaId)
    .slice()
    .sort(byOldestFirst);
}

/**
 * Oldest first, because the queue is a queue.
 *
 * A supplier waiting since the fifth should be paid before one approved this
 * morning, and a list that shows the newest first quietly inverts that every
 * time somebody works from the top.
 */
function byOldestFirst(a: PayableVoucher, b: PayableVoucher): number {
  if (a.dvDate !== b.dvDate) return a.dvDate < b.dvDate ? -1 : 1;
  // Same day: by voucher number, which is the order they were encoded in.
  return a.dvNo < b.dvNo ? -1 : a.dvNo > b.dvNo ? 1 : 0;
}

/** What the Treasurer owes, in total, on the vouchers in hand. */
export function totalAwaiting(vouchers: PayableVoucher[]): Centavos {
  return vouchers.reduce((sum, v) => sum + (v.netAmount ?? 0), 0);
}

/**
 * How long a voucher has been waiting, in days.
 *
 * Shown rather than computed into a rule. Nothing in CFMS refuses or escalates
 * on the strength of it - it is there so that a voucher sitting for three
 * weeks is visible as such on the screen the Treasurer actually works from.
 */
export function daysWaiting(dvDate: IsoDate, today: IsoDate): number {
  const from = Date.parse(`${dvDate}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}
