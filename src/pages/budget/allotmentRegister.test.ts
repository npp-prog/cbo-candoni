import { describe, it, expect } from 'vitest';
import {
  buildAllotmentRegister,
  budgetLineText,
  isLaterRelease,
  laterReleasesOf,
} from './allotmentRegister';
import type { Allotment, AroDraft } from '@/types/budget';

const line = (over: Partial<Allotment>): Allotment =>
  ({
    id: 'L1',
    fiscalYear: 2026,
    fundCode: 'GF',
    officeId: 'ACCT',
    officeName: 'Office of the Municipal Accountant',
    fppCode: '50203010',
    fppName: 'Office Supplies Expenses',
    accountCode: '50203010',
    accountName: 'Office Supplies Expenses',
    expenseClass: 'MOOE',
    allotmentNo: 'ARO-100-2026-0001',
    aroNo: 'ARO-100-2026-0001',
    aroPurpose: 'general',
    allotmentDate: '2026-01-01',
    amount: 90_000_00,
    forLaterRelease: 0,
    status: 'APPROVED',
    ...over,
  }) as Allotment;

/**
 * Neil's own screen, 08 Oct 2026: ARO-0001 issued 01 Jan releasing 90,000
 * and holding 10,000, the 10,000 released on 08 Oct. The old table showed the
 * order dated 08 Oct, with two lines, 100,000 released and nothing held.
 */
const issued = line({ id: 'ORIG', forLaterRelease: 0 });
const laterRelease = line({
  id: 'REL',
  allotmentDate: '2026-10-08',
  amount: 10_000_00,
  particulars: 'Release of allotment held for later release. Collections are in.',
  releasedFromHeld: { allotmentId: 'ORIG', reason: 'Collections are in.' },
});

describe('the allotment register', () => {
  it('keeps an order on its own date when a held amount is released later', () => {
    const rows = buildAllotmentRegister([laterRelease, issued]);
    const order = rows.find((r) => r.kind === 'ORDER');
    expect(order?.reference).toBe('ARO-100-2026-0001');
    expect(order?.date).toBe('2026-01-01');
    expect(order?.lines).toHaveLength(1);
    expect(order?.released).toBe(90_000_00);
  });

  it('shows what the order HELD AT ISSUE, though the hold has since been released', () => {
    const order = buildAllotmentRegister([laterRelease, issued]).find((r) => r.kind === 'ORDER');
    expect(order?.heldAtIssue).toBe(10_000_00);
    expect(order?.stillHeld).toBe(0);
  });

  it('gives the later release a row of its own, traced to the order', () => {
    const rel = buildAllotmentRegister([laterRelease, issued]).find(
      (r) => r.kind === 'LATER_RELEASE',
    );
    expect(rel?.reference).toBe('ARO-100-2026-0001');
    expect(rel?.date).toBe('2026-10-08');
    expect(rel?.released).toBe(10_000_00);
    expect(rel?.purpose).toBe('Collections are in.');
  });

  it('recognises a later release written before the field existed, by its particulars', () => {
    const { releasedFromHeld: _drop, ...old } = laterRelease;
    expect(isLaterRelease(old as Allotment)).toBe(true);
    expect(isLaterRelease(issued)).toBe(false);
  });

  it('puts every line of a multi-line order in one row', () => {
    const rows = buildAllotmentRegister([
      line({ id: 'A', aroNo: 'ARO-2', officeName: 'Mayor', amount: 5_00 }),
      line({ id: 'B', aroNo: 'ARO-2', officeName: 'Accountant', amount: 7_00 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].released).toBe(12_00);
    // Printed by office.
    expect(rows[0].lines.map((l) => l.officeName)).toEqual(['Accountant', 'Mayor']);
  });

  it('keeps withdrawals and lines with no order as rows of their own', () => {
    const rows = buildAllotmentRegister([
      line({ id: 'W', aroNo: undefined, allotmentNo: '', amount: -3_00, status: 'DRAFT' }),
      line({ id: 'N', aroNo: undefined, allotmentNo: 'ALT-1', amount: 4_00 }),
    ]);
    expect(rows.map((r) => r.kind).sort()).toEqual(['NO_ORDER', 'WITHDRAWAL']);
    expect(rows.find((r) => r.kind === 'WITHDRAWAL')?.status).toBe('DRAFT');
  });

  it('lists newest first', () => {
    const rows = buildAllotmentRegister([
      line({ id: 'a', aroNo: 'ARO-1', allotmentDate: '2026-01-05' }),
      line({ id: 'b', aroNo: 'ARO-2', allotmentDate: '2026-10-07' }),
    ]);
    expect(rows.map((r) => r.reference)).toEqual(['ARO-2', 'ARO-1']);
  });
});

/**
 * Patch 113: prepared orders are rows of the same register, with a status,
 * where they used to be a box of their own above it.
 */
describe('prepared orders in the register', () => {
  const draft = (over: Partial<AroDraft> = {}): AroDraft =>
    ({
      id: 'D1',
      fiscalYear: 2026,
      fundCode: 'GF',
      expenseClass: 'CO',
      purpose: 'cccc',
      date: '2026-10-08',
      status: 'DRAFT',
      lines: [
        {
          balanceId: 'b',
          officeId: 'mayor',
          officeName: 'Office of the Municipal Mayor',
          fppCode: 'CO-1',
          fppName: 'Construction of aadad',
          accountCode: '',
          accountName: '',
          amount: 10_000_00,
          forLaterRelease: 2_000_00,
        },
      ],
      ...over,
    }) as AroDraft;

  it('is a row marked Prepared, with no ARO number yet', () => {
    const rows = buildAllotmentRegister([issued], [draft()]);
    const p = rows.find((r) => r.kind === 'PREPARED');
    expect(p?.status).toBe('PREPARED');
    expect(p?.reference).toBe('');
    expect(p?.released).toBe(10_000_00);
    expect(p?.heldAtIssue).toBe(2_000_00);
    expect(p?.draft?.id).toBe('D1');
    expect(p?.lines[0].fppName).toBe('Construction of aadad');
  });

  it('comes first, because it is what someone has to act on', () => {
    const rows = buildAllotmentRegister(
      [line({ id: 'x', aroNo: 'ARO-9', allotmentDate: '2026-12-31' })],
      [draft({ date: '2026-01-01' })],
    );
    expect(rows[0].kind).toBe('PREPARED');
  });

  it('leaves out an order already approved - it is an issued order now', () => {
    const rows = buildAllotmentRegister([], [draft({ status: 'APPROVED', aroNo: 'ARO-7' })]);
    expect(rows).toHaveLength(0);
  });

  it('carries a released line for the acts that need it, and none on a prepared one', () => {
    const rows = buildAllotmentRegister([issued], [draft()]);
    expect(rows.find((r) => r.kind === 'ORDER')?.lines[0].allotment?.id).toBe('ORIG');
    expect(rows.find((r) => r.kind === 'PREPARED')?.lines[0].allotment).toBeUndefined();
  });
});

describe('laterReleasesOf', () => {
  it("finds the releases made from an order's holds", () => {
    const rows = buildAllotmentRegister([issued, laterRelease]);
    const order = rows.find((r) => r.kind === 'ORDER')!;
    expect(laterReleasesOf(order, rows).map((r) => r.released)).toEqual([10_000_00]);
  });

  it("finds none for another order", () => {
    const rows = buildAllotmentRegister([
      laterRelease,
      issued,
      line({ id: 'Z', aroNo: 'ARO-OTHER', allotmentNo: 'ARO-OTHER' }),
    ]);
    const other = rows.find((r) => r.reference === 'ARO-OTHER')!;
    expect(laterReleasesOf(other, rows)).toEqual([]);
  });
});

describe('budgetLineText', () => {
  it('names the object where there is one', () => {
    expect(budgetLineText({ accountCode: '50203010', accountName: 'Office Supplies' })).toEqual({
      code: '50203010',
      name: 'Office Supplies',
    });
  });

  it('names the PROGRAMME on a line appropriated by programme, instead of nothing', () => {
    expect(
      budgetLineText({
        accountCode: '',
        fppCode: 'CO-2026-01',
        fppName: 'Health Station, Payauan',
      }),
    ).toEqual({ code: '', name: 'Health Station, Payauan' });
  });
});
