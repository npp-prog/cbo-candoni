import { describe, it, expect } from 'vitest';
import { allocateDvShares, obligationLineKey } from './dvShares';

/** Patch 120: the one allocation that approval, cancellation and the verifier share. */
describe('allocateDvShares', () => {
  const lines = [
    { lineNo: 1, amount: 100_00 },
    { lineNo: 2, amount: 100_00 },
    { lineNo: 3, amount: 100_00 },
  ];

  it('spreads the voucher in proportion and the last line absorbs the remainder', () => {
    const shares = allocateDvShares(lines, 300_00, 100_00);
    expect(shares.map((s) => s.share)).toEqual([33_33, 33_33, 33_34]);
    expect(shares.reduce((t, s) => t + s.share, 0)).toBe(100_00);
  });

  it('gives a full draw back line for line', () => {
    const shares = allocateDvShares(lines, 300_00, 300_00);
    expect(shares.map((s) => s.share)).toEqual([100_00, 100_00, 100_00]);
  });

  it('is the same arithmetic forwards and backwards', () => {
    const forwards = allocateDvShares(lines, 300_00, 77_77).map((s) => s.share);
    const back = allocateDvShares(lines, 300_00, 77_77).map((s) => -s.share);
    expect(forwards.map((f, i) => f + back[i])).toEqual([0, 0, 0]);
  });

  it('does not divide by zero on an empty obligation', () => {
    expect(allocateDvShares([{ lineNo: 1, amount: 0 }], 0, 10_00)[0].share).toBe(10_00);
  });
});

describe('obligationLineKey', () => {
  it('keys on the appropriated object, not the object bought', () => {
    const key = obligationLineKey(
      { fiscalYear: 2026, fundCode: 'GF' },
      {
        fiscalYear: 2026,
        fundCode: 'GF',
        officeId: 'eng',
        responsibilityCenterId: null,
        programId: null,
        projectId: 'P1',
        activityId: null,
        fppCode: 'CO-2026-01',
        accountCode: '10604010',
        appropriatedAccountCode: '',
      },
    );
    expect(key.accountCode).toBe('');
    expect(key.fppCode).toBe('CO-2026-01');
  });
});
