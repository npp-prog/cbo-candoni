/**
 * Patch 152 - an Accounts Payable carried forward is an UNPAID VOUCHER.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * On conversion, every payable in the opening balances is a voucher the old
 * system approved and nobody has paid yet. The opening entry puts it in the
 * books - Cr Accounts Payable, the payee as subsidiary - but until now there
 * was no way to PAY it in CFMS: a check or an ADA is drawn against a voucher,
 * and the old voucher was not in CFMS.
 *
 * So each Accounts Payable line of the opening balances becomes a voucher in
 * Treasury's payment queue (Disbursements for Payment), approved and ready:
 *
 *   - its number is the old voucher's number (the line's Reference, "DV "
 *     dropped), or OB-<fund>-<year>-<n> where the line gave none;
 *   - dated the day it arose (Outstanding since), else the conversion date;
 *   - payee, particulars and amount from the line;
 *   - NO obligation and NO expense lines: the expense and the obligation were
 *     recorded in the year the voucher was approved. Paying it now only
 *     settles the payable - the RCI / RADAI books Dr Accounts Payable (the
 *     payee) / Cr Cash in Bank, and no budget line moves.
 *
 * The vouchers are the engine's: created with the opening entry, deleted if
 * the opening balances are re-opened - and re-opening is refused once any of
 * them has been paid, since a check drawn on it would then pay a payable the
 * books no longer have.
 */

export interface OpeningPayableLine {
  accountCode: string;
  credit: number;
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
  referenceNo?: string | null;
  agingDate?: string | null;
  particulars?: string | null;
}

export interface OpeningPayableVoucher {
  /** Firestore id - fixed, so a re-open finds every one of them. */
  id: string;
  dvNo: string;
  dvDate: string;
  payeeId: string | null;
  payeeName: string;
  particulars: string;
  amount: number;
}

/** "DV 2025-08-0123" -> "2025-08-0123"; blank -> null. */
export function voucherNumberFrom(referenceNo: string | null | undefined): string | null {
  const s = String(referenceNo ?? '')
    .trim()
    .replace(/^D\.?\s*V\.?\s*(No\.?)?\s*[:#-]?\s*/i, '')
    .trim();
  return s || null;
}

export function openingPayableVouchers(
  lines: OpeningPayableLine[],
  ctx: { payableAccountCode: string; fiscalYear: number; fundCode: string; asOfDate: string },
): OpeningPayableVoucher[] {
  const out: OpeningPayableVoucher[] = [];
  let n = 0;
  for (const l of lines) {
    if (l.accountCode !== ctx.payableAccountCode) continue;
    if (!(l.credit > 0)) continue;
    n += 1;
    const seq = String(n).padStart(4, '0');
    const dvNo = voucherNumberFrom(l.referenceNo) ?? `OB-${ctx.fundCode}-${ctx.fiscalYear}-${seq}`;
    const payeeName = String(l.subsidiaryName ?? '').trim() || 'Payee not named';
    const particulars =
      String(l.particulars ?? '').trim() ||
      `Accounts payable carried forward as at ${ctx.asOfDate}${l.referenceNo ? ` - ${l.referenceNo}` : ''}`;
    out.push({
      id: `OB__${ctx.fiscalYear}__${ctx.fundCode}__${seq}`,
      dvNo,
      dvDate: l.agingDate?.trim() || ctx.asOfDate,
      payeeId: l.subsidiaryType === 'PAYEE' && l.subsidiaryId ? l.subsidiaryId : null,
      payeeName,
      particulars,
      amount: l.credit,
    });
  }
  return out;
}
