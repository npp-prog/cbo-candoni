import { describe, expect, it } from 'vitest';
import {
  collectionLineNeedsSubsidiary,
  creditsByAccountAndSubsidiary,
  missingSubsidiaries,
} from './collectionSubsidiary';

describe('collectionLineNeedsSubsidiary (patch 158)', () => {
  it('asks for one on a receivable or a payable', () => {
    expect(collectionLineNeedsSubsidiary('10305020')).toBe(true);
    expect(collectionLineNeedsSubsidiary('20401020')).toBe(true);
  });
  it('not on revenue, unless the chart says so', () => {
    expect(collectionLineNeedsSubsidiary('40101050')).toBe(false);
    expect(collectionLineNeedsSubsidiary('40101050', { requiresSubsidiary: true })).toBe(true);
  });
  it('not on a line with no account yet', () => {
    expect(collectionLineNeedsSubsidiary('')).toBe(false);
  });
});

describe('missingSubsidiaries', () => {
  it('names the lines that need one and lack it', () => {
    expect(
      missingSubsidiaries(
        [
          { accountCode: '40101050', accountName: 'Business Tax' },
          { accountCode: '10305020', accountName: 'Advances for Payroll' },
          {
            accountCode: '10305020',
            accountName: 'Advances for Payroll',
            subsidiaryId: 'e1',
            subsidiaryName: 'Juan',
          },
        ],
        () => null,
      ),
    ).toEqual(['line 2 (10305020 Advances for Payroll)']);
  });
});

describe('creditsByAccountAndSubsidiary', () => {
  it('keeps one credit per account and subsidiary', () => {
    const out = creditsByAccountAndSubsidiary([
      { accountCode: '40101050', accountName: 'BT', amount: 100 },
      { accountCode: '40101050', accountName: 'BT', amount: 50 },
      {
        accountCode: '10305020',
        accountName: 'AfP',
        amount: 7,
        subsidiaryType: 'EMPLOYEE',
        subsidiaryId: 'a',
        subsidiaryName: 'A',
      },
      {
        accountCode: '10305020',
        accountName: 'AfP',
        amount: 3,
        subsidiaryType: 'EMPLOYEE',
        subsidiaryId: 'b',
        subsidiaryName: 'B',
      },
      {
        accountCode: '10305020',
        accountName: 'AfP',
        amount: 1,
        subsidiaryType: 'EMPLOYEE',
        subsidiaryId: 'a',
        subsidiaryName: 'A',
      },
    ]);
    expect(out.map((c) => [c.accountCode, c.subsidiaryName, c.amount])).toEqual([
      ['40101050', null, 150],
      ['10305020', 'A', 8],
      ['10305020', 'B', 3],
    ]);
  });
});
