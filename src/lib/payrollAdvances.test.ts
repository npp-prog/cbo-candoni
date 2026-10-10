import { describe, expect, it } from 'vitest';
import { openPayrollAdvances, payrollParticulars, payrollProformaEntry } from './payrollAdvances';

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
