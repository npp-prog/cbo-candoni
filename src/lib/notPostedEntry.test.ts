import { describe, it, expect } from 'vitest';
import { proposeNotPostedEntry } from './treasuryEntry';
import { TRUST_LIABILITIES } from './chartOfAccounts';

/** Patch 143: credits the bank did not post become trust liabilities. */
describe('the adjusting entry for credits not posted online', () => {
  const cash = {
    accountCode: '10102010',
    accountName: 'Cash in Bank - Local Currency, Current Account',
    subsidiaryType: 'BANK_ACCOUNT',
    subsidiaryId: 'b1',
    subsidiaryName: 'LBP GF',
  };

  it('puts the money back in the bank and owes it to each payee as a trust liability', () => {
    const lines = proposeNotPostedEntry({
      adaNo: '2026-10-0002',
      cash,
      trustLiability: TRUST_LIABILITIES,
      credits: [
        { payeeId: 'p2', payeeName: 'Juan Santos', accountNumber: '5566778899', amount: 350000 },
        { payeeId: 'p3', payeeName: 'Pedro Penduko', accountNumber: '7778889990', amount: 250000 },
      ],
    });
    expect(lines.map((l) => [l.accountCode, l.debit, l.credit, l.subsidiaryId])).toEqual([
      ['10102010', 600000, 0, 'b1'],
      ['20401010', 0, 350000, 'p2'],
      ['20401010', 0, 250000, 'p3'],
    ]);
    expect(lines.reduce((t, l) => t + l.debit - l.credit, 0)).toBe(0);
  });

  it('makes no entry when every credit was posted', () => {
    expect(proposeNotPostedEntry({ adaNo: 'x', cash, trustLiability: TRUST_LIABILITIES, credits: [] })).toEqual([]);
  });
});
