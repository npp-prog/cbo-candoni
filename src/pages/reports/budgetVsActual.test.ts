import { describe, it, expect } from 'vitest';
import {
  actualByFpp,
  buildComparison,
  unbudgetedActual,
  type ComparisonBalance,
  type ComparisonEntry,
} from './budgetVsActual';

const line = (over: Partial<ComparisonBalance> = {}): ComparisonBalance => ({
  fppCode: '5-02-03-010',
  fppName: 'Office Supplies Expenses',
  officeId: 'o1',
  officeName: 'Executive Services (Mayor)',
  sector: 'General Public Services',
  expenseClass: 'MOOE',
  appropriationOriginal: 100_000_00,
  appropriationContinuing: 0,
  appropriationRevised: 100_000_00,
  obligated: 60_000_00,
  ...over,
});

const entry = (fppCode: string, debit: number, credit = 0): ComparisonEntry => ({
  fppCode,
  debit,
  credit,
});

describe('actualByFpp', () => {
  it('sums debits less credits, so a reversal removes what it reverses', () => {
    const map = actualByFpp([
      entry('A', 50_000_00),
      entry('A', 0, 20_000_00),
      entry('B', 10_000_00),
    ]);
    expect(map.get('A')).toBe(30_000_00);
    expect(map.get('B')).toBe(10_000_00);
  });

  /**
   * Nothing without an FPP is budget expenditure - the credit to Accounts
   * Payable, the cash line, a collection. Counting them would put the whole
   * double entry into the actual column and double every figure in it.
   */
  it('ignores entries with no FPP', () => {
    const map = actualByFpp([{ debit: 999_00, credit: 0 }, entry('A', 100_00)]);
    expect([...map.keys()]).toEqual(['A']);
  });
});

describe('buildComparison', () => {
  it('puts the budget beside the ledger for one line', () => {
    const rows = buildComparison([line()], [entry('5-02-03-010', 45_000_00)], 'fpp');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      finalBudget: 100_000_00,
      obligated: 60_000_00,
      actual: 45_000_00,
    });
  });

  it('counts continuing appropriations in the original budget', () => {
    const rows = buildComparison(
      [line({ appropriationOriginal: 80_000_00, appropriationContinuing: 20_000_00 })],
      [],
      'fpp',
    );
    expect(rows[0].originalBudget).toBe(100_000_00);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * The same project appropriated to two offices is two budget lines and one
   * ledger total. Giving that total to each line would double the actual
   * column - and nothing would fail: the budget columns would still be right,
   * the statement would still foot to its own totals, and it would report an
   * overspend on a line that was not overspent.
   */
  it('does not count one FPP twice when it appears on two budget lines', () => {
    const rows = buildComparison(
      [
        line({ officeId: 'o1', officeName: 'Mayor', appropriationRevised: 60_000_00, obligated: 0 }),
        line({ officeId: 'o2', officeName: 'Health', appropriationRevised: 40_000_00, obligated: 0 }),
      ],
      [entry('5-02-03-010', 70_000_00)],
      'fpp',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].finalBudget).toBe(100_000_00);
    expect(rows[0].actual).toBe(70_000_00);
  });

  it('still counts it once when grouping by office', () => {
    const rows = buildComparison(
      [
        line({ officeId: 'o1', officeName: 'Mayor', appropriationRevised: 60_000_00 }),
        line({ officeId: 'o2', officeName: 'Health', appropriationRevised: 40_000_00 }),
      ],
      [entry('5-02-03-010', 70_000_00)],
      'office',
    );
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.actual, 0)).toBe(70_000_00);
  });

  it('groups a funding-source line by the service it delivers', () => {
    const rows = buildComparison(
      [
        line({
          fppCode: 'Concreting of Barangay Road',
          sector: '20% Development Fund',
          serviceSector: 'Economic Services',
        }),
      ],
      [],
      'sector',
    );
    expect(rows[0].key).toBe('Economic Services');
    expect(rows[0].bucket).toBe('ECONOMIC');
  });

  it('leaves a funding-source line unplaced when it names no service', () => {
    const rows = buildComparison([line({ sector: '20% Development Fund' })], [], 'fpp');
    expect(rows[0].bucket).toBeNull();
  });

  it('drops a line with neither appropriation nor obligation', () => {
    expect(
      buildComparison([line({ appropriationRevised: 0, obligated: 0 })], [], 'fpp'),
    ).toHaveLength(0);
  });

  /**
   * The ledger carrying more than was ever obligated is the signal the report
   * exists to raise - a voucher whose FPP was changed after certification, or
   * a journal entry charged straight to the line.
   */
  it('lets the actual exceed the obligated rather than capping it', () => {
    const rows = buildComparison([line({ obligated: 10_000_00 })], [entry('5-02-03-010', 90_000_00)], 'fpp');
    expect(rows[0].obligated - rows[0].actual).toBe(-80_000_00);
  });
});

describe('unbudgetedActual', () => {
  it('reports spending against an FPP with no appropriation at all', () => {
    const out = unbudgetedActual([line()], [entry('5-02-03-010', 10_00), entry('GHOST', 50_000_00)]);
    expect(out).toEqual([{ fppCode: 'GHOST', amount: 50_000_00 }]);
  });

  it('says nothing when an unbudgeted FPP nets to zero', () => {
    expect(
      unbudgetedActual([line()], [entry('GHOST', 50_000_00), entry('GHOST', 0, 50_000_00)]),
    ).toEqual([]);
  });
});
