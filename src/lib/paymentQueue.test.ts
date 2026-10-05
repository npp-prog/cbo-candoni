import { describe, it, expect } from 'vitest';
import {
  awaitingPayment,
  awaitingTransfer,
  totalAwaiting,
  daysWaiting,
  type PayableVoucher,
} from './paymentQueue';

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
  it('leaves out everything that has not been approved', () => {
    const rows = awaitingPayment([
      dv({ id: 'a', status: 'DRAFT' }),
      dv({ id: 'b', status: 'SUBMITTED' }),
      dv({ id: 'c', status: 'REVIEWED' }),
      dv({ id: 'd', status: 'APPROVED' }),
      dv({ id: 'e', status: 'CANCELLED' }),
      dv({ id: 'f', status: 'RETURNED' }),
      dv({ id: 'g', status: 'CLOSED' }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(['d']);
  });

  /**
   * The defect this test exists for: an Accountant posts the journal entry on
   * the voucher - which patch 75 moved on to the voucher screen, so it now
   * happens immediately after approval - and the voucher vanished from the
   * Treasurer's queue. Nobody had paid it. It was simply gone, and the only
   * way to find it again was to know its number.
   */
  it('keeps a voucher whose record says paid but which carries no instrument', () => {
    const rows = awaitingPayment([dv({ id: 'posted-not-paid', status: 'PAID' })]);
    expect(rows.map((r) => r.id)).toEqual(['posted-not-paid']);
  });

  it('drops a voucher marked paid that does carry a check', () => {
    const rows = awaitingPayment([
      dv({ id: 'really-paid', status: 'PAID', checkId: 'chk1' }),
      dv({ id: 'unpaid' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['unpaid']);
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

/**
 * The split between approved and sent over (patch 85).
 *
 * The case that matters most here is the fourth one. Getting the flag the
 * wrong way round would have emptied the Treasurer's queue of every voucher
 * approved before the patch, and nothing would have said so - the suppliers
 * would simply have stopped being paid.
 */
describe('awaitingPayment: Accounting has to send it over', () => {
  const base = {
    dvDate: '2026-10-01',
    payeeName: 'Negros Hardware',
    particulars: 'Office supplies',
    netAmount: 100_000,
    status: 'APPROVED',
  };

  it('does not offer a voucher Accounting is still holding', () => {
    const held = { ...base, id: 'a', dvNo: '100-26-10-0001', awaitingTransferToTreasury: true };
    expect(awaitingPayment([held])).toEqual([]);
    expect(awaitingTransfer([held]).map((v) => v.id)).toEqual(['a']);
  });

  it('offers it once it has been sent', () => {
    const sent = { ...base, id: 'b', dvNo: '100-26-10-0002', awaitingTransferToTreasury: false };
    expect(awaitingPayment([sent]).map((v) => v.id)).toEqual(['b']);
    expect(awaitingTransfer([sent])).toEqual([]);
  });

  it('keeps a voucher approved before patch 85, which carries neither field', () => {
    const old = { ...base, id: 'c', dvNo: '100-26-09-0099' };
    expect(awaitingPayment([old]).map((v) => v.id)).toEqual(['c']);
    expect(awaitingTransfer([old])).toEqual([]);
  });

  it('never offers a held voucher that somehow already has a check', () => {
    const paid = {
      ...base,
      id: 'd',
      dvNo: '100-26-10-0003',
      awaitingTransferToTreasury: true,
      checkId: 'chk1',
    };
    expect(awaitingPayment([paid])).toEqual([]);
    expect(awaitingTransfer([paid])).toEqual([]);
  });
});
