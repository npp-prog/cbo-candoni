import { describe, it, expect } from 'vitest';
import {
  SRE_MAPPABLE_LINES,
  SRE_RECEIPT_LINES,
  appropriationsByFund,
  estimatesAsEntries,
  expendituresByFund,
  mappingConflicts,
  receiptsByLine,
  resolveTotals,
  unmappedReceipts,
  type SreEntry,
} from './sre';

const rev = (accountCode: string, credit: number, over: Partial<SreEntry> = {}): SreEntry => ({
  fundCode: 'GF',
  accountCode,
  debit: 0,
  credit,
  ...over,
});

const exp = (fppCode: string, debit: number, over: Partial<SreEntry> = {}): SreEntry => ({
  fundCode: 'GF',
  accountCode: '5-02-03-010',
  fppCode,
  debit,
  credit: 0,
  ...over,
});

describe('the form itself', () => {
  it('ships with the Annex A lines and no mapping', () => {
    expect(SRE_RECEIPT_LINES.find((l) => l.key === 'ira')?.label).toBe(
      '1. Internal Revenue Allotment',
    );
    expect(SRE_MAPPABLE_LINES.every((l) => l.kind === 'ITEM')).toBe(true);
  });

  /**
   * resolveTotals makes one pass, which is only correct if every line is
   * declared after everything it adds up. A line moved above its inputs would
   * quietly total zero.
   */
  it('declares every subtotal after the lines it sums', () => {
    const seen = new Set<string>();
    for (const line of SRE_RECEIPT_LINES) {
      for (const k of line.sum ?? []) {
        expect(seen.has(k), `${line.key} sums ${k} before it is declared`).toBe(true);
      }
      seen.add(line.key);
    }
  });

  it('adds every item into exactly one subtotal', () => {
    const summed = SRE_RECEIPT_LINES.flatMap((l) => l.sum ?? []);
    for (const item of SRE_MAPPABLE_LINES) {
      expect(summed.filter((k) => k === item.key), item.key).toHaveLength(1);
    }
  });
});

describe('receiptsByLine', () => {
  it('sums credits less debits, so a refund reduces the line', () => {
    const map = receiptsByLine(
      [rev('4-01-02-040', 500_000_00), { ...rev('4-01-02-040', 0), debit: 20_000_00 }],
      { rptBasic: ['4-01-02-040'] },
    );
    expect(map.get('rptBasic')).toBe(480_000_00);
  });

  it('ignores an account nobody mapped', () => {
    const map = receiptsByLine([rev('4-99-99-999', 1_000_00)], { rptBasic: ['4-01-02-040'] });
    expect(map.size).toBe(0);
  });
});

describe('resolveTotals', () => {
  it('rolls items up through the subtotals to the grand total', () => {
    const totals = resolveTotals(
      new Map([
        ['rptBasic', 100_00],
        ['businessTax', 200_00],
        ['regulatoryFees', 50_00],
        ['ira', 1_000_00],
        ['acquisitionOfLoans', 500_00],
      ]),
    );
    expect(totals.get('totalTaxRevenue')).toBe(300_00);
    expect(totals.get('totalNonTaxRevenue')).toBe(50_00);
    expect(totals.get('totalLocalSources')).toBe(350_00);
    expect(totals.get('totalExternalSources')).toBe(1_000_00);
    expect(totals.get('totalNonIncomeReceipts')).toBe(500_00);
    expect(totals.get('totalReceipts')).toBe(1_850_00);
  });

  it('treats an absent item as nothing rather than failing', () => {
    expect(resolveTotals(new Map()).get('totalReceipts')).toBe(0);
  });
});

describe('unmappedReceipts', () => {
  const isRevenue = (code: string) => code.startsWith('4-');

  /**
   * The failure this guards against is a statement that foots to its own
   * totals while leaving a revenue account out. Nothing looks wrong, and the
   * municipality under-reports what it received to BLGF.
   */
  it('names revenue that no line claims', () => {
    const out = unmappedReceipts(
      [rev('4-01-02-040', 100_00, { accountName: 'Basic RPT' }), rev('4-02-01-010', 900_00, { accountName: 'Permit Fees' })],
      { rptBasic: ['4-01-02-040'] },
      isRevenue,
    );
    expect(out).toEqual([{ accountCode: '4-02-01-010', accountName: 'Permit Fees', amount: 900_00 }]);
  });

  it('says nothing about an expense account', () => {
    expect(unmappedReceipts([exp('A', 500_00)], {}, isRevenue)).toEqual([]);
  });

  it('says nothing when an unmapped account nets to zero', () => {
    const out = unmappedReceipts(
      [rev('4-02-01-010', 100_00), { ...rev('4-02-01-010', 0), debit: 100_00 }],
      {},
      isRevenue,
    );
    expect(out).toEqual([]);
  });
});

describe('mappingConflicts', () => {
  it('finds an account put on two lines', () => {
    expect(
      mappingConflicts({ rptBasic: ['4-01-02-040'], rptSef: ['4-01-02-040', '4-01-02-050'] }),
    ).toEqual([{ accountCode: '4-01-02-040', lines: ['rptBasic', 'rptSef'] }]);
  });

  it('is quiet on a clean mapping', () => {
    expect(mappingConflicts({ rptBasic: ['4-01-02-040'], rptSef: ['4-01-02-050'] })).toEqual([]);
  });
});

describe('expendituresByFund', () => {
  const sectors = [
    { fppCode: 'ROAD', sector: '20% Development Fund', serviceSector: 'Economic Services' },
    { fppCode: 'SALARIES', sector: 'General Public Services' },
    { fppCode: 'HEALTH', sector: 'Health, Nutrition and Population Control' },
    // A funding source with no service named: CFMS cannot place it.
    { fppCode: 'UNPLACED', sector: 'LDRRMF' },
  ];

  it('splits the General Fund into the four buckets of Annex A', () => {
    const t = expendituresByFund(
      [exp('ROAD', 100_00), exp('SALARIES', 200_00), exp('HEALTH', 300_00)],
      sectors,
    );
    expect(t.generalFund.ECONOMIC).toBe(100_00);
    expect(t.generalFund.GENERAL).toBe(200_00);
    expect(t.generalFund.SOCIAL).toBe(300_00);
    expect(t.total).toBe(600_00);
  });

  it('keeps the other two funds on their own lines', () => {
    const t = expendituresByFund(
      [exp('X', 100_00, { fundCode: 'SEF' }), exp('Y', 250_00, { fundCode: 'TF' })],
      sectors,
    );
    expect(t.specialEducationFund).toBe(100_00);
    expect(t.trustFund).toBe(250_00);
    expect(t.total).toBe(350_00);
  });

  /**
   * An expense CFMS cannot classify still foots into the total, on a line of
   * its own. Pushing it into General Services would make the statement foot
   * correctly and say something untrue; dropping it would make the statement
   * foot to less than the municipality spent.
   */
  it('counts what it cannot classify rather than guessing or dropping it', () => {
    const t = expendituresByFund([exp('UNPLACED', 400_00), exp('NOBODY', 100_00)], sectors);
    expect(t.generalFundUnclassified).toBe(500_00);
    expect(t.generalFund.GENERAL).toBe(0);
    expect(t.total).toBe(500_00);
  });

  it('ignores entries with no budget line, which are not budget expenditure', () => {
    const t = expendituresByFund([{ fundCode: 'GF', accountCode: '1-01-01-010', debit: 900_00, credit: 0 }], sectors);
    expect(t.total).toBe(0);
  });

  it('nets a reversal against what it reverses', () => {
    const t = expendituresByFund(
      [exp('SALARIES', 500_00), { ...exp('SALARIES', 0), credit: 200_00 }],
      sectors,
    );
    expect(t.generalFund.GENERAL).toBe(300_00);
  });
});

describe('estimatesAsEntries', () => {
  it('puts an estimate on the same line the actual would land on', () => {
    const mapping = { rptBasic: ['40101010'], businessTax: ['40201010'] };

    const estimate = receiptsByLine(
      estimatesAsEntries([
        { fundCode: 'GF', accountCode: '40101010', annual: 4_000_000_00 },
        { fundCode: 'GF', accountCode: '40201010', annual: 1_000_000_00 },
      ]),
      mapping,
    );

    const actual = receiptsByLine(
      [
        { fundCode: 'GF', accountCode: '40101010', credit: 3_500_000_00, debit: 0 },
        { fundCode: 'GF', accountCode: '40201010', credit: 1_200_000_00, debit: 0 },
      ],
      mapping,
    );

    expect([...estimate.keys()].sort()).toEqual([...actual.keys()].sort());
    expect(estimate.get('rptBasic')).toBe(4_000_000_00);
    expect(actual.get('rptBasic')).toBe(3_500_000_00);
  });

  it('subtotals an estimate through the same resolution as an actual', () => {
    const totals = resolveTotals(
      receiptsByLine(
        estimatesAsEntries([
          { fundCode: 'GF', accountCode: '40101010', annual: 4_000_000_00 },
          { fundCode: 'GF', accountCode: '40201010', annual: 1_000_000_00 },
        ]),
        { rptBasic: ['40101010'], businessTax: ['40201010'] },
      ),
    );
    expect(totals.get('totalTaxRevenue')).toBe(5_000_000_00);
    expect(totals.get('totalReceipts')).toBe(5_000_000_00);
  });
});

describe('appropriationsByFund', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    fundCode: 'GF',
    fppCode: '1011',
    sector: 'General Public Services',
    appropriationRevised: 1_000_00,
    ...over,
  });

  it('buckets the budget exactly as the actual is bucketed', () => {
    const totals = appropriationsByFund([
      line(),
      line({
        fppCode: '8751',
        sector: 'Health, Nutrition and Population Control',
        appropriationRevised: 500_00,
      }),
    ]);
    expect(totals.generalFund.GENERAL).toBe(1_000_00);
    expect(totals.generalFund.SOCIAL).toBe(500_00);
    expect(totals.total).toBe(1_500_00);
  });

  it('keeps the Special Education and Trust Funds on their own lines', () => {
    const totals = appropriationsByFund([
      line({ fundCode: 'SEF', appropriationRevised: 200_00 }),
      line({ fundCode: 'TF', appropriationRevised: 300_00 }),
    ]);
    expect(totals.specialEducationFund).toBe(200_00);
    expect(totals.trustFund).toBe(300_00);
    expect(totals.generalFund.GENERAL).toBe(0);
  });

  /**
   * A funding source with no service named cannot be bucketed, and is carried
   * in its own figure rather than dropped - the budget column must foot to the
   * appropriation whatever the sector data looks like.
   */
  it('carries an unbucketable line rather than losing it', () => {
    const totals = appropriationsByFund([
      line({ sector: '20% Development Fund', serviceSector: undefined }),
    ]);
    expect(totals.generalFundUnclassified).toBe(1_000_00);
    expect(totals.total).toBe(1_000_00);
  });

  it('ignores a line with no appropriation', () => {
    expect(appropriationsByFund([line({ appropriationRevised: 0 })]).total).toBe(0);
  });
});
