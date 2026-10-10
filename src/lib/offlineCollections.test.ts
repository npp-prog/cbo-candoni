import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseAbstractFile } from '@/pages/treasury/parseAbstract';
import {
  ABSTRACT_HEADERS,
  abstractCsv,
  abstractRows,
  nextFreeSerial,
  readSetup,
  subsidiaryLedgers,
  receiptProblems,
  type OfflineReceipt,
  type OfflineSetup,
} from './offlineCollections';

const setup: OfflineSetup = {
  format: 'CFMS-OFFLINE-SETUP',
  version: 1,
  projectId: 'cbo-candoni-dev',
  generatedAt: '2027-01-02T00:00:00Z',
  generatedBy: 'Neil',
  fiscalYear: 2027,
  headingLines: ['Republic of the Philippines', 'MUNICIPAL GOVERNMENT OF CANDONI', 'Candoni'],
  treasurer: { name: 'TREASURER', position: 'Municipal Treasurer' },
  officer: { id: 'e5', name: 'SANTOS, Juan', position: 'Revenue Collection Clerk' },
  funds: [{ code: 'GF', name: 'General Fund' }],
  accounts: [
    { code: '40202200', name: 'Hospital Fees', perParty: false },
    { code: '40603990', name: 'Miscellaneous Income', perParty: false },
    { code: '10301010', name: 'Accounts Receivable', perParty: true },
  ],
  subsidiaries: [
    { name: 'DELA CRUZ, Ana', type: 'PAYEE' },
    { name: 'TOPES, Elsie', type: 'PAYEE' },
  ],
  formTypes: [
    { code: 'AF51', name: 'Official Receipt', printedAs: 'ACCT. FORM NO. 51', serialLength: 7 },
  ],
  movements: [
    {
      formCode: 'AF51',
      kind: 'ISSUE',
      movementDate: '2027-01-02',
      serialFrom: '7707701',
      serialTo: '7707750',
      custodianId: 'e5',
    },
  ],
};

const receipt = (o: Partial<OfflineReceipt>): OfflineReceipt => ({
  id: Math.random().toString(36),
  kind: 'CASH',
  fundCode: 'GF',
  orDate: '2027-01-05',
  formCode: 'AF51',
  orNumber: '7707701',
  payorName: 'ELSIE TOPES',
  lines: [{ accountCode: '40202200', description: 'Health Certificate', amount: 5000 }],
  totalAmount: 5000,
  cancelled: false,
  createdAt: '',
  updatedAt: '',
  ...o,
});

async function asFile(rows: ReturnType<typeof abstractRows>): Promise<File> {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...ABSTRACT_HEADERS] });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Abstract');
  const buf = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'a.xlsx');
}

describe('the offline app abstract reads back through the CFMS bulk upload', () => {
  it('two-line receipt, a cancelled one, and the collector and report', async () => {
    const rows = abstractRows(
      [
        receipt({
          orNumber: '7707702',
          lines: [
            { accountCode: '40202200', description: 'Health Certificate', amount: 5000 },
            { accountCode: '40603990', description: 'Miscellaneous Income', amount: 3000 },
          ],
          totalAmount: 8000,
        }),
        receipt({
          orNumber: '7707701',
          cancelled: true,
          cancelReason: 'wrong payor',
          lines: [],
          totalAmount: 0,
        }),
      ],
      { reportNo: 'JS-2027-001', setup },
    );
    const parsed = await parseAbstractFile(await asFile(rows));
    expect(parsed).toHaveLength(2);
    const [cancelled, two] = parsed;
    expect(cancelled).toMatchObject({ orNumber: '7707701', cancelled: true, totalAmount: 0 });
    expect(two).toMatchObject({
      date: '2027-01-05',
      reportRef: 'JS-2027-001',
      accountableForm: 'AF51',
      orNumber: '7707702',
      payor: 'ELSIE TOPES',
      collector: 'SANTOS, Juan',
      fund: 'GF',
      totalAmount: 8000,
      cancelled: false,
    });
    expect(two.lines).toEqual([
      { revenueCode: '40202200', description: 'Health Certificate', amount: 5000 },
      { revenueCode: '40603990', description: 'Miscellaneous Income', amount: 3000 },
    ]);
    expect(two.problem).toBeUndefined();
  });

  it('an e-collection carries its TRN and the subsidiary', async () => {
    const rows = abstractRows(
      [
        receipt({
          kind: 'EOR',
          formCode: undefined,
          orNumber: 'EOR-0001',
          trn: '2027ABC123',
          lines: [
            {
              accountCode: '40202200',
              description: 'Health Certificate',
              amount: 12345,
              subsidiary: 'DELA CRUZ, Ana',
            },
          ],
          totalAmount: 12345,
        }),
      ],
      { reportNo: 'JS-2027-002', setup },
    );
    const [r] = await parseAbstractFile(await asFile(rows));
    expect(r.trn).toBe('2027ABC123');
    expect(r.lines[0]).toEqual({
      revenueCode: '40202200',
      description: 'Health Certificate',
      amount: 12345,
      subsidiary: 'DELA CRUZ, Ana',
    });
  });
});

describe('the CSV choice reads back the same (patch 174)', () => {
  it('keeps leading zeros and amounts, read as text', async () => {
    const rows = abstractRows(
      [
        receipt({
          orNumber: '0007100001',
          lines: [{ accountCode: '40202200', description: 'Business tax, "Q1"', amount: 300000 }],
          totalAmount: 300000,
        }),
      ],
      { reportNo: 'EJBL-2026-001', setup },
    );
    const csv = abstractCsv(rows);
    const [r] = await parseAbstractFile(new File([csv], 'a.csv', { type: 'text/csv' }));
    expect(r).toMatchObject({ orNumber: '0007100001', totalAmount: 300000, date: '2027-01-05' });
    expect(r.lines).toEqual([
      { revenueCode: '40202200', description: 'Business tax, "Q1"', amount: 300000 },
    ]);
  });
});

describe('the receipt checks', () => {
  it('a serial must be in a booklet issued to the officer, and used once', () => {
    expect(receiptProblems(receipt({}), setup, [])).toEqual([]);
    expect(receiptProblems(receipt({ orNumber: '7707800' }), setup, []).join()).toMatch(
      /not issued/,
    );
    expect(receiptProblems(receipt({ orDate: '2027-01-01' }), setup, []).join()).toMatch(
      /not issued/,
    );
    const first = receipt({});
    expect(receiptProblems(receipt({}), setup, [first]).join()).toMatch(/already used/);
  });

  it('a per-party account needs a subsidiary ledger CFMS knows (patch 174)', () => {
    const ar = { accountCode: '10301010', description: 'Collection of receivable', amount: 100 };
    expect(
      receiptProblems(receipt({ payorName: 'PEDRO CRUZ', lines: [ar] }), setup, []).join(),
    ).toMatch(/not a subsidiary ledger/);
    expect(
      receiptProblems(receipt({ lines: [{ ...ar, subsidiary: 'Ana Dela Cruz' }] }), setup, []),
    ).toEqual([]);
    // Blank: the payor, when the payor is a Name.
    expect(receiptProblems(receipt({ payorName: 'Elsie Topes', lines: [ar] }), setup, [])).toEqual(
      [],
    );
  });

  it('e-collections need a TRN, not a booklet', () => {
    expect(
      receiptProblems(
        receipt({ kind: 'EOR', formCode: undefined, orNumber: 'X1' }),
        setup,
        [],
      ).join(),
    ).toMatch(/TRN/);
    expect(
      receiptProblems(
        receipt({ kind: 'EOR', formCode: undefined, orNumber: 'X1', trn: 'T' }),
        setup,
        [],
      ),
    ).toEqual([]);
  });

  it('suggests the next unused serial', () => {
    expect(nextFreeSerial(setup, 'AF51', '2027-01-05', [])).toBe('7707701');
    expect(nextFreeSerial(setup, 'AF51', '2027-01-05', [receipt({})])).toBe('7707702');
  });

  it('reads a setup file and refuses anything else', () => {
    expect(readSetup(JSON.stringify(setup)).officer.name).toBe('SANTOS, Juan');
    expect(() => readSetup('{"a":1}')).toThrow(/not a CFMS/);
  });
});

describe('the subsidiary ledgers in the setup file', () => {
  it('are the Names, and the employees not already a Name - as the upload sees them', () => {
    expect(
      subsidiaryLedgers(
        [
          { name: 'ABC Trading' },
          { name: 'SANTOS, Juan', employeeId: 'e2' },
          { name: 'Old Supplier', active: false },
        ],
        [
          { id: 'e2', displayName: 'SANTOS, Juan' },
          { id: 'e5', displayName: 'REYES, Ana' },
        ],
      ),
    ).toEqual([
      { name: 'ABC Trading', type: 'PAYEE' },
      { name: 'REYES, Ana', type: 'EMPLOYEE' },
      { name: 'SANTOS, Juan', type: 'EMPLOYEE' },
    ]);
  });
});
