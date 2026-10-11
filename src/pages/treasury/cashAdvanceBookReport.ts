import type { Centavos, IsoDate } from '@/types/common';

/**
 * Cash Book - Cash Advances.
 *
 * GAM for LGUs, Appendix 26. "This record shall be maintained by the local
 * treasurer or disbursing officers performing disbursement functions thru cash
 * advances."
 *
 * One book per disbursing officer, and the column that matters is the last
 * one. Instruction 9: "Balance - the difference between the Debit and Credit
 * columns WHICH SHALL BE EQUAL TO THE AMOUNT OF CASH IN HAND of Disbursing
 * Officers."
 *
 * ---------------------------------------------------------------------------
 * PATCH 177: ONLY THE ADVANCES FOR PAYROLL AND THE RCDisb
 * ---------------------------------------------------------------------------
 * The cash a disbursing officer holds in Candoni is the Advance for Payroll,
 * and what he pays out of it is reported on the Report of Cash Disbursements.
 * So the book is made of exactly those two movements:
 *
 *   Debit   an Advance for Payroll - a voucher, approved or paid, that debits
 *           Advances for Payroll (10305020). The amount is that debit; the
 *           officer is the subsidiary on the line, else the voucher's payee.
 *           Ref. is the check (or ADA) that paid it, per instruction 6, and
 *           the voucher number only where none is on file.
 *   Credit  each payroll on a certified (or journalized) RCDisb, at its net,
 *           dated the RCDisb, referenced "RCDisb no. / payroll no.". The
 *           officer is the one whose advance the payroll was paid from.
 *
 * Patch 179: an advance granted in an earlier year and still outstanding comes
 * in through the opening balances (an OPENING debit to Advances for Payroll,
 * passed in as a voucher "OB:<ledger id>" - see openingPayrollAdvances). It is
 * dated when it was granted, so it reaches the book as part of the balance
 * brought forward, and the payrolls and refunds against it are credited to the
 * same officer.
 *
 * Patch 178: and the unused part of an advance handed back on an Official
 * Receipt (a collection marked as the refund of a payroll) - a credit, dated
 * the receipt, referenced "OR <no>", for the officer whose advance it was.
 *
 * Nothing else - the old cash advances register and the liquidation reports -
 * is read.
 */

export const ADVANCE_GRANTED = new Set(['APPROVED', 'PAID']);
export const RCDISB_REPORTED = new Set(['CERTIFIED', 'JOURNALIZED']);

export interface CbcaVoucher {
  id: string;
  dvNo: string;
  dvDate: IsoDate;
  status: string;
  fundCode: string;
  particulars?: string | null;
  payeeId?: string | null;
  payeeName?: string | null;
  accountLines?: Array<{
    accountCode: string;
    debit: number;
    credit: number;
    subsidiaryId?: string | null;
    subsidiaryName?: string | null;
  }> | null;
}

/** Just enough of a check or an ADA to date and reference a debit. */
export interface CbcaPayment {
  dvId: string;
  no: string;
  date?: IsoDate | null;
  status?: string;
}

export interface CbcaPayroll {
  id: string;
  payrollNo: string;
  dvId?: string | null;
  particulars?: string | null;
  disbursingOfficer?: { id: string; name: string } | null;
}

export interface CbcaRcdisb {
  id: string;
  reportNo?: string | null;
  reportDate: IsoDate;
  status: string;
  fundCode: string;
  accountableOfficerId?: string | null;
  accountableOfficerName?: string | null;
  lines: Array<{
    sourceId: string;
    sourceNo: string;
    amount: number;
    particulars?: string | null;
    excluded?: boolean;
  }>;
}

/** Patch 178: an Official Receipt for the unused part of an advance for payroll. */
export interface CbcaRefund {
  id: string;
  orNumber: string;
  orDate: IsoDate;
  status: string;
  fundCode: string;
  totalAmount: number;
  refundForPayrollId?: string | null;
  refundForPayrollNo?: string | null;
}

export interface CbcaEntry {
  date: IsoDate;
  particulars: string;
  reference: string;
  debit: Centavos;
  credit: Centavos;
  /** The running balance after this line: cash that should be in hand. */
  balance: Centavos;
}

export interface CbcaBook {
  officerId: string;
  officerName: string;
  fundCode: string;
  /** Carried forward as the opening balance, per instruction 5. */
  broughtForward: Centavos;
  entries: CbcaEntry[];
  totalDebit: Centavos;
  totalCredit: Centavos;
  /** broughtForward + debits - credits: the cash in hand at the closing date. */
  closingBalance: Centavos;
}

interface Movement {
  date: IsoDate;
  particulars: string;
  reference: string;
  debit: Centavos;
  credit: Centavos;
}

function officerOfVoucher(
  v: CbcaVoucher,
  line: { subsidiaryId?: string | null; subsidiaryName?: string | null },
): { id: string; name: string } | null {
  if (line.subsidiaryId && line.subsidiaryName)
    return { id: line.subsidiaryId, name: line.subsidiaryName };
  if (v.payeeId && v.payeeName) return { id: v.payeeId, name: v.payeeName };
  return null;
}

export function buildCashAdvanceBook(input: {
  vouchers: CbcaVoucher[];
  payments?: CbcaPayment[];
  payrolls: CbcaPayroll[];
  rcdisbs: CbcaRcdisb[];
  /** Patch 178: collections that refund an unused advance (refundForPayrollId). */
  refunds?: CbcaRefund[];
  advanceAccountCode: string;
  from: IsoDate;
  to: IsoDate;
  officerId?: string | null;
  fundCode?: string | null;
}): CbcaBook[] {
  // The payment that released each voucher's money. A cancelled check is no payment.
  const paymentByDv = new Map<string, CbcaPayment>();
  for (const p of input.payments ?? []) {
    if (p.status === 'CANCELLED') continue;
    if (!paymentByDv.has(p.dvId)) paymentByDv.set(p.dvId, p);
  }

  const movements = new Map<string, Movement[]>();
  const who = new Map<string, { officerId: string; officerName: string; fundCode: string }>();
  const officerByDv = new Map<string, { id: string; name: string }>();

  const key = (officerId: string, fundCode: string) => `${officerId}__${fundCode}`;
  const wanted = (officerId: string, fundCode: string) =>
    (!input.officerId || officerId === input.officerId) &&
    (!input.fundCode || fundCode === input.fundCode);
  const push = (officer: { id: string; name: string }, fundCode: string, m: Movement) => {
    if (!wanted(officer.id, fundCode)) return;
    const k = key(officer.id, fundCode);
    if (!who.has(k)) who.set(k, { officerId: officer.id, officerName: officer.name, fundCode });
    const list = movements.get(k) ?? [];
    list.push(m);
    movements.set(k, list);
  };

  // ---- Debits: the Advances for Payroll -----------------------------------
  for (const v of input.vouchers) {
    if (!ADVANCE_GRANTED.has(v.status)) continue;
    const lines = (v.accountLines ?? []).filter(
      (l) => l.accountCode === input.advanceAccountCode && (l.debit || 0) > 0,
    );
    if (lines.length === 0) continue;
    const officer = officerOfVoucher(v, lines[0]);
    if (!officer) continue;
    officerByDv.set(v.id, officer);
    const paid = paymentByDv.get(v.id);
    const particulars = String(v.particulars ?? '').trim();
    push(officer, v.fundCode, {
      date: (paid?.date as IsoDate | undefined) || v.dvDate,
      particulars: particulars ? `Advance for payroll: ${particulars}` : 'Advance for payroll',
      // Patch 179: an advance carried in the opening balances has no voucher.
      reference: paid?.no || (v.id.startsWith('OB:') ? v.dvNo : `DV ${v.dvNo}`),
      debit: lines.reduce((s, l) => s + l.debit, 0),
      credit: 0,
    });
  }

  // ---- Credits: the payrolls on a certified RCDisb ------------------------
  const payrollById = new Map(input.payrolls.map((p) => [p.id, p]));
  for (const r of input.rcdisbs) {
    if (!RCDISB_REPORTED.has(r.status)) continue;
    for (const l of r.lines ?? []) {
      if (l.excluded || !l.amount) continue;
      const p = payrollById.get(l.sourceId);
      const officer =
        (p?.dvId ? officerByDv.get(p.dvId) : undefined) ??
        (p?.disbursingOfficer?.id
          ? { id: p.disbursingOfficer.id, name: p.disbursingOfficer.name }
          : undefined) ??
        (r.accountableOfficerId
          ? { id: r.accountableOfficerId, name: r.accountableOfficerName ?? r.accountableOfficerId }
          : undefined);
      if (!officer) continue;
      const particulars = String(p?.particulars ?? l.particulars ?? '').trim();
      push(officer, r.fundCode, {
        date: r.reportDate,
        particulars: particulars || `Payroll ${l.sourceNo}`,
        reference: `RCDisb ${r.reportNo ?? ''} / ${p?.payrollNo ?? l.sourceNo}`.replace('  ', ' '),
        debit: 0,
        credit: l.amount,
      });
    }
  }

  // ---- Credits: the unused advance handed back on an OR (patch 178) -----
  for (const c of input.refunds ?? []) {
    if (!c.refundForPayrollId || c.status === 'CANCELLED' || !c.totalAmount) continue;
    const p = payrollById.get(c.refundForPayrollId);
    const officer =
      (p?.dvId ? officerByDv.get(p.dvId) : undefined) ??
      (p?.disbursingOfficer?.id
        ? { id: p.disbursingOfficer.id, name: p.disbursingOfficer.name }
        : undefined);
    if (!officer) continue;
    push(officer, c.fundCode, {
      date: c.orDate,
      particulars:
        `Refund of unused advance - payroll ${p?.payrollNo ?? c.refundForPayrollNo ?? ''}`.trim(),
      reference: `OR ${c.orNumber}`,
      debit: 0,
      credit: c.totalAmount,
    });
  }

  const books: CbcaBook[] = [];
  for (const [k, list] of movements) {
    const w = who.get(k)!;
    let broughtForward = 0;
    const inPeriod: Movement[] = [];
    for (const m of list) {
      if (m.date > input.to) continue;
      if (m.date < input.from) {
        broughtForward += m.debit - m.credit;
        continue;
      }
      inPeriod.push(m);
    }
    if (inPeriod.length === 0 && broughtForward === 0) continue;

    inPeriod.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        // A debit before a credit on the same day: the officer cannot pay out
        // an advance before it reaches him.
        b.debit - a.debit ||
        a.reference.localeCompare(b.reference),
    );

    let balance = broughtForward;
    let totalDebit = 0;
    let totalCredit = 0;
    const entries: CbcaEntry[] = inPeriod.map((m) => {
      balance += m.debit - m.credit;
      totalDebit += m.debit;
      totalCredit += m.credit;
      return { ...m, balance };
    });

    books.push({
      officerId: w.officerId,
      officerName: w.officerName,
      fundCode: w.fundCode,
      broughtForward,
      entries,
      totalDebit,
      totalCredit,
      closingBalance: balance,
    });
  }

  return books.sort(
    (a, b) => a.officerName.localeCompare(b.officerName) || a.fundCode.localeCompare(b.fundCode),
  );
}
