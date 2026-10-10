import { describe, expect, it } from 'vitest';
import {
  openPayrollAdvances,
  payrollParticulars,
  payrollProformaEntry,
  refundReceiptDraft,
  openingPayrollAdvances,
} from './payrollAdvances';

const ADV = '10305020';

const dv = (over: Record<string, unknown>) => ({
  id: 'dv1',
  dvNo: '2026-10-0100',
  dvDate: '2026-10-01',
  status: 'PAID',
  payeeId: 'pay9',
  payeeName: 'Juan Dela Cruz',
  particulars: 'Cash advance for the payroll of regular employees, Oct 1-15',
  accountLines: [
    {
      accountCode: ADV,
      debit: 1_000_000,
      credit: 0,
      subsidiaryType: 'EMPLOYEE',
      subsidiaryId: 'emp7',
      subsidiaryName: 'Juan Dela Cruz',
    },
    { accountCode: '10102020', debit: 0, credit: 1_000_000 },
  ],
  ...over,
});

describe('openPayrollAdvances (patch 155)', () => {
  it('lists an advance with what is still to be liquidated', () => {
    const out = openPayrollAdvances(
      [dv({})],
      [{ id: 'p1', dvId: 'dv1', status: 'DRAFT', totalNet: 400_000 }],
      ADV,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dvNo: '2026-10-0100',
      advance: 1_000_000,
      liquidated: 400_000,
      outstanding: 600_000,
      officer: { type: 'EMPLOYEE', id: 'emp7', name: 'Juan Dela Cruz' },
    });
  });

  it('drops an advance fully liquidated, and one not yet approved', () => {
    expect(
      openPayrollAdvances(
        [dv({}), dv({ id: 'dv2', status: 'SUBMITTED' })],
        [{ id: 'p1', dvId: 'dv1', status: 'DRAFT', totalNet: 1_000_000 }],
        ADV,
      ),
    ).toEqual([]);
  });

  it('ignores a cancelled payroll, and the payroll being edited', () => {
    const out = openPayrollAdvances(
      [dv({})],
      [
        { id: 'p1', dvId: 'dv1', status: 'CANCELLED', totalNet: 1_000_000 },
        { id: 'p2', dvId: 'dv1', status: 'DRAFT', totalNet: 300_000 },
      ],
      ADV,
      'p2',
    );
    expect(out[0].outstanding).toBe(1_000_000);
  });

  it('is not fooled by a voucher with no advance for payroll', () => {
    expect(
      openPayrollAdvances(
        [dv({ accountLines: [{ accountCode: '50203010', debit: 5, credit: 0 }] })],
        [],
        ADV,
      ),
    ).toEqual([]);
  });

  it("falls back to the voucher's payee as the officer", () => {
    const out = openPayrollAdvances(
      [dv({ accountLines: [{ accountCode: ADV, debit: 100, credit: 0 }] })],
      [],
      ADV,
    );
    expect(out[0].officer).toEqual({ type: 'PAYEE', id: 'pay9', name: 'Juan Dela Cruz' });
  });
});

describe('the refund (patch 158)', () => {
  it('counts the refund declared on a payroll as accounted for', () => {
    const out = openPayrollAdvances(
      [dv({})],
      [{ id: 'p1', dvId: 'dv1', status: 'DRAFT', totalNet: 700_000, refundAmount: 200_000 }],
      ADV,
    );
    expect(out[0]).toMatchObject({ liquidated: 900_000, outstanding: 100_000 });
  });

  it('closes the advance when net and refund make it up', () => {
    expect(
      openPayrollAdvances(
        [dv({})],
        [{ id: 'p1', dvId: 'dv1', status: 'DRAFT', totalNet: 950_000, refundAmount: 50_000 }],
        ADV,
      ),
    ).toEqual([]);
  });

  it('keeps the refund out of the entry - net paid only', () => {
    const e = payrollProformaEntry({
      net: 950_000,
      officer: { type: 'EMPLOYEE', id: 'emp7', name: 'Juan Dela Cruz' },
      particulars: 'x',
      dueToOfficers: { code: '20101020', name: 'Due to Officers and Employees' },
      advancesForPayroll: { code: ADV, name: 'Advances for Payroll' },
    });
    expect(e.reduce((s, l) => s + l.debit, 0)).toBe(950_000);
  });
});

describe('refundReceiptDraft (patch 158)', () => {
  const payroll = {
    id: 'pr1',
    payrollNo: 'PR-1',
    dvNo: '2026-10-0100',
    refundAmount: 50_000,
    disbursingOfficer: { type: 'EMPLOYEE', id: 'emp7', name: 'Juan Dela Cruz' },
  };
  const afp = { code: ADV, name: 'Advances for Payroll' };

  it('credits Advances for Payroll in the officer account', () => {
    const d = refundReceiptDraft(payroll, afp)!;
    expect(d.payorName).toBe('Juan Dela Cruz');
    expect(d.lines).toEqual([
      {
        lineNo: 1,
        accountCode: ADV,
        accountName: 'Advances for Payroll',
        amount: 50_000,
        subsidiaryType: 'EMPLOYEE',
        subsidiaryId: 'emp7',
        subsidiaryName: 'Juan Dela Cruz',
      },
    ]);
  });

  it('asks only what is still to be refunded, and nothing when it is all in', () => {
    expect(refundReceiptDraft(payroll, afp, 20_000)!.lines[0].amount).toBe(30_000);
    expect(refundReceiptDraft(payroll, afp, 50_000)).toBeNull();
    expect(refundReceiptDraft({ ...payroll, refundAmount: 0 }, afp)).toBeNull();
  });
});

describe('payrollParticulars', () => {
  it('prefixes the voucher particulars', () => {
    expect(payrollParticulars('Regular employees, Oct 1-15')).toBe(
      'Liquidation of payroll - Regular employees, Oct 1-15',
    );
    expect(payrollParticulars('')).toBe('Liquidation of payroll');
  });
});

describe('payrollProformaEntry', () => {
  it('puts both lines in the disbursing officer subsidiary account', () => {
    const e = payrollProformaEntry({
      net: 600_000,
      officer: { type: 'EMPLOYEE', id: 'emp7', name: 'Juan Dela Cruz' },
      particulars: 'Liquidation of payroll - x',
      dueToOfficers: { code: '20101020', name: 'Due to Officers and Employees' },
      advancesForPayroll: { code: ADV, name: 'Advances for Payroll' },
    });
    expect(e.map((l) => [l.accountCode, l.debit, l.credit, l.subsidiaryName])).toEqual([
      ['20101020', 600_000, 0, 'Juan Dela Cruz'],
      [ADV, 0, 600_000, 'Juan Dela Cruz'],
    ]);
  });
});

describe('openingPayrollAdvances (patch 159)', () => {
  const entries = [
    {
      id: 'le1',
      sourceType: 'OPENING',
      accountCode: ADV,
      debit: 300_000,
      jevId: 'j0',
      jevNo: '01-0001',
      entryDate: '2025-12-31',
      agingDate: '2025-11-28',
      referenceNo: 'DV 2025-11-0456',
      particulars: 'Payroll advance, Nov 16-30',
      subsidiaryType: 'EMPLOYEE',
      subsidiaryId: 'emp7',
      subsidiaryName: 'Juan Dela Cruz',
    },
    { id: 'le2', sourceType: 'DV', accountCode: ADV, debit: 5, entryDate: '2026-01-02' },
    {
      id: 'le3',
      sourceType: 'OPENING',
      accountCode: '10305010',
      debit: 5,
      entryDate: '2025-12-31',
    },
  ];

  it('offers an advance for payroll carried forward, as a voucher would be', () => {
    const vs = openingPayrollAdvances(entries, ADV);
    expect(vs).toHaveLength(1);
    const out = openPayrollAdvances(
      vs,
      [{ id: 'p', dvId: 'OB:le1', status: 'DRAFT', totalNet: 100_000 }],
      ADV,
    );
    expect(out[0]).toMatchObject({
      dvId: 'OB:le1',
      dvNo: 'DV 2025-11-0456',
      dvDate: '2025-11-28',
      openingJevId: 'j0',
      outstanding: 200_000,
      officer: { type: 'EMPLOYEE', id: 'emp7', name: 'Juan Dela Cruz' },
    });
  });
});
