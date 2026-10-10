/**
 * Patch 163 - the Bank Reconciliation Statement in the office's own format
 * (BRS_<account>_<MM><Mon><YYYY>.xlsx).
 *
 * The statement has two columns of figures, BOOK and BANK, and six fixed
 * lines of reconciling items between the unadjusted and the adjusted
 * balances:
 *
 *   1. Checks issued not taken up by the bank         Bank  (-)
 *   2. Checks issued overstated/(understated) by book  Book
 *   3. Deposits not taken up by the bank               Bank  (+)
 *   4. Deposits overstated/(understated) by book       Book
 *   5. Bank debit/credit memos not taken up by the LGU Book  (+ credit, - debit)
 *   6. Other reconciling items                         Bank  (bank errors)
 *
 * The second sheet, the SCHEDULES, lists every item behind each line: Date,
 * Reference No., Name, Amount, Remarks, and a subtotal.
 *
 * Nothing here is typed in. The book balance is the General Ledger's; the
 * outstanding checks and deposits in transit are the open documents; the memos
 * and the bank errors are the statement lines classified on the Bank statement
 * tab. Lines 2 and 4 are book errors - they are corrected by a journal entry,
 * which the ledger then carries, so they print as nil.
 */

export type BrsColumn = 'BOOK' | 'BANK';

export type BrsLineKey =
  | 'CHECKS_NOT_TAKEN_UP'
  | 'CHECKS_BOOK_ERROR'
  | 'DEPOSITS_NOT_TAKEN_UP'
  | 'DEPOSITS_BOOK_ERROR'
  | 'MEMOS_NOT_TAKEN_UP'
  | 'OTHER';

export interface BrsItem {
  date: string;
  ref: string;
  name: string;
  /** Signed, centavos: the effect on the column it sits in. */
  amount: number;
  remarks: string;
}

export interface BrsLine {
  key: BrsLineKey;
  label: string;
  column: BrsColumn;
  amount: number;
  items: BrsItem[];
  /** The Explanatory Note column. */
  note: string;
}

export interface Brs {
  monthLabel: string;
  bookBalance: number;
  bankBalance: number;
  lines: BrsLine[];
  adjustedBook: number;
  adjustedBank: number;
  difference: number;
  /** What the reconciliation record stores (the server re-checks these). */
  depositsInTransit: number;
  outstandingChecks: number;
  bankAdjustments: number;
  bookAdjustments: number;
}

export interface BrsInput {
  statementDate: string;
  bankShortName: string;
  lguShortName?: string;
  bookBalance: number;
  bankBalance: number;
  checks: Array<{ date: string; ref: string; name: string; amount: number }>;
  deposits: Array<{ date: string; ref: string; name: string; amount: number }>;
  /** Statement lines classified BANK_CHARGE, INTEREST_INCOME or ERROR. */
  statementLines: Array<{
    date: string;
    ref: string;
    description: string;
    debit: number;
    credit: number;
    kind: 'BANK_CHARGE' | 'INTEREST_INCOME' | 'ERROR';
  }>;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "July 2026" */
export function monthLabel(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${date.slice(0, 4)}`;
}

/** The last day of the statement's month - what the ledger is read through. */
export function monthEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

/** 7/1/2026, as the schedules write a date in a remark. */
export function mdy(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}/${date.slice(0, 4)}`;
}

/** "Carried forward - outstanding since 6/12/2026" for an item of an earlier month. */
function carried(date: string, statementDate: string): string {
  return date < `${statementDate.slice(0, 7)}-01`
    ? `Carried forward - outstanding since ${mdy(date)}`
    : '';
}

const byDate = (a: BrsItem, b: BrsItem) =>
  a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref, undefined, { numeric: true });

const sum = (items: BrsItem[]) => items.reduce((t, i) => t + i.amount, 0);

function count(n: number, one: string): string {
  return n === 0 ? '' : `${n} ${one}${n === 1 ? '' : 's'} - see schedule`;
}

export function buildBrs(input: BrsInput): Brs {
  const bank = input.bankShortName || 'the bank';
  const lgu = input.lguShortName || 'the LGU';
  const asOf = monthEnd(input.statementDate);

  const checks: BrsItem[] = input.checks
    .filter((c) => c.date <= asOf)
    .map((c) => ({
      date: c.date,
      ref: c.ref,
      name: c.name,
      amount: -Math.abs(c.amount),
      remarks: carried(c.date, input.statementDate),
    }))
    .sort(byDate);

  const deposits: BrsItem[] = input.deposits
    .filter((d) => d.date <= asOf)
    .map((d) => ({
      date: d.date,
      ref: d.ref,
      name: d.name,
      amount: Math.abs(d.amount),
      remarks: carried(d.date, input.statementDate),
    }))
    .sort(byDate);

  const lines = input.statementLines.filter((t) => t.date <= asOf);

  const memos: BrsItem[] = lines
    .filter((t) => t.kind !== 'ERROR')
    .map((t) => {
      const credit = t.kind === 'INTEREST_INCOME';
      return {
        date: t.date,
        ref: t.ref,
        name: t.description,
        amount: credit ? t.credit : -t.debit,
        remarks: credit ? 'Credit memo' : 'Debit memo',
      };
    })
    .sort(byDate);

  /*
   * A bank error sits on the bank's side: the statement shows a movement that
   * is not ours, so it is reversed - a wrong debit added back, a wrong credit
   * taken off.
   */
  const errors: BrsItem[] = lines
    .filter((t) => t.kind === 'ERROR')
    .map((t) => ({
      date: t.date,
      ref: t.ref,
      name: t.description,
      amount: t.debit - t.credit,
      remarks: t.debit ? 'Bank error - debit to be reversed' : 'Bank error - credit to be reversed',
    }))
    .sort(byDate);

  const out: BrsLine[] = [
    {
      key: 'CHECKS_NOT_TAKEN_UP',
      label: `Checks Issued not taken up by ${bank}`,
      column: 'BANK',
      amount: sum(checks),
      items: checks,
      note: count(checks.length, 'outstanding check'),
    },
    {
      key: 'CHECKS_BOOK_ERROR',
      label: `Check Issued Overstated/(Understated) by ${lgu}`,
      column: 'BOOK',
      amount: 0,
      items: [],
      note: '',
    },
    {
      key: 'DEPOSITS_NOT_TAKEN_UP',
      label: `Deposits not taken up by ${bank}`,
      column: 'BANK',
      amount: sum(deposits),
      items: deposits,
      note: count(deposits.length, 'deposit in transit'),
    },
    {
      key: 'DEPOSITS_BOOK_ERROR',
      label: `Deposit Overstated/(Understated) by ${lgu}`,
      column: 'BOOK',
      amount: 0,
      items: [],
      note: '',
    },
    {
      key: 'MEMOS_NOT_TAKEN_UP',
      label: `Bank Debit/Credit Memos not taken up by ${lgu}`,
      column: 'BOOK',
      amount: sum(memos),
      items: memos,
      note: memos.length ? `${memos.length} memo${memos.length === 1 ? '' : 's'} - for JEV` : '',
    },
    {
      key: 'OTHER',
      label: 'Other Reconciling Items',
      column: 'BANK',
      amount: sum(errors),
      items: errors,
      note: errors.length ? `${errors.length} bank error${errors.length === 1 ? '' : 's'}` : '',
    },
  ];

  const bookAdj = out.filter((l) => l.column === 'BOOK').reduce((t, l) => t + l.amount, 0);
  const bankAdj = out.filter((l) => l.column === 'BANK').reduce((t, l) => t + l.amount, 0);
  const adjustedBook = input.bookBalance + bookAdj;
  const adjustedBank = input.bankBalance + bankAdj;

  return {
    monthLabel: monthLabel(input.statementDate),
    bookBalance: input.bookBalance,
    bankBalance: input.bankBalance,
    lines: out,
    adjustedBook,
    adjustedBank,
    difference: adjustedBank - adjustedBook,
    depositsInTransit: sum(deposits),
    outstandingChecks: -sum(checks),
    bankAdjustments: sum(errors),
    bookAdjustments: bookAdj,
  };
}

/** BRS_1172-1020-22_07Jul2026 */
export function brsFileName(accountNumber: string, statementDate: string): string {
  const m = Number(statementDate.slice(5, 7));
  const mon = (MONTHS[m - 1] ?? '').slice(0, 3);
  return `BRS_${accountNumber}_${String(m).padStart(2, '0')}${mon}${statementDate.slice(0, 4)}`;
}

/** "Jul2026" - the suffix of the two sheet names, BR_ and S_. */
export function sheetSuffix(statementDate: string): string {
  const m = Number(statementDate.slice(5, 7));
  return `${(MONTHS[m - 1] ?? '').slice(0, 3)}${statementDate.slice(0, 4)}`;
}
