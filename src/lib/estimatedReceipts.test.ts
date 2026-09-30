import { describe, it, expect } from 'vitest';
import {
  annualOf,
  checkReceiptLine,
  checkReceiptSet,
  estimateThroughQuarter,
  receiptKeyId,
  type ReceiptLineInput,
} from './estimatedReceipts';

const line = (over: Partial<ReceiptLineInput> = {}): ReceiptLineInput => ({
  lineNo: 1,
  accountCode: '40101010',
  incomeClass: 'REGULAR',
  q1: 100_00,
  q2: 100_00,
  q3: 100_00,
  q4: 100_00,
  ...over,
});

describe('receiptKeyId', () => {
  it('is one line per account per fund per year', () => {
    expect(receiptKeyId({ fiscalYear: 2026, fundCode: 'GF', accountCode: '40101010' })).toBe(
      '2026__GF__40101010',
    );
  });

  /**
   * The same account in two funds is two different estimates. The Special
   * Education Fund's share of real property tax is not the General Fund's.
   */
  it('separates the same account in different funds', () => {
    const gf = receiptKeyId({ fiscalYear: 2026, fundCode: 'GF', accountCode: '40101010' });
    const sef = receiptKeyId({ fiscalYear: 2026, fundCode: 'SEF', accountCode: '40101010' });
    expect(gf).not.toBe(sef);
  });
});

describe('annualOf', () => {
  it('adds the four quarters', () => {
    expect(annualOf({ q1: 1_00, q2: 2_00, q3: 3_00, q4: 4_00 })).toBe(10_00);
  });

  it('treats a missing quarter as nothing rather than failing', () => {
    expect(annualOf({ q2: 5_00 })).toBe(5_00);
    expect(annualOf(undefined)).toBe(0);
  });
});

describe('estimateThroughQuarter', () => {
  it('is January to the end of the quarter', () => {
    const e = { q1: 1_00, q2: 2_00, q3: 4_00, q4: 8_00 };
    expect(estimateThroughQuarter(e, 1)).toBe(1_00);
    expect(estimateThroughQuarter(e, 3)).toBe(7_00);
    expect(estimateThroughQuarter(e, 4)).toBe(annualOf(e));
  });
});

describe('checkReceiptLine', () => {
  it('passes an ordinary line', () => {
    expect(checkReceiptLine(line()).ok).toBe(true);
  });

  it('refuses a negative estimate rather than netting it', () => {
    const result = checkReceiptLine(line({ q3: -50_00 }));
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('RECEIPT_NEGATIVE');
    expect(result.violations[0].message).toContain('3rd quarter');
  });

  it('refuses a line with no account code', () => {
    expect(checkReceiptLine(line({ accountCode: '' })).violations[0].code).toBe(
      'RECEIPT_NO_ACCOUNT',
    );
  });

  it('refuses an income class outside the three the form has', () => {
    const result = checkReceiptLine(line({ incomeClass: 'ORDINARY' }));
    expect(result.violations[0].code).toBe('RECEIPT_BAD_CLASS');
  });

  it('accepts a line that is zero in three quarters', () => {
    expect(checkReceiptLine(line({ q1: 0, q2: 0, q3: 0, q4: 900_00 })).ok).toBe(true);
  });

  /** Centavos are integers. A peso-as-float amount would round somewhere else. */
  it('refuses a fractional centavo', () => {
    expect(checkReceiptLine(line({ q1: 100.5 })).violations[0].code).toBe('RECEIPT_UNREADABLE');
  });
});

describe('checkReceiptSet', () => {
  it('passes a file of distinct accounts', () => {
    expect(
      checkReceiptSet([line(), line({ lineNo: 2, accountCode: '40201010' })]).ok,
    ).toBe(true);
  });

  /**
   * The failure this function exists for. Each line writes to a document keyed
   * on the account, so a duplicate REPLACES rather than adds - the file would
   * post, report nothing, and leave whichever row came last.
   */
  it('refuses the same account twice and names both rows', () => {
    const result = checkReceiptSet([
      line({ lineNo: 4 }),
      line({ lineNo: 9, q1: 999_00 }),
    ]);
    expect(result.ok).toBe(false);
    const duplicate = result.violations.find((v) => v.code === 'RECEIPT_DUPLICATE');
    expect(duplicate).toBeDefined();
    expect(duplicate?.details).toMatchObject({ first: 4, second: 9 });
  });

  it('does not report a duplicate for two rows that both lack an account code', () => {
    const result = checkReceiptSet([
      line({ lineNo: 1, accountCode: '' }),
      line({ lineNo: 2, accountCode: '' }),
    ]);
    expect(result.violations.some((v) => v.code === 'RECEIPT_DUPLICATE')).toBe(false);
    expect(result.violations.filter((v) => v.code === 'RECEIPT_NO_ACCOUNT')).toHaveLength(2);
  });

  it('refuses an empty file', () => {
    expect(checkReceiptSet([]).violations[0].code).toBe('RECEIPT_EMPTY');
  });

  it('refuses a file that estimates nothing anywhere', () => {
    const result = checkReceiptSet([line({ q1: 0, q2: 0, q3: 0, q4: 0 })]);
    expect(result.violations.some((v) => v.code === 'RECEIPT_ALL_ZERO')).toBe(true);
  });

  it('reports every bad row, not just the first', () => {
    const result = checkReceiptSet([
      line({ lineNo: 1, accountCode: '40101010', q1: -1_00 }),
      line({ lineNo: 2, accountCode: '40201010', q2: -1_00 }),
    ]);
    expect(result.violations.filter((v) => v.code === 'RECEIPT_NEGATIVE')).toHaveLength(2);
  });
});
