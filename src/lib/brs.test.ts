import { describe, expect, it } from 'vitest';
import { brsFileName, buildBrs, monthEnd, sheetSuffix } from './brs';

describe('the BRS in the office format (patch 163)', () => {
  const base = {
    statementDate: '2026-07-31',
    bankShortName: 'LBP',
    bookBalance: 18_060_948_86,
    bankBalance: 11_453_903_84,
  };

  it('puts each reconciling item in its column and agrees the adjusted balances', () => {
    const brs = buildBrs({
      ...base,
      checks: [
        { date: '2026-06-12', ref: '0001', name: 'A', amount: 39_582_02 },
        { date: '2026-07-20', ref: '0002', name: 'B', amount: 300_000_00 },
        { date: '2026-08-02', ref: '0003', name: 'Late', amount: 5_00 },
      ],
      deposits: [],
      statementLines: [
        {
          date: '2026-07-31',
          ref: 'DM1',
          description: 'ADA debit',
          debit: 6_946_627_04,
          credit: 0,
          kind: 'BANK_CHARGE',
        },
      ],
    });
    const checks = brs.lines.find((l) => l.key === 'CHECKS_NOT_TAKEN_UP')!;
    expect(checks.column).toBe('BANK');
    expect(checks.amount).toBe(-339_582_02);
    expect(checks.items).toHaveLength(2);
    expect(checks.items[0].remarks).toBe('Carried forward - outstanding since 6/12/2026');
    expect(checks.items[1].remarks).toBe('');
    expect(checks.label).toBe('Checks Issued not taken up by LBP');
    const memos = brs.lines.find((l) => l.key === 'MEMOS_NOT_TAKEN_UP')!;
    expect(memos.column).toBe('BOOK');
    expect(memos.amount).toBe(-6_946_627_04);
    expect(brs.adjustedBank).toBe(11_114_321_82);
    expect(brs.adjustedBook).toBe(11_114_321_82);
    expect(brs.difference).toBe(0);
    expect(brs.outstandingChecks).toBe(339_582_02);
    expect(brs.bookAdjustments).toBe(-6_946_627_04);
  });

  it('reverses a bank error on the bank side and adds deposits in transit', () => {
    const brs = buildBrs({
      ...base,
      bookBalance: 0,
      bankBalance: 0,
      checks: [],
      deposits: [{ date: '2026-07-31', ref: 'DS1', name: 'X', amount: 100_00 }],
      statementLines: [
        {
          date: '2026-07-10',
          ref: 'E1',
          description: 'Wrong credit',
          debit: 0,
          credit: 40_00,
          kind: 'ERROR',
        },
        {
          date: '2026-07-11',
          ref: 'I1',
          description: 'Interest',
          debit: 0,
          credit: 2_00,
          kind: 'INTEREST_INCOME',
        },
      ],
    });
    expect(brs.lines.find((l) => l.key === 'OTHER')!.amount).toBe(-40_00);
    expect(brs.bankAdjustments).toBe(-40_00);
    expect(brs.depositsInTransit).toBe(100_00);
    expect(brs.adjustedBank).toBe(60_00);
    expect(brs.adjustedBook).toBe(2_00);
  });

  it('names the file and the sheets as the office does', () => {
    expect(brsFileName('1172-1020-22', '2026-07-31')).toBe('BRS_1172-1020-22_07Jul2026');
    expect(sheetSuffix('2026-07-31')).toBe('Jul2026');
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
  });
});

describe('the BRS workbook', () => {
  it('has the statement and the schedules, BR_ and S_', async () => {
    const { brsWorkbook } = await import('./brsXlsx');
    const brs = buildBrs({
      statementDate: '2026-07-31',
      bankShortName: 'LBP',
      bookBalance: 100_00,
      bankBalance: 150_00,
      checks: [{ date: '2026-07-02', ref: '0001', name: 'A', amount: 50_00 }],
      deposits: [],
      statementLines: [],
    });
    const book = brsWorkbook(brs, {
      entityName: 'Municipal Government of Candoni',
      statementDate: '2026-07-31',
      bankName: 'Land Bank of the Philippines',
      branch: 'Kabankalan City',
      fundLabel: 'General Fund',
      accountNumber: '1172-1020-22',
      preparedBy: { name: 'A', position: 'Bookkeeper' },
      certifiedBy: { name: 'B', position: 'Municipal Accountant' },
    });
    expect(book.SheetNames).toEqual(['BR_Jul2026', 'S_Jul2026']);
    expect(book.Sheets.BR_Jul2026.A1.v).toBe('MUNICIPAL GOVERNMENT OF CANDONI');
  });
});
