import { describe, it, expect } from 'vitest';
import {
  proposePaymentEntry,
  rebuildPaymentEntry,
  renumberPaymentEntry,
  paymentParticulars,
} from './treasuryEntry';

const PAYABLE = { code: '20101010', name: 'Accounts Payable' };

const CASH = {
  accountCode: '10102010',
  accountName: 'Cash in Bank - Local Currency, Current Account',
  subsidiaryType: 'BANK_ACCOUNT',
  subsidiaryId: 'bank1',
  subsidiaryName: 'Land Bank Kabankalan 1234',
};

const CHECKS = [
  {
    sourceNo: '1234',
    payeeId: 'p1',
    payeeName: 'Negros Hardware',
    particulars: 'Purchase of office supplies',
    amount: 120_000,
  },
  {
    sourceNo: '1235',
    payeeId: 'p2',
    payeeName: 'Candoni Builders',
    particulars: 'Progress billing, barangay road',
    amount: 360_000,
  },
];

describe('paymentParticulars', () => {
  it('reads the way the office writes it', () => {
    expect(paymentParticulars('RCI', '1234', 'Purchase of office supplies')).toBe(
      'Payment of Check No. 1234 - Purchase of office supplies',
    );
  });

  it('names an advice an advice', () => {
    expect(paymentParticulars('RADAI', '2026-0007', 'September payroll')).toBe(
      'Payment of ADA No. 2026-0007 - September payroll',
    );
  });

  /* A dangling dash on a ledger line looks like something went missing. */
  it('leaves no dangling dash when the voucher said nothing', () => {
    expect(paymentParticulars('RCI', '1234', '')).toBe('Payment of Check No. 1234');
    expect(paymentParticulars('RCI', '1234', null)).toBe('Payment of Check No. 1234');
  });
});

describe('proposePaymentEntry', () => {
  it('settles the payable one creditor at a time', () => {
    const entry = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: CHECKS,
    });

    const debits = entry.filter((l) => l.debit > 0);
    expect(debits).toHaveLength(2);
    expect(debits[0]).toMatchObject({
      accountCode: '20101010',
      debit: 120_000,
      subsidiaryType: 'PAYEE',
      subsidiaryId: 'p1',
      subsidiaryName: 'Negros Hardware',
      particulars: 'Payment of Check No. 1234 - Purchase of office supplies',
    });
  });

  /*
   * Patch 147. Each check is paid by the bank on its own, when it is
   * presented - so Cash in Bank is credited per check, worded like the
   * payable line but naming the report: "Payment of RCI <no> Check No. <no>
   * - <the voucher's particulars>".
   */
  it('credits the bank once per check, naming the RCI and the check', () => {
    const entry = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: CHECKS,
      reportNo: '2026-10-0005',
    });

    const credits = entry.filter((l) => l.credit > 0);
    expect(credits).toHaveLength(2);
    expect(credits[0]).toMatchObject({
      accountCode: '10102010',
      credit: 120_000,
      subsidiaryId: 'bank1',
      particulars: 'Payment of RCI 2026-10-0005 Check No. 1234 - Purchase of office supplies',
    });
    expect(credits[1].credit).toBe(360_000);
    // Debits first, then the credits.
    expect(entry.map((l) => (l.debit > 0 ? 'D' : 'C')).join('')).toBe('DDCC');
  });

  it('leaves the report number out until the report has one', () => {
    const entry = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: [{ sourceNo: '1240', amount: 10_000 }],
    });
    expect(entry.find((l) => l.credit > 0)?.particulars).toBe('Payment of RCI Check No. 1240');
  });

  it('keeps ONE credit for a RADAI, which the bank debits as one', () => {
    const entry = proposePaymentEntry({
      kind: 'RADAI',
      payable: PAYABLE,
      cash: CASH,
      documents: CHECKS,
      reportNo: '2026-101',
    });
    const credits = entry.filter((l) => l.credit > 0);
    expect(credits).toHaveLength(1);
    expect(credits[0].credit).toBe(480_000);
  });

  it('balances', () => {
    const entry = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: CHECKS,
    });
    expect(entry.reduce((s, l) => s + l.debit, 0)).toBe(480_000);
    expect(entry.reduce((s, l) => s + l.credit, 0)).toBe(480_000);
  });

  /*
   * A cancelled check is reported - the report foots around it - but it paid
   * nobody, so it is not a line in the entry.
   */
  it('leaves a cancelled check out of the entry and out of the total', () => {
    const entry = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: [...CHECKS, { sourceNo: '1236', amount: 50_000, excluded: true }],
    });

    expect(entry.filter((l) => l.debit > 0)).toHaveLength(2);
    expect(entry.filter((l) => l.credit > 0)).toHaveLength(2);
    expect(entry.reduce((s, l) => s + l.credit, 0)).toBe(480_000);
  });

  /*
   * The one that matters most. A report loaded from a bank file has names and
   * no ids. Guessing the payee from the name would merge two similarly named
   * suppliers into one subsidiary account, and nothing anywhere would say so.
   */
  it('leaves the subsidiary empty rather than guessing a payee from a name', () => {
    const entry = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: [{ sourceNo: '1240', payeeName: 'Negros Hardware', amount: 10_000 }],
    });

    const debit = entry.find((l) => l.debit > 0);
    expect(debit?.subsidiaryType).toBeNull();
    expect(debit?.subsidiaryId).toBeNull();
    expect(debit?.subsidiaryName).toBeNull();
  });

  it('proposes nothing at all when there is nothing reportable', () => {
    expect(
      proposePaymentEntry({
        kind: 'RCI',
        payable: PAYABLE,
        cash: CASH,
        documents: [{ sourceNo: '1236', amount: 50_000, excluded: true }],
      }),
    ).toEqual([]);
  });
});

describe('rebuildPaymentEntry', () => {
  /*
   * The upload used to RESCALE the entry when a held row was resolved. With
   * one payable line per document that would spread the new payment across
   * every other supplier's subsidiary account - right to the centavo and
   * wrong about who was paid.
   */
  it('adds the resolved document instead of stretching the others', () => {
    const existing = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: CHECKS,
    });

    const rebuilt = rebuildPaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      existing,
      documents: [
        ...CHECKS,
        { sourceNo: '1236', payeeId: 'p3', payeeName: 'Rivera Trading', amount: 20_000 },
      ],
    });

    const debits = rebuilt.filter((l) => l.debit > 0);
    expect(debits).toHaveLength(3);
    expect(debits[0].debit).toBe(120_000);
    expect(debits[2]).toMatchObject({ subsidiaryId: 'p3', debit: 20_000 });
    expect(rebuilt.reduce((s, l) => s + l.credit, 0)).toBe(500_000);
    expect(rebuilt.filter((l) => l.credit > 0)).toHaveLength(3);
  });

  it('keeps the bank line it was given, adjustments and all', () => {
    const adjusted = [
      { accountCode: '20101010', accountName: 'Accounts Payable', debit: 120_000, credit: 0 },
      {
        accountCode: '10102020',
        accountName: 'Cash in Bank - Savings',
        debit: 0,
        credit: 120_000,
        subsidiaryType: 'BANK_ACCOUNT',
        subsidiaryId: 'bank9',
        subsidiaryName: 'Land Bank savings',
      },
    ];

    const rebuilt = rebuildPaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      existing: adjusted,
      documents: CHECKS,
    });

    const credits = rebuilt.filter((l) => l.credit > 0);
    expect(credits.map((l) => l.credit)).toEqual([120_000, 360_000]);
    for (const l of credits) {
      expect(l).toMatchObject({ accountCode: '10102020', subsidiaryId: 'bank9' });
    }
  });

  it('leaves an entry it cannot read alone', () => {
    expect(
      rebuildPaymentEntry({
        kind: 'RCI',
        payable: PAYABLE,
        existing: [],
        documents: CHECKS,
      }),
    ).toEqual([]);
  });
});

describe('renumberPaymentEntry (patch 147)', () => {
  const entry = proposePaymentEntry({
    kind: 'RCI',
    payable: PAYABLE,
    cash: CASH,
    documents: CHECKS,
    reportNo: '2026-10-05',
  });

  it('puts the certified number into the cash lines', () => {
    const out = renumberPaymentEntry(entry, 'RCI', '2026-10-0005');
    expect(out.filter((l) => l.credit > 0).map((l) => l.particulars)).toEqual([
      'Payment of RCI 2026-10-0005 Check No. 1234 - Purchase of office supplies',
      expect.stringMatching(/^Payment of RCI 2026-10-0005 Check No\. 1235/),
    ]);
  });

  it('numbers a line that had no number yet', () => {
    const bare = proposePaymentEntry({
      kind: 'RCI',
      payable: PAYABLE,
      cash: CASH,
      documents: [{ sourceNo: '1240', amount: 10_000 }],
    });
    const out = renumberPaymentEntry(bare, 'RCI', '2026-10-0006');
    expect(out.find((l) => l.credit > 0)?.particulars).toBe(
      'Payment of RCI 2026-10-0006 Check No. 1240',
    );
  });

  it('leaves the payable lines, and wording the Accountant changed, alone', () => {
    const edited = entry.map((l, i) =>
      i === entry.length - 1 ? { ...l, particulars: 'Encashment of checks' } : l,
    );
    const out = renumberPaymentEntry(edited, 'RCI', '2026-10-0005');
    expect(out.filter((l) => l.debit > 0)).toEqual(edited.filter((l) => l.debit > 0));
    expect(out[out.length - 1].particulars).toBe('Encashment of checks');
  });
});
