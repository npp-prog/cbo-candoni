import { describe, it, expect } from 'vitest';
import { buildAdvanceRegister, type AdvanceLedgerEntry } from './advances';
import { isLiquidatableAccount, liquidatableByDefault } from './chartOfAccounts';

/** Patch 133: advances to be liquidated are read off the General Ledger. */
const e = (over: Partial<AdvanceLedgerEntry>): AdvanceLedgerEntry => ({
  id: 'x',
  fiscalYear: 2026,
  fundCode: 'GF',
  entryDate: '2026-10-09',
  jevNo: '100-2026-10-0010',
  accountCode: '19901030',
  accountName: 'Advances to Special Disbursing Officer',
  debit: 0,
  credit: 0,
  subsidiaryType: 'PAYEE',
  subsidiaryId: 'p-bella',
  subsidiaryName: 'Ma Bella Dela Cruz',
  ...over,
});
const advanceAccounts = (code: string) => code === '19901030' || code === '19901040';

describe('the accounts subject to liquidation', () => {
  it('defaults to the four the Accountant named, by title, whatever the code', () => {
    expect(liquidatableByDefault('19901030', 'Advances to Special Disbursing Officer')).toBe(true);
    expect(liquidatableByDefault('10305040', 'Advances to Officers and Employees')).toBe(true);
    expect(liquidatableByDefault('19901010', 'Advances for Operating Expenses')).toBe(true);
    expect(liquidatableByDefault('10305990', 'Other Receivables')).toBe(true);
    // Payroll advances are liquidated by the RCDisb, not a liquidation report.
    expect(liquidatableByDefault('19901020', 'Advances for Payroll')).toBe(false);
    expect(liquidatableByDefault('20101010', 'Accounts Payable')).toBe(false);
  });
  it("follows the Accountant's choice once made", () => {
    expect(
      isLiquidatableAccount({ code: '19901020', name: 'Advances for Payroll', liquidatable: true }),
    ).toBe(true);
    expect(
      isLiquidatableAccount({
        code: '19901030',
        name: 'Advances to Special Disbursing Officer',
        liquidatable: false,
      }),
    ).toBe(false);
  });
});

describe('buildAdvanceRegister', () => {
  it('finds an advance granted on an ADA (JEV 100-2026-10-0010)', () => {
    const r = buildAdvanceRegister(
      [
        e({ id: 'g1', debit: 10_000_00, particulars: 'cash advance supplies' }),
        e({
          id: 'c1',
          accountCode: '10102020',
          credit: 10_000_00,
          subsidiaryId: 'bank',
          subsidiaryName: 'General Fund',
        }),
      ],
      advanceAccounts,
    );
    expect(r.advances).toHaveLength(1);
    expect(r.advances[0]).toMatchObject({
      id: 'g1',
      officerName: 'Ma Bella Dela Cruz',
      amountGranted: 10_000_00,
      outstanding: 10_000_00,
      accountCode: '19901030',
    });
  });

  it('settles the oldest advance first', () => {
    const r = buildAdvanceRegister(
      [
        e({ id: 'g1', entryDate: '2026-09-01', jevNo: 'A', debit: 5_000_00 }),
        e({ id: 'g2', entryDate: '2026-10-01', jevNo: 'B', debit: 3_000_00 }),
        e({ id: 'l1', entryDate: '2026-10-05', jevNo: 'C', credit: 6_000_00 }),
      ],
      advanceAccounts,
    );
    expect(r.advances.map((a) => [a.id, a.outstanding])).toEqual([
      ['g1', 0],
      ['g2', 2_000_00],
    ]);
  });

  it('keeps officers and accounts apart, and names advances with no officer', () => {
    const r = buildAdvanceRegister(
      [
        e({ id: 'g1', debit: 1_000_00 }),
        e({ id: 'g2', debit: 2_000_00, subsidiaryId: 'p-juan', subsidiaryName: 'Juan' }),
        e({ id: 'l2', credit: 2_000_00, subsidiaryId: 'p-juan', subsidiaryName: 'Juan' }),
        e({ id: 'g3', debit: 700_00, subsidiaryId: null, subsidiaryName: null }),
        e({ id: 'n1', accountCode: '50203010', debit: 9_00 }),
      ],
      advanceAccounts,
    );
    expect(r.advances.find((a) => a.id === 'g1')?.outstanding).toBe(1_000_00);
    expect(r.advances.find((a) => a.id === 'g2')?.outstanding).toBe(0);
    expect(r.unassigned.map((u) => u.id)).toEqual(['g3']);
    expect(r.advances.some((a) => a.id === 'n1')).toBe(false);
  });
});
