// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/chartOfAccounts.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
/**
 * The Revised Chart of Accounts for Local Government Units.
 *
 * ------------------------------------------------------------------------
 * THIS FILE IS VENDORED INTO THE CLOUD FUNCTIONS BUILD.
 * The copy at `functions/src/lib/chartOfAccounts.ts` must be byte-identical
 * below the header. `scripts/sync-rules.mjs` copies it and CI compares them.
 * ------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * The municipality's chart arrives as what COA publishes: a code and a title,
 * and nothing else. CFMS needs eight more fields per account - what class it
 * is, which way it normally moves, where it lands on the statements, whether
 * it may be posted to at all.
 *
 * Six hundred and twenty-five accounts is too many to classify by hand, and
 * hand-classifying them is how a chart ends up with two accounts in the same
 * group carrying different treatments because two different afternoons made
 * the decision.
 *
 * So the classification is DERIVED from the code, which is not a shortcut: the
 * code IS the classification. The Revised Chart of Accounts is a structured
 * numbering scheme, and every field below is read out of it rather than
 * guessed. Where the structure genuinely does not say - which accounts need a
 * subsidiary ledger - this file sets almost nothing and the Chart of Accounts
 * screen is where the office decides.
 *
 *     digit 1     account group   1 asset, 2 liability, 3 equity,
 *                                 4 revenue, 5 expense
 *     digits 2-3  major group     within the account group
 *     digits 4-5  sub-major group
 *     digits 6-8  the account, and its contra account at +1
 */

export interface Violation {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
}

/** An eight-digit Revised Chart of Accounts code. */
export const RCA_CODE = /^\d{8}$/;

export type AccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type FsClassification =
  | 'CURRENT_ASSET'
  | 'NON_CURRENT_ASSET'
  | 'CURRENT_LIABILITY'
  | 'NON_CURRENT_LIABILITY'
  | 'NET_ASSETS_EQUITY'
  | 'REVENUE'
  | 'EXPENSE'
  | 'NON_FINANCIAL_ITEM';
export type CashFlowClass = 'OPERATING' | 'INVESTING' | 'FINANCING' | 'NON_CASH';
export type ExpenseClass = 'PS' | 'MOOE' | 'FE' | 'CO';

// ---------------------------------------------------------------------------
// Account class
// ---------------------------------------------------------------------------

const CLASS_BY_GROUP: Record<string, AccountClass> = {
  '1': 'ASSET',
  '2': 'LIABILITY',
  '3': 'EQUITY',
  '4': 'REVENUE',
  '5': 'EXPENSE',
};

export function accountClassFor(code: string): AccountClass | null {
  return CLASS_BY_GROUP[code.trim().charAt(0)] ?? null;
}

// ---------------------------------------------------------------------------
// Contra accounts
// ---------------------------------------------------------------------------

/**
 * An account that sits against another and moves the opposite way.
 *
 * Detected by title rather than by code. The code convention - a contra
 * account is its parent plus one - is real, but it is a convention: 20102022
 * "Premium on Bonds Payable" is parent plus two and is not contra at all,
 * while nothing in the digits distinguishes 10301011 "Allowance for
 * Impairment" from an ordinary account that simply happens to be numbered
 * next.
 *
 * Getting this wrong is not cosmetic. An "Allowance for Impairment" recorded
 * with a debit normal balance would be shown as an asset on the Statement of
 * Financial Position and would add to net assets instead of reducing them, on
 * a hundred and thirty-five accounts at once.
 */
const CONTRA_TITLES = [
  /^allowance for impairment\b/i,
  /^accumulated depreciation\b/i,
  /^accumulated amortization\b/i,
  /^accumulated impairment\b/i,
  /^discount on\b/i,
  /^sales discounts?$/i,
  /^sales returns\b/i,
  /^remeasurement loss$/i,
];

export function isContraAccount(name: string): boolean {
  const title = name.trim();
  return CONTRA_TITLES.some((re) => re.test(title));
}

const DEBIT_CLASSES: AccountClass[] = ['ASSET', 'EXPENSE'];

export function normalBalanceFor(code: string, name: string): NormalBalance | null {
  const accountClass = accountClassFor(code);
  if (!accountClass) return null;
  const ordinary: NormalBalance = DEBIT_CLASSES.includes(accountClass) ? 'DEBIT' : 'CREDIT';
  if (!isContraAccount(name)) return ordinary;
  return ordinary === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}

// ---------------------------------------------------------------------------
// Capital Outlay
// ---------------------------------------------------------------------------

/**
 * The asset groups a Capital Outlay appropriation is charged to.
 *
 * There is NO Capital Outlay expense account in the Revised Chart of
 * Accounts. The 5-series runs Personnel Services, MOOE, Financial Expenses,
 * Direct Costs and Non-Cash Expenses, and stops. Capital Outlay is a
 * budgetary classification whose object of expenditure is the asset acquired
 * - a building, a vehicle, a piece of software - so it is charged to
 * Investment Property, Property Plant and Equipment, Biological Assets or
 * Intangible Assets.
 *
 * CFMS offered only expense accounts as the object of an obligation, which
 * meant a Capital Outlay obligation could not be encoded at all.
 */
export const CAPITAL_OUTLAY_GROUPS = ['106', '107', '108', '109'];

export function isCapitalOutlayAccount(code: string): boolean {
  const c = code.trim();
  return CAPITAL_OUTLAY_GROUPS.some((g) => c.startsWith(g));
}

/**
 * True where this account may be the object of a budget charge.
 *
 * An expense account, or one of the capitalisable asset accounts Capital
 * Outlay is charged to. A contra asset is not one: accumulated depreciation
 * is never bought.
 */
export function isBudgetChargeable(code: string, name: string): boolean {
  if (isContraAccount(name)) return false;
  if (accountClassFor(code) === 'EXPENSE') return true;
  return isCapitalOutlayAccount(code);
}

const EXPENSE_CLASS_BY_MAJOR: Record<string, ExpenseClass> = {
  '501': 'PS',
  '502': 'MOOE',
  '503': 'FE',
  // Direct Costs - the cost of sales of an economic enterprise. Budgeted and
  // obligated as MOOE, which is where a market's or a waterworks' purchases
  // appear in the appropriation ordinance.
  '504': 'MOOE',
  // 5-05 is deliberately absent. Depreciation, impairment and the other
  // non-cash expenses are never obligated and never appear in an
  // appropriation, so giving them an expense class would put them in the
  // obligation picker beside things the municipality actually buys.
};

export function expenseClassFor(code: string, name: string): ExpenseClass | null {
  const c = code.trim();
  if (isContraAccount(name)) return null;
  if (isCapitalOutlayAccount(c)) return 'CO';
  return EXPENSE_CLASS_BY_MAJOR[c.slice(0, 3)] ?? null;
}

// ---------------------------------------------------------------------------
// Budgetary accounts
// ---------------------------------------------------------------------------

/**
 * The 3-05 series: Fund Balance, Appropriations, Allotments, Obligations and
 * the reversions.
 *
 * These belong to the budget registries, not to the General Ledger. CFMS keeps
 * the registry itself - appropriation, allotment and obligation are maintained
 * transactionally in `budgetBalances`, with the controls that go with them -
 * so posting an appropriation to an equity account here would give the
 * municipality two records of the same budget, kept by different means, with
 * nothing reconciling them.
 *
 * They are loaded so the chart is complete and so a report that lists the
 * Revised Chart of Accounts is not missing twenty-five rows. They are not
 * postable.
 */
export function isBudgetaryAccount(code: string): boolean {
  return code.trim().startsWith('305');
}

// ---------------------------------------------------------------------------
// Statement classification
// ---------------------------------------------------------------------------

const CURRENT_ASSET_GROUPS = ['101', '103', '104', '105'];
const CURRENT_LIABILITY_GROUPS = ['201', '202', '203', '204', '205', '299'];

export function fsClassificationFor(code: string): FsClassification | null {
  const c = code.trim();
  const accountClass = accountClassFor(c);
  if (!accountClass) return null;

  switch (accountClass) {
    case 'ASSET':
      return CURRENT_ASSET_GROUPS.includes(c.slice(0, 3))
        ? 'CURRENT_ASSET'
        : 'NON_CURRENT_ASSET';
    case 'LIABILITY':
      return CURRENT_LIABILITY_GROUPS.includes(c.slice(0, 3))
        ? 'CURRENT_LIABILITY'
        : 'NON_CURRENT_LIABILITY';
    case 'EQUITY':
      return 'NET_ASSETS_EQUITY';
    case 'REVENUE':
      return 'REVENUE';
    case 'EXPENSE':
      return 'EXPENSE';
  }
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

/** Investments and the capitalisable assets. */
const INVESTING_GROUPS = ['102', ...CAPITAL_OUTLAY_GROUPS];
/** Bonds and loans payable. */
const FINANCING_PREFIX = '20102';
/** Depreciation, impairment and the rest of the non-cash expenses. */
const NON_CASH_MAJOR = '505';

export function cashFlowClassFor(code: string, name: string): CashFlowClass {
  const c = code.trim();
  // A contra account never moves cash: it is the offset to something that
  // did, or to a revaluation that did not.
  if (isContraAccount(name)) return 'NON_CASH';
  if (c.slice(0, 3) === NON_CASH_MAJOR) return 'NON_CASH';
  if (isBudgetaryAccount(c)) return 'NON_CASH';
  if (c.startsWith(FINANCING_PREFIX)) return 'FINANCING';
  if (INVESTING_GROUPS.includes(c.slice(0, 3))) return 'INVESTING';
  return 'OPERATING';
}

// ---------------------------------------------------------------------------
// Subsidiary ledgers
// ---------------------------------------------------------------------------

/**
 * The accounts CFMS posts through a subsidiary ledger.
 *
 * Deliberately a short, explicit list rather than a pattern. Which accounts
 * need a subsidiary is an office's own decision about how it wants to be able
 * to answer questions, and a rule that guessed would turn every remittance
 * line into a search for a party the account already names - "Due to BIR"
 * does not need a subsidiary saying BIR.
 *
 * These three are the ones CFMS itself relies on: the payables it ages, the
 * receivables it ages, and the cash advances it chases by accountable officer.
 * Everything else arrives with no subsidiary required, and the Chart of
 * Accounts screen is where the office turns others on.
 */
const SUBSIDIARY_ACCOUNTS = new Set(['20101010', '10301010']);
const SUBSIDIARY_PREFIX = '10305';

export function requiresSubsidiaryFor(code: string): boolean {
  const c = code.trim();
  return SUBSIDIARY_ACCOUNTS.has(c) || c.startsWith(SUBSIDIARY_PREFIX);
}

// ---------------------------------------------------------------------------
// Advances subject to liquidation - patch 133
// ---------------------------------------------------------------------------

/**
 * Which accounts hold money an officer must liquidate.
 *
 * The Accountant decides, on Master Data > Chart of Accounts ("Advance subject
 * to liquidation"). Neil: "all Accounts under Advances to Officers and
 * Employees, Advances for Operating Expenses, Advances to Special Disbursing
 * Officer and Other Receivables are subject for liquidation ... create a
 * master data that will select which accounts."
 *
 * Until an account has been ticked or cleared there, it follows this default:
 * those four by title - whichever code the chart gives them (the 2015 chart
 * kept the advances under 1-03-05, the current one under 1-99-01). Advances
 * for Payroll is left out on purpose: a payroll advance is liquidated by the
 * Report of Cash Disbursement, not by a liquidation report.
 */
const LIQUIDATABLE_TITLES = new Set([
  'ADVANCES FOR OPERATING EXPENSES',
  'ADVANCES TO SPECIAL DISBURSING OFFICER',
  'ADVANCES TO SPECIAL DISBURSING OFFICERS',
  'ADVANCES TO OFFICERS AND EMPLOYEES',
  'OTHER RECEIVABLES',
]);

export function liquidatableByDefault(code: string, name: string): boolean {
  const title = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) return LIQUIDATABLE_TITLES.has(title);
  const c = String(code ?? '').trim();
  return ['19901010', '19901030', '19901040', '10305010', '10305030', '10305040', '10305990'].includes(c);
}

/** The Accountant's choice where one was made; the default where not. */
export function isLiquidatableAccount(a: {
  code: string;
  name?: string | null;
  liquidatable?: boolean | null;
}): boolean {
  if (typeof a.liquidatable === 'boolean') return a.liquidatable;
  return liquidatableByDefault(a.code, a.name ?? '');
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

export interface ChartRow {
  code: string;
  name: string;
}

export interface DerivedAccount {
  code: string;
  name: string;
  accountClass: AccountClass;
  normalBalance: NormalBalance;
  fsClassification: FsClassification;
  cashFlowClass: CashFlowClass;
  expenseClass: ExpenseClass | null;
  postable: boolean;
  isControl: boolean;
  requiresSubsidiary: boolean;
  /** The major group, for grouping a listing without re-slicing the code. */
  majorGroup: string;
}

export function deriveAccount(row: ChartRow): DerivedAccount | null {
  const code = String(row.code ?? '').trim();
  const name = String(row.name ?? '').replace(/\s+/g, ' ').trim();

  const accountClass = accountClassFor(code);
  const normalBalance = normalBalanceFor(code, name);
  const fsClassification = fsClassificationFor(code);
  if (!accountClass || !normalBalance || !fsClassification) return null;

  const subsidiary = requiresSubsidiaryFor(code);

  return {
    code,
    name,
    accountClass,
    normalBalance,
    fsClassification,
    cashFlowClass: cashFlowClassFor(code, name),
    expenseClass: expenseClassFor(code, name),
    postable: !isBudgetaryAccount(code),
    // A control account is one posted to only through its subsidiary, which is
    // the same set here. Kept as two fields because they are two questions,
    // and an office may well want a subsidiary on an account it still posts to
    // directly.
    isControl: subsidiary,
    requiresSubsidiary: subsidiary,
    majorGroup: code.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface ChartRowInput extends ChartRow {
  /** 1-based, for the message that names the offending row of a file. */
  lineNo: number;
}

export function checkChart(rows: ChartRowInput[]): CheckResult {
  const violations: Violation[] = [];

  if (rows.length === 0) {
    return {
      ok: false,
      violations: [{ code: 'CHART_EMPTY', message: 'The file carries no accounts.' }],
    };
  }

  const seen = new Map<string, number>();

  for (const row of rows) {
    const code = String(row.code ?? '').trim();
    const name = String(row.name ?? '').trim();

    if (!RCA_CODE.test(code)) {
      violations.push({
        code: 'CHART_BAD_CODE',
        message:
          `Line ${row.lineNo} has the account code "${code}". A Revised Chart of Accounts code ` +
          'is eight digits, and the digits are what every classification is read out of - a code ' +
          'of another shape cannot be classified at all.',
        details: { lineNo: row.lineNo, code },
      });
      continue;
    }

    if (!name) {
      violations.push({
        code: 'CHART_NO_NAME',
        message: `Line ${row.lineNo} (${code}) has no account title.`,
        details: { lineNo: row.lineNo, code },
      });
    }

    const first = seen.get(code);
    if (first !== undefined) {
      violations.push({
        code: 'CHART_DUPLICATE',
        message:
          `Account ${code} appears on line ${first} and again on line ${row.lineNo}. The code is ` +
          'the account’s identity, so the second would replace the first rather than add to ' +
          'it, and the chart would load with one of the two titles and no error.',
        details: { code, first, second: row.lineNo },
      });
    } else {
      seen.set(code, row.lineNo);
    }
  }

  return violations.length === 0
    ? { ok: true, violations: [] }
    : { ok: false, violations };
}

// ---------------------------------------------------------------------------
// The accounts the system posts to by code
// ---------------------------------------------------------------------------

/**
 * Every account CFMS writes into a journal entry by a hardcoded code.
 *
 * These exist because a hardcoded account code with a hardcoded title beside
 * it is a claim about the Chart of Accounts, and nothing was checking it. Four
 * of the seven were wrong, and each had been wrong since the feature shipped.
 *
 * The GAM Revised Chart of Accounts for LGUs (Volume III) gives major group
 * 1-01 exactly two Cash on Hand accounts - 1-01-01-010 Cash Local Treasury and
 * 1-01-01-020 Petty Cash - and there is no "Cash - Collecting Officers" in the
 * LGU chart at all. That is the national government agency account. Posting
 * collections to it here meant posting them to code 1-01-01-020, whose real
 * title is Petty Cash, so every peso collected and every deposit made ran
 * through the petty cash fund: the undeposited collections have been sitting
 * in Petty Cash on the Statement of Financial Position, and Cash Local
 * Treasury - which the Cash in Local Treasury report reads - stood at nil.
 *
 * The bank pair had the same fault the other way about: the constant named for
 * the current account carried the savings account code. And Advances for
 * Payroll is 1-03-05-020, in the cash advances group with the other advances,
 * not the 1-99 code the payroll entry was proposing, which is in no chart.
 *
 * `checkNamedAccounts` holds all of them against the chart Candoni actually
 * loaded, so the next one cannot ship quietly.
 */
export interface NamedAccount {
  readonly code: string;
  readonly name: string;
}

/** 1-01-01-010. Collections in the hands of the treasury, before deposit. */
export const CASH_LOCAL_TREASURY: NamedAccount = {
  code: '10101010',
  name: 'Cash Local Treasury',
};

/** 1-01-01-020. The petty cash fund, and nothing else. */
export const PETTY_CASH: NamedAccount = {
  code: '10101020',
  name: 'Petty Cash',
};

/** 1-01-02-010. */
export const CASH_IN_BANK_CURRENT: NamedAccount = {
  code: '10102010',
  name: 'Cash in Bank - Local Currency, Current Account',
};

/** 1-01-02-020. */
export const CASH_IN_BANK_SAVINGS: NamedAccount = {
  code: '10102020',
  name: 'Cash in Bank - Local Currency, Savings Account',
};

/** 1-03-05-020, with the other cash advances. */
export const ADVANCES_FOR_PAYROLL: NamedAccount = {
  code: '10305020',
  name: 'Advances for Payroll',
};

export const ACCOUNTS_PAYABLE: NamedAccount = {
  code: '20101010',
  name: 'Accounts Payable',
};

export const DUE_TO_OFFICERS_AND_EMPLOYEES: NamedAccount = {
  code: '20101020',
  name: 'Due to Officers and Employees',
};

/**
 * 2-02-01-010. Every tax the municipality withholds is owed to this one
 * creditor.
 *
 * ---------------------------------------------------------------------------
 * ONE ACCOUNT, MANY TAXES
 * ---------------------------------------------------------------------------
 * Expanded withholding tax on goods, final VAT withholding, the percentage
 * taxes - they are not separate accounts in the Revised Chart. They are all
 * DUE TO BIR, and which tax a particular peso was withheld under belongs in
 * the SUBSIDIARY ledger, not in the account title.
 *
 * CFMS used to write the tax code's own description into the account name:
 *
 *     20201010  Expanded withholding tax on goods (1%)
 *     20201010  Final VAT withholding on goods (5%)
 *
 * Two different titles against one code, neither of them the account's name,
 * in the General Ledger. The Trial Balance showed one figure for the account
 * and the ledger showed two names for it, and nothing said which was the
 * account and which was the reason.
 */
export const DUE_TO_BIR: NamedAccount = {
  code: '20201010',
  name: 'Due to BIR',
};

export const NAMED_ACCOUNTS: readonly NamedAccount[] = [
  CASH_LOCAL_TREASURY,
  PETTY_CASH,
  CASH_IN_BANK_CURRENT,
  CASH_IN_BANK_SAVINGS,
  ADVANCES_FOR_PAYROLL,
  ACCOUNTS_PAYABLE,
  DUE_TO_OFFICERS_AND_EMPLOYEES,
  DUE_TO_BIR,
];

/**
 * The prescribed title of an account CFMS posts to by code.
 *
 * Returns null for anything outside the named list, which is most of the
 * chart. It is a fallback for the places that cannot read the loaded chart,
 * not a substitute for it.
 */
export function namedAccountTitle(code: string): string | null {
  const wanted = String(code ?? '').trim();
  return NAMED_ACCOUNTS.find((a) => a.code === wanted)?.name ?? null;
}

/** A bank account record, as much of it as a journal line needs. */
export interface BankAccountRef {
  id?: string;
  /** The General Ledger account this bank account posts to. */
  glAccountCode?: string | null;
  /** The OFFICE'S OWN NAME for the account - "General Fund", "Trust Fund". */
  accountName?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
}

/**
 * The Cash in Bank line for a bank account, named correctly.
 *
 * ---------------------------------------------------------------------------
 * THE MISTAKE THIS EXISTS TO STOP
 * ---------------------------------------------------------------------------
 * A bank account record carries two different names and they are easy to
 * confuse. `glAccountCode` is the General Ledger account it posts to -
 * 10102010, Cash in Bank - Local Currency, Current Account. `accountName` is
 * what the OFFICE calls that bank account: "General Fund".
 *
 * The RCI entry was built with the account CODE from the first and the account
 * NAME from the second, so the proposed entry read
 *
 *     10102020     General Fund     10,000.00
 *
 * which is not an account in anybody's chart. Nothing refuses it: the entry
 * balances, the code is real, and the name is only a label travelling beside
 * it - all the way into every ledger line, where the General Ledger, the
 * journals and the trial balance print it.
 *
 * ---------------------------------------------------------------------------
 * AND THE NAME IS NOT WASTED
 * ---------------------------------------------------------------------------
 * "General Fund" is the right answer to a different question. Cash in Bank is
 * a control account kept per bank account, so the office's own name for the
 * account is exactly what belongs in the SUBSIDIARY ledger - which is where
 * this now puts it, and where the Subsidiary Ledger report can make it agree
 * with the control account.
 *
 * Returns null when the title cannot be established, because a line posted to
 * a code under the wrong title is the fault being fixed. The caller says so to
 * the user rather than guessing.
 */
export function cashInBankLine(
  bank: BankAccountRef,
  /** The loaded chart, where there is one. Preferred over the named list. */
  resolveTitle?: (code: string) => string | null | undefined,
): {
  accountCode: string;
  accountName: string;
  subsidiaryType: 'BANK_ACCOUNT';
  subsidiaryId: string | null;
  subsidiaryName: string;
} | null {
  const code = String(bank.glAccountCode ?? '').trim();
  if (!code) return null;

  const title = resolveTitle?.(code) || namedAccountTitle(code);
  if (!title) return null;

  const ownName =
    String(bank.accountName ?? '').trim() ||
    `${bank.bankName ?? ''} ${bank.accountNumber ?? ''}`.trim();

  return {
    accountCode: code,
    accountName: title,
    subsidiaryType: 'BANK_ACCOUNT',
    subsidiaryId: bank.id ?? null,
    subsidiaryName: ownName || code,
  };
}

/**
 * Every account named above must exist in the loaded chart under exactly that
 * title. A mismatch means CFMS is posting to an account that is not the one the
 * code believes it is - which is not caught by anything else, because the
 * posting is perfectly valid and balances perfectly against the wrong account.
 */
export function checkNamedAccounts(
  chart: Array<{ code: string; name: string }>,
): Violation[] {
  const byCode = new Map(chart.map((r) => [r.code.trim(), r.name.trim()]));
  const violations: Violation[] = [];

  for (const account of NAMED_ACCOUNTS) {
    const found = byCode.get(account.code);
    if (found === undefined) {
      violations.push({
        code: 'NAMED_ACCOUNT_MISSING',
        message:
          `CFMS posts to account ${account.code} (${account.name}) by code, and it is not in the ` +
          'Chart of Accounts.',
        details: { code: account.code, expected: account.name },
      });
    } else if (found !== account.name) {
      violations.push({
        code: 'NAMED_ACCOUNT_RENAMED',
        message:
          `CFMS posts to account ${account.code} as \u201c${account.name}\u201d, but the Chart of ` +
          `Accounts calls it \u201c${found}\u201d. One of the two is wrong, and the postings have ` +
          'been going to whichever account carries that code.',
        details: { code: account.code, expected: account.name, found },
      });
    }
  }

  return violations;
}
