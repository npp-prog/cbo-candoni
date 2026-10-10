import { describe, expect, it } from 'vitest';
import { allocateRemittances, describeAllocation, type RemittableReceipt } from './remittances';

const r = (
  orNumber: string,
  amount: number,
  over: Partial<RemittableReceipt> = {},
): RemittableReceipt => ({
  id: `c${orNumber}`,
  orNumber,
  orDate: '2026-10-01',
  totalAmount: amount,
  status: 'ISSUED',
  collectingOfficerId: 'e1',
  collectingOfficerName: 'Juan',
  accountableForm: 'AF51',
  ...over,
});
const m = (id: string, amount: number, date = '2026-10-02', over = {}) => ({
  id,
  remittanceDate: date,
  amount,
  status: 'RECORDED',
  collectingOfficerId: 'e1',
  ...over,
});

describe('allocateRemittances (patch 160)', () => {
  const receipts = [r('0003', 300), r('0001', 100), r('0002', 200)];

  it('applies an exact remittance to every receipt', () => {
    const out = allocateRemittances(receipts, [m('m1', 600)]);
    expect([...out.byReceipt.values()].every((x) => x.state === 'REMITTED')).toBe(true);
    expect(out.officers[0]).toMatchObject({
      collected: 600,
      remitted: 600,
      unremitted: 0,
      excess: 0,
    });
  });

  it('applies a short remittance in AF series order, lowest receipt first', () => {
    const out = allocateRemittances(receipts, [m('m1', 250)]);
    expect(out.byReceipt.get('c0001')?.state).toBe('REMITTED');
    expect(out.byReceipt.get('c0002')).toEqual({ remitted: 150, unremitted: 50, state: 'PARTIAL' });
    expect(out.byReceipt.get('c0003')?.state).toBe('NOT_REMITTED');
    expect(out.officers[0].unremitted).toBe(350);
    expect(out.byRemittance.get('m1')).toEqual([
      { collectionId: 'c0001', orNumber: '0001', amount: 100 },
      { collectionId: 'c0002', orNumber: '0002', amount: 150 },
    ]);
  });

  it('a later remittance picks up where the last stopped', () => {
    const out = allocateRemittances(receipts, [m('m2', 100, '2026-10-05'), m('m1', 250)]);
    expect(out.byRemittance.get('m2')).toEqual([
      { collectionId: 'c0002', orNumber: '0002', amount: 50 },
      { collectionId: 'c0003', orNumber: '0003', amount: 50 },
    ]);
  });

  it('ignores cancelled remittances, e-collections and cancelled receipts; keeps officers apart', () => {
    const out = allocateRemittances(
      [
        ...receipts,
        r('0004', 999, { eCollectionKind: 'EOR' }),
        r('0005', 999, { status: 'CANCELLED' }),
        r('0100', 50, { collectingOfficerId: 'e2', collectingOfficerName: 'Ana' }),
      ],
      [
        m('m1', 600, '2026-10-02', { status: 'CANCELLED' }),
        m('m3', 70, '2026-10-02', { collectingOfficerId: 'e2' }),
      ],
    );
    expect(out.byReceipt.has('c0004')).toBe(false);
    expect(out.byReceipt.get('c0001')?.state).toBe('NOT_REMITTED');
    const ana = out.officers.find((o) => o.key === 'e2')!;
    expect(ana).toMatchObject({ collected: 50, remitted: 70, unremitted: 0, excess: 20 });
  });

  it('describes what a remittance covered', () => {
    const out = allocateRemittances(receipts, [m('m1', 250)]);
    const totals = new Map(receipts.map((x) => [x.id, x.totalAmount]));
    expect(describeAllocation(out.byRemittance.get('m1')!, totals)).toBe('0001, 0002 (part)');
    const all = allocateRemittances(receipts, [m('m1', 600)]);
    expect(describeAllocation(all.byRemittance.get('m1')!, totals)).toBe('0001-0003');
  });
});
