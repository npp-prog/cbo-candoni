import { describe, expect, it } from 'vitest';
import {
  reconcileCashInBank,
  reconcileLocalTreasury,
  type BankBookInput,
  type ReconLedgerEntry,
  type ReconReport,
} from './cashReconciliation';

const CLT = '10101010';
const CIB = '10102020';

let n = 0;
const gl = (over: Partial<ReconLedgerEntry>): ReconLedgerEntry => ({
  id: `l${++n}`,
  jevId: 'j1',
  jevNo: '100-26-10-001',
  entryDate: '2026-10-07',
  accountCode: CLT,
  debit: 0,
  credit: 0,
  sourceType: 'RCD',
  ...over,
});

const rcd = (over: Partial<ReconReport>): ReconReport => ({
  id: 'r1',
  reportType: 'RCD',
  reportNo: '111',
  reportDate: '2026-10-07',
  status: 'JOURNALIZED',
  jevId: 'j1',
  accountableOfficerName: 'REYES, Ana B.',
  lines: [
    { sourceId: 'c1', sourceNo: '1234566', amount: 100_00 },
    { sourceId: 'c2', sourceNo: '1234567', amount: 200_00 },
  ],
  deposits: [{ sourceId: 'd1', depositSlipNo: 'DS-1', amount: 200_00 }],
  ...over,
});

describe('reconcileLocalTreasury', () => {
  it('agrees a journalized RCD with its entry', () => {
    const r = reconcileLocalTreasury({
      fiscalYear: 2026,
      asOf: '2026-10-31',
      rcds: [rcd({})],
      ledger: [gl({ debit: 300_00, sourceId: 'r1' }), gl({ credit: 200_00, sourceId: 'r1' })],
    });
    expect(r.treasuryBalance).toBe(100_00);
    expect(r.bookBalance).toBe(100_00);
    expect(r.items).toEqual([]);
    expect(r.agreed.count).toBe(1);
    expect(r.unexplained).toBe(0);
  });

  it('names a certified RCD not yet journalized, and the opening balance', () => {
    const r = reconcileLocalTreasury({
      fiscalYear: 2026,
      asOf: '2026-10-31',
      rcds: [rcd({ status: 'CERTIFIED', jevId: null, forwardedAt: '2026-10-08' })],
      ledger: [
        gl({
          jevId: 'jo',
          jevNo: 'OB-1',
          sourceType: 'OPENING',
          entryDate: '2026-01-01',
          debit: 50_00,
        }),
      ],
    });
    expect(r.treasuryBalance).toBe(100_00);
    expect(r.bookBalance).toBe(50_00);
    const t = r.items.find((i) => i.side === 'TREASURY_ONLY')!;
    expect(t.effect).toBe(-100_00);
    expect(t.cause).toMatch(/not yet journalized/);
    const o = r.items.find((i) => i.side === 'BOOKS_ONLY')!;
    expect(o.cause).toMatch(/Beginning balance/);
    expect(r.bridged).toBe(50_00);
    expect(r.unexplained).toBe(0);
  });

  it('treats an entry dated after the date as not yet in the books', () => {
    const r = reconcileLocalTreasury({
      fiscalYear: 2026,
      asOf: '2026-10-07',
      rcds: [rcd({})],
      ledger: [
        gl({ debit: 300_00, sourceId: 'r1', entryDate: '2026-10-09' }),
        gl({ credit: 200_00, sourceId: 'r1', entryDate: '2026-10-09' }),
      ],
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].cause).toMatch(/after the date/);
  });

  it('flags a journalized amount that differs from the report', () => {
    const r = reconcileLocalTreasury({
      fiscalYear: 2026,
      asOf: '2026-10-31',
      rcds: [rcd({})],
      ledger: [gl({ debit: 290_00, sourceId: 'r1' }), gl({ credit: 200_00, sourceId: 'r1' })],
    });
    expect(r.items[0].side).toBe('DIFFERENT');
    expect(r.items[0].effect).toBe(-10_00);
    expect(r.unexplained).toBe(0);
  });

  it('nets a reversed RCD entry against the withdrawn report', () => {
    const r = reconcileLocalTreasury({
      fiscalYear: 2026,
      asOf: '2026-10-31',
      rcds: [rcd({ status: 'CANCELLED' })],
      ledger: [
        gl({ debit: 300_00, sourceId: 'r1' }),
        gl({ credit: 200_00, sourceId: 'r1' }),
        gl({ jevId: 'j2', jevNo: 'R-1', sourceType: 'REVERSING', sourceId: 'j1', credit: 300_00 }),
        gl({ jevId: 'j2', jevNo: 'R-1', sourceType: 'REVERSING', sourceId: 'j1', debit: 200_00 }),
      ],
    });
    expect(r.items).toEqual([]);
    expect(r.bookBalance).toBe(0);
  });
});

const book = (over: Partial<BankBookInput> = {}): BankBookInput => ({
  bankAccountId: 'ba1',
  fiscalYear: 2026,
  beginningBalance: 1_000_00,
  manualEntries: [],
  deposits: [
    {
      id: 'd1',
      fiscalYear: 2026,
      depositDate: '2026-10-07',
      depositSlipNo: 'DS-1',
      amount: 200_00,
      status: 'IN_TRANSIT',
      jevId: 'j1',
      treasuryReportId: 'r1',
    },
  ],
  checks: [
    {
      id: 'k1',
      fiscalYear: 2026,
      checkDate: '2026-10-08',
      checkNo: '0001234',
      payeeName: 'Juan',
      netAmount: 150_00,
      status: 'RELEASED',
      treasuryReportId: 'rci1',
    },
  ],
  adas: [],
  ...over,
});

const rci = (over: Partial<ReconReport> = {}): ReconReport => ({
  id: 'rci1',
  reportType: 'RCI',
  reportNo: '2026-10-0001',
  reportDate: '2026-10-08',
  status: 'JOURNALIZED',
  jevId: 'j5',
  ...over,
});

const bankGl = (over: Partial<ReconLedgerEntry>) =>
  gl({ accountCode: CIB, subsidiaryId: 'ba1', ...over });

describe('reconcileCashInBank', () => {
  const ledger = [
    bankGl({
      jevId: 'jo',
      jevNo: 'OB',
      sourceType: 'OPENING',
      entryDate: '2026-01-01',
      debit: 1_000_00,
    }),
    bankGl({ jevId: 'j1', sourceId: 'r1', debit: 200_00 }),
    bankGl({
      jevId: 'j5',
      jevNo: 'J5',
      sourceType: 'RCI',
      sourceId: 'rci1',
      entryDate: '2026-10-08',
      credit: 150_00,
      particulars: 'Payment of RCI 2026-10-0001 Check No. 0001234',
    }),
  ];

  it('agrees the book with the ledger document by document', () => {
    const r = reconcileCashInBank({
      asOf: '2026-10-31',
      book: book(),
      reports: [rcd({}), rci()],
      ledger,
      onlyAccountOnCode: true,
    });
    expect(r.treasuryBalance).toBe(1_050_00);
    expect(r.bookBalance).toBe(1_050_00);
    expect(r.items).toEqual([]);
    expect(r.agreed.count).toBe(3);
  });

  it('names a check on an RCI not yet journalized, and pairs a bank charge with its JEV', () => {
    const r = reconcileCashInBank({
      asOf: '2026-10-31',
      book: book({
        manualEntries: [
          {
            id: 'm1',
            entryDate: '2026-10-30',
            kind: 'BANK_CHARGE',
            inflow: false,
            particulars: 'Service charge',
            amount: 50_00,
          },
        ],
      }),
      reports: [rcd({}), rci({ status: 'CERTIFIED', jevId: null, forwardedAt: '2026-10-09' })],
      ledger: [
        ...ledger.slice(0, 2),
        bankGl({
          jevId: 'j9',
          jevNo: 'J9',
          sourceType: 'ADJUSTING',
          entryDate: '2026-10-31',
          credit: 50_00,
          particulars: 'Bank charges October',
        }),
      ],
      onlyAccountOnCode: true,
    });
    const rciItem = r.items.find((i) => i.reference.startsWith('RCI'))!;
    expect(rciItem.side).toBe('TREASURY_ONLY');
    expect(rciItem.effect).toBe(150_00);
    expect(rciItem.cause).toMatch(/not yet journalized/);
    const pair = r.items.find((i) => i.side === 'PAIRED')!;
    expect(pair.effect).toBe(0);
    expect(r.unexplained).toBe(0);
  });

  it('ignores another bank account on the same GL account', () => {
    const r = reconcileCashInBank({
      asOf: '2026-10-31',
      book: book(),
      reports: [rcd({}), rci()],
      ledger: [...ledger, bankGl({ jevId: 'jx', subsidiaryId: 'ba2', debit: 999_00 })],
      onlyAccountOnCode: false,
    });
    expect(r.bookBalance).toBe(1_050_00);
    expect(r.items).toEqual([]);
  });

  it('shows the check missing from an RCI entry', () => {
    const r = reconcileCashInBank({
      asOf: '2026-10-31',
      book: book({
        checks: [
          ...book().checks,
          {
            id: 'k2',
            fiscalYear: 2026,
            checkDate: '2026-10-08',
            checkNo: '0001235',
            payeeName: 'Pedro',
            netAmount: 20_00,
            status: 'RELEASED',
            treasuryReportId: 'rci1',
          },
        ],
      }),
      reports: [rcd({}), rci()],
      ledger,
      onlyAccountOnCode: true,
    });
    expect(r.items[0].side).toBe('DIFFERENT');
    expect(r.items[0].cause).toMatch(/Not in the entry: Check No\. 0001235/);
  });
});
