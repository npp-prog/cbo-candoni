import { describe, it, expect } from 'vitest';
import { matchPayees, parseBankFileGrid, parsePayeeSheet } from './dvPayees';
import { checkDvPayees, withEtAl, withoutEtAl } from '@/lib/accounting-rules';
import { proposePaymentEntry } from '@/lib/treasuryEntry';
import { proposeDvEntry } from './proposeEntry';

/** Patch 138: "Payee, et al." - one voucher, several payees, one ADA. */
describe('the payee list of a group voucher', () => {
  const sheet = [
    { Name: 'Juan Dela Cruz', 'ATM No.': '0012-3456-78', Amount: '5,000.00' },
    { Name: 'Maria Santos', 'ATM No.': '0099-1111-22', Amount: '3,000.50' },
    { Name: '', 'ATM No.': '', Amount: '' },
    { Name: 'Pedro Penduko', 'ATM No.': '7777', Amount: '1,999.50' },
  ];

  it('reads Name, ATM / Account No. and Amount, skipping blank lines', () => {
    const { rows, problems } = parsePayeeSheet(sheet);
    expect(problems).toEqual([]);
    expect(rows.map((r) => [r.name, r.accountNumber, r.amount])).toEqual([
      ['Juan Dela Cruz', '0012-3456-78', 5_000_00],
      ['Maria Santos', '0099-1111-22', 3_000_50],
      ['Pedro Penduko', '7777', 1_999_50],
    ]);
  });

  it('does not take an "Account Name" column for the name or the account', () => {
    const { rows } = parsePayeeSheet([
      { 'Account Name': 'JDC SAVINGS', Name: 'Juan Dela Cruz', 'Account No.': '123', Amount: 10 },
    ]);
    expect(rows[0].name).toBe('Juan Dela Cruz');
    expect(rows[0].accountNumber).toBe('123');
  });

  it('matches by account number, then TIN, then an exact unique name - never a near one', () => {
    const { rows } = parsePayeeSheet(sheet);
    const m = matchPayees(
      rows,
      [
        { id: 'p1', name: 'DELA CRUZ, JUAN', bankAccountNumber: '001234567 8' },
        { id: 'p2', name: 'Maria Santos', employeeId: 'e2' },
        { id: 'p3', name: 'Pedro Pendoko' },
      ],
      [{ id: 'e2', bankAccountNumber: '0099111122' }],
    );
    expect(m.map((r) => [r.payeeId, r.matchedOn])).toEqual([
      ['p1', 'ACCOUNT'],
      ['p2', 'ACCOUNT'],
      [null, null],
    ]);
    expect(m[0].payeeName).toBe('DELA CRUZ, JUAN');
  });

  it('flags an uploaded account that differs from the master record', () => {
    const m = matchPayees(
      [{ lineNo: 2, name: 'Maria Santos', accountNumber: '555', tin: '', amount: 1 }],
      [{ id: 'p2', name: 'Maria Santos', bankAccountNumber: '999' }],
      [],
    );
    expect(m[0]).toMatchObject({ payeeId: 'p2', matchedOn: 'NAME', accountDiffers: true });
  });

  it('treats an account that lost its leading zeros in Excel as the same account', () => {
    const m = matchPayees(
      [{ lineNo: 2, name: 'M. B. Dela Cruz', accountNumber: '11223344', tin: '', amount: 1 }],
      [{ id: 'p1', name: 'Ma Bella Dela Cruz', bankAccountNumber: '0011223344' }],
      [],
    );
    expect(m[0]).toMatchObject({
      payeeId: 'p1',
      matchedOn: 'ACCOUNT',
      accountDiffers: false,
      accountNumber: '0011223344',
    });
  });

  it('writes the et al. once, and takes it off', () => {
    expect(withEtAl('Juan Dela Cruz')).toBe('Juan Dela Cruz, et al.');
    expect(withEtAl('Juan Dela Cruz, et al.')).toBe('Juan Dela Cruz, et al.');
    expect(withoutEtAl('Juan Dela Cruz et al')).toBe('Juan Dela Cruz');
  });

  it('holds the list to the net amount, the master list and an account each', () => {
    const ok = [
      { payeeId: 'p1', payeeName: 'A', accountNumber: '0011223344', amount: 600 },
      { payeeId: 'p2', payeeName: 'B', accountNumber: '5566778899', amount: 400 },
    ];
    expect(checkDvPayees(ok, 1000).ok).toBe(true);
    expect(checkDvPayees(ok, 999).violations.map((v) => v.code)).toContain('PAYEES_NOT_NET');
    expect(
      checkDvPayees(
        [
          { ...ok[0], payeeId: null },
          { ...ok[1], accountNumber: '' },
        ],
        1000,
      ).violations.map((v) => v.code),
    ).toEqual(['PAYEE_NOT_ON_FILE', 'PAYEE_NO_ACCOUNT']);
    expect(checkDvPayees([ok[0], { ...ok[1], payeeId: 'p1' }], 1000).violations[0].code).toBe(
      'PAYEE_TWICE',
    );
    expect(checkDvPayees([ok[0]], 600).violations[0].code).toBe('PAYEES_TOO_FEW');
  });

  it('credits the payable per payee on the voucher, and the ADA clears it per payee', () => {
    const payees = [
      { payeeId: 'p1', payeeName: 'A', amount: 600 },
      { payeeId: 'p2', payeeName: 'B', amount: 400 },
    ];
    const dv = proposeDvEntry({
      grossAmount: 1000,
      deductions: [],
      netAmount: 1000,
      obligationLines: [{ accountCode: '50101010', accountName: 'Salaries', amount: 1000 }],
      payee: { id: 'p1', name: 'A, et al.' },
      payees,
    });
    const ap = dv.filter((l) => l.credit > 0);
    expect(ap.map((l) => [l.subsidiaryId, l.credit])).toEqual([
      ['p1', 600],
      ['p2', 400],
    ]);

    const radai = proposePaymentEntry({
      kind: 'RADAI',
      payable: { code: '20101010', name: 'Accounts Payable' },
      cash: { accountCode: '10102020', accountName: 'Cash in Bank' },
      documents: [
        { sourceNo: '2026-10-0002', payeeId: 'p1', payeeName: 'A, et al.', amount: 1000, payees },
      ],
    });
    expect(radai.filter((l) => l.debit > 0).map((l) => [l.subsidiaryId, l.debit])).toEqual([
      ['p1', 600],
      ['p2', 400],
    ]);
    expect(radai.find((l) => l.credit > 0)?.credit).toBe(1000);
  });
});

describe('the payee list messages', () => {
  it('names a row with no payee by its line number', () => {
    const r = checkDvPayees(
      [
        { payeeId: 'p1', payeeName: 'Ana', accountNumber: '0011223344', amount: 100 },
        { payeeId: null, payeeName: '', accountNumber: '', amount: 0 },
      ],
      100,
    );
    const text = r.violations.map((v) => v.message).join(' ');
    expect(text).toContain('No payee from the master list on line 2');
    expect(text).toContain('No ATM / account number for line 2');
    expect(text).toContain('No share entered for line 2');
    expect(text).not.toContain('(no name)');
  });
});

describe("reading the bank's own file back", () => {
  it('recognises it by its first row and reads the amount as centavos', () => {
    const rows = parseBankFileGrid([
      ['0011223344', 'Ma Bella Dela Cruz', '1000010'],
      ['5566778899', 'Juan Santos', '1000000'],
    ]);
    expect(rows).toEqual([
      { lineNo: 1, accountNumber: '0011223344', name: 'Ma Bella Dela Cruz', tin: '', amount: 1000010 },
      { lineNo: 2, accountNumber: '5566778899', name: 'Juan Santos', tin: '', amount: 1000000 },
    ]);
  });

  it('leaves a list with headings to be read by its headings', () => {
    expect(parseBankFileGrid([['Name', 'ATM No.', 'Amount'], ['Ana', '0011223344', '100.00']])).toBeNull();
  });
});
