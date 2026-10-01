/**
 * Seeds the reference data a fresh CFMS environment needs before anyone can
 * record a transaction: the funds, the chart of accounts, the offices, the
 * withholding tax codes and the numbering rules.
 *
 *   npx tsx scripts/seed.ts --project cbo-candoni-dev
 *   npx tsx scripts/seed.ts --project cbo-candoni-dev --emulator
 *
 * Requires Application Default Credentials (`gcloud auth application-default
 * login`) or GOOGLE_APPLICATION_CREDENTIALS pointing at a service account.
 *
 * WHAT THIS DOES NOT DO: it creates no users, no roles and no transactions.
 * The first administrator is granted their role deliberately, by a person,
 * through `setUserRoles` - seeding an administrator account with a known
 * identity into a financial system is exactly the sort of thing that is
 * forgotten and later found by somebody else.
 *
 * Re-running is safe: every document is written by a known id with merge, so
 * a second run updates rather than duplicates. It will not overwrite a
 * classification an accountant has since corrected in the UI unless that field
 * is part of the seed.
 */

import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const projectId = valueOf('--project') ?? process.env.GCLOUD_PROJECT;
const useEmulator = args.includes('--emulator');

if (!projectId) {
  console.error('Usage: tsx scripts/seed.ts --project <firebase-project-id> [--emulator]');
  process.exit(1);
}

if (useEmulator) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
}

initializeApp({
  projectId,
  credential: useEmulator ? undefined : applicationDefault(),
});

const db = getFirestore();

function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

const FUNDS = [
  { code: 'GF', name: 'General Fund', bookCode: '100', statutory: true, sortOrder: 1 },
  { code: 'SEF', name: 'Special Education Fund', bookCode: '200', statutory: true, sortOrder: 2 },
  { code: 'TF', name: 'Trust Fund', bookCode: '300', statutory: true, sortOrder: 3 },
];

// ---------------------------------------------------------------------------
// Chart of accounts
//
// A working subset of the COA Revised Chart of Accounts for Local Government
// Units. It covers the accounts a municipality touches in ordinary operations
// and is enough to run the full transaction chain end to end. The Municipal
// Accountant extends it from Master Data as the municipality's activities
// require - which is why every account carries its own classification rather
// than the classification being inferred from the code range.
// ---------------------------------------------------------------------------

type SeedAccount = [
  code: string,
  name: string,
  accountClass: string,
  normalBalance: 'DEBIT' | 'CREDIT',
  fsClassification: string,
  cashFlowClass: string,
  extra?: { expenseClass?: string; isControl?: boolean; requiresSubsidiary?: boolean },
];

const ACCOUNTS: SeedAccount[] = [
  // --- Cash and cash equivalents -------------------------------------------
  ['10101010', 'Cash in Vault', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],
  ['10101020', 'Cash - Collecting Officers', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['10102010', 'Cash in Bank - Local Currency, Savings Account', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['10102020', 'Cash in Bank - Local Currency, Current Account', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['10102030', 'Cash in Bank - Local Currency, Time Deposits', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'INVESTING'],

  // --- Receivables ----------------------------------------------------------
  ['10301010', 'Accounts Receivable', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['10301020', 'Allowance for Impairment - Accounts Receivable', 'ASSET', 'CREDIT', 'CURRENT_ASSET', 'NON_CASH'],
  ['10302010', 'Real Property Tax Receivable', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],
  ['10302020', 'Special Education Tax Receivable', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],
  ['10305010', 'Due from National Government Agencies', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['10305030', 'Due from Local Government Units', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['19901010', 'Advances for Operating Expenses', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['19901020', 'Advances for Payroll', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['19901030', 'Advances to Special Disbursing Officer', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['19901040', 'Advances to Officers and Employees', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING', { isControl: true, requiresSubsidiary: true }],

  // --- Inventories ----------------------------------------------------------
  ['10404010', 'Office Supplies Inventory', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],
  ['10404020', 'Accountable Forms, Plates and Stickers Inventory', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],
  ['10404060', 'Fuel, Oil and Lubricants Inventory', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],
  ['10404070', 'Medical, Dental and Laboratory Supplies Inventory', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],
  ['10404990', 'Other Supplies and Materials Inventory', 'ASSET', 'DEBIT', 'CURRENT_ASSET', 'OPERATING'],

  // --- Property, plant and equipment ---------------------------------------
  ['10601010', 'Land', 'ASSET', 'DEBIT', 'NON_CURRENT_ASSET', 'INVESTING'],
  ['10604010', 'Buildings', 'ASSET', 'DEBIT', 'NON_CURRENT_ASSET', 'INVESTING'],
  ['10604011', 'Accumulated Depreciation - Buildings', 'ASSET', 'CREDIT', 'NON_CURRENT_ASSET', 'NON_CASH'],
  ['10605010', 'Office Equipment', 'ASSET', 'DEBIT', 'NON_CURRENT_ASSET', 'INVESTING'],
  ['10605011', 'Accumulated Depreciation - Office Equipment', 'ASSET', 'CREDIT', 'NON_CURRENT_ASSET', 'NON_CASH'],
  ['10605020', 'Information and Communication Technology Equipment', 'ASSET', 'DEBIT', 'NON_CURRENT_ASSET', 'INVESTING'],
  ['10606010', 'Motor Vehicles', 'ASSET', 'DEBIT', 'NON_CURRENT_ASSET', 'INVESTING'],
  ['10606011', 'Accumulated Depreciation - Motor Vehicles', 'ASSET', 'CREDIT', 'NON_CURRENT_ASSET', 'NON_CASH'],
  ['10603010', 'Road Networks', 'ASSET', 'DEBIT', 'NON_CURRENT_ASSET', 'INVESTING'],
  ['10698010', 'Construction in Progress - Buildings and Other Structures', 'ASSET', 'DEBIT', 'NON_CURRENT_ASSET', 'INVESTING'],

  // --- Liabilities ----------------------------------------------------------
  ['20101010', 'Accounts Payable', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['20101020', 'Due to Officers and Employees', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['20201010', 'Due to BIR', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true }],
  ['20201020', 'Due to GSIS', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true }],
  ['20201030', 'Due to Pag-IBIG', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true }],
  ['20201040', 'Due to PhilHealth', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true }],
  ['20201050', 'Due to NGAs', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['20201070', 'Due to LGUs', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING', { isControl: true, requiresSubsidiary: true }],
  ['20401040', 'Trust Liabilities', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING'],
  ['20401050', 'Guaranty / Security Deposits Payable', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING'],
  ['29999990', 'Other Payables', 'LIABILITY', 'CREDIT', 'CURRENT_LIABILITY', 'OPERATING'],
  ['20601010', 'Loans Payable - Domestic', 'LIABILITY', 'CREDIT', 'NON_CURRENT_LIABILITY', 'FINANCING'],

  // --- Equity ---------------------------------------------------------------
  ['30101010', 'Government Equity', 'EQUITY', 'CREDIT', 'NET_ASSETS_EQUITY', 'NON_CASH'],
  ['30101020', 'Accumulated Surplus / (Deficit)', 'EQUITY', 'CREDIT', 'NET_ASSETS_EQUITY', 'NON_CASH'],

  // --- Revenue --------------------------------------------------------------
  ['40101010', 'Real Property Tax - Basic', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40101020', 'Special Education Tax', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40101030', 'Real Property Tax - Penalties', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40102010', 'Business Tax', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40102030', 'Community Tax', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40102040', 'Franchise Tax', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40201010', 'Permit Fees', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40201020', 'Registration Fees', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40202010', 'Clearance and Certification Fees', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40202160', 'Market Fees', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40202170', 'Slaughterhouse Fees', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40202200', 'Medical, Dental and Laboratory Fees', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40202210', 'Waterworks System Fees', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40301010', 'Share from National Tax Allotment', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40401010', 'Interest Income', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40402010', 'Rent / Lease Income', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40501010', 'Subsidy from National Government', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],
  ['40603000', 'Miscellaneous Income', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING'],

  // --- Personnel services ---------------------------------------------------
  ['50101010', 'Salaries and Wages - Regular', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50101020', 'Salaries and Wages - Casual / Contractual', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50102010', 'Personal Economic Relief Allowance (PERA)', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50102020', 'Representation Allowance (RA)', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50102030', 'Transportation Allowance (TA)', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50102040', 'Clothing / Uniform Allowance', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50102100', 'Honoraria', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50102130', 'Overtime and Night Pay', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50102140', 'Year End Bonus', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50103010', 'Retirement and Life Insurance Premiums', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50103020', 'Pag-IBIG Contributions', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50103030', 'PhilHealth Contributions', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],
  ['50103040', 'Employees Compensation Insurance Premiums', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'PS' }],

  // --- Maintenance and other operating expenses ----------------------------
  ['50201010', 'Travelling Expenses - Local', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50202010', 'Training Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50203010', 'Office Supplies Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50203020', 'Accountable Forms Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50203070', 'Drugs and Medicines Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50203080', 'Medical, Dental and Laboratory Supplies Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50203090', 'Fuel, Oil and Lubricants Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50203990', 'Other Supplies and Materials Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50204010', 'Water Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50204020', 'Electricity Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50205010', 'Postage and Courier Services', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50205020', 'Telephone Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50205030', 'Internet Subscription Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50210030', 'Extraordinary and Miscellaneous Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50211990', 'Other Professional Services', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50212020', 'Janitorial Services', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50212030', 'Security Services', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50213040', 'Repairs and Maintenance - Buildings and Other Structures', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50213050', 'Repairs and Maintenance - Machinery and Equipment', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50213060', 'Repairs and Maintenance - Transportation Equipment', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50214010', 'Subsidy to National Government Agencies', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50214030', 'Financial Assistance / Subsidy to Local Government Units', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50215010', 'Taxes, Duties and Licenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50215020', 'Fidelity Bond Premiums', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50215030', 'Insurance Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50299050', 'Rent / Lease Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],
  ['50299990', 'Other Maintenance and Operating Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'MOOE' }],

  // --- Financial expenses and depreciation ----------------------------------
  ['50301020', 'Interest Expenses', 'EXPENSE', 'DEBIT', 'EXPENSE', 'FINANCING', { expenseClass: 'FE' }],
  ['50301040', 'Bank Charges', 'EXPENSE', 'DEBIT', 'EXPENSE', 'OPERATING', { expenseClass: 'FE' }],
  ['50501040', 'Depreciation - Buildings and Other Structures', 'EXPENSE', 'DEBIT', 'EXPENSE', 'NON_CASH', { expenseClass: 'MOOE' }],
  ['50501050', 'Depreciation - Machinery and Equipment', 'EXPENSE', 'DEBIT', 'EXPENSE', 'NON_CASH', { expenseClass: 'MOOE' }],
  ['50501060', 'Depreciation - Transportation Equipment', 'EXPENSE', 'DEBIT', 'EXPENSE', 'NON_CASH', { expenseClass: 'MOOE' }],
];

// ---------------------------------------------------------------------------
// Offices
// ---------------------------------------------------------------------------

const OFFICES = [
  ['1011', 'Office of the Sangguniang Bayan', 'SB'],
  ['1021', 'Office of the Municipal Mayor', 'MMO'],
  ['1031', 'Office of the Municipal Vice Mayor', 'MVMO'],
  ['1041', 'Office of the Municipal Administrator', 'MADMO'],
  ['1051', 'Office of the Municipal Planning and Development Coordinator', 'MPDO'],
  ['1061', 'Office of the Municipal Civil Registrar', 'MCRO'],
  ['1071', 'Office of the Municipal Budget Officer', 'MBO'],
  ['1081', 'Office of the Municipal Accountant', 'MACCO'],
  ['1091', 'Office of the Municipal Treasurer', 'MTO'],
  ['1101', 'Office of the Municipal Assessor', 'MASSO'],
  ['1111', 'Office of the Municipal Engineer', 'MEO'],
  ['1121', 'Office of the Municipal Health Officer', 'MHO'],
  ['1131', 'Office of the Municipal Social Welfare and Development Officer', 'MSWDO'],
  ['1141', 'Office of the Municipal Agriculturist', 'MAGRO'],
  ['1151', 'Office of the Municipal Disaster Risk Reduction and Management Officer', 'MDRRMO'],
  ['1161', 'Office of the Municipal Environment and Natural Resources Officer', 'MENRO'],
  ['1171', 'Office of the Municipal Human Resource Management Officer', 'MHRMO'],
  ['1181', 'General Services Office', 'GSO'],
];

// ---------------------------------------------------------------------------
// Withholding tax codes
//
// Rates current under the TRAIN Law as commonly applied by LGUs. The
// Accountant should confirm them against the prevailing BIR issuance before
// the first live voucher - they change, and a wrong rate leaves the
// municipality liable for the shortfall.
// ---------------------------------------------------------------------------

const TAX_CODES = [
  { code: 'EWT-GOODS', description: 'Expanded withholding tax on goods (1%)', kind: 'EWT', rate: 0.01, base: 'NET_OF_VAT', accountCode: '20201010', atc: 'WC158' },
  { code: 'EWT-SERV', description: 'Expanded withholding tax on services (2%)', kind: 'EWT', rate: 0.02, base: 'NET_OF_VAT', accountCode: '20201010', atc: 'WC160' },
  { code: 'EWT-PROF', description: 'Expanded withholding tax on professional fees (10%)', kind: 'EWT', rate: 0.10, base: 'NET_OF_VAT', accountCode: '20201010', atc: 'WC010' },
  { code: 'EWT-RENT', description: 'Expanded withholding tax on rentals (5%)', kind: 'EWT', rate: 0.05, base: 'NET_OF_VAT', accountCode: '20201010', atc: 'WC100' },
  { code: 'VAT-WH-G', description: 'Final VAT withholding on goods (5%)', kind: 'VAT_WITHHOLDING', rate: 0.05, base: 'NET_OF_VAT', accountCode: '20201010', atc: 'WV010' },
  { code: 'VAT-WH-S', description: 'Final VAT withholding on services (5%)', kind: 'VAT_WITHHOLDING', rate: 0.05, base: 'NET_OF_VAT', accountCode: '20201010', atc: 'WV020' },
  { code: 'PT-GOODS', description: 'Percentage tax withheld on goods (3%)', kind: 'PERCENTAGE_TAX', rate: 0.03, base: 'GROSS', accountCode: '20201010', atc: 'WB080' },
  { code: 'RETENTION', description: 'Retention on infrastructure contracts (10%)', kind: 'OTHER', rate: 0.10, base: 'GROSS', accountCode: '20401050' },
];

// ---------------------------------------------------------------------------
// Numbering rules
// ---------------------------------------------------------------------------

const NUMBERING = [
  { docType: 'OBR', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'DV', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'JEV', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'ADA', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'RCD', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'LIQ', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'PAYROLL', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'ALLOT', pattern: '{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
  { docType: 'APPROP', pattern: '{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
];

// ---------------------------------------------------------------------------

async function seed() {
  console.log(`Seeding CFMS reference data into ${projectId}${useEmulator ? ' (emulator)' : ''}\n`);

  await writeBatch('funds', FUNDS, (f) => f.code, (f) => ({ ...f, id: f.code, active: true }));

  await writeBatch(
    'accounts',
    ACCOUNTS,
    (a) => a[0],
    (a) => ({
      id: a[0],
      code: a[0],
      name: a[1],
      accountClass: a[2],
      normalBalance: a[3],
      fsClassification: a[4],
      cashFlowClass: a[5],
      expenseClass: a[6]?.expenseClass ?? null,
      isControl: a[6]?.isControl ?? false,
      requiresSubsidiary: a[6]?.requiresSubsidiary ?? false,
      postable: true,
      active: true,
    }),
  );

  await writeBatch(
    'offices',
    OFFICES,
    (o) => o[0],
    (o, i) => ({ id: o[0], code: o[0], name: o[1], shortName: o[2], sortOrder: i + 1, active: true }),
  );

  await writeBatch(
    'taxCodes',
    TAX_CODES,
    (t) => t.code,
    (t) => ({ ...t, id: t.code, active: true }),
  );

  await writeBatch(
    'numberingRules',
    NUMBERING,
    (n) => n.docType,
    (n) => ({ ...n, id: n.docType, active: true }),
  );

  // System settings, only if absent - re-running must not wipe the
  // municipality's own signatories and control switches.
  const settingsRef = db.collection('settings').doc('general');
  if (!(await settingsRef.get()).exists) {
    await settingsRef.set({
      municipality: 'Municipality of Candoni',
      province: 'Province of Negros Occidental',
      reportHeaderLines: [
        'Republic of the Philippines',
        'Province of Negros Occidental',
        'Municipality of Candoni',
      ],
      currentFiscalYear: new Date().getFullYear(),
      checkStaleMonths: 6,
      sessionTimeoutMinutes: 45,
      allowBudgetOverride: true,
      budgetOverrideRoles: ['SUPER_ADMIN', 'BUDGET_OFFICER'],
      allowSelfApproval: false,
      cashAdvanceDueDays: {
        TRAVEL: 30,
        SPECIAL_ACTIVITY: 20,
        PETTY_CASH: 20,
        PAYROLL: 5,
        FUND_TRANSFER: 60,
        OTHER: 30,
      },
      signatories: {},
      updatedAt: new Date().toISOString(),
    });
    console.log('settings/general: created');
  } else {
    console.log('settings/general: already present, left alone');
  }

  console.log('\nReference data seeded.');
  console.log(
    '\nNo users or roles were created. Grant the first Super Administrator by signing in\n' +
      'with a Firebase account, then running (once, from a trusted shell):\n\n' +
      `  firebase functions:shell --project ${projectId}\n` +
      "  setUserRoles({ uid: '<their uid>', roles: ['SUPER_ADMIN'] })\n\n" +
      'or by setting the custom claim directly with the Admin SDK. Thereafter roles are\n' +
      'granted through Administration > Users and Roles.',
  );
}

async function writeBatch<T>(
  collection: string,
  items: T[],
  idOf: (item: T) => string,
  docOf: (item: T, index: number) => Record<string, unknown>,
): Promise<void> {
  let written = 0;
  for (let i = 0; i < items.length; i += 400) {
    const batch = db.batch();
    for (const [offset, item] of items.slice(i, i + 400).entries()) {
      batch.set(db.collection(collection).doc(idOf(item)), docOf(item, i + offset), { merge: true });
      written++;
    }
    await batch.commit();
  }
  console.log(`${collection}: ${written} records`);
}

seed().catch((err) => {
  console.error('\nSeeding failed:', err);
  process.exit(1);
});
