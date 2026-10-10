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
  /** The advance for payroll the voucher granted. */
  advance: number;
  /** Net already reported on payrolls drawn on it. */
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
    used.set(p.dvId, (used.get(p.dvId) ?? 0) + (p.totalNet || 0));
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
