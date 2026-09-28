import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

/**
 * Admin SDK initialisation for the CBO accounting engine.
 *
 * Everything in this codebase runs with Admin credentials, which BYPASS
 * Firestore Security Rules entirely. That is the point - the rules deny clients
 * write access to the General Ledger precisely so that only this code can write
 * it. It also means every callable in this project must do its own
 * authorisation check before touching anything. There is no safety net below
 * this layer.
 */

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
export const auth = getAuth();
export const storage = getStorage();
export { FieldValue, Timestamp };

db.settings({ ignoreUndefinedProperties: true });

/** The region all CBO functions are deployed to. Closest to Negros Occidental. */
export const REGION = 'asia-southeast1';

/**
 * App Check enforcement.
 *
 * In production every callable requires a valid App Check token, so a copied
 * web config cannot be used to drive the accounting engine from a script. The
 * emulator suite issues no such token - App Check attests that a request came
 * from the real deployed app, which by definition a local run is not - so
 * enforcing it there rejects every call with a bare "unauthenticated" and makes
 * the engine untestable.
 *
 * FUNCTIONS_EMULATOR is set by the emulator itself and is never present in a
 * deployed function, so this cannot accidentally disable the check in
 * production. It is deliberately read once, here, rather than repeated at each
 * of the twenty-odd call sites where one could later be missed.
 */
export const ENFORCE_APP_CHECK = process.env.FUNCTIONS_EMULATOR !== 'true';

export const COL = {
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
  appropriations: 'appropriations',
  allotments: 'allotments',
  obligations: 'obligations',
  budgetBalances: 'budgetBalances',
  budgetSummaries: 'budgetSummaries',
  disbursementVouchers: 'disbursementVouchers',
  jevs: 'jevs',
  ledgerEntries: 'ledgerEntries',
  checks: 'checks',
  ada: 'ada',
  payrolls: 'payrolls',
  cashAdvances: 'cashAdvances',
  liquidations: 'liquidations',
  accountingPeriods: 'accountingPeriods',
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
  bankTransactions: 'bankTransactions',
  bankReconciliations: 'bankReconciliations',
  importBatches: 'importBatches',
  users: 'users',
  roleDefinitions: 'roleDefinitions',
  workflowHistory: 'workflowHistory',
  auditLogs: 'auditLogs',
  documents: 'documents',
  notifications: 'notifications',
  settings: 'settings',
  counters: 'counters',
} as const;
