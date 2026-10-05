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
