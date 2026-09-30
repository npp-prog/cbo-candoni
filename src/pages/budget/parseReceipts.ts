import { readSheet, findCell, findText, type SheetRow } from '@/lib/spreadsheet';
import { parsePeso } from '@/lib/money';
import { INCOME_CLASSES, type IncomeClass } from '@/lib/estimatedReceipts';

/**
 * Reading the receipts side of LBP Form No. 1.
 *
 * The Treasurer already keeps this as a spreadsheet - it is the schedule the
 * Local Finance Committee signs - so CBO reads that rather than asking for a
 * hundred lines to be typed a second time.
 *
 * ---------------------------------------------------------------------------
 * TWO SHAPES OF FILE, BECAUSE BOTH EXIST
 * ---------------------------------------------------------------------------
 * A quarterly file has a column per quarter. An annual one has a single
 * amount, which is the budget-year column of LBP Form No. 1 and is what most
 * offices actually hold.
 *
 * Where only an annual figure is given it goes ENTIRELY IN THE FOURTH QUARTER
 * rather than being divided by four. Dividing would produce four figures
 * nobody estimated and a Quarterly Report of Receipts showing a tidy shortfall
 * against each of the first three - a variance invented by CBO, reported to
 * the Local Finance Committee as though the Treasurer had projected it. The
 * screen says plainly that the split is missing and lets the office enter it.
 */

export interface ParsedReceiptRow {
  lineNo: number;
  accountCode: string;
  accountName: string;
  incomeClass: IncomeClass;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  particulars: string;
  /** True where the file gave a year total and no quarterly split. */
  annualOnly: boolean;
  /** Why this row cannot be sent. The whole file is held back if any row has one. */
  problem?: string;
}

const COLUMNS = {
  accountCode: [/account\s*code/i, /uacs/i, /^code$/i, /revenue\s*code/i],
  accountName: [
    /account\s*(name|title)/i,
    /^particulars?$/i,
    /description\s*of\s*income/i,
    /source\s*of\s*income/i,
    /^source$/i,
  ],
  incomeClass: [/income\s*class/i, /^class(ification)?$/i, /regular/i, /^type$/i],
  q1: [/^q1$/i, /1st\s*quarter/i, /first\s*quarter/i, /quarter\s*1/i],
  q2: [/^q2$/i, /2nd\s*quarter/i, /second\s*quarter/i, /quarter\s*2/i],
  q3: [/^q3$/i, /3rd\s*quarter/i, /third\s*quarter/i, /quarter\s*3/i],
  q4: [/^q4$/i, /4th\s*quarter/i, /fourth\s*quarter/i, /quarter\s*4/i],
  // "Budget Year" first: it is LBP Form No. 1's own column 7 heading, and a
  // file carrying both it and a "Current Year" estimate must not read the
  // current year's figure as next year's budget.
  annual: [
    /budget\s*year/i,
    /proposed/i,
    /estimated\s*income/i,
    /annual/i,
    /^total$/i,
    /^amount$/i,
    /estimate/i,
  ],
  particulars: [/remarks/i, /notes?/i],
};

/**
 * How an office writes the three classes, mapped to CBO's codes.
 *
 * "Non-Income Receipts" and "Non-Regular Income" both begin with "non", and a
 * loose match on that word would put loan proceeds in with grants. Both are
 * outside regular income, so the statutory limits would come out right and the
 * SRE would not - the kind of error that survives a footing check.
 */
const CLASS_ALIASES: Record<string, IncomeClass> = {
  REGULAR: 'REGULAR',
  'REGULAR INCOME': 'REGULAR',
  R: 'REGULAR',
  'NON-REGULAR': 'NON_REGULAR',
  'NON REGULAR': 'NON_REGULAR',
  NONREGULAR: 'NON_REGULAR',
  'NON-REGULAR INCOME': 'NON_REGULAR',
  'NON REGULAR INCOME': 'NON_REGULAR',
  NR: 'NON_REGULAR',
  'NON-INCOME': 'NON_INCOME',
  'NON INCOME': 'NON_INCOME',
  NONINCOME: 'NON_INCOME',
  'NON-INCOME RECEIPTS': 'NON_INCOME',
  'NON INCOME RECEIPTS': 'NON_INCOME',
  NI: 'NON_INCOME',
};

const money = (row: SheetRow, patterns: RegExp[]): number =>
  parsePeso(String(findCell(row, patterns) ?? '')) ?? 0;

export async function parseReceiptsFile(file: File): Promise<ParsedReceiptRow[]> {
  const sheet = await readSheet(file);
  const rows: ParsedReceiptRow[] = [];

  sheet.forEach((raw: SheetRow, i) => {
    const accountCode = findText(raw, COLUMNS.accountCode);
    const accountName = findText(raw, COLUMNS.accountName);

    const q1 = money(raw, COLUMNS.q1);
    const q2 = money(raw, COLUMNS.q2);
    const q3 = money(raw, COLUMNS.q3);
    const q4 = money(raw, COLUMNS.q4);
    const quarterly = q1 + q2 + q3 + q4;
    const annual = money(raw, COLUMNS.annual);

    // A blank row, or one of the headings and sub-totals the form prints
    // between sections - "Total Tax Revenue", "Total Local Sources". They
    // carry an amount and no account code, and adding them would double the
    // municipality's estimated income.
    if (!accountCode && quarterly === 0 && annual === 0) return;

    const rawClass = findText(raw, COLUMNS.incomeClass).trim().toUpperCase();
    const incomeClass = CLASS_ALIASES[rawClass] ?? (rawClass as IncomeClass);

    const annualOnly = quarterly === 0 && annual !== 0;

    const problems: string[] = [];
    if (!accountCode) problems.push('no account code');
    if (quarterly === 0 && annual === 0) problems.push('no amount');
    if (rawClass && !INCOME_CLASSES.includes(incomeClass)) {
      problems.push(`"${rawClass}" is not an income class`);
    }
    if (quarterly !== 0 && annual !== 0 && quarterly !== annual) {
      // The file states both, and they disagree. Neither is obviously right,
      // so CBO refuses rather than choosing - a silently preferred column here
      // is a wrong total on a signed form.
      problems.push(
        `the quarters come to ${(quarterly / 100).toFixed(2)} and the year column says ` +
          `${(annual / 100).toFixed(2)}`,
      );
    }
    if (q1 < 0 || q2 < 0 || q3 < 0 || q4 < 0 || annual < 0) {
      problems.push('a negative estimate');
    }

    rows.push({
      lineNo: i + 1,
      accountCode,
      accountName,
      // An unclassed row is regular income, which is what the great majority
      // of a municipality's receipts are. It is shown on the screen before
      // anything is sent, so a wrong default is visible rather than assumed.
      incomeClass: INCOME_CLASSES.includes(incomeClass) ? incomeClass : 'REGULAR',
      q1,
      q2,
      q3,
      q4: annualOnly ? annual : q4,
      particulars: findText(raw, COLUMNS.particulars),
      annualOnly,
      problem: problems.length ? problems.join(', ') : undefined,
    });
  });

  return rows;
}
