/**
 * Canonical Firestore collection names.
 *
 * Every read and write in CBO goes through these constants so that a typo
 * cannot silently create a parallel collection - in a schemaless database that
 * is the single most expensive class of mistake, because it fails quietly and
 * the data is only discovered missing at report time.
 *
 * The names are also referenced by `firestore.rules`; changing one here means
 * changing it there. The rules test suite asserts the two stay in step.
 */
export const COL = {
  // Master data
  funds: 'funds',
  accounts: 'accounts',
  offices: 'offices',
  responsibilityCenters: 'responsibilityCenters',
  programs: 'programs',
  projects: 'projects',
  activities: 'activities',
  payees: 'payees',
  employees: 'employees',
  banks: 'banks',
  bankAccounts: 'bankAccounts',
  taxCodes: 'taxCodes',
  fiscalYears: 'fiscalYears',
  numberingRules: 'numberingRules',

  // Budget
  appropriations: 'appropriations',
  allotments: 'allotments',
  obligations: 'obligations',
  budgetBalances: 'budgetBalances',
  budgetSummaries: 'budgetSummaries',

  // Accounting
  disbursementVouchers: 'disbursementVouchers',
  jevs: 'jevs',
  ledgerEntries: 'ledgerEntries',
  checks: 'checks',
  ada: 'ada',
  payrolls: 'payrolls',
  cashAdvances: 'cashAdvances',
  liquidations: 'liquidations',
  accountingPeriods: 'accountingPeriods',

  // Treasury
  collections: 'collections',
  revenueCodes: 'revenueCodes',
  primaryReports: 'primaryReports',
  accountableFormTypes: 'accountableFormTypes',
  accountableFormMovements: 'accountableFormMovements',
  raafReports: 'raafReports',
  rcds: 'rcds',
  treasuryReports: 'treasuryReports',
  treasuryImports: 'treasuryImports',
  openingBalances: 'openingBalances',
  deposits: 'deposits',
  cashPositions: 'cashPositions',

  // Reconciliation
  bankTransactions: 'bankTransactions',
  bankReconciliations: 'bankReconciliations',
  importBatches: 'importBatches',

  // System
  users: 'users',
  roleDefinitions: 'roleDefinitions',
  workflowHistory: 'workflowHistory',
  auditLogs: 'auditLogs',
  documents: 'documents',
  notifications: 'notifications',
  settings: 'settings',
  counters: 'counters',
} as const;

export type CollectionName = (typeof COL)[keyof typeof COL];

/**
 * Collections no client may ever write to directly, under any role. These are
 * produced exclusively by the Cloud Functions accounting engine. Listed here so
 * the same list can be asserted in the rules test suite.
 */
export const SERVER_ONLY_COLLECTIONS: CollectionName[] = [
  COL.ledgerEntries,
  COL.auditLogs,
  COL.counters,
  COL.budgetBalances,
  COL.budgetSummaries,
  COL.cashPositions,
  COL.accountingPeriods,
  COL.workflowHistory,
  COL.treasuryImports,
  COL.primaryReports,
  COL.accountableFormMovements,
  COL.raafReports,
];
