import { describe, it, expect } from 'vitest';
import { buildBankPayrollFile } from './bankUpload';

const ROWS = [
  { accountNumber: '1234567890', name: 'Dela Cruz, Juan', amount: 1_000_010 },
  { accountNumber: '0098765432', name: 'Ma. Santos', amount: 1_000_000 },
];

/** Patch 142: "Download for the bank" on the RADAI writes the bank's format. */
describe('buildBankPayrollFile', () => {
  it('has no heading row: row 1 is the first payee', () => {
    const { content } = buildBankPayrollFile(ROWS);
    expect(content!.split('\r\n')[0]).toBe('1234567890,DELA CRUZ JUAN,1000010');
  });

  it('writes the amount in centavos with no decimal point, and the name with no dot', () => {
    const { content } = buildBankPayrollFile(ROWS);
    expect(content).toBe('1234567890,DELA CRUZ JUAN,1000010\r\n0098765432,MA SANTOS,1000000\r\n');
    expect(content).not.toContain('.');
  });

  it('carries no letterhead and no byte-order mark', () => {
    const { content } = buildBankPayrollFile(ROWS);
    expect(content!.charCodeAt(0)).not.toBe(0xfeff);
    expect(content).not.toContain('Republic of the Philippines');
  });

  it('refuses to build a file with an account number missing, and names who', () => {
    const result = buildBankPayrollFile([
      ROWS[0],
      { accountNumber: '', name: 'Reyes, Pedro', amount: 30_000 },
      { accountNumber: null, name: 'Lim, Ana', amount: 20_000 },
    ]);
    expect(result.content).toBeNull();
    expect(result.missing).toEqual(['Reyes, Pedro', 'Lim, Ana']);
    expect(result.problems[0]).toContain('Reyes, Pedro');
  });

  it('refuses an account that is not 10 digits', () => {
    const result = buildBankPayrollFile([{ accountNumber: '1172-1020-2', name: 'Ana', amount: 1 }]);
    expect(result.content).toBeNull();
    expect(result.problems[0]).toContain('has 9 digits');
  });

  it('counts and totals even when it refuses', () => {
    const result = buildBankPayrollFile([
      ROWS[0],
      { accountNumber: '', name: 'Reyes, Pedro', amount: 30_000 },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.total).toBe(1_030_010);
  });
});
