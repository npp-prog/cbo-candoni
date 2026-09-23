/**
 * CBO - Candoni Books Online
 * Cloud Functions accounting engine.
 *
 * Municipal Government of Candoni, Province of Negros Occidental
 *
 * ---------------------------------------------------------------------------
 * ARCHITECTURAL POSITION
 * ---------------------------------------------------------------------------
 * The browser is never the authority for a financial balance.
 *
 * The React application at cbo.mgocandoni.com may display "Available Allotment:
 * ₱500,000" and may allow a user to type an obligation of ₱300,000. When that
 * obligation is submitted, `certifyObligation` re-reads the allotment released
 * and the amount already obligated from Firestore, inside the transaction that
 * will commit the certification, and makes its own decision. If the browser was
 * showing a figure that was stale by four minutes, or was manipulated in a
 * console, the server's answer is the one that stands.
 *
 * Every function in this file follows the same shape:
 *   1. requireCaller(request, [roles])   - authorise; no default allow
 *   2. read everything the decision needs, inside the transaction
 *   3. apply the invariants from lib/rules.ts (shared with the frontend)
 *   4. write the document, the derived balances, the workflow event and the
 *      audit record atomically
 *
 * These functions run with Admin credentials and therefore bypass Firestore
 * Security Rules entirely. There is no safety net underneath this code. A
 * callable without an authorisation check at the top is a defect, not a style
 * preference.
 * ---------------------------------------------------------------------------
 */

import { setGlobalOptions } from 'firebase-functions/v2';
import { REGION } from './lib/firebase';

setGlobalOptions({
  region: REGION,
  maxInstances: 20,
  // A financial operation that takes more than 60 seconds has gone wrong.
  timeoutSeconds: 60,
  memory: '512MiB',
});

// --- Budget ------------------------------------------------------------------
export { approveAppropriation, releaseAllotment } from './budget/appropriations';
export { certifyObligation, cancelObligation } from './budget/obligations';
export { importBudgetLines } from './budget/import';

// --- Accounting --------------------------------------------------------------
export { submitDv, reviewDv, approveDv, cancelDv } from './accounting/dv';
export { postJev, reverseJev } from './accounting/jev';
export { issueCheck, cancelCheck, issueAda, cancelAda } from './accounting/payments';
export { postLiquidation } from './accounting/liquidation';

// --- Treasury ----------------------------------------------------------------
export { postRcd, recordDeposit } from './treasury/collections';
export { postOpeningBalances } from './accounting/opening';
export {
  certifyTreasuryReport,
  journalizeTreasuryReport,
  cancelTreasuryReport,
} from './treasury/reports';
export { importTreasuryPayments, resolveImportRow } from './treasury/import';
export { importCollections } from './treasury/collectionsImport';

// --- Reconciliation ----------------------------------------------------------
export {
  importBankStatement,
  autoMatchBankTransactions,
  finalizeReconciliation,
} from './recon/reconciliation';

// --- Administration ----------------------------------------------------------
export { closePeriod, reopenPeriod, lockPeriod } from './admin/periods';
export { setUserRoles, onBeforeSignIn, recordExport } from './admin/users';

// --- Scheduled integrity and monitoring --------------------------------------
export {
  verifyBudgetBalances,
  flagOverdueCashAdvances,
  markStaleChecks,
  flagUndepositedCollections,
} from './admin/scheduled';
