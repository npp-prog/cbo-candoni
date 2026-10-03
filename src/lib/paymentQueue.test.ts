import { describe, it, expect } from 'vitest';
import { awaitingPayment, totalAwaiting, daysWaiting, type PayableVoucher } from './paymentQueue';

const dv = (over: Partial<PayableVoucher> & { id: string }): PayableVoucher => ({
  dvNo: '100-26-01-0001',
  dvDate: '2026-01-05',
  payeeName: 'Rujen General Merchandise',
  particulars: 'Office supplies',
  netAmount: 2_000_000,
  status: 'APPROVED',
  ...over,
});

describe('awaitingPayment', () => {
  it('takes only approved vouchers', () => {
    const rows = awaitingPayment([
      dv({ id: 'a', status: 'DRAFT' }),
      dv({ id: 'b', status: 'SUBMITTED' }),
      dv({ id: 'c', status: 'REVIEWED' }),
      dv({ id: 'd', status: 'APPROVED' }),
      dv({ id: 'e', status: 'CANCELLED' }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(['d']);
  });

  it('drops a voucher that already has a check', () => {
    const rows = awaitingPayment([
      dv({ id: 'paid', checkId: 'chk1' }),
      dv({ id: 'unpaid' }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(['unpaid']);
  });

  it('drops a voucher that already has an advice', () => {
    const rows = awaitingPayment([dv({ id: 'paid', adaId: 'ada1' }), dv({ id: 'unpaid' })]);

    expect(rows.map((r) => r.id)).toEqual(['unpaid']);
  });

  it('puts the oldest first, because the queue is a queue', () => {
    const rows = awaitingPayment([
      dv({ id: 'new', dvDate: '2026-03-01' }),
      dv({ id: 'old', dvDate: '2026-01-05' }),
      dv({ id: 'middle', dvDate: '2026-02-10' }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(['old', 'middle', 'new']);
  });

  it('breaks a same-day tie by voucher number, the order they were encoded', () => {
    const rows = awaitingPayment([
      dv({ id: 'second', dvNo: '100-26-01-0002' }),
      dv({ id: 'first', dvNo: '100-26-01-0001' }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(['first', 'second']);
  });

  it('does not disturb the array it was given', () => {
    const input = [dv({ id: 'b', dvDate: '2026-03-01' }), dv({ id: 'a', dvDate: '2026-01-01' })];
    awaitingPayment(input);

    expect(input.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('totalAwaiting', () => {
  it('adds the net amounts, in centavos', () => {
    expect(
      totalAwaiting([dv({ id: 'a', netAmount: 2_000_000 }), dv({ id: 'b', netAmount: 1_550 })]),
    ).toBe(2_001_550);
  });

  it('is zero on an empty queue', () => {
    expect(totalAwaiting([])).toBe(0);
  });
});

describe('daysWaiting', () => {
  it('counts whole days', () => {
    expect(daysWaiting('2026-01-05', '2026-01-05')).toBe(0);
    expect(daysWaiting('2026-01-05', '2026-01-06')).toBe(1);
    expect(daysWaiting('2026-01-05', '2026-02-05')).toBe(31);
  });

  it('never reports a negative wait for a voucher dated ahead', () => {
    expect(daysWaiting('2026-06-01', '2026-01-05')).toBe(0);
  });

  it('returns zero rather than NaN on a date it cannot read', () => {
    expect(daysWaiting('not a date', '2026-01-05')).toBe(0);
  });
});
