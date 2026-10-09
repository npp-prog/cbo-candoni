import { describe, expect, it } from 'vitest';
import { namesCheck, paymentReversalLines, rciCheckReversalLines } from './rciReversal';

const AP = { accountCode: '20101010', accountName: 'Accounts Payable' };
const CASH = {
  accountCode: '10102020',
  accountName: 'Cash in Bank - LCCA',
  subsidiaryType: 'BANK_ACCOUNT',
  subsidiaryId: 'lbp1',
  subsidiaryName: 'Land Bank of the Philippines 1172-1020-22',
};

const PER_CHECK = [
  {
    lineNo: 1,
    ...AP,
    debit: 120_000,
    credit: 0,
    subsidiaryId: 'p1',
    particulars: 'Payment of Check No. 1234 - Supplies',
  },
  {
    lineNo: 2,
    ...AP,
    debit: 360_000,
    credit: 0,
    subsidiaryId: 'p2',
    particulars: 'Payment of Check No. 12345 - Works',
  },
  {
    lineNo: 3,
    ...CASH,
    debit: 0,
    credit: 120_000,
    particulars: 'Payment of RCI 2026-10-0005 Check No. 1234 - Supplies',
  },
  {
    lineNo: 4,
    ...CASH,
    debit: 0,
    credit: 360_000,
    particulars: 'Payment of RCI 2026-10-0005 Check No. 12345 - Works',
  },
];

const ONE_CREDIT = [
  PER_CHECK[0],
  PER_CHECK[1],
  { lineNo: 3, ...CASH, debit: 0, credit: 480_000, particulars: 'Payments per RCI' },
];

describe('namesCheck', () => {
  it('matches the check and not a longer number that starts with it', () => {
    expect(namesCheck('Payment of Check No. 1234 - x', '1234')).toBe(true);
    expect(namesCheck('Payment of Check No. 12345 - x', '1234')).toBe(false);
    expect(namesCheck('Payment of Check No. 1234', '1234')).toBe(true);
  });
});

describe('rciCheckReversalLines (patch 151)', () => {
  it('mirrors only the lines of the chosen check', () => {
    const out = rciCheckReversalLines(PER_CHECK, [{ checkNo: '1234', amount: 120_000 }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      accountCode: '10102020',
      subsidiaryId: 'lbp1',
      debit: 120_000,
      credit: 0,
    });
    // Patch 153: what is still owed goes to Trust Liabilities, same payee.
    expect(out[1]).toMatchObject({
      accountCode: '20401010',
      accountName: 'Trust Liabilities',
      subsidiaryId: 'p1',
      debit: 0,
      credit: 120_000,
    });
    expect(out[1].particulars).toMatch(/^Check No\. 1234 cancelled - held in trust/);
    expect(out.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it('balances for several checks', () => {
    const out = rciCheckReversalLines(PER_CHECK, [
      { checkNo: '1234', amount: 120_000 },
      { checkNo: '12345', amount: 360_000 },
    ]);
    const dr = out.reduce((s, l) => s + l.debit, 0);
    const cr = out.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBe(480_000);
    expect(cr).toBe(480_000);
  });

  it("takes the check's share of a single Cash in Bank credit on an older entry", () => {
    const out = rciCheckReversalLines(ONE_CREDIT, [{ checkNo: '12345', amount: 360_000 }]);
    expect(out[0]).toMatchObject({
      accountCode: '10102020',
      subsidiaryId: 'lbp1',
      debit: 360_000,
      credit: 0,
    });
    expect(out[0].particulars).toMatch(/Check No\. 12345/);
    expect(out[1]).toMatchObject({ accountCode: '20401010', subsidiaryId: 'p2', credit: 360_000 });
  });

  it('refuses when no payable line names the check', () => {
    expect(() => rciCheckReversalLines(PER_CHECK, [{ checkNo: '9999', amount: 1 }])).toThrow(
      /Check No\. 9999/,
    );
  });

  it('refuses when the lines do not add up to the check', () => {
    expect(() => rciCheckReversalLines(PER_CHECK, [{ checkNo: '1234', amount: 100_000 }])).toThrow(
      /come to 1200\.00/,
    );
  });

  it('refuses when nothing is chosen', () => {
    expect(() => rciCheckReversalLines(PER_CHECK, [])).toThrow(/at least one/);
  });
});

describe('paymentReversalLines - a RADAI (patch 153)', () => {
  const TL = { code: '20401010', name: 'Trust Liabilities' };
  const RADAI = [
    {
      lineNo: 1,
      ...AP,
      debit: 500_000,
      credit: 0,
      subsidiaryId: 'p1',
      particulars: 'Payment of ADA No. 2026-10-0003 - Honoraria',
    },
    {
      lineNo: 2,
      ...AP,
      debit: 500_000,
      credit: 0,
      subsidiaryId: 'p2',
      particulars: 'Payment of ADA No. 2026-10-0003 - Honoraria',
    },
    {
      lineNo: 3,
      ...AP,
      debit: 200_000,
      credit: 0,
      subsidiaryId: 'p3',
      particulars: 'Payment of ADA No. 2026-10-0004 - Supplies',
    },
    { lineNo: 4, ...CASH, debit: 0, credit: 1_200_000, particulars: 'Payments per RADAI' },
  ];

  it('takes a group ADA - every payee - out of the single cash credit', () => {
    const out = paymentReversalLines(RADAI, [{ no: '2026-10-0003', amount: 1_000_000 }], {
      label: 'ADA No.',
      trustLiability: TL,
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ accountCode: '10102020', debit: 1_000_000, credit: 0 });
    expect(out.slice(1).map((l) => [l.accountCode, l.subsidiaryId, l.credit])).toEqual([
      ['20401010', 'p1', 500_000],
      ['20401010', 'p2', 500_000],
    ]);
  });

  it('does not take ADA 2026-10-0004 for 2026-10-0003', () => {
    expect(() =>
      paymentReversalLines(RADAI, [{ no: '2026-10-0004', amount: 1_000_000 }], {
        label: 'ADA No.',
        trustLiability: TL,
      }),
    ).toThrow(/come to 2000\.00/);
  });
});
