import { describe, it, expect } from 'vitest';
import { bankAmount, bankFileCsv, bankName, buildBankFile } from './bankFile';
import { checkDvPayees } from './accounting-rules';

/** Patch 140: the bank's upload file for a group ADA. */
describe('the bank file', () => {
  it('writes the amount in centavos with no decimal point', () => {
    expect(bankAmount(1000010)).toBe('1000010'); // 10,000.10
    expect(bankAmount(1000000)).toBe('1000000'); // 10,000.00
  });

  it('takes every special character out of the name, the dot included', () => {
    expect(bankName('Ma. Bella Dela Cruz')).toBe('Ma Bella Dela Cruz');
    expect(bankName('Dela Cruz, Juan Jr.')).toBe('Dela Cruz Juan Jr');
    expect(bankName('Pe\u00f1a-Santos')).toBe('Pena Santos');
  });

  it('has no heading row: line 1 is the first payee', () => {
    const { rows, problems } = buildBankFile([
      { payeeName: 'Ma. Bella Dela Cruz', accountNumber: '0011-2233-44', amount: 400000 },
      { payeeName: 'Juan Santos', accountNumber: '5566778899', amount: 600010 },
    ]);
    expect(problems).toEqual([]);
    expect(bankFileCsv(rows)).toBe(
      '0011223344,Ma Bella Dela Cruz,400000\r\n5566778899,Juan Santos,600010\r\n',
    );
  });

  it('reports an account that is not 10 digits rather than pad or cut it', () => {
    const { rows, problems } = buildBankFile([
      { payeeName: 'Ana', accountNumber: '11223344', amount: 100 },
    ]);
    expect(rows[0].account).toBe('11223344');
    expect(problems[0]).toContain('has 8 digits; the bank needs 10');
  });

  it('holds a group voucher to 10-digit accounts at submission', () => {
    const r = checkDvPayees(
      [
        { payeeId: 'p1', payeeName: 'Ana', accountNumber: '0011223344', amount: 50 },
        { payeeId: 'p2', payeeName: 'Ben', accountNumber: '11223344', amount: 50 },
      ],
      100,
    );
    expect(r.violations.map((v) => v.code)).toEqual(['PAYEE_ACCOUNT_NOT_10_DIGITS']);
    expect(r.violations[0].message).toContain('Ben');
  });
});
