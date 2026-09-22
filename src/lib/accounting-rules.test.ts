import { describe, it, expect } from 'vitest';
import {
  checkDoubleEntry,
  checkAllotmentAgainstAppropriation,
  checkAllotmentWithdrawal,
  checkObligationAgainstAllotment,
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
      allotmentAlreadyReleased: 3_000_000_00,
      requestedRelease: 1_500_000_00,
    });
    expect(r.ok).toBe(true);
  });

  it('permits a release that exactly exhausts the appropriation', () => {
    const r = checkAllotmentAgainstAppropriation({
      appropriationRevised: 5_000_000_00,
      allotmentAlreadyReleased: 3_000_000_00,
      requestedRelease: 2_000_000_00,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a release exceeding the appropriation by one centavo', () => {
    const r = checkAllotmentAgainstAppropriation({
      appropriationRevised: 5_000_000_00,
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
