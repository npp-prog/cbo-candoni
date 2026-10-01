import { describe, expect, it } from 'vitest';
import {
  BASIC_SHARES,
  RPT_ACCOUNTS,
  SEF_SHARES,
  buildRptAbstract,
  splitByShares,
  type RptLedgerEntry,
} from './rptAbstractReport';

/**
 * The worked example in GAM Volume I, Section 69, is the fixture that matters:
 * 100.00 of basic tax with a 10% discount for prompt payment shares out as
 *
 *              Receipt   Discount
 *   Municipality  36.00      4.00
 *   Province      31.50      3.50
 *   Barangay      22.50      2.50
 *
 * If the code reproduces the manual's own numbers it is doing the right thing.
 */

const entry = (accountCode: string, signedAmount: number, period = 1): RptLedgerEntry => ({
  period,
  accountCode,
  signedAmount,
});

/** Revenue is credit-normal, so a collection is negative in the ledger. */
const collected = (code: string, amount: number, period = 1) => entry(code, -amount, period);
/** A discount is a debit against revenue. */
const discounted = (code: string, amount: number, period = 1) => entry(code, amount, period);

const build = (entries: RptLedgerEntry[], fromPeriod = 1, throughPeriod = 12) =>
  buildRptAbstract({ entries, fromPeriod, throughPeriod });

describe('splitByShares', () => {
  it('splits on the basic sharing', () => {
    expect(splitByShares(10_000, BASIC_SHARES)).toEqual([4_000, 3_500, 2_500]);
  });

  it('divides the special education fund equally', () => {
    expect(splitByShares(10_000, SEF_SHARES)).toEqual([5_000, 5_000]);
  });

  it('never loses a centavo, and gives the odd one to the largest share', () => {
    // 1.01 shared 40/35/25: 40.4, 35.35, 25.25 centavos.
    const parts = splitByShares(101, BASIC_SHARES);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(101);
    expect(parts).toEqual([41, 35, 25]);
  });

  it('keeps the total exact across many awkward amounts', () => {
    for (let amount = 1; amount <= 500; amount++) {
      const parts = splitByShares(amount, BASIC_SHARES);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(amount);
    }
  });

  it('handles zero', () => {
    expect(splitByShares(0, BASIC_SHARES)).toEqual([0, 0, 0]);
  });
});

describe('buildRptAbstract', () => {
  it('reproduces the worked example in Section 69', () => {
    const a = build([
      collected(RPT_ACCOUNTS.basic, 100_00),
      discounted(RPT_ACCOUNTS.basicDiscount, 10_00),
    ]);

    expect(a.basic.gross).toBe(100_00);
    expect(a.basic.discount).toBe(10_00);
    expect(a.basic.net).toBe(90_00);

    expect(a.basic.rows).toEqual([
      { label: 'Municipality', rate: 4_000, own: true, grossShare: 40_00, discountShare: 4_00, netShare: 36_00 },
      { label: 'Province', rate: 3_500, own: false, grossShare: 35_00, discountShare: 3_50, netShare: 31_50 },
      { label: 'Barangays', rate: 2_500, own: false, grossShare: 25_00, discountShare: 2_50, netShare: 22_50 },
    ]);

    // 31.50 to the province and 22.50 to the barangays is the 54.00 that has
    // to leave, and 36.00 is what Candoni keeps.
    expect(a.totalToRemit).toBe(54_00);
    expect(a.totalOwn).toBe(36_00);
  });

  it('shares the special education fund equally and gives the barangays none', () => {
    const a = build([collected(RPT_ACCOUNTS.sef, 80_00)]);

    expect(a.sef.rows.map((r) => r.label)).toEqual([
      'Municipal School Board',
      'Provincial School Board',
    ]);
    expect(a.sef.rows.map((r) => r.netShare)).toEqual([40_00, 40_00]);
    expect(a.totalToRemit).toBe(40_00);
  });

  it('leaves the penalties unallocated', () => {
    const a = build([
      collected(RPT_ACCOUNTS.basic, 100_00),
      collected(RPT_ACCOUNTS.penalties, 15_00),
    ]);

    expect(a.penalties).toBe(15_00);
    // One account carries both taxes and they share differently, so the
    // penalties are not pushed through either rate.
    expect(a.totalToRemit).toBe(35_00 + 25_00);
  });

  it('compares the shares against the movement on Due to LGUs', () => {
    const a = build([
      collected(RPT_ACCOUNTS.basic, 100_00),
      discounted(RPT_ACCOUNTS.basicDiscount, 10_00),
      // The sharing entry the abstract exists to prompt.
      collected(RPT_ACCOUNTS.dueToLgus, 54_00),
    ]);

    expect(a.dueToLgusMovement).toBe(54_00);
    expect(a.dueToLgusDifference).toBe(0);
  });

  it('shows the gap where the sharing entry has not been drawn', () => {
    const a = build([collected(RPT_ACCOUNTS.basic, 100_00)]);

    expect(a.totalToRemit).toBe(60_00);
    expect(a.dueToLgusMovement).toBe(0);
    expect(a.dueToLgusDifference).toBe(-60_00);
  });

  it('lists the months that have something in them and skips the rest', () => {
    const a = build([
      collected(RPT_ACCOUNTS.basic, 50_00, 1),
      collected(RPT_ACCOUNTS.sef, 10_00, 1),
      collected(RPT_ACCOUNTS.basic, 30_00, 6),
    ]);

    expect(a.months.map((m) => m.period)).toEqual([1, 6]);
    expect(a.months[0]).toEqual({
      period: 1,
      basicGross: 50_00,
      basicDiscount: 0,
      sefGross: 10_00,
      sefDiscount: 0,
      penalties: 0,
    });
    expect(a.basic.gross).toBe(80_00);
  });

  it('stops at the chosen period', () => {
    const a = buildRptAbstract({
      entries: [
        collected(RPT_ACCOUNTS.basic, 50_00, 3),
        collected(RPT_ACCOUNTS.basic, 90_00, 9),
      ],
      fromPeriod: 1,
      throughPeriod: 6,
    });

    expect(a.basic.gross).toBe(50_00);
  });

  it('ignores accounts that are not part of this abstract', () => {
    const a = build([
      collected(RPT_ACCOUNTS.basic, 40_00),
      collected('40202010', 99_00), // Permit fees
      collected('40102080', 12_00), // Real Property Transfer Tax - a different tax
    ]);

    expect(a.basic.gross).toBe(40_00);
    expect(a.totalToRemit).toBe(14_00 + 10_00);
  });

  it('keeps the shares adding back to the net tax', () => {
    const a = build([
      collected(RPT_ACCOUNTS.basic, 1_234_567),
      discounted(RPT_ACCOUNTS.basicDiscount, 98_765),
      collected(RPT_ACCOUNTS.sef, 1_234_567),
      discounted(RPT_ACCOUNTS.sefDiscount, 98_765),
    ]);

    expect(a.basic.rows.reduce((s, r) => s + r.netShare, 0)).toBe(a.basic.net);
    expect(a.sef.rows.reduce((s, r) => s + r.netShare, 0)).toBe(a.sef.net);
    expect(a.totalOwn + a.totalToRemit).toBe(a.basic.net + a.sef.net);
  });
});
