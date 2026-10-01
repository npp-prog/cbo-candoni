import { describe, it, expect } from 'vitest';
import {
  checkDvCategory,
  checkDoubleEntry,
  checkAllotmentAgainstAppropriation,
  checkAllotmentWithdrawal,
  checkObligationAgainstAllotment,
  checkAugmentationExpenseClass,
  checkExpenseDebitsHaveFpp,
  checkRealignmentSet,
  planAugmentationAllotment,
  checkAugmentationAuthority,
  augmentationAuthorityKey,
  checkDvMath,
  checkLiquidation,
  computeReconciliation,
  checkReconciliationFinalizable,
  checkPeriodOpen,
  checkTrialBalance,
  findProbableDuplicates,
  outstandingAdvance,
} from './accounting-rules';
import { parsePeso, formatPeso, applyRate, netOfVat, amountInWords, sum } from './money';
import { agingBucket, periodRange, staleDate, daysBetween } from './dates';
import { renderDocumentNumber, counterId } from './numbering';

/**
 * These tests exercise the invariants the whole system rests on. They are
 * deliberately written in terms of realistic municipal figures rather than
 * round toy numbers, because the failures that matter are the ones involving
 * centavos and proportional allocation.
 */

describe('double entry', () => {
  it('accepts a balanced entry', () => {
    const r = checkDoubleEntry([
      { lineNo: 1, accountCode: '50203010', debit: 125_000_00, credit: 0 },
      { lineNo: 2, accountCode: '20101010', debit: 0, credit: 123_750_00 },
      { lineNo: 3, accountCode: '20201010', debit: 0, credit: 1_250_00 },
    ]);
    expect(r.ok).toBe(true);
  });

  it('rejects an entry that is out of balance by one centavo', () => {
    const r = checkDoubleEntry([
      { lineNo: 1, accountCode: '50203010', debit: 100_000_00, credit: 0 },
      { lineNo: 2, accountCode: '20101010', debit: 0, credit: 99_999_99 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('JEV_UNBALANCED');
    expect(r.violations[0].message).toContain('0.01');
  });

  it('rejects an empty entry', () => {
    expect(checkDoubleEntry([]).violations[0].code).toBe('JEV_EMPTY');
  });

  it('rejects a line carrying both a debit and a credit', () => {
    const r = checkDoubleEntry([
      { lineNo: 1, accountCode: '50203010', debit: 500_00, credit: 500_00 },
      { lineNo: 2, accountCode: '10101010', debit: 0, credit: 0 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain('LINE_BOTH_SIDES');
  });

  it('rejects a non-integer amount, which would mean pesos crept in', () => {
    const r = checkDoubleEntry([
      { lineNo: 1, accountCode: '50203010', debit: 1234.56, credit: 0 },
      { lineNo: 2, accountCode: '10101010', debit: 0, credit: 1234.56 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain('AMOUNT_NOT_INTEGER');
  });
});

describe('allotment control', () => {
  it('permits a release within the appropriation', () => {
    const r = checkAllotmentAgainstAppropriation({
      appropriationRevised: 5_000_000_00,
      forLaterRelease: 0,
      allotmentAlreadyReleased: 3_000_000_00,
      requestedRelease: 1_500_000_00,
    });
    expect(r.ok).toBe(true);
  });

  it('permits a release that exactly exhausts the appropriation', () => {
    const r = checkAllotmentAgainstAppropriation({
      appropriationRevised: 5_000_000_00,
      forLaterRelease: 0,
      allotmentAlreadyReleased: 3_000_000_00,
      requestedRelease: 2_000_000_00,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a release exceeding the appropriation by one centavo', () => {
    const r = checkAllotmentAgainstAppropriation({
      appropriationRevised: 5_000_000_00,
      forLaterRelease: 0,
      allotmentAlreadyReleased: 3_000_000_00,
      requestedRelease: 2_000_000_01,
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('ALLOTMENT_EXCEEDS_APPROPRIATION');
    expect((r.violations[0].details as { excess: number }).excess).toBe(1);
  });

  it('refuses a withdrawal that would drop released below obligated', () => {
    const r = checkAllotmentWithdrawal({
      allotmentAlreadyReleased: 1_000_000_00,
      obligated: 800_000_00,
      requestedWithdrawal: -300_000_00,
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('WITHDRAWAL_BELOW_OBLIGATIONS');
  });

  it('permits a withdrawal down to the obligated amount', () => {
    const r = checkAllotmentWithdrawal({
      allotmentAlreadyReleased: 1_000_000_00,
      obligated: 800_000_00,
      requestedWithdrawal: -200_000_00,
    });
    expect(r.ok).toBe(true);
  });
});

describe('budget control on obligations', () => {
  it('permits an obligation within the available allotment', () => {
    expect(
      checkObligationAgainstAllotment({
        allotmentReleased: 500_000_00,
        alreadyObligated: 100_000_00,
        requestedObligation: 300_000_00,
      }).ok,
    ).toBe(true);
  });

  it('permits an obligation that exactly exhausts the allotment', () => {
    expect(
      checkObligationAgainstAllotment({
        allotmentReleased: 500_000_00,
        alreadyObligated: 200_000_00,
        requestedObligation: 300_000_00,
      }).ok,
    ).toBe(true);
  });

  it('refuses an obligation exceeding the available allotment and reports the shortfall', () => {
    const r = checkObligationAgainstAllotment({
      allotmentReleased: 500_000_00,
      alreadyObligated: 300_000_00,
      requestedObligation: 250_000_00,
    });
    expect(r.ok).toBe(false);
    const d = r.violations[0].details as { available: number; excess: number };
    expect(d.available).toBe(200_000_00);
    expect(d.excess).toBe(50_000_00);
  });

  it('refuses a zero or negative obligation', () => {
    expect(
      checkObligationAgainstAllotment({
        allotmentReleased: 500_000_00,
        alreadyObligated: 0,
        requestedObligation: 0,
      }).violations[0].code,
    ).toBe('OBLIGATION_NOT_POSITIVE');
  });
});

describe('disbursement voucher arithmetic', () => {
  const lines = [
    { lineNo: 1, accountCode: '50203010', debit: 100_000_00, credit: 0 },
    { lineNo: 2, accountCode: '20101010', debit: 0, credit: 98_000_00 },
    { lineNo: 3, accountCode: '20201010', debit: 0, credit: 2_000_00 },
  ];

  it('accepts a voucher whose net equals gross less deductions', () => {
    const r = checkDvMath({
      grossAmount: 100_000_00,
      deductions: [{ amount: 2_000_00 }],
      netAmount: 98_000_00,
      accountLines: lines,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a voucher whose stated net does not follow from the deductions', () => {
    const r = checkDvMath({
      grossAmount: 100_000_00,
      deductions: [{ amount: 2_000_00 }],
      netAmount: 99_000_00,
      accountLines: lines,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain('DV_NET_MISMATCH');
  });

  it('refuses deductions larger than the gross amount', () => {
    const r = checkDvMath({
      grossAmount: 1_000_00,
      deductions: [{ amount: 1_500_00 }],
      netAmount: -500_00,
      accountLines: lines,
    });
    expect(r.violations.map((v) => v.code)).toContain('DEDUCTIONS_EXCEED_GROSS');
  });
});

describe('liquidation control', () => {
  it('accepts a full liquidation with no refund', () => {
    expect(
      checkLiquidation({
        amountGranted: 15_000_00,
        previouslyLiquidated: 0,
        previouslyRefunded: 0,
        amountLiquidated: 15_000_00,
        refundAmount: 0,
        reimbursementAmount: 0,
      }).ok,
    ).toBe(true);
  });

  it('accepts a partial liquidation with the balance refunded', () => {
    expect(
      checkLiquidation({
        amountGranted: 15_000_00,
        previouslyLiquidated: 0,
        previouslyRefunded: 0,
        amountLiquidated: 12_350_00,
        refundAmount: 2_650_00,
        reimbursementAmount: 0,
      }).ok,
    ).toBe(true);
  });

  it('refuses spending beyond the advance unless it is claimed as a reimbursement', () => {
    const r = checkLiquidation({
      amountGranted: 15_000_00,
      previouslyLiquidated: 0,
      previouslyRefunded: 0,
      amountLiquidated: 16_200_00,
      refundAmount: 0,
      reimbursementAmount: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('LIQ_EXCEEDS_ADVANCE');
  });

  it('accepts the excess when it is correctly claimed as a reimbursement', () => {
    expect(
      checkLiquidation({
        amountGranted: 15_000_00,
        previouslyLiquidated: 0,
        previouslyRefunded: 0,
        amountLiquidated: 16_200_00,
        refundAmount: 0,
        reimbursementAmount: 1_200_00,
      }).ok,
    ).toBe(true);
  });

  it('refuses a reimbursement that does not equal the excess', () => {
    const r = checkLiquidation({
      amountGranted: 15_000_00,
      previouslyLiquidated: 0,
      previouslyRefunded: 0,
      amountLiquidated: 16_200_00,
      refundAmount: 0,
      reimbursementAmount: 900_00,
    });
    expect(r.violations.map((v) => v.code)).toContain('LIQ_REIMBURSEMENT_MISMATCH');
  });

  it('accumulates across several partial liquidations', () => {
    // 30,000 already liquidated and 5,000 already refunded leaves 15,000 of
    // the 50,000 advance still to account for.
    const r = checkLiquidation({
      amountGranted: 50_000_00,
      previouslyLiquidated: 30_000_00,
      previouslyRefunded: 5_000_00,
      amountLiquidated: 14_000_00,
      refundAmount: 0,
      reimbursementAmount: 0,
    });
    expect(r.ok).toBe(true);
    expect(
      outstandingAdvance({ amountGranted: 50_000_00, amountLiquidated: 44_000_00, amountRefunded: 5_000_00 }),
    ).toBe(1_000_00);
  });

  it('counts prior liquidations when deciding whether the advance is exceeded', () => {
    // The same 50,000 advance: 16,000 now would take the total past it.
    const r = checkLiquidation({
      amountGranted: 50_000_00,
      previouslyLiquidated: 30_000_00,
      previouslyRefunded: 5_000_00,
      amountLiquidated: 16_000_00,
      refundAmount: 0,
      reimbursementAmount: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('LIQ_EXCEEDS_ADVANCE');
  });
});

describe('bank reconciliation', () => {
  it('computes the standard four-way reconciliation', () => {
    const t = computeReconciliation({
      balancePerBank: 1_250_000_00,
      depositsInTransit: 85_000_00,
      outstandingChecks: 132_500_00,
      bankAdjustments: 0,
      balancePerBooks: 1_203_700_00,
      bookAdjustments: -1_200_00,
    });
    expect(t.adjustedBankBalance).toBe(1_202_500_00);
    expect(t.adjustedBookBalance).toBe(1_202_500_00);
    expect(t.difference).toBe(0);
    expect(t.reconciled).toBe(true);
  });

  it('refuses to finalise with any difference at all, however small', () => {
    const r = checkReconciliationFinalizable({
      balancePerBank: 1_250_000_00,
      depositsInTransit: 85_000_00,
      outstandingChecks: 132_500_00,
      bankAdjustments: 0,
      balancePerBooks: 1_203_700_01,
      bookAdjustments: -1_200_00,
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('RECON_NOT_BALANCED');
  });
});

describe('accounting period control', () => {
  it('allows posting to an open or reopened period', () => {
    expect(checkPeriodOpen('OPEN', 'DV 100-26-09-0001').ok).toBe(true);
    expect(checkPeriodOpen('REOPENED', 'DV 100-26-09-0001').ok).toBe(true);
    expect(checkPeriodOpen(undefined, 'DV 100-26-09-0001').ok).toBe(true);
  });

  it('blocks posting to a closed or locked period', () => {
    expect(checkPeriodOpen('CLOSED', 'DV 1').violations[0].code).toBe('PERIOD_CLOSED');
    expect(checkPeriodOpen('TEMPORARILY_LOCKED', 'DV 1').violations[0].code).toBe('PERIOD_LOCKED');
  });
});

describe('trial balance', () => {
  it('foots when debits equal credits', () => {
    expect(
      checkTrialBalance([
        { debit: 500_000_00, credit: 0 },
        { debit: 0, credit: 500_000_00 },
      ]).ok,
    ).toBe(true);
  });

  it('reports a ledger that does not foot', () => {
    const r = checkTrialBalance([
      { debit: 500_000_00, credit: 0 },
      { debit: 0, credit: 499_999_99 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('TRIAL_BALANCE_OUT');
  });
});

describe('duplicate detection', () => {
  const existing = [
    { id: 'a', ref: 'DV 100-26-08-0021', payeeId: 'p1', amount: 45_000_00, date: '2026-08-14', invoiceNo: 'SI-9912' },
    { id: 'b', ref: 'DV 100-26-09-0004', payeeId: 'p2', amount: 45_000_00, date: '2026-09-02' },
  ];

  it('flags the same supplier invoice number regardless of amount', () => {
    const hits = findProbableDuplicates(
      { id: 'new', ref: 'DV new', payeeId: 'p1', amount: 12_000_00, date: '2026-09-20', invoiceNo: 'SI-9912' },
      existing,
    );
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('flags the same payee and amount within the window', () => {
    const hits = findProbableDuplicates(
      { id: 'new', ref: 'DV new', payeeId: 'p1', amount: 45_000_00, date: '2026-09-20' },
      existing,
    );
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('does not flag the same amount to a different payee', () => {
    const hits = findProbableDuplicates(
      { id: 'new', ref: 'DV new', payeeId: 'p3', amount: 45_000_00, date: '2026-09-20' },
      existing,
    );
    expect(hits).toHaveLength(0);
  });
});

describe('money', () => {
  it('parses Philippine-formatted input to centavos', () => {
    expect(parsePeso('1,234,567.89')).toBe(123_456_789);
    expect(parsePeso('₱1,234.56')).toBe(123_456);
    expect(parsePeso('1234')).toBe(123_400);
    expect(parsePeso('(1,234.56)')).toBe(-123_456);
    expect(parsePeso('')).toBeNull();
    expect(parsePeso('abc')).toBeNull();
  });

  it('rounds a third decimal place half-up', () => {
    expect(parsePeso('10.005')).toBe(1001);
    expect(parsePeso('10.004')).toBe(1000);
  });

  it('formats centavos as pesos', () => {
    expect(formatPeso(123_456_789)).toBe('₱1,234,567.89');
    expect(formatPeso(-123_456, { parens: true })).toBe('(₱1,234.56)');
    expect(formatPeso(0, { dash: true })).toBe('-');
  });

  it('survives a parse-format round trip without drift', () => {
    for (const s of ['0.01', '0.10', '1.00', '999,999.99', '12,345.67']) {
      expect(formatPeso(parsePeso(s)!, { symbol: false })).toBe(
        Number(s.replace(/,/g, '')).toLocaleString('en-PH', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      );
    }
  });

  it('applies a withholding rate rounded to the centavo', () => {
    // 2% expanded withholding on ₱45,678.90
    expect(applyRate(4_567_890, 0.02)).toBe(91_358);
    // 5% final VAT withholding on the net of VAT
    expect(netOfVat(1_120_000)).toBe(1_000_000);
    expect(applyRate(netOfVat(1_120_000), 0.05)).toBe(50_000);
  });

  it('writes amounts in words for the face of a voucher', () => {
    expect(amountInWords(123_456)).toBe('ONE THOUSAND TWO HUNDRED THIRTY FOUR PESOS AND 56/100 ONLY');
    expect(amountInWords(100)).toBe('ONE PESO AND 00/100 ONLY');
    expect(amountInWords(0)).toBe('ZERO PESOS AND 00/100 ONLY');
    expect(amountInWords(1_000_000_00)).toBe('ONE MILLION PESOS AND 00/100 ONLY');
  });

  it('sums without floating point drift', () => {
    const ten = Array.from({ length: 10 }, () => 10); // ten centavos, ten times
    expect(sum(ten)).toBe(100);
  });
});

describe('dates and aging', () => {
  it('buckets cash advances by days overdue', () => {
    expect(agingBucket('2026-09-30', '2026-09-21')).toBe('CURRENT');
    expect(agingBucket('2026-09-01', '2026-09-21')).toBe('D1_30');
    expect(agingBucket('2026-07-01', '2026-09-21')).toBe('D61_90');
    expect(agingBucket('2026-01-01', '2026-09-21')).toBe('OVER_90');
  });

  it('computes a period range including the last day of the month', () => {
    expect(periodRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange(2026, 9)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('computes the staleness date six months out', () => {
    expect(staleDate('2026-09-21')).toBe('2027-03-21');
    expect(staleDate('2026-08-31')).toBe('2027-02-28');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-09-01', '2026-09-21')).toBe(20);
  });
});

describe('document numbering', () => {
  it('renders the Candoni numbering format', () => {
    expect(
      renderDocumentNumber('{BOOK}-{YY}-{MM}-{SEQ}', {
        bookCode: '100',
        fiscalYear: 2026,
        month: 9,
        sequence: 1,
      }),
    ).toBe('100-26-09-0001');
  });

  it('derives a counter id that encodes the reset policy', () => {
    expect(
      counterId({ docType: 'DV', fundCode: 'GF', fiscalYear: 2026, month: 9, resetOn: 'MONTH', perFund: true }),
    ).toBe('DV__GF__2026__09');
    expect(
      counterId({ docType: 'ALLOT', fundCode: 'GF', fiscalYear: 2026, month: 9, resetOn: 'YEAR', perFund: true }),
    ).toBe('ALLOT__GF__2026');
  });
});

// ---------------------------------------------------------------------------
// Realignment
// ---------------------------------------------------------------------------

describe('checkRealignmentSet', () => {
  it('accepts a balanced pair', () => {
    expect(
      checkRealignmentSet([
        { lineNo: 1, amount: -20000000 },
        { lineNo: 2, amount: 20000000 },
      ]).ok,
    ).toBe(true);
  });

  it('accepts one source split across several destinations', () => {
    expect(
      checkRealignmentSet([
        { lineNo: 1, amount: -50000000 },
        { lineNo: 2, amount: 30000000 },
        { lineNo: 3, amount: 15000000 },
        { lineNo: 4, amount: 5000000 },
      ]).ok,
    ).toBe(true);
  });

  it('refuses a single line, which is half a budget act', () => {
    const result = checkRealignmentSet([{ lineNo: 1, amount: -20000000 }]);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('REALIGNMENT_NEEDS_TWO_LINES');
  });

  it('refuses a set that does not come to zero, and says by how much', () => {
    const result = checkRealignmentSet([
      { lineNo: 1, amount: -20000000 },
      { lineNo: 2, amount: 25000000 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('REALIGNMENT_NOT_BALANCED');
    expect(result.violations[0].details?.net).toBe(5000000);
    expect(result.violations[0].message).toContain('50000.00');
  });

  it('refuses a set that is all zeroes', () => {
    const result = checkRealignmentSet([
      { lineNo: 1, amount: 0 },
      { lineNo: 2, amount: 0 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('REALIGNMENT_MOVES_NOTHING');
  });

  it('tolerates a zero line alongside a real pair', () => {
    expect(
      checkRealignmentSet([
        { lineNo: 1, amount: 20000000 },
        { lineNo: 2, amount: -20000000 },
        { lineNo: 3, amount: 0 },
      ]).ok,
    ).toBe(true);
  });

  /**
   * There is no separate "one-sided" violation, and this is why: a set of
   * non-negative amounts that sums to zero is a set of zeroes. Any all-gives
   * or all-takes set therefore fails on the balance check first, and only the
   * all-zero case reaches the last rule. A one-sided check would be a branch
   * no input could ever take.
   */
  it('refuses an all-gives set on the balance rule, not a one-sided rule', () => {
    const result = checkRealignmentSet([
      { lineNo: 1, amount: 20000000 },
      { lineNo: 2, amount: 30000000 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('REALIGNMENT_NOT_BALANCED');
  });
});

// ---------------------------------------------------------------------------
// An expense must name its budget line
// ---------------------------------------------------------------------------

describe('checkExpenseDebitsHaveFpp', () => {
  const isExpense = (code: string) => code.startsWith('5-');

  it('accepts an expense debit that names a budget line', () => {
    expect(
      checkExpenseDebitsHaveFpp(
        [{ lineNo: 1, accountCode: '5-02-03-010', debit: 100000, credit: 0, fppCode: '5-02-03-010' }],
        isExpense,
      ).ok,
    ).toBe(true);
  });

  it('refuses an expense debit with no budget line, and names the line', () => {
    const result = checkExpenseDebitsHaveFpp(
      [
        { lineNo: 1, accountCode: '5-02-03-010', debit: 100000, credit: 0 },
        { lineNo: 2, accountCode: '2-01-01-010', debit: 0, credit: 100000 },
      ],
      isExpense,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('EXPENSE_WITHOUT_FPP');
    expect(result.violations[0].details?.lineNos).toEqual([1]);
  });

  /**
   * The credit to Accounts Payable, the cash line, the opening balance. None
   * of them is budget expenditure, and an FPP put on one would foot into the
   * comparison of budget against actual as spending that never happened.
   */
  it('leaves every line that is not an expense debit alone', () => {
    expect(
      checkExpenseDebitsHaveFpp(
        [
          { lineNo: 1, accountCode: '1-01-01-010', debit: 500000, credit: 0 },
          { lineNo: 2, accountCode: '2-01-01-010', debit: 0, credit: 500000 },
          { lineNo: 3, accountCode: '4-01-02-040', debit: 0, credit: 250000 },
        ],
        isExpense,
      ).ok,
    ).toBe(true);
  });

  /**
   * A credit to an expense account undoes something already charged and
   * carries the FPP of whatever it undoes. Requiring one here would be asking
   * the same question twice, the second time of somebody who may not know.
   */
  it('does not require a budget line on a credit to an expense', () => {
    expect(
      checkExpenseDebitsHaveFpp(
        [{ lineNo: 1, accountCode: '5-02-03-010', debit: 0, credit: 100000 }],
        isExpense,
      ).ok,
    ).toBe(true);
  });

  it('ignores stray spacing around an account code', () => {
    expect(
      checkExpenseDebitsHaveFpp(
        [{ lineNo: 1, accountCode: ' 5-02-03-010 ', debit: 100000, credit: 0 }],
        isExpense,
      ).ok,
    ).toBe(false);
  });

  it('names every offending line, not only the first', () => {
    const result = checkExpenseDebitsHaveFpp(
      [
        { lineNo: 1, accountCode: '5-02-03-010', debit: 100000, credit: 0 },
        { lineNo: 2, accountCode: '5-02-01-010', debit: 50000, credit: 0 },
        { lineNo: 3, accountCode: '2-01-01-010', debit: 0, credit: 150000 },
      ],
      isExpense,
    );
    expect(result.violations[0].details?.lineNos).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Augmentation
// ---------------------------------------------------------------------------

describe('checkAugmentationExpenseClass', () => {
  it('accepts a move within one expense class', () => {
    expect(
      checkAugmentationExpenseClass([
        { lineNo: 1, expenseClass: 'MOOE', amount: -50_000_00 },
        { lineNo: 2, expenseClass: 'MOOE', amount: 50_000_00 },
      ]).ok,
    ).toBe(true);
  });

  /**
   * MOOE savings moved into Capital Outlay is not a borderline case: it is
   * spending the Sanggunian never authorised, made under an omnibus authority
   * that does not reach it. The right instrument exists and is one ordinance
   * away, so the message names it.
   */
  it('refuses a move across expense classes and names the other instrument', () => {
    const result = checkAugmentationExpenseClass([
      { lineNo: 1, expenseClass: 'MOOE', amount: -50_000_00 },
      { lineNo: 2, expenseClass: 'CO', amount: 50_000_00 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('AUGMENTATION_CROSSES_EXPENSE_CLASS');
    expect(result.violations[0].message).toContain('supplemental budget');
    expect(result.violations[0].details?.expenseClasses).toEqual(['CO', 'MOOE']);
  });

  /**
   * A zero line is a row somebody began and did not finish. Letting its class
   * fail the set would refuse a lawful augmentation over a blank row.
   */
  it('ignores the class of a zero line', () => {
    expect(
      checkAugmentationExpenseClass([
        { lineNo: 1, expenseClass: 'MOOE', amount: -50_000_00 },
        { lineNo: 2, expenseClass: 'MOOE', amount: 50_000_00 },
        { lineNo: 3, expenseClass: 'CO', amount: 0 },
      ]).ok,
    ).toBe(true);
  });

  it('accepts a single line, which the balance rule refuses on its own grounds', () => {
    expect(
      checkAugmentationExpenseClass([{ lineNo: 1, expenseClass: 'PS', amount: -1_000_00 }]).ok,
    ).toBe(true);
  });

  /**
   * LBE Form No. 2, Note 2, second sentence: "Savings from CO cannot be used
   * for augmentation purposes."
   *
   * This is a SEPARATE prohibition from the same-class rule, and the one CBO
   * used to miss: a set drawn from Capital Outlay and applied to Capital
   * Outlay never crosses a class, so the class rule passed it.
   */
  it('refuses Capital Outlay savings as a source, even within Capital Outlay', () => {
    const result = checkAugmentationExpenseClass([
      { lineNo: 1, expenseClass: 'CO', amount: -800_000_00 },
      { lineNo: 2, expenseClass: 'CO', amount: 800_000_00 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('AUGMENTATION_FROM_CAPITAL_OUTLAY');
    expect(result.violations[0].message).toContain('supplemental budget');
    expect(result.violations[0].details?.lineNos).toEqual([1]);
  });

  /**
   * Capital Outlay on the receiving side is a different fault, and the reader
   * needs the message that matches what they did.
   */
  it('still calls a move INTO Capital Outlay a crossing, not a CO source', () => {
    const result = checkAugmentationExpenseClass([
      { lineNo: 1, expenseClass: 'MOOE', amount: -50_000_00 },
      { lineNo: 2, expenseClass: 'CO', amount: 50_000_00 },
    ]);
    expect(result.violations[0].code).toBe('AUGMENTATION_CROSSES_EXPENSE_CLASS');
  });

  it('names every Capital Outlay line the savings were taken from', () => {
    const result = checkAugmentationExpenseClass([
      { lineNo: 1, expenseClass: 'CO', amount: -300_000_00 },
      { lineNo: 2, expenseClass: 'CO', amount: -200_000_00 },
      { lineNo: 3, expenseClass: 'CO', amount: 500_000_00 },
    ]);
    expect(result.violations[0].details?.lineNos).toEqual([1, 2]);
  });

  it('ignores a Capital Outlay line left at zero', () => {
    expect(
      checkAugmentationExpenseClass([
        { lineNo: 1, expenseClass: 'PS', amount: -10_000_00 },
        { lineNo: 2, expenseClass: 'PS', amount: 10_000_00 },
        { lineNo: 3, expenseClass: 'CO', amount: 0 },
      ]).ok,
    ).toBe(true);
  });

  it('accepts an empty set rather than inventing a violation', () => {
    expect(checkAugmentationExpenseClass([]).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The For Later Release hold
// ---------------------------------------------------------------------------

describe('checkAllotmentAgainstAppropriation with a hold', () => {
  const base = {
    appropriationRevised: 1_000_000_00,
    allotmentAlreadyReleased: 0,
  };

  it('behaves as before when nothing is held', () => {
    expect(
      checkAllotmentAgainstAppropriation({
        ...base,
        forLaterRelease: 0,
        requestedRelease: 1_000_000_00,
      }).ok,
    ).toBe(true);
  });

  /**
   * The field is REQUIRED, and this test is here to say why rather than to
   * exercise arithmetic.
   *
   * It was optional, defaulting to nothing, so that the call sites that
   * already existed would keep compiling. They did, and they kept ignoring
   * the hold: three of the four places that check an allotment went on
   * releasing authority the Budget Officer had withheld. An optional
   * parameter on a safety rule defaults to no safety, and the compiler is
   * what makes a new call site answer the question now.
   */
  it('cannot be called without saying what is held', () => {
    // @ts-expect-error forLaterRelease is required
    checkAllotmentAgainstAppropriation({ ...base, requestedRelease: 1_00 });
  });

  /**
   * The whole point of the hold. Without this, CBO would let the Budget
   * Officer release authority they had explicitly decided to withhold, and
   * would do it silently because everything else still foots.
   */
  it('refuses a release that reaches into the held part', () => {
    const result = checkAllotmentAgainstAppropriation({
      ...base,
      forLaterRelease: 300_000_00,
      requestedRelease: 800_000_00,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0].details?.excess).toBe(100_000_00);
    expect(result.violations[0].message).toContain('held for later release');
  });

  it('allows a release up to the unheld part exactly', () => {
    expect(
      checkAllotmentAgainstAppropriation({
        ...base,
        forLaterRelease: 300_000_00,
        requestedRelease: 700_000_00,
      }).ok,
    ).toBe(true);
  });

  it('counts what is already released against the unheld part', () => {
    expect(
      checkAllotmentAgainstAppropriation({
        appropriationRevised: 1_000_000_00,
        forLaterRelease: 300_000_00,
        allotmentAlreadyReleased: 500_000_00,
        requestedRelease: 300_000_00,
      }).ok,
    ).toBe(false);
  });

  /**
   * A withdrawal is always permitted against the appropriation, hold or no
   * hold. Whether it may be withdrawn is the obligation question, and that is
   * checkAllotmentWithdrawal's.
   */
  it('lets a withdrawal through whatever is held', () => {
    expect(
      checkAllotmentAgainstAppropriation({
        appropriationRevised: 1_000_000_00,
        forLaterRelease: 900_000_00,
        allotmentAlreadyReleased: 100_000_00,
        requestedRelease: -50_000_00,
      }).ok,
    ).toBe(true);
  });
});

describe('checkDvCategory', () => {
  const isExpense = (code: string) => code.startsWith('5');

  const line = (over: Record<string, unknown> = {}) => ({
    lineNo: 1,
    accountCode: '20101010',
    debit: 0,
    credit: 1_000_00,
    ...over,
  });

  it('passes an obligated voucher that carries an obligation', () => {
    const result = checkDvCategory(
      {
        category: 'OBLIGATED',
        hasObligation: true,
        lines: [line({ accountCode: '50201010', debit: 1_000_00, credit: 0, fppCode: '1011' })],
      },
      isExpense,
    );
    expect(result.ok).toBe(true);
  });

  /**
   * The hole this rule closes. Before the category existed, a voucher with no
   * obligation simply went through, and nothing distinguished a deliberate
   * trust settlement from an obligation somebody forgot to attach.
   */
  it('refuses an obligated voucher with no obligation behind it', () => {
    const result = checkDvCategory(
      { category: 'OBLIGATED', hasObligation: false, lines: [line()] },
      isExpense,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('DV_OBLIGATION_MISSING');
  });

  it('passes a trust liability that debits a liability', () => {
    const result = checkDvCategory(
      {
        category: 'TRUST_LIABILITY',
        hasObligation: false,
        lines: [
          line({ lineNo: 1, accountCode: '20401010', debit: 1_000_00, credit: 0 }),
          line({ lineNo: 2, accountCode: '10101010', debit: 0, credit: 1_000_00 }),
        ],
      },
      isExpense,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a trust liability that draws on an obligation', () => {
    const result = checkDvCategory(
      { category: 'TRUST_LIABILITY', hasObligation: true, lines: [line()] },
      isExpense,
    );
    expect(result.violations[0].code).toBe('DV_TRUST_HAS_OBLIGATION');
  });

  /**
   * The half that makes the category a control rather than a label. An expense
   * on a trust-liability voucher is spending with no obligation and no
   * allotment, wearing the one label that excuses the missing obligation.
   */
  it('refuses a trust liability that debits an expense', () => {
    const result = checkDvCategory(
      {
        category: 'TRUST_LIABILITY',
        hasObligation: false,
        lines: [
          line({ lineNo: 1, accountCode: '50203010', debit: 5_000_00, credit: 0 }),
          line({ lineNo: 2, accountCode: '10101010', debit: 0, credit: 5_000_00 }),
        ],
      },
      isExpense,
    );
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.code === 'DV_TRUST_DEBITS_EXPENSE');
    expect(violation).toBeDefined();
    expect(violation?.details).toMatchObject({ lineNos: [1] });
  });

  /**
   * A CREDIT to an expense reverses something already charged. It is not new
   * spending, and refusing it would make a correction impossible to record.
   */
  it('allows a credit to an expense on a trust liability', () => {
    const result = checkDvCategory(
      {
        category: 'TRUST_LIABILITY',
        hasObligation: false,
        lines: [line({ accountCode: '50203010', debit: 0, credit: 1_000_00 })],
      },
      isExpense,
    );
    expect(result.ok).toBe(true);
  });

  it('reports both faults when a trust liability has an obligation and an expense', () => {
    const result = checkDvCategory(
      {
        category: 'TRUST_LIABILITY',
        hasObligation: true,
        lines: [line({ accountCode: '50203010', debit: 1_00, credit: 0 })],
      },
      isExpense,
    );
    expect(result.violations.map((v) => v.code).sort()).toEqual([
      'DV_TRUST_DEBITS_EXPENSE',
      'DV_TRUST_HAS_OBLIGATION',
    ]);
  });

  it('refuses a category it does not recognise rather than letting it through', () => {
    const result = checkDvCategory(
      { category: 'ORDINARY', hasObligation: false, lines: [line()] },
      isExpense,
    );
    expect(result.violations[0].code).toBe('DV_CATEGORY_UNKNOWN');
  });

  /**
   * An unclassified voucher must not pass by default. A missing category is
   * how every pre-existing voucher looks, and treating that as "obligated, no
   * obligation needed" would reopen the hole for exactly the records nobody
   * revisits.
   */
  it('refuses an empty category', () => {
    const result = checkDvCategory(
      { category: '', hasObligation: true, lines: [line()] },
      isExpense,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('DV_CATEGORY_UNKNOWN');
  });
});

// ---------------------------------------------------------------------------

describe('planAugmentationAllotment', () => {
  /**
   * The rule under test: savings come out of unreleased appropriation first,
   * and only what cannot be found there is taken back out of the released
   * allotment. Whatever is taken back is released on the augmented side, so
   * the fund's total allotment never changes.
   */
  const line = (over: Partial<Parameters<typeof planAugmentationAllotment>[0][number]>) => ({
    lineNo: 1,
    accountCode: '50203010',
    accountName: 'Office Supplies Expenses',
    officeName: 'Mayor',
    amount: 0,
    appropriationRevised: 0,
    allotmentReleased: 0,
    obligated: 0,
    forLaterRelease: 0,
    ...over,
  });

  it('moves allotment peso for peso when the source is fully released', () => {
    const plan = planAugmentationAllotment([
      line({ lineNo: 1, amount: -40_000, appropriationRevised: 100_000, allotmentReleased: 100_000 }),
      line({ lineNo: 2, amount: 40_000, appropriationRevised: 50_000 }),
    ]);

    expect(plan.ok).toBe(true);
    expect(plan.totalMoved).toBe(40_000);
    expect(plan.moves).toEqual([
      { lineNo: 1, allotmentDelta: -40_000 },
      { lineNo: 2, allotmentDelta: 40_000 },
    ]);
  });

  it('refuses an augmentation from a line whose allotment is not released', () => {
    // An augmentation is made AFTER the allotment: savings are what is left of
    // a released allotment. A line with none has nothing to call savings, and
    // letting it through would leave the augmented item unable to obligate.
    const plan = planAugmentationAllotment([
      line({ lineNo: 1, amount: -50_000, appropriationRevised: 100_000, allotmentReleased: 0 }),
      line({ lineNo: 2, amount: 50_000, appropriationRevised: 20_000 }),
    ]);

    expect(plan.ok).toBe(false);
    expect(plan.violations[0].code).toBe('AUGMENTATION_BEFORE_ALLOTMENT');
    expect(plan.moves).toEqual([]);
  });

  it('moves the full amount even where appropriation is left unreleased', () => {
    // 20,000 of the appropriation was never released. That is not savings, so
    // the whole 50,000 still comes out of the released allotment.
    const plan = planAugmentationAllotment([
      line({ lineNo: 1, amount: -50_000, appropriationRevised: 100_000, allotmentReleased: 80_000 }),
      line({ lineNo: 2, amount: 50_000, appropriationRevised: 20_000 }),
    ]);

    expect(plan.totalMoved).toBe(50_000);
    expect(plan.moves).toEqual([
      { lineNo: 1, allotmentDelta: -50_000 },
      { lineNo: 2, allotmentDelta: 50_000 },
    ]);
  });

  it('refuses where the released allotment cannot cover what is taken', () => {
    const plan = planAugmentationAllotment([
      line({ lineNo: 1, amount: -50_000, appropriationRevised: 100_000, allotmentReleased: 30_000 }),
      line({ lineNo: 2, amount: 50_000, appropriationRevised: 20_000 }),
    ]);

    expect(plan.ok).toBe(false);
    expect(plan.violations[0].code).toBe('AUGMENTATION_ALLOTMENT_OBLIGATED');
  });

  describe('under a supplemental budget, which is a different act', () => {
    // Section 321: the Sanggunian is re-appropriating and may move
    // appropriation that was never released as allotment.
    it('takes the savings from unreleased appropriation first', () => {
      const plan = planAugmentationAllotment(
        [
          line({ lineNo: 1, amount: -50_000, appropriationRevised: 100_000, allotmentReleased: 30_000 }),
          line({ lineNo: 2, amount: 50_000, appropriationRevised: 20_000 }),
        ],
        'SUPPLEMENTAL',
      );

      expect(plan.ok).toBe(true);
      expect(plan.totalMoved).toBe(0);
      expect(plan.moves).toEqual([]);
    });

    it('moves only the shortfall', () => {
      const plan = planAugmentationAllotment(
        [
          line({ lineNo: 1, amount: -50_000, appropriationRevised: 100_000, allotmentReleased: 80_000 }),
          line({ lineNo: 2, amount: 50_000, appropriationRevised: 20_000 }),
        ],
        'SUPPLEMENTAL',
      );

      expect(plan.totalMoved).toBe(30_000);
    });

    it('allows a source with no allotment released at all', () => {
      const plan = planAugmentationAllotment(
        [
          line({ lineNo: 1, amount: -50_000, appropriationRevised: 100_000, allotmentReleased: 0 }),
          line({ lineNo: 2, amount: 50_000, appropriationRevised: 20_000 }),
        ],
        'SUPPLEMENTAL',
      );

      expect(plan.ok).toBe(true);
      expect(plan.totalMoved).toBe(0);
    });
  });

  it('refuses to take allotment that is already obligated', () => {
    const plan = planAugmentationAllotment([
      line({
        lineNo: 1,
        amount: -50_000,
        appropriationRevised: 100_000,
        allotmentReleased: 100_000,
        obligated: 90_000,
      }),
      line({ lineNo: 2, amount: 50_000, appropriationRevised: 20_000 }),
    ]);

    expect(plan.ok).toBe(false);
    expect(plan.violations[0].code).toBe('AUGMENTATION_ALLOTMENT_OBLIGATED');
    // Nothing is half-done: a refused plan moves nothing at all.
    expect(plan.moves).toEqual([]);
    expect(plan.totalMoved).toBe(0);
  });

  it('refuses where the augmented line is held for later release', () => {
    const plan = planAugmentationAllotment([
      line({ lineNo: 1, amount: -40_000, appropriationRevised: 100_000, allotmentReleased: 100_000 }),
      line({ lineNo: 2, amount: 40_000, appropriationRevised: 20_000, forLaterRelease: 60_000 }),
    ]);

    expect(plan.ok).toBe(false);
    expect(plan.violations[0].code).toBe('AUGMENTATION_ALLOTMENT_HELD');
    expect(plan.moves).toEqual([]);
  });

  it('apportions across several augmented items and keeps the centavos exact', () => {
    // Under a supplemental budget the withdrawn total can be less than the
    // appropriation moved, which is when the apportionment becomes visible.
    const plan = planAugmentationAllotment(
      [
        line({ lineNo: 1, amount: -100_000, appropriationRevised: 130_000, allotmentReleased: 100_000 }),
        line({ lineNo: 2, amount: 33_333, appropriationRevised: 10_000 }),
        line({ lineNo: 3, amount: 66_667, appropriationRevised: 10_000 }),
      ],
      'SUPPLEMENTAL',
    );

    expect(plan.ok).toBe(true);
    expect(plan.totalMoved).toBe(70_000);
    // 23,333.1 and 46,666.9 - the odd centavo goes to the larger item.
    expect(plan.moves).toEqual([
      { lineNo: 1, allotmentDelta: -70_000 },
      { lineNo: 2, allotmentDelta: 23_333 },
      { lineNo: 3, allotmentDelta: 46_667 },
    ]);
  });

  it('takes from several sources at once', () => {
    const plan = planAugmentationAllotment([
      line({ lineNo: 1, amount: -30_000, appropriationRevised: 30_000, allotmentReleased: 30_000 }),
      line({ lineNo: 2, amount: -20_000, appropriationRevised: 40_000, allotmentReleased: 25_000 }),
      line({ lineNo: 3, amount: 50_000, appropriationRevised: 10_000 }),
    ]);

    expect(plan.totalMoved).toBe(50_000);
    expect(plan.moves).toEqual([
      { lineNo: 1, allotmentDelta: -30_000 },
      { lineNo: 2, allotmentDelta: -20_000 },
      { lineNo: 3, allotmentDelta: 50_000 },
    ]);
  });

  it('never changes the total allotment of the fund', () => {
    const plan = planAugmentationAllotment([
      line({ lineNo: 1, amount: -70_000, appropriationRevised: 90_000, allotmentReleased: 90_000 }),
      line({ lineNo: 2, amount: 25_000, appropriationRevised: 10_000 }),
      line({ lineNo: 3, amount: 45_000, appropriationRevised: 10_000 }),
    ]);

    expect(plan.moves.reduce((s, m) => s + m.allotmentDelta, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('checkAugmentationAuthority', () => {
  /**
   * Section 336 grants the power only where the annual budget's General
   * Provisions carry the omnibus authority. CBO cannot read an ordinance, so
   * the whole of this rule is: do not assume one.
   */
  const authorised = {
    [augmentationAuthorityKey(2026, 'GF')]: {
      ordinanceNo: 'No. 2025-14',
      generalProvisionsSection: 'Section 12',
    },
  };

  it('allows an augmentation once the ordinance and section are recorded', () => {
    expect(
      checkAugmentationAuthority({ authority: authorised, fiscalYear: 2026, fundCode: 'GF' }).ok,
    ).toBe(true);
  });

  it('refuses when nothing has been recorded at all', () => {
    const result = checkAugmentationAuthority({
      authority: undefined,
      fiscalYear: 2026,
      fundCode: 'GF',
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('AUGMENTATION_NOT_AUTHORISED');
  });

  it('refuses for a year that has not been recorded, even though another has', () => {
    // The authority is granted by one annual ordinance and does not carry over.
    expect(
      checkAugmentationAuthority({ authority: authorised, fiscalYear: 2027, fundCode: 'GF' }).ok,
    ).toBe(false);
  });

  it('refuses for a fund that has not been recorded', () => {
    // The SEF has its own budget and its own General Provisions.
    expect(
      checkAugmentationAuthority({ authority: authorised, fiscalYear: 2026, fundCode: 'SEF' }).ok,
    ).toBe(false);
  });

  it('refuses a half-filled entry', () => {
    const half = {
      [augmentationAuthorityKey(2026, 'GF')]: {
        ordinanceNo: 'No. 2025-14',
        generalProvisionsSection: '   ',
      },
    };
    expect(
      checkAugmentationAuthority({ authority: half, fiscalYear: 2026, fundCode: 'GF' }).ok,
    ).toBe(false);
  });

  it('matches the fund code whatever case it is given in', () => {
    expect(
      checkAugmentationAuthority({ authority: authorised, fiscalYear: 2026, fundCode: 'gf' }).ok,
    ).toBe(true);
  });

  it('names the year and the fund in the message, so it says what to record', () => {
    const result = checkAugmentationAuthority({
      authority: undefined,
      fiscalYear: 2026,
      fundCode: 'SEF',
    });
    expect(result.violations[0].message).toContain('2026');
    expect(result.violations[0].message).toContain('SEF');
  });
});
