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

  /**
   * Reads the appropriation ordinance, or a batch of allotment releases, into
   * the budget ledger - already approved, since the Sanggunian enacted the one
   * and the Budget Officer authorises the other by sending it.
   *
   * All of a call posts or none of it does. The `reference` is the ordinance or
   * release number and doubles as the guard against posting the same file
   * twice: a second attempt finds its rows already there and is refused before
   * it writes anything, which matters because appropriations are additive and a
   * duplicate would quietly double the municipality's spending authority.
   */
  importBudgetLines: (p: {
    kind: 'APPROPRIATION' | 'ALLOTMENT';
    fiscalYear: number;
    fundCode: string;
    appropriationKind?: string;
    reference: string;
    date: IsoDate;
    fileName?: string;
    rows: Array<{
      lineNo: number;
      office: string;
      accountCode: string;
      expenseClass?: string;
      amount: Centavos;
      particulars?: string;
    }>;
  }) =>
    call<
      typeof p,
      {
        posted: number;
        budgetLines: number;
        total: Centavos;
        allotmentNo: string | null;
        reference: string;
      }
    >('importBudgetLines', p),

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
   * Reads the Treasurer's own RCI or RADAI file into a draft report.
   *
   * The browser splits the file into rows and nothing more. Which voucher each
   * row paid, whether that voucher is approved, whether the amount agrees and
   * what is therefore posted are all decided on the server against CBO's own
   * records - the amount that reaches the books is the voucher's net, never the
   * figure in the file.
   *
   * A row the server cannot place comes back as pending rather than failing the
   * upload, and the report it produced cannot be certified until every one of
   * those has been dealt with.
   */
  importTreasuryPayments: (p: {
    importType: 'RCI' | 'RADAI';
    fiscalYear: number;
    fundCode: string;
    reportDate: IsoDate;
    bankAccountId: Id;
    /** RADAI: the one ADA number the whole batch went to the bank under. */
    adaNo?: string;
    fileName?: string;
    rows: Array<{
      lineNo: number;
      date: IsoDate;
      serialNo?: string;
      dvNo: string;
      obrNo?: string;
      payeeName?: string;
      particulars?: string;
      responsibilityCenter?: string;
      amount: Centavos;
    }>;
  }) =>
    call<
      typeof p,
      {
        importId: Id;
        reportId: Id;
        rowCount: number;
        matchedCount: number;
        pendingCount: number;
        matchedTotal: Centavos;
        pendingTotal: Centavos;
      }
    >('importTreasuryPayments', p),

  /**
   * Reads the Abstract of Collections: one official receipt per entry, with a
   * line per revenue account.
   *
   * A revenue code with no COA account mapped against it stops the whole file -
   * a collection posted to a guessed account misstates the revenue, and the
   * cash still foots, so nothing later would catch it. A receipt already in the
   * books is skipped rather than refused, which makes a long upload resumable.
   */
  importCollections: (p: {
    fiscalYear: number;
    fundCode: string;
    fileName?: string;
    receipts: Array<{
      lineNo: number;
      date: IsoDate;
      reportRef: string;
      accountableForm?: string;
      orNumber: string;
      payor?: string;
      collector?: string;
      cancelled?: boolean;
      remarks?: string;
      lines: Array<{ revenueCode: string; description?: string; amount: Centavos }>;
    }>;
  }) =>
    call<
      typeof p,
      {
        posted: number;
        skipped: number;
        cancelled: number;
        total: Centavos;
        unknownOfficers: string[];
      }
    >('importCollections', p),

  /**
   * Deals with one held row: links it to the voucher it actually paid, or sets
   * it aside with a note saying how it was handled outside CBO.
   */
  resolveImportRow: (p: {
    importId: Id;
    lineNo: number;
    action: 'LINK' | 'SET_ASIDE';
    dvId?: Id;
    serialNo?: string;
    note?: string;
  }) =>
    call<typeof p, { importId: Id; lineNo: number; pendingCount: number; totalAmount: Centavos }>(
      'resolveImportRow',
      p,
    ),

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

  /**
   * Grants roles. The user may be named by `uid` - the usual case, from the
   * administration table - or by `email`, which is how an administrator adds
   * somebody who has not signed in yet and so has no profile to click on.
   *
   * The Firebase Authentication account must already exist. This grants access;
   * it does not create credentials.
   */
  setUserRoles: (p: {
    uid?: Id;
    email?: string;
    roles: string[];
    officeScope?: Id[];
    fundScope?: string[];
  }) =>
    call<typeof p, { uid: Id; roles: string[]; segregationWarnings?: string[] }>('setUserRoles', p),

  recordExport: (p: { report: string; format: string; filters?: Record<string, unknown> }) =>
    call<typeof p, { logged: true }>('recordExport', p),

  // --- Accountable forms ---------------------------------------------------
  //
  // Custody moves in serial ranges, never in quantities, and every one of these
  // is refused by the server when the range is not where the caller thinks it
  // is. The browser's copy of the arithmetic (src/lib/serials.ts) exists to
  // show the officer the answer before they press the button, not to decide it.

  recordFormMovement: (p: {
    fiscalYear: number;
    formCode: string;
    kind: 'RECEIPT' | 'ISSUE' | 'RETURN' | 'SPOILED' | 'CANCELLED';
    movementDate: IsoDate;
    serialFrom: string;
    serialTo: string;
    custodianId?: Id;
    custodianName?: string;
    sourceRef?: string;
    remarks?: string;
  }) => call<typeof p, { movementId: Id; quantity: number }>('recordFormMovement', p),

  voidFormMovement: (p: { movementId: Id; reason: string }) =>
    call<typeof p, { movementId: Id }>('voidFormMovement', p),

  prepareRaaf: (p: {
    fiscalYear: number;
    officerId: Id;
    officerName: string;
    officerPosition?: string;
    basis: 'CUSTODIAN' | 'COLLECTING_OFFICER';
    periodFrom: IsoDate;
    periodTo: IsoDate;
  }) => call<typeof p, { raafId: Id; lines: number; hasDiscrepancy: boolean }>('prepareRaaf', p),

  certifyRaaf: (p: { raafId: Id }) =>
    call<typeof p, { raafId: Id; raafNo: string }>('certifyRaaf', p),

  cancelRaaf: (p: { raafId: Id; reason: string }) =>
    call<typeof p, { raafId: Id }>('cancelRaaf', p),
};
