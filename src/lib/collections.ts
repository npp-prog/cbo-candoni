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
  /**
   * The financing side of the budget year: what the Local Finance Committee
   * certified as reasonably collectible, per revenue account per fund. The
   * appropriation ordinance carries only expenditure, so without this the SRE
   * and the Statement of Comparison have no budget column for receipts.
   */
  estimatedReceipts: 'estimatedReceipts',
  /**
   * The Trust Fund's own funding control. A programme is money received for a
   * stated purpose, with a programmed ceiling that a Funding Utilization
   * Request is checked against - the part the released allotment plays in the
   * General Fund. Not tied to a fiscal year: trust money does not expire with
   * the budget.
   */
  trustPrograms: 'trustPrograms',

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
  adaNumbers: 'adaNumbers',
  bankLedgers: 'bankLedgers',
  bankLedgerEntries: 'bankLedgerEntries',
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
  COL.estimatedReceipts,
  COL.trustPrograms,
  COL.cashPositions,
  COL.accountingPeriods,
  COL.workflowHistory,
  COL.treasuryImports,
  COL.bankLedgers,
  COL.bankLedgerEntries,
  COL.adaNumbers,
  COL.primaryReports,
  COL.accountableFormMovements,
  COL.raafReports,
];
