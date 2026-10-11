import { describe, expect, it } from 'vitest';
import {
  buildCashAdvanceBook,
  type CbcaPayroll,
  type CbcaRcdisb,
  type CbcaVoucher,
} from './cashAdvanceBookReport';

const AFP = '10305020';

const dv = (over: Partial<CbcaVoucher> = {}): CbcaVoucher => ({
  id: 'dv1',
  dvNo: '2026-09-001',
  dvDate: '2026-09-02',
  status: 'APPROVED',
  fundCode: 'GF',
  particulars: 'Salaries of casuals, September',
  payeeId: 'p1',
  payeeName: 'Ana Cruz',
  accountLines: [
    {
      accountCode: AFP,
      debit: 100_000_00,
      credit: 0,
      subsidiaryId: 'e1',
      subsidiaryName: 'Juan Dela Cruz',
    },
    { accountCode: '10102020', debit: 0, credit: 100_000_00 },
  ],
  ...over,
});

const payroll = (over: Partial<CbcaPayroll> = {}): CbcaPayroll => ({
  id: 'pr1',
  payrollNo: 'PR-001',
  dvId: 'dv1',
  particulars: 'Liquidation of payroll - Salaries of casuals, September',
  ...over,
});

const rcdisb = (over: Partial<CbcaRcdisb> = {}): CbcaRcdisb => ({
  id: 'r1',
  reportNo: 'RCDisb-2026-09-01',
  reportDate: '2026-09-20',
  status: 'CERTIFIED',
  fundCode: 'GF',
  lines: [{ sourceId: 'pr1', sourceNo: 'PR-001', amount: 60_000_00 }],
  ...over,
});

const build = (over: Partial<Parameters<typeof buildCashAdvanceBook>[0]> = {}) =>
  buildCashAdvanceBook({
    vouchers: [dv()],
    payments: [{ dvId: 'dv1', no: 'Check 0001234', date: '2026-09-03', status: 'RELEASED' }],
    payrolls: [payroll()],
    rcdisbs: [rcdisb()],
    advanceAccountCode: AFP,
    from: '2026-09-01',
    to: '2026-09-30',
    fundCode: 'GF',
    ...over,
  });

describe('Cash Book - Cash Advances (patch 177: advances for payroll and RCDisb only)', () => {
  it('debits the advance for payroll at the check, credits the payroll on the RCDisb', () => {
    const [b] = build();
    expect(b.officerName).toBe('Juan Dela Cruz');
    expect(b.entries.map((e) => [e.date, e.reference, e.debit, e.credit, e.balance])).toEqual([
      ['2026-09-03', 'Check 0001234', 100_000_00, 0, 100_000_00],
      ['2026-09-20', 'RCDisb RCDisb-2026-09-01 / PR-001', 0, 60_000_00, 40_000_00],
    ]);
    expect(b.closingBalance).toBe(40_000_00);
  });

  it('uses the voucher number and date when no check or ADA paid it', () => {
    const [b] = build({ payments: [] });
    expect(b.entries[0].reference).toBe('DV 2026-09-001');
    expect(b.entries[0].date).toBe('2026-09-02');
  });

  it('ignores a draft voucher, a voucher not on Advances for Payroll, and a draft RCDisb', () => {
    expect(build({ vouchers: [dv({ status: 'DRAFT' })], rcdisbs: [] })).toEqual([]);
    expect(
      build({
        vouchers: [dv({ accountLines: [{ accountCode: '50101010', debit: 5_00, credit: 0 }] })],
        rcdisbs: [],
      }),
    ).toEqual([]);
    const [b] = build({ rcdisbs: [rcdisb({ status: 'DRAFT' })] });
    expect(b.entries).toHaveLength(1);
  });

  it('brings forward what happened before From, and leaves out what is after To', () => {
    const [b] = build({ from: '2026-09-10', to: '2026-09-30' });
    expect(b.broughtForward).toBe(100_000_00);
    expect(b.entries).toHaveLength(1);
    const [c] = build({ from: '2026-09-01', to: '2026-09-10' });
    expect(c.entries).toHaveLength(1);
    expect(c.closingBalance).toBe(100_000_00);
  });

  it('falls back to the payee when the advance line names no officer', () => {
    const [b] = build({
      vouchers: [dv({ accountLines: [{ accountCode: AFP, debit: 10_00, credit: 0 }] })],
    });
    expect(b.officerName).toBe('Ana Cruz');
    expect(b.entries).toHaveLength(2);
  });
});
