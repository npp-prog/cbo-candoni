import { describe, it, expect } from 'vitest';
import {
  buildCashAdvanceBook,
  type CbcaAdvance,
  type CbcaLiquidation,
} from './cashAdvanceBook';

const adv = (over: Partial<CbcaAdvance> = {}): CbcaAdvance => ({
  id: 'CA1',
  fundCode: 'GF',
  accountableOfficerId: 'EMP1',
  accountableOfficerName: 'Lourdes M. Sagun',
  dvId: 'DV1',
  dvNo: 'DV-2026-0100',
  dateGranted: '2026-03-04',
  amountGranted: 50_000_00,
  purpose: 'Travelling expenses, Bacolod seminar',
  outstandingBalance: 50_000_00,
  ...over,
});

const liq = (over: Partial<CbcaLiquidation> = {}): CbcaLiquidation => ({
  id: 'LQ1',
  cashAdvanceId: 'CA1',
  liquidationNo: 'LR-2026-0044',
  liquidationDate: '2026-03-20',
  amountLiquidated: 38_000_00,
  refundAmount: 0,
  status: 'POSTED',
  ...over,
});

const MARCH = { from: '2026-03-01', to: '2026-03-31' };
const build = (
  advances: CbcaAdvance[],
  liquidations: CbcaLiquidation[],
  over: Partial<Parameters<typeof buildCashAdvanceBook>[0]> = {},
) => buildCashAdvanceBook({ advances, liquidations, ...MARCH, ...over });

describe('the debit column', () => {
  it('is the cash advance granted', () => {
    const [book] = build([adv()], []);
    expect(book.totalDebit).toBe(50_000_00);
    expect(book.entries[0].debit).toBe(50_000_00);
  });

  /** Instruction 6: the reference is the CHECK that paid the advance. */
  it('references the check that paid the advance', () => {
    const [book] = build([adv()], [], { checks: [{ dvId: 'DV1', checkNo: '0004567' }] });
    expect(book.entries[0].reference).toBe('0004567');
  });

  it('falls back to the voucher number when no check is found', () => {
    expect(build([adv()], [])[0].entries[0].reference).toBe('DV-2026-0100');
  });
});

describe('the credit column', () => {
  it('is the amount liquidated', () => {
    const [book] = build([adv()], [liq()]);
    expect(book.totalCredit).toBe(38_000_00);
  });

  /**
   * Cash handed back reduces what is in the drawer exactly as spending it
   * does. Instruction 9's balance would be wrong without it.
   */
  it('counts a refund as a credit of its own', () => {
    const [book] = build([adv()], [liq({ refundAmount: 12_000_00 })]);
    expect(book.entries).toHaveLength(3);
    expect(book.totalCredit).toBe(50_000_00);
    expect(book.closingBalance).toBe(0);
  });

  /**
   * The server moves a cash advance only when the liquidation is POSTED.
   * Anything looser would show an officer clear while the record still holds
   * him accountable.
   */
  it.each(['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RETURNED', 'CANCELLED'])(
    'ignores a %s liquidation',
    (status) => {
      expect(build([adv()], [liq({ status })])[0].totalCredit).toBe(0);
    },
  );

  it('ignores a liquidation against an advance that is not in the book', () => {
    expect(build([adv()], [liq({ cashAdvanceId: 'CA-OTHER' })])[0].totalCredit).toBe(0);
  });
});

describe('the balance column', () => {
  it('runs debit less credit down the page', () => {
    const [book] = build([adv()], [liq()]);
    expect(book.entries.map((e) => e.balance)).toEqual([50_000_00, 12_000_00]);
    expect(book.closingBalance).toBe(12_000_00);
  });

  /**
   * An officer cannot spend an advance before it reaches him. Sorted the other
   * way, the balance would dip negative for one line and read as a shortage.
   */
  it('puts a debit before a credit on the same day', () => {
    const [book] = build([adv()], [liq({ liquidationDate: '2026-03-04' })]);
    expect(book.entries[0].debit).toBe(50_000_00);
    expect(book.entries.every((e) => e.balance >= 0)).toBe(true);
  });

  it('carries earlier movement forward as the opening balance', () => {
    const [book] = build([adv({ dateGranted: '2026-01-10' })], [liq()]);
    expect(book.broughtForward).toBe(50_000_00);
    expect(book.entries).toHaveLength(1);
    expect(book.closingBalance).toBe(12_000_00);
  });

  it('stops at the closing date', () => {
    const [book] = build([adv()], [liq({ liquidationDate: '2026-04-05' })]);
    expect(book.entries).toHaveLength(1);
    expect(book.closingBalance).toBe(50_000_00);
  });
});

describe('one book per officer and fund', () => {
  it('keeps two officers apart', () => {
    const books = build(
      [adv(), adv({ id: 'CA2', accountableOfficerId: 'EMP2', accountableOfficerName: 'Ana Cruz' })],
      [],
    );
    expect(books).toHaveLength(2);
  });

  it('keeps the two funds of one officer apart', () => {
    const books = build([adv(), adv({ id: 'CA2', fundCode: 'SEF' })], []);
    expect(books).toHaveLength(2);
    expect(books.map((b) => b.fundCode).sort()).toEqual(['GF', 'SEF']);
  });

  it('can be limited to one officer', () => {
    const advances = [adv(), adv({ id: 'CA2', accountableOfficerId: 'EMP2' })];
    expect(build(advances, [], { officerId: 'EMP2' })).toHaveLength(1);
  });

  it('orders books by officer name', () => {
    const books = build(
      [
        adv({ accountableOfficerId: 'Z', accountableOfficerName: 'Zenaida Uy' }),
        adv({ id: 'CA2', accountableOfficerId: 'A', accountableOfficerName: 'Ariel Diaz' }),
      ],
      [],
    );
    expect(books.map((b) => b.officerName)).toEqual(['Ariel Diaz', 'Zenaida Uy']);
  });
});

/**
 * Instruction 10's tie-up, taken further: the book's closing balance and the
 * `outstandingBalance` each advance carries are reached by different means -
 * one by adding up this book, the other inside the transaction that posts a
 * liquidation - and where the book covers everything they must agree.
 */
describe('the tie-up with what the records hold', () => {
  it('agrees with the outstanding balances when the period covers everything', () => {
    const [book] = build([adv({ outstandingBalance: 12_000_00 })], [liq()]);
    expect(book.coversEverything).toBe(true);
    expect(book.closingBalance).toBe(book.outstandingRecorded);
    expect(book.drift).toBe(0);
  });

  it('reports a genuine drift when the two disagree', () => {
    const [book] = build([adv({ outstandingBalance: 15_000_00 })], [liq()]);
    expect(book.coversEverything).toBe(true);
    expect(book.drift).toBe(-3_000_00);
  });

  /**
   * And says when the comparison cannot honestly be made. Struck at a past
   * date, the book has not reached liquidations the stored figure already
   * counts, so a difference means nothing - and a check that reports a
   * discrepancy it cannot tell from normal is one nobody believes.
   */
  it('refuses the comparison when a document falls after the closing date', () => {
    const [book] = build([adv({ outstandingBalance: 12_000_00 })], [liq({ liquidationDate: '2026-05-02' })]);
    expect(book.coversEverything).toBe(false);
  });

  it('refuses it too when an advance was granted after the closing date', () => {
    const books = build([adv(), adv({ id: 'CA2', dateGranted: '2026-06-01' })], []);
    expect(books[0].coversEverything).toBe(false);
  });
});
