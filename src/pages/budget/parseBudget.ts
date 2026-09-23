import { readSheet, findCell, findText, type SheetRow } from '@/lib/spreadsheet';
import { parsePeso } from '@/lib/money';

/**
 * Reading the annex to the appropriation ordinance, and allotment releases.
 *
 * The annex is a spreadsheet the Budget Office already maintains: one row per
 * office per account, with the amount. CBO reads that rather than asking for
 * six hundred lines to be typed a second time.
 *
 * The office column is matched by code, by name or by short name, because the
 * annex uses whichever the Budget Officer finds readable and none of them is
 * wrong. Resolving it is the server's job; this only picks the column out.
 */

export interface ParsedBudgetRow {
  lineNo: number;
  office: string;
  accountCode: string;
  accountName: string;
  expenseClass: string;
  amount: number;
  particulars: string;
  /** Why this row cannot be sent. The whole file is held back if any row has one. */
  problem?: string;
}

const COLUMNS = {
  office: [/office/i, /department/i, /agency/i, /^dept/i, /cost\s*cent/i],
  accountCode: [/account\s*code/i, /uacs/i, /^code$/i, /^account$/i, /object\s*code/i],
  accountName: [/account\s*(name|title)/i, /object\s*of\s*expend/i],
  expenseClass: [/expense\s*class/i, /allotment\s*class/i, /^class$/i, /^ec$/i],
  amount: [/^amount/i, /appropriation/i, /allotment/i, /^total/i, /amount/i, /budget/i],
  particulars: [/purpose/i, /description/i, /remarks/i, /particular/i],
};

/** The expense classes as they are written in an annex, mapped to CBO's codes. */
const EXPENSE_CLASS_ALIASES: Record<string, string> = {
  PS: 'PS',
  'PERSONNEL SERVICES': 'PS',
  'PERSONAL SERVICES': 'PS',
  MOOE: 'MOOE',
  'MAINTENANCE AND OTHER OPERATING EXPENSES': 'MOOE',
  'MAINTENANCE & OTHER OPERATING EXPENSES': 'MOOE',
  FE: 'FE',
  'FINANCIAL EXPENSES': 'FE',
  CO: 'CO',
  'CAPITAL OUTLAY': 'CO',
  'CAPITAL OUTLAYS': 'CO',
};

export async function parseBudgetFile(file: File): Promise<ParsedBudgetRow[]> {
  const sheet = await readSheet(file);
  const rows: ParsedBudgetRow[] = [];

  sheet.forEach((raw: SheetRow, i) => {
    const amount = parsePeso(String(findCell(raw, COLUMNS.amount) ?? '')) ?? 0;
    const office = findText(raw, COLUMNS.office);
    const accountCode = findText(raw, COLUMNS.accountCode);

    // Blank rows, and the sub-totals an annex prints under each office: those
    // carry an amount and nothing that identifies a budget line. Including them
    // would double the office's budget, so a row must name both an office and
    // an account to count as a line at all.
    if (!office && !accountCode) return;

    const rawClass = findText(raw, COLUMNS.expenseClass).toUpperCase();
    const expenseClass = EXPENSE_CLASS_ALIASES[rawClass] ?? rawClass;

    const problems: string[] = [];
    if (!amount) problems.push('no amount');
    if (!office) problems.push('no office');
    if (!accountCode) problems.push('no account code');

    rows.push({
      lineNo: i + 1,
      office,
      accountCode,
      accountName: findText(raw, COLUMNS.accountName),
      expenseClass,
      amount,
      particulars: findText(raw, COLUMNS.particulars),
      problem: problems.length ? problems.join(', ') : undefined,
    });
  });

  return rows;
}
