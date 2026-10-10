import { describe, expect, it } from 'vitest';
import {
  compareWithOpening,
  naturalFromTb,
  netByCode,
  openNominalAccounts,
  priorTbId,
} from './priorTrialBalance';

describe('prior year trial balances', () => {
  const post = [
    { accountCode: '10102020', debit: 500_00, credit: 0 },
    { accountCode: '20101010', debit: 0, credit: 200_00 },
    { accountCode: '30101010', debit: 0, credit: 300_00 },
  ];

  it('nets each account, debit less credit, and drops zeros', () => {
    const m = netByCode([...post, { accountCode: '10102020', debit: 0, credit: 500_00 }]);
    expect(m.has('10102020')).toBe(false);
    expect(m.get('20101010')).toBe(-200_00);
  });

  it('finds revenue and expense left open on a post-closing trial balance', () => {
    expect(openNominalAccounts(netByCode(post))).toEqual([]);
    expect(
      openNominalAccounts(netByCode([...post, { accountCode: '40101010', debit: 0, credit: 1 }])),
    ).toEqual(['40101010']);
  });

  it('agrees with opening balances that carry the same position', () => {
    const opening = netByCode([
      { accountCode: '10102020', debit: 300_00, credit: 0 },
      { accountCode: '10102020', debit: 200_00, credit: 0 },
      { accountCode: '20101010', debit: 0, credit: 200_00 },
      { accountCode: '30101010', debit: 0, credit: 300_00 },
    ]);
    expect(compareWithOpening(netByCode(post), opening)).toEqual([]);
  });

  it('names each account that differs, both ways', () => {
    const opening = netByCode([
      { accountCode: '10102020', debit: 450_00, credit: 0 },
      { accountCode: '19901990', debit: 50_00, credit: 0 },
      { accountCode: '20101010', debit: 0, credit: 200_00 },
      { accountCode: '30101010', debit: 0, credit: 300_00 },
    ]);
    expect(compareWithOpening(netByCode(post), opening)).toEqual([
      { accountCode: '10102020', trialBalance: 500_00, opening: 450_00, difference: 50_00 },
      { accountCode: '19901990', trialBalance: 0, opening: 50_00, difference: -50_00 },
    ]);
  });

  it('presents natural balances and keys one per year, fund and kind', () => {
    const n = naturalFromTb(netByCode(post));
    expect(n.get('20101010')).toBe(200_00);
    expect(n.get('10102020')).toBe(500_00);
    expect(priorTbId(2025, 'GF', 'POST')).toBe('2025__GF__POST');
  });
});
