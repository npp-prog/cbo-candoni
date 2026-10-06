import { describe, it, expect } from 'vitest';
import { proposeDvEntry, ACCOUNTS_PAYABLE } from './proposeEntry';

/**
 * The subsidiary on a proposed disbursement entry.
 *
 * The question these answer is not "does it copy the payee across" - that is
 * one line and nobody would get it wrong. It is WHICH LINE it copies the payee
 * onto, which is the part that was wrong in every hand-built entry the office
 * encoded before patch 84: the payee went on whichever line the encoder
 * happened to be looking at, or on none.
 */

const PAYEE = { id: 'p1', name: 'Negros Hardware' };

const OBLIGATION_LINES = [
  { accountCode: '50203010', accountName: 'Office Supplies Expenses', amount: 100_000 },
];

const EWT = {
  code: 'WE010',
  description: 'Expanded withholding tax - goods',
  accountCode: '20201010',
  accountName: 'Due to BIR',
  amount: 1_000,
};

describe('proposeDvEntry: the subsidiary ledger', () => {
  it('puts the payee on the payable, because that is the account kept per creditor', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [],
      netAmount: 100_000,
      obligationLines: OBLIGATION_LINES,
      payee: PAYEE,
    });

    const payable = lines.find((l) => l.accountCode === ACCOUNTS_PAYABLE.code);
    expect(payable).toBeDefined();
    expect(payable).toMatchObject({
      subsidiaryType: 'PAYEE',
      subsidiaryId: 'p1',
      subsidiaryName: 'Negros Hardware',
    });
  });

  it('leaves the expense debits alone', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [],
      netAmount: 100_000,
      obligationLines: OBLIGATION_LINES,
      payee: PAYEE,
    });

    const expense = lines.find((l) => l.accountCode === '50203010');
    expect(expense?.subsidiaryType).toBeUndefined();
  });

  /*
   * The one that matters. "Due to BIR" names its creditor in its own title,
   * and the party owed the withholding is the BIR - not the supplier it was
   * withheld FROM. A payee subsidiary here would say the municipality owes
   * them money it is in fact holding back on their behalf, and the Aging of
   * Payables would show it as such.
   */
  it('does not name the supplier on the tax withheld from them', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [EWT],
      netAmount: 99_000,
      obligationLines: OBLIGATION_LINES,
      payee: PAYEE,
    });

    const withheld = lines.find((l) => l.accountCode === '20201010');
    expect(withheld?.credit).toBe(1_000);
    expect(withheld?.subsidiaryType).toBeUndefined();
    expect(withheld?.subsidiaryName).toBeUndefined();
  });

  it('proposes no subsidiary at all before a payee has been chosen', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [],
      netAmount: 100_000,
      obligationLines: OBLIGATION_LINES,
      payee: null,
    });

    expect(lines.every((l) => l.subsidiaryType === undefined)).toBe(true);
  });

  /*
   * Not a subsidiary rule so much as the reason the subsidiary matters: the
   * voucher recognises a liability and never credits cash. If this ever fails,
   * the entry is crediting a bank account the Treasurer has not drawn on.
   */
  it('still credits the payable and never cash', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [EWT],
      netAmount: 99_000,
      obligationLines: OBLIGATION_LINES,
      payee: PAYEE,
    });

    const credits = lines.filter((l) => l.credit > 0);
    expect(credits.map((l) => l.accountCode).sort()).toEqual(
      ['20201010', ACCOUNTS_PAYABLE.code].sort(),
    );
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(100_000);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBe(100_000);
  });
});

/**
 * The withholding lines (patch 88).
 *
 * Every tax the municipality withholds posts to ONE account - Due to BIR. The
 * entry used to carry the TAX's own name as the account name, so the General
 * Ledger showed two different titles against code 20201010 and neither of them
 * was the account's name.
 */
describe('proposeDvEntry: what a withholding line says', () => {
  const EWT_WITH_CODE = {
    code: 'WE010',
    description: 'Expanded withholding tax on goods (1%)',
    accountCode: '20201010',
    accountName: 'Due to BIR',
    taxCodeId: 'tc-ewt',
    amount: 1_000,
  };

  it('names the account, and puts the tax in the subsidiary', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [EWT_WITH_CODE],
      netAmount: 99_000,
      obligationLines: OBLIGATION_LINES,
      payee: PAYEE,
    });

    const withheld = lines.find((l) => l.accountCode === '20201010');
    expect(withheld).toMatchObject({
      accountName: 'Due to BIR',
      subsidiaryType: 'TAX_CODE',
      subsidiaryId: 'tc-ewt',
      subsidiaryName: 'Expanded withholding tax on goods (1%)',
    });
  });

  /*
   * Two taxes on one voucher is the case that made the old shape visible: one
   * code, two names. They must now agree on the account and differ only in the
   * subsidiary.
   */
  it('gives two taxes one account and two subsidiaries', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [
        EWT_WITH_CODE,
        {
          code: 'WV020',
          description: 'Final VAT withholding on goods (5%)',
          accountCode: '20201010',
          accountName: 'Due to BIR',
          taxCodeId: 'tc-vat',
          amount: 5_000,
        },
      ],
      netAmount: 94_000,
      obligationLines: OBLIGATION_LINES,
      payee: PAYEE,
    });

    const withheld = lines.filter((l) => l.accountCode === '20201010');
    expect(withheld).toHaveLength(2);
    expect(new Set(withheld.map((l) => l.accountName))).toEqual(new Set(['Due to BIR']));
    expect(withheld.map((l) => l.subsidiaryId)).toEqual(['tc-ewt', 'tc-vat']);
  });

  /*
   * A retention typed in by hand has no tax code behind it. Inventing a
   * subsidiary for it would put something in the BIR's subsidiary ledger that
   * is not a tax.
   */
  it('leaves a hand-typed deduction without a subsidiary', () => {
    const lines = proposeDvEntry({
      grossAmount: 100_000,
      deductions: [
        {
          code: 'RET',
          description: 'Retention, 10%',
          accountCode: '20101010',
          accountName: 'Accounts Payable',
          amount: 10_000,
        },
      ],
      netAmount: 90_000,
      obligationLines: OBLIGATION_LINES,
      payee: null,
    });

    const retention = lines.filter((l) => l.credit === 10_000);
    expect(retention[0].subsidiaryType).toBeUndefined();
  });
});
