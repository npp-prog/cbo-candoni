import { describe, it, expect } from 'vitest';
import { buildAllotmentRegister, budgetLineText, isLaterRelease } from './allotmentRegister';
import type { Allotment } from '@/types/budget';

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
    expect(rows[0].lines.map((l) => l.line.officeName)).toEqual(['Accountant', 'Mayor']);
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
