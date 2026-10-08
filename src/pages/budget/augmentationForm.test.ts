import { describe, it, expect } from 'vitest';
import { buildAugmentationSheet, objectOfExpenditure, officeOf } from './augmentationForm';

/** LBE Form No. 2, filled from a prepared augmentation. Patch 116. */
const line = (over: Record<string, unknown>) => ({
  officeName: 'Office of the Municipal Mayor',
  accountCode: '50203010',
  accountName: 'Office Supplies Expenses',
  fppCode: '50203010',
  fppName: 'Office Supplies Expenses',
  expenseClass: 'MOOE',
  amount: 0,
  ...over,
});

const build = (lines: ReturnType<typeof line>[]) =>
  buildAugmentationSheet({
    fiscalYear: 2026,
    lgu: 'MUNICIPAL GOVERNMENT OF CANDONI',
    ordinanceNo: ' Office Order No. 2026-03 ',
    lines,
    prepared: true,
  });

describe('buildAugmentationSheet', () => {
  it('puts the savings on the FROM side and the augmented items on the TO side, both positive', () => {
    const s = build([
      line({ amount: -30_000_00 }),
      line({ accountCode: '50202010', accountName: 'Training Expenses', amount: 30_000_00 }),
    ]);
    expect(s.from.map((r) => r.amount)).toEqual([30_000_00]);
    expect(s.to.map((r) => r.objectOfExpenditure)).toEqual(['50202010 - Training Expenses']);
    expect(s.totalFrom).toBe(30_000_00);
    expect(s.totalTo).toBe(30_000_00);
    expect(s.balanced).toBe(true);
    expect(s.ordinanceNo).toBe('Office Order No. 2026-03');
  });

  it('lets the sides have different numbers of rows - only the totals must agree', () => {
    const s = build([
      line({ amount: -10_00 }),
      line({ accountName: 'Fuel', accountCode: '50203090', amount: -20_00 }),
      line({ accountName: 'Training', accountCode: '50202010', amount: 30_00 }),
    ]);
    expect(s.from).toHaveLength(2);
    expect(s.to).toHaveLength(1);
    expect(s.balanced).toBe(true);
  });

  it('says when the totals do not agree', () => {
    expect(build([line({ amount: -10_00 }), line({ amount: 9_00 })]).balanced).toBe(false);
  });

  it('is not balanced when nothing has been entered', () => {
    expect(build([]).balanced).toBe(false);
  });
});

describe('objectOfExpenditure', () => {
  it('names the programme where the ordinance named no object', () => {
    expect(objectOfExpenditure(line({ accountCode: '', accountName: '', fppName: 'Road, Gatuslao' }))).toBe(
      'Road, Gatuslao',
    );
  });
});

describe('officeOf', () => {
  it("is the Sanggunian's only when every line is a legislative office", () => {
    expect(officeOf([line({ officeName: 'Sangguniang Bayan' }), line({ officeName: 'Office of the Vice Mayor' })])).toBe(
      'Sanggunian',
    );
    expect(officeOf([line({ officeName: 'Sangguniang Bayan' }), line({})])).toBe('Executive');
    expect(officeOf([line({})])).toBe('Executive');
  });
});
