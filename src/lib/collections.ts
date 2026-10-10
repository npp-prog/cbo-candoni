/**
 * Canonical Firestore collection names.
 *
 * Every read and write in CFMS goes through these constants so that a typo
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
  /**
   * The barangays of the municipality.
   *
   * Not offices. An office is a department OF the municipality; a barangay is
   * a separate local government unit that the municipality collects real
   * property tax on behalf of and remits a share to. Putting them in the same
   * list would have the Office picker on every voucher offering Barangay
   * Payauan as somewhere to charge an expense.
   */
  barangays: 'barangays',
  /** Who collects on the municipality's behalf: GCash, Maya, a bank's portal. */
  intermediaries: 'intermediaries',
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
  /** The appropriation ordinance as a document of its own. Patch 119. */
  ordinances: 'ordinances',
  fundingSources: 'fundingSources',
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
  /** One marker per fiscal year and fund; see recordEstimatedReceipts. */
  estimatedReceiptLocks: 'estimatedReceiptLocks',
  /**
   * An augmentation being prepared, before it is posted.
   *
   * ONE DOCUMENT PER SET, holding all of its lines, because an augmentation is
   * a set that comes to zero and a draft made of loose rows could be approved
   * halfway. See src/types/budget.ts.
   */
  augmentationDrafts: 'augmentationDrafts',
  /**
   * An Allotment Release Order prepared and awaiting the Budget Officer's
   * approval. Released by `approveAro`, which marks it APPROVED with its ARO
   * number - kept, as the record of who prepared it, and so the same uploaded
   * file cannot be prepared twice.
   */
  aroDrafts: 'aroDrafts',
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
  /** Patch 169: the preceding year's pre- and post-closing trial balances. */
  priorTrialBalances: 'priorTrialBalances',
  /** Patch 170: the preceding year's Statement of Cash Flows, by caption. */
  priorCashFlows: 'priorCashFlows',
  deposits: 'deposits',
  /** Patch 160: the collector's remittances to the Liquidating Officer. */
  collectionRemittances: 'collectionRemittances',
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
  /**
   * One document per manually assigned number, so that uniqueness is a
   * database constraint rather than an application check. See
   * certifyObligation.
   */
  documentNumbers: 'documentNumbers',
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
