import { httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import { functions } from './firebase';
import type { Centavos, Id, IsoDate } from '@/types/common';

/**
 * Typed client for the CBO accounting engine (Cloud Functions).
 *
 * Every state-changing financial operation goes through here. The frontend
 * never writes to `ledgerEntries`, `budgetBalances`, `counters` or `auditLogs`
 * - security rules deny it outright - and it never decides whether a
 * transaction is permissible. It submits an intent; the server decides.
 *
 * Notice what the payloads do *not* contain: computed balances. A call to
 * `certifyObligation` sends the obligation id and the amount requested, not
 * the available allotment the browser happened to be displaying. The function
 * re-reads the balance from Firestore inside a transaction and makes its own
 * determination. That is the whole point of this layer.
 */

export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

async function call<Req, Res>(name: string, payload: Req): Promise<Res> {
  try {
    const fn = httpsCallable<Req, Res>(functions, name);
    const result: HttpsCallableResult<Res> = await fn(payload);
    return result.data;
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: unknown };
    throw new EngineError(
      e.code ?? 'internal',
      e.message ?? 'The accounting engine could not complete this operation.',
      e.details,
    );
  }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export const engine = {
  approveAppropriation: (p: { appropriationId: Id }) =>
    call<typeof p, { appropriationId: Id; budgetBalanceId: Id }>('approveAppropriation', p),

  releaseAllotment: (p: { allotmentId: Id }) =>
    call<typeof p, { allotmentId: Id; allotmentNo: string; availableAppropriation: Centavos }>(
      'releaseAllotment',
      p,
    ),

  /**
   * Certifies an obligation as to availability of allotment and assigns its
   * OBR number. `override` is accepted only from a role permitted to use it
   * and is recorded on the OBR and in the audit log.
   */
  certifyObligation: (p: { obligationId: Id; override?: { reason: string } }) =>
    call<typeof p, { obrNo: string; lines: Array<{ lineNo: number; availableAllotment: Centavos }> }>(
      'certifyObligation',
      p,
    ),

  cancelObligation: (p: { obligationId: Id; reason: string }) =>
    call<typeof p, { obligationId: Id }>('cancelObligation', p),

  // -------------------------------------------------------------------------
  // Accounting
  // -------------------------------------------------------------------------

  submitDv: (p: { dvId: Id }) => call<typeof p, { dvNo: string }>('submitDv', p),

  reviewDv: (p: { dvId: Id; decision: 'REVIEWED' | 'RETURNED'; remarks?: string }) =>
    call<typeof p, { dvId: Id; status: string }>('reviewDv', p),

  /**
   * Approves a DV, draws its number if not yet drawn, and generates the
   * proposed JEV. The JEV is created in DRAFT - approval of a voucher and
   * posting to the ledger are two distinct acts by two distinct roles.
   */
  approveDv: (p: { dvId: Id }) =>
    call<typeof p, { dvId: Id; dvNo: string; jevId: Id; jevNo: string }>('approveDv', p),

  cancelDv: (p: { dvId: Id; reason: string }) => call<typeof p, { dvId: Id }>('cancelDv', p),

  /**
   * Posts a JEV to the General Ledger. Validates debit = credit, that the
   * accounting period is open, and that the caller holds a posting role, then
   * writes the immutable ledger entries. Irreversible except by a reversing
   * entry.
   */
  postJev: (p: { jevId: Id }) =>
    call<typeof p, { jevId: Id; jevNo: string; ledgerEntryCount: number; postedAt: string }>(
      'postJev',
      p,
    ),

  reverseJev: (p: { jevId: Id; reason: string; reversalDate?: IsoDate }) =>
    call<typeof p, { originalJevId: Id; reversingJevId: Id; reversingJevNo: string }>(
      'reverseJev',
      p,
    ),

  issueCheck: (p: { dvId: Id; bankAccountId: Id; checkNo: string; checkDate: IsoDate }) =>
    call<typeof p, { checkId: Id; checkNo: string }>('issueCheck', p),

  cancelCheck: (p: { checkId: Id; reason: string }) =>
    call<typeof p, { checkId: Id; jevId?: Id }>('cancelCheck', p),

  issueAda: (p: { dvId: Id; bankAccountId: Id; adaDate: IsoDate }) =>
    call<typeof p, { adaId: Id; adaNo: string }>('issueAda', p),

  cancelAda: (p: { adaId: Id; reason: string }) => call<typeof p, { adaId: Id }>('cancelAda', p),

  postLiquidation: (p: { liquidationId: Id }) =>
    call<typeof p, { liquidationId: Id; jevId: Id; outstandingBalance: Centavos }>(
      'postLiquidation',
      p,
    ),

  // postPayroll is gone. A payroll raises no entry of its own; the entry comes
  // from the RCDisb that reports the cash paid, via journalizeTreasuryReport.
  // Posting both put the same salaries in the ledger twice.

  // -------------------------------------------------------------------------
  // Treasury
  // -------------------------------------------------------------------------

  postRcd: (p: { rcdId: Id }) =>
    call<typeof p, { rcdId: Id; rcdNo: string; jevId: Id }>('postRcd', p),

  recordDeposit: (p: { depositId: Id }) =>
    call<typeof p, { depositId: Id; jevId?: Id }>('recordDeposit', p),

  /**
   * The Treasurer closes a report and forwards it to Accounting. From here the
   * covered checks, advices, receipts or payrolls belong to this report and
   * cannot be cancelled without withdrawing it.
   */
  certifyTreasuryReport: (p: { reportId: Id }) =>
    call<typeof p, { reportId: Id; reportNo: string; totalAmount: number; documentCount: number }>(
      'certifyTreasuryReport',
      p,
    ),

  /**
   * The Accountant raises the report's journal entry and posts it. An adjusted
   * entry may be supplied and replaces the proposal, but it must still foot to
   * the total the Treasurer certified - the journal has to agree with the
   * report that was signed.
   */
  journalizeTreasuryReport: (p: {
    reportId: Id;
    entry?: Array<{
      accountCode: string;
      accountName: string;
      debit: number;
      credit: number;
      particulars?: string;
    }>;
  }) =>
    call<typeof p, { reportId: Id; reportNo: string; jevId: Id; jevNo: string }>(
      'journalizeTreasuryReport',
      p,
    ),

  cancelTreasuryReport: (p: { reportId: Id; reason: string }) =>
    call<typeof p, { reportId: Id }>('cancelTreasuryReport', p),

  /**
   * Opening balances, posted as a journal entry rather than typed onto a
   * statement. Once per fiscal year and fund; a correction afterwards is an
   * adjusting entry, so the change is visible.
   */
  postOpeningBalances: (p: {
    fiscalYear: number;
    fundCode: string;
    asOfDate: string;
    remarks?: string;
    lines: Array<{
      accountCode: string;
      accountName?: string;
      debit?: number;
      credit?: number;
      particulars?: string;
    }>;
  }) =>
    call<typeof p, { jevId: Id; jevNo: string; lineCount: number; total: number }>(
      'postOpeningBalances',
      p,
    ),

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  importBankStatement: (p: {
    bankAccountId: Id;
    statementDate: IsoDate;
    rows: Array<{
      transactionDate: IsoDate;
      postingDate?: IsoDate;
      referenceNo?: string;
      description: string;
      debit: Centavos;
      credit: Centavos;
      runningBalance?: Centavos;
    }>;
  }) =>
    call<typeof p, { importBatchId: Id; imported: number; duplicatesSkipped: number }>(
      'importBankStatement',
      p,
    ),

  autoMatchBankTransactions: (p: { bankAccountId: Id; reconciliationId: Id }) =>
    call<typeof p, { matched: number; suggested: number; unmatched: number }>(
      'autoMatchBankTransactions',
      p,
    ),

  finalizeReconciliation: (p: { reconciliationId: Id }) =>
    call<typeof p, { reconciliationId: Id; difference: Centavos }>('finalizeReconciliation', p),

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  closePeriod: (p: { fiscalYear: number; period: number; fundCode: string }) =>
    call<typeof p, { periodId: Id }>('closePeriod', p),

  reopenPeriod: (p: { fiscalYear: number; period: number; fundCode: string; reason: string }) =>
    call<typeof p, { periodId: Id }>('reopenPeriod', p),

  /** Temporarily locks a period during month-end review, without closing it. */
  lockPeriod: (p: { fiscalYear: number; period: number; fundCode: string; locked: boolean }) =>
    call<typeof p, { periodId: Id }>('lockPeriod', p),

  setUserRoles: (p: { uid: Id; roles: string[]; officeScope?: Id[]; fundScope?: string[] }) =>
    call<typeof p, { uid: Id; roles: string[]; segregationWarnings?: string[] }>('setUserRoles', p),

  recordExport: (p: { report: string; format: string; filters?: Record<string, unknown> }) =>
    call<typeof p, { logged: true }>('recordExport', p),
};
