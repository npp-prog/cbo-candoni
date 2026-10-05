import { describe, it, expect } from 'vitest';
import {
  missingDetail,
  receiptDetailProblems,
  receiptIsIncomplete,
  describeProblems,
} from './receiptDetail';

const BASIC = '40102040';
const SEF = '40102050';
const PENALTY = '40105020';
const PERMIT_FEE = '40201010';

describe('missingDetail', () => {
  it('asks for the tax year and the barangay on a basic tax line', () => {
    expect(missingDetail({ accountCode: BASIC, amount: 100_00 }, 'GF')).toEqual([
      'the tax year',
      'the barangay',
    ]);
  });

  it('asks only for the tax year on the SEF share', () => {
    // The Special Education Fund is divided between the two school boards.
    // The barangays have no part of it, so asking for one would be asking a
    // question with no right answer.
    expect(missingDetail({ accountCode: SEF, amount: 100_00 }, 'SEF')).toEqual(['the tax year']);
  });

  it('is satisfied once both are given', () => {
    expect(
      missingDetail(
        { accountCode: BASIC, amount: 100_00, rptTaxYear: 'CURRENT', barangayId: 'b1' },
        'GF',
      ),
    ).toEqual([]);
  });

  it('asks nothing of an ordinary fee', () => {
    expect(missingDetail({ accountCode: PERMIT_FEE, amount: 500_00 }, 'GF')).toEqual([]);
  });

  it('asks for the trust programme on a Trust Fund receipt', () => {
    expect(missingDetail({ accountCode: PERMIT_FEE, amount: 500_00 }, 'TF')).toEqual([
      'the trust programme',
    ]);
  });

  it('asks for all three where they all apply', () => {
    expect(missingDetail({ accountCode: BASIC, amount: 100_00 }, 'TF')).toEqual([
      'the tax year',
      'the barangay',
      'the trust programme',
    ]);
  });

  it('skips a line with no amount on it', () => {
    // An empty row on a half-filled form is not a collection. Refusing it
    // would stop the clerk before they had typed anything.
    expect(missingDetail({ accountCode: BASIC, amount: 0 }, 'TF')).toEqual([]);
    expect(missingDetail({ amount: null }, 'TF')).toEqual([]);
  });

  it('skips a line with an amount but no account chosen yet', () => {
    expect(missingDetail({ amount: 100_00 }, 'TF')).toEqual([]);
  });

  it('reads the penalty line as a tax line needing its year', () => {
    expect(missingDetail({ accountCode: PENALTY, amount: 10_00 }, 'GF')).toContain('the tax year');
  });
});

describe('receiptDetailProblems', () => {
  it('reports the line number and what it needs', () => {
    const problems = receiptDetailProblems(
      [
        { lineNo: 1, accountCode: PERMIT_FEE, accountName: 'Permit fee', amount: 100_00 },
        { lineNo: 2, accountCode: BASIC, accountName: 'Basic tax', amount: 500_00 },
      ],
      'GF',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].lineNo).toBe(2);
    expect(problems[0].missing).toBe('the tax year and the barangay');
  });

  it('numbers an unnumbered line by its position', () => {
    const problems = receiptDetailProblems([{ accountCode: BASIC, amount: 1 }], 'GF');
    expect(problems[0].lineNo).toBe(1);
  });

  it('finds nothing wrong with a complete receipt', () => {
    expect(
      receiptDetailProblems(
        [{ lineNo: 1, accountCode: BASIC, amount: 1, rptTaxYear: 'CURRENT', barangayId: 'b1' }],
        'GF',
      ),
    ).toEqual([]);
  });
});

describe('describeProblems', () => {
  it('names the account when there is one line', () => {
    const text = describeProblems([
      { lineNo: 2, accountCode: BASIC, accountName: 'Real Property Tax - Basic', missing: 'the barangay' },
    ]);
    expect(text).toBe('Line 2, Real Property Tax - Basic, needs the barangay.');
  });

  it('lists them when there are several', () => {
    const text = describeProblems([
      { lineNo: 1, accountCode: BASIC, accountName: 'Basic', missing: 'the tax year' },
      { lineNo: 3, accountCode: SEF, accountName: 'SEF', missing: 'the barangay' },
    ]);
    expect(text).toBe('Line 1 needs the tax year; line 3 needs the barangay.');
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeProblems([])).toBe('');
  });
});

describe('receiptIsIncomplete', () => {
  it('flags a receipt recorded before CFMS asked', () => {
    expect(
      receiptIsIncomplete({ fundCode: 'GF', lines: [{ accountCode: BASIC, amount: 100_00 }] }),
    ).toBe(true);
  });

  it('leaves a complete one alone', () => {
    expect(
      receiptIsIncomplete({
        fundCode: 'GF',
        lines: [{ accountCode: BASIC, amount: 100_00, rptTaxYear: 'CURRENT', barangayId: 'b1' }],
      }),
    ).toBe(false);
  });

  it('copes with a receipt that has no lines at all', () => {
    expect(receiptIsIncomplete({ fundCode: 'GF' })).toBe(false);
  });
});
