import { readSheet, findCell, findText, type SheetRow } from '@/lib/spreadsheet';
import { parsePeso } from '@/lib/money';

/**
 * Reading the annex to the appropriation ordinance, and allotment releases.
 *
 * The annex is a spreadsheet the Budget Office already maintains: one row per
 * office per account, with the amount. CFMS reads that rather than asking for
 * six hundred lines to be typed a second time.
 *
 * The office column is matched by code, by name or by short name, because the
 * annex uses whichever the Budget Officer finds readable and none of them is
 * wrong. Resolving it is the server's job; this only picks the column out.
 */

export interface ParsedBudgetRow {
  lineNo: number;
  office: string;
  /** The FPP as the ordinance writes it: an object code, or a project name. */
  fpp: string;
  fppName: string;
  sector: string;
  /** Named only where the sector is a funding source rather than a service. */
  serviceSector: string;
  /** Empty on a project line, where the ordinance named no object. */
  accountCode: string;
  accountName: string;
  expenseClass: string;
  amount: number;
  particulars: string;
  /** Why this row cannot be sent. The whole file is held back if any row has one. */
  problem?: string;
}

/** An object code of the Revised Chart of Accounts, e.g. 5-02-03-010. */
export const OBJECT_CODE = /^\d-\d\d-\d\d-\d\d\d$/;

const COLUMNS = {
  // "Office/Function Name" and "Office/Function Code" are how the FY2025
  // ordinance writes them; either identifies the office, so either will do.
  office: [
    /office\s*\/?\s*function\s*name/i,
    /office\s*\/?\s*function\s*code/i,
    /office/i,
    /department/i,
    /agency/i,
    /^dept/i,
    /cost\s*cent/i,
  ],
  fpp: [/^fpp$/i, /fpp\s*code/i, /^f\.?p\.?p\.?$/i, /function.*programme.*project/i],
  fppName: [/fpp\s*name/i, /programme\s*name/i, /program\s*name/i, /project\s*name/i],
  sector: [/^sector$/i, /sector/i],
  serviceSector: [/service\s*sector/i, /sector\s*served/i],
  accountCode: [/account\s*code/i, /uacs/i, /object\s*code/i, /^code$/i],
  accountName: [/account\s*(name|title)/i, /object\s*of\s*expend/i],
  expenseClass: [/allotment\s*class/i, /expense\s*class/i, /^class$/i, /^ec$/i],
  // "Annual Appropriation Amount" first, so that a file carrying both it and
  // "Continuing Appropriations Amount" does not read the continuing column as
  // the amount and post last year's carry-over as this year's budget.
  amount: [
    /annual\s*appropriation/i,
    /^amount/i,
    /appropriation/i,
    /allotment/i,
    /^total/i,
    /amount/i,
    /budget/i,
  ],
  particulars: [/purpose/i, /description/i, /remarks/i, /particular/i],
};

/** The expense classes as they are written in an annex, mapped to CFMS's codes. */
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
    const fpp = findText(raw, COLUMNS.fpp);

    // Blank rows, and the sub-totals an annex prints under each office: those
    // carry an amount and nothing that identifies a budget line. Including them
    // would double the office's budget, so a row must name both an office and
    // an FPP to count as a line at all.
    if (!office && !fpp) return;

    const rawClass = findText(raw, COLUMNS.expenseClass).toUpperCase();
    const expenseClass = EXPENSE_CLASS_ALIASES[rawClass] ?? rawClass;

    // Where the FPP is an object code it is also the account code, unless the
    // file gives one of its own. Where it is a project name there is no
    // account code, and that is not a gap - the object of expenditure becomes
    // known when the obligation is raised.
    const explicitAccount = findText(raw, COLUMNS.accountCode);
    const accountCode = explicitAccount || (OBJECT_CODE.test(fpp) ? fpp : '');

    const problems: string[] = [];
    if (!amount) problems.push('no amount');
    if (!office) problems.push('no office');
    if (!fpp) problems.push('no FPP');

    rows.push({
      lineNo: i + 1,
      office,
      fpp,
      fppName: findText(raw, COLUMNS.fppName),
      sector: findText(raw, COLUMNS.sector),
      serviceSector: findText(raw, COLUMNS.serviceSector),
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
