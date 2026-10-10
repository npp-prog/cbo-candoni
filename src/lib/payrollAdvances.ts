/**
 * Patch 155 - a payroll is the LIQUIDATION of an advance for payroll.
 *
 * The disbursing officer draws a cash advance for the payroll on a voucher:
 *
 *     Dr Advances for Payroll - <the disbursing officer>
 *       Cr Cash in Bank
 *
 * pays the employees in cash, and reports what was paid on an RCDisb, whose
 * entry closes the advance against what was owed to the staff:
 *
 *     Dr Due to Officers and Employees - <the disbursing officer>   net paid
 *       Cr Advances for Payroll - <the disbursing officer>          net paid
 *
 * So a payroll is recorded FROM its advance: the voucher it liquidates, the
 * officer who drew it, its particulars - and only the net paid, which is the
 * one figure the liquidation needs. (The gross and the deductions were booked
 * on the payroll's own voucher, by Accounting.)
 *
 * Patch 158: what was NOT paid out is refunded by the officer. The payroll
 * declares it (refundAmount) so the advance is fully accounted for, but the
 * refund is not in the payroll's entry - it is receipted in Collections and
 * the RCD journalizes it: Dr Cash - Local Treasury / Cr Advances for Payroll.
 *
 * This file is the arithmetic of that: which advances are still open, by how
 * much, and the entry a payroll proposes.
 */

export interface AdvanceVoucher {
  id: string;
  dvNo: string;
  dvDate: string;
  status: string;
  payeeId?: string | null;
  payeeName?: string | null;
  particulars?: string | null;
  officeId?: string | null;
  officeName?: string | null;
  /** Patch 159: an advance carried in the opening balances - its JEV. */
  openingJevId?: string | null;
  accountLines?: Array<{
    accountCode: string;
    debit: number;
    credit: number;
    subsidiaryType?: string | null;
    subsidiaryId?: string | null;
    subsidiaryName?: string | null;
  }> | null;
}

export interface PayrollAgainstAdvance {
  id: string;
  dvId?: string | null;
  status: string;
  totalNet: number;
  /** Patch 158: the unspent part, refunded through Collections. */
  refundAmount?: number | null;
}

export interface Officer {
  type: string;
  id: string;
  name: string;
}

export interface OpenAdvance {
  dvId: string;
  dvNo: string;
  dvDate: string;
  dvStatus: string;
  officer: Officer | null;
  particulars: string;
  officeId: string | null;
  officeName: string | null;
  /** Patch 159: set for an advance carried in the opening balances. */
  openingJevId: string | null;
  /** The advance for payroll the voucher granted. */
  advance: number;
  /**
   * Accounted for by the payrolls drawn on it: the net paid plus the refund
   * each declared (patch 158).
   */
  liquidated: number;
  outstanding: number;
}

/** A voucher that has granted the advance: approved (in the books) or paid. */
const GRANTED = new Set(['APPROVED', 'PAID']);

/**
 * The advances for payroll still open: every approved or paid voucher that
 * debits Advances for Payroll, less the net of the payrolls already recorded
 * against it. `exceptPayrollId` leaves one payroll out - the one being edited.
 */
export function openPayrollAdvances(
  vouchers: AdvanceVoucher[],
  payrolls: PayrollAgainstAdvance[],
  advanceAccountCode: string,
  exceptPayrollId?: string | null,
): OpenAdvance[] {
  const used = new Map<string, number>();
  for (const p of payrolls) {
    if (!p.dvId || p.status === 'CANCELLED' || p.id === exceptPayrollId) continue;
    // Patch 158: a refund declared on a payroll accounts for that part of the
    // advance too - it is collected, not paid out on another payroll.
    used.set(p.dvId, (used.get(p.dvId) ?? 0) + (p.totalNet || 0) + (p.refundAmount || 0));
  }

  const out: OpenAdvance[] = [];
  for (const v of vouchers) {
    if (!GRANTED.has(v.status)) continue;
    const lines = (v.accountLines ?? []).filter(
      (l) => l.accountCode === advanceAccountCode && (l.debit || 0) > 0,
    );
    if (lines.length === 0) continue;
    const advance = lines.reduce((s, l) => s + l.debit, 0);
    const liquidated = used.get(v.id) ?? 0;
    const outstanding = advance - liquidated;
    if (outstanding <= 0) continue;
    out.push({
      dvId: v.id,
      dvNo: v.dvNo,
      dvDate: v.dvDate,
      dvStatus: v.status,
      officer: officerOf(v, lines[0]),
      particulars: String(v.particulars ?? '').trim(),
      officeId: v.officeId ?? null,
      officeName: v.officeName ?? null,
      openingJevId: v.openingJevId ?? null,
      advance,
      liquidated,
      outstanding,
    });
  }
  return out.sort((a, b) => a.dvDate.localeCompare(b.dvDate) || a.dvNo.localeCompare(b.dvNo));
}

/**
 * The disbursing officer: the subsidiary the advance was booked to - so the
 * liquidation lands in the same subsidiary account - else the voucher's payee.
 */
export function officerOf(
  v: AdvanceVoucher,
  advanceLine?: {
    subsidiaryType?: string | null;
    subsidiaryId?: string | null;
    subsidiaryName?: string | null;
  },
): Officer | null {
  if (advanceLine?.subsidiaryId && advanceLine.subsidiaryType && advanceLine.subsidiaryName) {
    return {
      type: advanceLine.subsidiaryType,
      id: advanceLine.subsidiaryId,
      name: advanceLine.subsidiaryName,
    };
  }
  if (v.payeeId && v.payeeName) return { type: 'PAYEE', id: v.payeeId, name: v.payeeName };
  return null;
}

/** "Liquidation of payroll - <the voucher's particulars>". */
export function payrollParticulars(dvParticulars: string | null | undefined): string {
  const p = String(dvParticulars ?? '').trim();
  return p ? `Liquidation of payroll - ${p}` : 'Liquidation of payroll';
}

export interface ProformaLine {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  subsidiaryType: string | null;
  subsidiaryId: string | null;
  subsidiaryName: string | null;
  particulars: string;
}

/**
 * The entry a payroll proposes - and the RCDisb journalizes: both lines in
 * the disbursing officer's subsidiary account.
 */
export function payrollProformaEntry(input: {
  net: number;
  officer: Officer | null;
  particulars: string;
  dueToOfficers: { code: string; name: string };
  advancesForPayroll: { code: string; name: string };
}): ProformaLine[] {
  if (!(input.net > 0)) return [];
  const sub = {
    subsidiaryType: input.officer?.type ?? null,
    subsidiaryId: input.officer?.id ?? null,
    subsidiaryName: input.officer?.name ?? null,
  };
  return [
    {
      accountCode: input.dueToOfficers.code,
      accountName: input.dueToOfficers.name,
      debit: input.net,
      credit: 0,
      ...sub,
      particulars: input.particulars,
    },
    {
      accountCode: input.advancesForPayroll.code,
      accountName: input.advancesForPayroll.name,
      debit: 0,
      credit: input.net,
      ...sub,
      particulars: input.particulars,
    },
  ];
}

/**
 * Patch 158 - the receipt for a payroll's refund: the disbursing officer pays
 * back what the payroll did not use, and the receipt credits Advances for
 * Payroll in the officer's subsidiary account - so the RCD that reports it
 * closes the rest of the advance. Null when the payroll declared no refund.
 */
export function refundReceiptDraft(
  payroll: {
    id: string;
    payrollNo: string;
    dvNo?: string | null;
    refundAmount?: number | null;
    disbursingOfficer?: Officer | null;
  },
  advancesForPayroll: { code: string; name: string },
  /** What earlier receipts have already refunded, so this one asks only the rest. */
  alreadyReceipted = 0,
): {
  payrollId: string;
  payrollNo: string;
  payorName: string;
  particulars: string;
  lines: Array<{
    lineNo: number;
    accountCode: string;
    accountName: string;
    amount: number;
    subsidiaryType: string | null;
    subsidiaryId: string | null;
    subsidiaryName: string | null;
  }>;
} | null {
  const amount = (payroll.refundAmount ?? 0) - alreadyReceipted;
  if (!(amount > 0)) return null;
  const o = payroll.disbursingOfficer ?? null;
  return {
    payrollId: payroll.id,
    payrollNo: payroll.payrollNo,
    payorName: o?.name ?? '',
    particulars: `Refund of unexpended payroll advance - Payroll ${payroll.payrollNo}${payroll.dvNo ? `, DV ${payroll.dvNo}` : ''}`,
    lines: [
      {
        lineNo: 1,
        accountCode: advancesForPayroll.code,
        accountName: advancesForPayroll.name,
        amount,
        subsidiaryType: o?.type ?? null,
        subsidiaryId: o?.id ?? null,
        subsidiaryName: o?.name ?? null,
      },
    ],
  };
}

/**
 * Patch 159 - an ADVANCE FOR PAYROLL CARRIED IN THE OPENING BALANCES.
 *
 * Granted under the old system, so there is no CFMS voucher for it - only the
 * opening entry's debit to Advances for Payroll, in the officer's subsidiary
 * account. Each such debit is offered on New payroll as if it were a voucher:
 * numbered by the line's Reference (the old DV No.), dated the day it arose,
 * and keyed "OB:<ledger entry>" so the payrolls drawn on it are counted
 * against it like any other.
 */
export function openingPayrollAdvances(
  entries: Array<{
    id: string;
    sourceType?: string | null;
    accountCode: string;
    debit: number;
    jevId?: string | null;
    jevNo?: string | null;
    entryDate: string;
    agingDate?: string | null;
    referenceNo?: string | null;
    particulars?: string | null;
    subsidiaryType?: string | null;
    subsidiaryId?: string | null;
    subsidiaryName?: string | null;
  }>,
  advanceAccountCode: string,
): AdvanceVoucher[] {
  return entries
    .filter(
      (e) => e.sourceType === 'OPENING' && e.accountCode === advanceAccountCode && e.debit > 0,
    )
    .map((e) => ({
      id: `OB:${e.id}`,
      // The ledger carries the opening JEV's reference ("Opening GF 2026"),
      // which names no voucher; the line's particulars say what it was.
      dvNo:
        String(e.referenceNo ?? '').trim() && !/^opening\b/i.test(String(e.referenceNo))
          ? String(e.referenceNo).trim()
          : `Opening balance${e.jevNo ? ` (JEV ${e.jevNo})` : ''}`,
      dvDate: e.agingDate || e.entryDate,
      // In the books already: the opening entry is posted.
      status: 'APPROVED',
      payeeId: null,
      payeeName: e.subsidiaryName ?? null,
      particulars: String(e.particulars ?? '').trim() || 'Advance for payroll carried forward',
      openingJevId: e.jevId ?? null,
      accountLines: [
        {
          accountCode: e.accountCode,
          debit: e.debit,
          credit: 0,
          subsidiaryType: e.subsidiaryType ?? null,
          subsidiaryId: e.subsidiaryId ?? null,
          subsidiaryName: e.subsidiaryName ?? null,
        },
      ],
    }));
}

/** An advance carried forward, not a CFMS voucher. */
export const isOpeningAdvanceId = (dvId: string | null | undefined) =>
  String(dvId ?? '').startsWith('OB:');
