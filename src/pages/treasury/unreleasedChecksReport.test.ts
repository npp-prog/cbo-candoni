import { describe, it, expect } from 'vitest';
import { buildUnreleasedChecks, totalUnreleased, type SucCheck } from './unreleasedChecksReport';

const chk = (over: Partial<SucCheck> = {}): SucCheck => ({
  id: 'C1',
  checkNo: '0001234',
  checkDate: '2026-12-18',
  fundCode: 'GF',
  bankAccountId: 'BA1',
  bankName: 'Land Bank of the Philippines',
  bankAccountNumber: '1234-5678-90',
  dvId: 'DV1',
  dvNo: 'DV-2026-0455',
  payeeName: 'Rivera Hardware',
  particulars: 'Supply of cement, Barangay Payauan road',
  netAmount: 145_000_00,
  status: 'SIGNED',
  ...over,
});

const YEAR_END = '2026-12-31';
const build = (checks: SucCheck[], over: Partial<Parameters<typeof buildUnreleasedChecks>[0]> = {}) =>
  buildUnreleasedChecks({ checks, asOf: YEAR_END, ...over });

describe('which checks belong on the schedule', () => {
  it.each(['PREPARED', 'FOR_SIGNATURE', 'SIGNED'])('lists a %s check', (status) => {
    expect(build([chk({ status })])[0].rows).toHaveLength(1);
  });

  it('leaves out a check already handed over at the date', () => {
    expect(build([chk({ status: 'RELEASED', dateReleased: '2026-12-20' })])).toEqual([]);
  });

  /**
   * The case the whole as-at rule exists for. A check drawn in December and
   * handed over in January was unreleased on 31 December, and the journal
   * voucher that restores cash at 31 December has to include it.
   */
  it('lists a check released AFTER the date it is struck at', () => {
    const sheets = build([chk({ status: 'RELEASED', dateReleased: '2027-01-08' })]);
    expect(sheets[0].rows).toHaveLength(1);
    expect(sheets[0].rows[0].releasedLater).toBe(true);
    expect(sheets[0].rows[0].dateReleased).toBe('2027-01-08');
  });

  it('marks a check still unreleased today as not released later', () => {
    expect(build([chk()])[0].rows[0].releasedLater).toBe(false);
  });

  it('counts a cleared check released after the date, since clearing implies release', () => {
    expect(build([chk({ status: 'CLEARED', dateReleased: '2027-01-15' })])[0].rows).toHaveLength(1);
  });

  it('leaves out a check not yet drawn at the date', () => {
    expect(build([chk({ checkDate: '2027-01-04' })])).toEqual([]);
  });

  it('keeps a check drawn exactly on the date', () => {
    expect(build([chk({ checkDate: YEAR_END })])[0].rows).toHaveLength(1);
  });

  /**
   * Patch 45 left every one of these out and said CBO did not record when a
   * check was cancelled. It does - `cancelledBy` carries the moment - and
   * these are the cases that were being dropped.
   */
  it('lists a check cancelled AFTER the date, which was live on it', () => {
    const sheets = build([chk({ status: 'CANCELLED', cancelledAt: '2027-02-11' })]);
    expect(sheets[0].rows).toHaveLength(1);
    expect(sheets[0].rows[0].cancelledLater).toBe(true);
  });

  it('leaves out a check already cancelled by the date', () => {
    expect(build([chk({ status: 'CANCELLED', cancelledAt: '2026-12-15' })])).toEqual([]);
  });

  /**
   * The safe way round. Without a recorded moment the check is treated as
   * already cancelled, because the alternative restores cash the municipality
   * may not be holding.
   */
  it('leaves out a cancelled check with no recorded moment', () => {
    expect(build([chk({ status: 'CANCELLED' })])).toEqual([]);
  });

  it('leaves out a check cancelled later that had already been released', () => {
    expect(
      build([
        chk({ status: 'CANCELLED', cancelledAt: '2027-02-11', dateReleased: '2026-11-20' }),
      ]),
    ).toEqual([]);
  });

  /**
   * Going stale does not hand a check to the payee. A stale check that was
   * never released is money still sitting in the bank.
   */
  it('lists a stale check that was never released', () => {
    const sheets = build([chk({ status: 'STALE' })]);
    expect(sheets[0].rows).toHaveLength(1);
    expect(sheets[0].rows[0].staleUnreleased).toBe(true);
  });

  it('leaves out a stale check that had been released by the date', () => {
    expect(build([chk({ status: 'STALE', dateReleased: '2026-06-30' })])).toEqual([]);
  });

  /**
   * Still left out, and deliberately. The replacement stands in its place and
   * is on this schedule itself if it is unreleased; counting both would
   * restore the same money twice through the year-end journal voucher.
   */
  it('leaves out a replaced check, whose replacement stands in its place', () => {
    expect(build([chk({ status: 'REPLACED' })])).toEqual([]);
  });
});

describe('one sheet per bank account', () => {
  /** Instruction 1: the sheet is the basis of one journal voucher per account. */
  it('splits checks across the accounts they were drawn on', () => {
    const sheets = build([
      chk(),
      chk({ id: 'C2', bankAccountId: 'BA2', bankName: 'Development Bank', bankAccountNumber: '999' }),
    ]);
    expect(sheets).toHaveLength(2);
    expect(sheets.map((s) => s.bankAccountId).sort()).toEqual(['BA1', 'BA2']);
  });

  it('totals each sheet on its own', () => {
    const sheets = build([chk(), chk({ id: 'C2', netAmount: 55_000_00 })]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].total).toBe(200_000_00);
  });

  it('can be limited to one account', () => {
    const checks = [chk(), chk({ id: 'C2', bankAccountId: 'BA2' })];
    expect(build(checks, { bankAccountId: 'BA2' })).toHaveLength(1);
  });

  it('orders sheets by bank, then by account number', () => {
    const sheets = build([
      chk({ bankAccountId: 'B', bankName: 'Zamora Bank' }),
      chk({ id: 'C2', bankAccountId: 'A', bankName: 'Aurora Bank' }),
    ]);
    expect(sheets.map((s) => s.bankName)).toEqual(['Aurora Bank', 'Zamora Bank']);
  });
});

describe('what each line carries', () => {
  /**
   * The face value, not the gross of the voucher. It is the amount the bank
   * still holds and the amount the journal voucher puts back.
   */
  it('reports the face value of the check', () => {
    expect(build([chk({ netAmount: 98_500_00 })])[0].rows[0].amount).toBe(98_500_00);
  });

  it('carries the voucher number and the nature of payment', () => {
    const row = build([chk()])[0].rows[0];
    expect(row.dvNo).toBe('DV-2026-0455');
    expect(row.natureOfPayment).toBe('Supply of cement, Barangay Payauan road');
  });

  /**
   * The manual heads this column "CAFOA No." The CAFOA is suspended, so what
   * goes there is the obligation number off the voucher - and an empty column
   * where the voucher carried none, never a fabricated reference.
   */
  it('fills the reference column from the obligation on the voucher', () => {
    const row = build([chk()], { obrByDv: { DV1: 'OBR-2026-0210' } })[0].rows[0];
    expect(row.obrNo).toBe('OBR-2026-0210');
  });

  it('leaves the reference empty when the voucher carried no obligation', () => {
    expect(build([chk()])[0].rows[0].obrNo).toBe('');
  });

  it('orders lines by check date, then by serial number', () => {
    const rows = build([
      chk({ id: 'A', checkDate: '2026-12-20', checkNo: '0001240' }),
      chk({ id: 'B', checkDate: '2026-12-02', checkNo: '0001202' }),
      chk({ id: 'C', checkDate: '2026-12-02', checkNo: '0001201' }),
    ])[0].rows;
    expect(rows.map((r) => r.checkNo)).toEqual(['0001201', '0001202', '0001240']);
  });
});

describe('the amount the year-end journal voucher restores', () => {
  it('is every sheet added together', () => {
    const sheets = build([
      chk({ netAmount: 100_000_00 }),
      chk({ id: 'C2', bankAccountId: 'BA2', netAmount: 40_000_00 }),
    ]);
    expect(totalUnreleased(sheets)).toBe(140_000_00);
  });

  it('is nothing when every check was handed over', () => {
    expect(totalUnreleased(build([chk({ status: 'RELEASED', dateReleased: '2026-12-01' })]))).toBe(0);
  });
});
