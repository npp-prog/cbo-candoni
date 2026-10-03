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
 * Approved, and nothing drawn against it yet.
 *
 * A voucher that already has a check or an advice is NOT shown. It has been
 * paid once; offering it again is offering to pay it twice, and the server
 * would refuse but the Treasurer should never be put in front of the button.
 */
export function awaitingPayment<T extends PayableVoucher>(vouchers: T[]): T[] {
  return vouchers
    .filter((v) => v.status === 'APPROVED')
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
