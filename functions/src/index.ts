/**
 * CFMS - Candoni Financial Management System
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
export { certifyObligation, uncertifyObligation, cancelObligation } from './budget/obligations';
export { importBudgetLines } from './budget/import';
export { issueAro, approveAro, releaseHeldAllotment } from './budget/aro';
export { recordEstimatedReceipts, unlockEstimatedReceipts } from './budget/estimatedReceipts';
export { recordTrustProgram } from './accounting/trustPrograms';
export { importChartOfAccounts } from './masterdata/accounts';

// --- Accounting --------------------------------------------------------------
export {
  submitDv,
  reviewDv,
  approveDv,
  forwardDvToTreasury,
  unapproveDv,
  cancelDv,
} from './accounting/dv';
export { postJev, reverseJev, correctJev, amendPostedJev } from './accounting/jev';
export { issueCheck, cancelCheck, issueAda, cancelAda } from './accounting/payments';
export { postLiquidation } from './accounting/liquidation';

// --- Treasury ----------------------------------------------------------------
export { postRcd, recordDeposit } from './treasury/collections';
export { postOpeningBalances, reopenOpeningBalances } from './accounting/opening';
export {
  certifyTreasuryReport,
  journalizeTreasuryReport,
  cancelTreasuryReport,
} from './treasury/reports';
export { importTreasuryPayments, resolveImportRow } from './treasury/import';
export { importCollections } from './treasury/collectionsImport';
export {
  setBankLedgerOpening,
  recordBankLedgerEntry,
  voidBankLedgerEntry,
} from './treasury/bankLedger';
export {
  reserveAdaNumbers,
  retireAdaReservation,
  voidSkippedAdaNumber,
} from './accounting/adaNumbers';
export {
  savePrimaryReport,
  closePrimaryReport,
  reopenPrimaryReport,
  cancelPrimaryReport,
} from './treasury/primaryReports';
export {
  recordFormMovement,
  voidFormMovement,
  prepareRaaf,
  certifyRaaf,
  cancelRaaf,
} from './treasury/accountableForms';

// --- Reconciliation ----------------------------------------------------------
export {
  importBankStatement,
  autoMatchBankTransactions,
  finalizeReconciliation,
} from './recon/reconciliation';

// --- Administration ----------------------------------------------------------
export { closePeriod, reopenPeriod, lockPeriod } from './admin/periods';
export { setUserRoles, createUserAccount, onBeforeSignIn, recordExport } from './admin/users';
export { lockAttachments } from './admin/attachments';

// --- Scheduled integrity and monitoring --------------------------------------
export {
  verifyBudgetBalances,
  flagOverdueCashAdvances,
  markStaleChecks,
  flagUndepositedCollections,
} from './admin/scheduled';
