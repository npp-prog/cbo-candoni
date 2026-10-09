import { describe, expect, it } from 'vitest';
import { openingPayableVouchers, voucherNumberFrom } from './openingPayables';

const CTX = {
  payableAccountCode: '20101010',
  fiscalYear: 2026,
  fundCode: 'GF',
  asOfDate: '2025-12-31',
};

describe('voucherNumberFrom', () => {
  it('drops the DV prefix', () => {
    expect(voucherNumberFrom('DV 2025-08-0123')).toBe('2025-08-0123');
    expect(voucherNumberFrom('DV No. 2025-08-0123')).toBe('2025-08-0123');
    expect(voucherNumberFrom('2025-08-0123')).toBe('2025-08-0123');
    expect(voucherNumberFrom('  ')).toBeNull();
    expect(voucherNumberFrom(null)).toBeNull();
  });
});

describe('openingPayableVouchers (patch 152)', () => {
  const lines = [
    { accountCode: '10102020', credit: 0 },
    {
      accountCode: '20101010',
      credit: 500_000,
      subsidiaryType: 'PAYEE',
      subsidiaryId: 'p1',
      subsidiaryName: 'Negros Hardware',
      referenceNo: 'DV 2025-08-0123',
      agingDate: '2025-08-14',
      particulars: 'Office supplies, August',
    },
    { accountCode: '20101010', credit: 120_000, subsidiaryName: 'Juan Cruz' },
    { accountCode: '20201010', credit: 99_000, subsidiaryName: 'Not a payable voucher' },
  ];

  it('makes one voucher per Accounts Payable credit, and nothing else', () => {
    const out = openingPayableVouchers(lines, CTX);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'OB__2026__GF__0001',
      dvNo: '2025-08-0123',
      dvDate: '2025-08-14',
      payeeId: 'p1',
      payeeName: 'Negros Hardware',
      particulars: 'Office supplies, August',
      amount: 500_000,
    });
  });

  it('numbers and dates a line that gave neither', () => {
    const out = openingPayableVouchers(lines, CTX);
    expect(out[1]).toMatchObject({
      id: 'OB__2026__GF__0002',
      dvNo: 'OB-GF-2026-0002',
      dvDate: '2025-12-31',
      payeeId: null,
      payeeName: 'Juan Cruz',
    });
    expect(out[1].particulars).toMatch(/carried forward as at 2025-12-31/);
  });

  it('ignores a debit balance on the payable account', () => {
    expect(openingPayableVouchers([{ accountCode: '20101010', credit: 0 }], CTX)).toEqual([]);
  });
});
