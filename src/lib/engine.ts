import { httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import { functions } from './firebase';
import type { Centavos, Id, IsoDate } from '@/types/common';

/** One figure the budget repair found to differ from its documents. */
export interface RepairDrift {
  id: string;
  label: string;
  fundCode: string;
  stored: Centavos;
  rebuilt: Centavos;
  obligated?: Centavos;
}

/**
 * Typed client for the CFMS accounting engine (Cloud Functions).
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
  /**
   * Approve every draft line of one uploaded ordinance, whole or not at all.
   * Patch 112: an ordinance file lands as drafts.
   */
  approveOrdinanceUpload: (p: { fiscalYear: number; fundCode: string; reference: string }) =>
    call<{ upload: typeof p }, { approved: number; total: Centavos; reference: string }>(
      'approveAppropriation',
      { upload: p },
    ),
  /**
   * Post a prepared augmentation or realignment. Only its id is sent: the
   * engine reads the set itself, so what is posted is what was prepared.
   */
  approvePreparedSet: (p: { draftId: Id }) =>
    call<
      { kind: 'APPROPRIATION'; draftId: Id },
      { posted: number; allotmentMoved: Centavos; reference: string }
    >('importBudgetLines', { kind: 'APPROPRIATION', draftId: p.draftId }),

  /**
   * Encode, correct or remove a source of financing (patch 123). Refused
   * when a removal or reduction would leave an approved act unfinanced.
   */
  saveFundingSource: (p: {
    id?: Id;
    remove?: boolean;
    fiscalYear?: number;
    fundCode?: string;
    section?: string;
    particulars?: string;
    accountCode?: string | null;
    accountName?: string | null;
    amount?: Centavos;
    actId?: Id | null;
  }) => call<typeof p, { id: Id; removed: boolean }>('saveFundingSource', p),

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
  /**
   * The OBR number is TYPED IN, not generated. The Budget Office assigns it
   * from its own book; CFMS refuses a duplicate.
   */
  certifyObligation: (p: { obligationId: Id; obrNo: string; override?: { reason: string } }) =>
    call<typeof p, { obrNo: string; lines: Array<{ lineNo: number; availableAllotment: Centavos }> }>(
      'certifyObligation',
      p,
    ),

  /**
   * The Budget Officer takes a certification back so the staff can correct the
   * obligation. Refused once the Accountant has approved a voucher against it.
   */
  uncertifyObligation: (p: { obligationId: Id; reason: string }) =>
    call<typeof p, { obligationId: Id; obrNo: string | null; vouchersDrawingOnIt: string[] }>(
      'uncertifyObligation',
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
    /** Required on a realignment: 'SUPPLEMENTAL' or 'AUGMENTATION'. */
    instrument?: string;
    reference: string;
    date: IsoDate;
    fileName?: string;
    rows: Array<{
      lineNo: number;
      office: string;
      /** The FPP as the ordinance writes it: an object code, or a project name. */
      fpp: string;
      fppName?: string;
      sector: string;
      /** Named only where the sector is a funding source rather than a service. */
      serviceSector?: string;
      /** Absent on a project line: the ordinance named no object of expenditure. */
      accountCode?: string;
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
        /** How much allotment a realignment carried across with it. */
        allotmentMoved: Centavos;
        /** An ordinance file lands as drafts since patch 112: how many lines. */
        drafted?: number;
        /** A realignment or augmentation file lands as one prepared set: its id. */
        preparedSet?: string;
        /**
         * An allotment upload no longer releases anything. It fills prepared
         * release orders - one per expense class - for the Budget Officer to
         * approve. This says how many.
         */
        preparedOrders?: number;
      }
    >('importBudgetLines', p),

  /**
   * Releases a PREPARED Allotment Release Order. The Budget Officer's act.
   *
   * Only the order's id is sent. The lines and amounts are read from the
   * stored order inside the transaction that releases them, so what is
   * approved is exactly what was prepared - not whatever the browser says at
   * the moment of approval. (`issueAro`, which released an order the moment it
   * was entered, now refuses and says to prepare it instead.)
   */
  approveAro: (p: { draftId: Id }) =>
    call<
      typeof p,
      { aroNo: string; form: string; lineCount: number; totalReleased: Centavos; totalHeld: Centavos }
    >('approveAro', p),

  /**
   * Releasing allotment that an Allotment Release Order held back.
   *
   * Column 5 of the ARO exists "to provide safeguards for shortfalls in the
   * collection of revenues". This is the act that lets the money go once the
   * collections have come in - a NEW allotment line, so the register shows
   * both the holding back and the release, each with its own date.
   *
   * `collectionsAtRelease` and `estimateAtRelease` are what the screen was
   * showing when the Budget Officer decided. The engine does not refuse on
   * them; it records them, so the decision can be read afterwards against what
   * was known at the time.
   */
  releaseHeldAllotment: (p: {
    allotmentId: Id;
    amount: Centavos;
    date: IsoDate;
    reason: string;
    collectionsAtRelease: Centavos;
    estimateAtRelease: Centavos;
  }) =>
    call<typeof p, { allotmentId: Id; released: Centavos; stillHeld: Centavos }>(
      'releaseHeldAllotment',
      p,
    ),

  /**
   * The budget year's estimated receipts - LBP Form No. 1, section II.
   *
   * REPLACE leaves the year's estimate for that fund matching the file sent,
   * deleting the accounts the file no longer names. MERGE only adds and
   * updates. Re-uploading a corrected form wants REPLACE; editing one line on
   * the screen wants MERGE.
   */
  recordEstimatedReceipts: (p: {
    fiscalYear: number;
    fundCode: string;
    mode: 'MERGE' | 'REPLACE';
    fileName?: string;
    lines: Array<{
      accountCode: string;
      accountName?: string;
      incomeClass: string;
      q1: Centavos;
      q2: Centavos;
      q3: Centavos;
      q4: Centavos;
      particulars?: string;
    }>;
  }) =>
    call<
      typeof p,
      {
        fiscalYear: number;
        fundCode: string;
        mode: string;
        lineCount: number;
        removed: number;
        total: Centavos;
      }
    >('recordEstimatedReceipts', p),

  /**
   * Re-open a closed receipts schedule, so it can be recorded over.
   *
   * Budget Officer only, and the reason is required: two statutory limits and
   * the SRE are worked out from the total this re-opens, so a change to it has
   * to be answerable a year later. Recorded CRITICAL in the audit trail.
   */
  unlockEstimatedReceipts: (p: { fiscalYear: number; fundCode: string; reason: string }) =>
    call<typeof p, { fiscalYear: number; fundCode: string; reopened: boolean }>(
      'unlockEstimatedReceipts',
      p,
    ),

  /**
   * Create or amend a Trust Fund programme.
   *
   * Omit `programId` to create. The worked figures - utilised and disbursed -
   * are never sent: they are maintained inside the transactions that certify a
   * utilisation and approve a voucher, so the balance cannot drift from the
   * documents that moved it.
   */
  recordTrustProgram: (p: {
    programId?: Id;
    programCode: string;
    programName: string;
    sourceAgency: string;
    reference: string;
    /** The RCA code of the trust liability. Validated server-side if given. */
    accountCode?: string;
    startYear?: number;
    programmed: Centavos;
    received: Centavos;
    status: 'ACTIVE' | 'CLOSED';
    notes?: string;
  }) =>
    call<
      typeof p,
      {
        programId: Id;
        programCode: string;
        programmed: Centavos;
        received: Centavos;
        utilised: Centavos;
        disbursed: Centavos;
        availableToUtilise: Centavos;
        unpaidUtilisations: Centavos;
      }
    >('recordTrustProgram', p),

  /**
   * Load the Revised Chart of Accounts.
   *
   * Sends a code and a title per row and nothing else: every classification is
   * derived on the server from the code, by the same rules the screen
   * previewed with. KEEP_EDITS, the default, updates only the title on an
   * account that already exists — re-deriving would silently undo the
   * corrections the Accountant has made since the first load.
   */
  importChartOfAccounts: (p: {
    rows: Array<{ code: string; name: string }>;
    fileName?: string;
    mode?: 'KEEP_EDITS' | 'REDERIVE';
  }) =>
    call<
      typeof p,
      { total: number; created: number; updated: number; unchanged: number; mode: string }
    >('importChartOfAccounts', p),

  cancelObligation: (p: { obligationId: Id; reason: string }) =>
    call<typeof p, { obligationId: Id; cancelledVouchers: string[] }>('cancelObligation', p),

  // -------------------------------------------------------------------------
  // Accounting
  // -------------------------------------------------------------------------

  submitDv: (p: { dvId: Id }) => call<typeof p, { dvNo: string }>('submitDv', p),

  reviewDv: (p: { dvId: Id; decision: 'REVIEWED' | 'RETURNED'; remarks?: string }) =>
    call<typeof p, { dvId: Id; status: string }>('reviewDv', p),

  /**
   * Approves a DV, consumes its obligation, and POSTS its journal entry to the
   * General Ledger in the same act.
   *
   * Posting used to be a second button on a second screen. It is not any more:
   * approving a voucher is the decision that the claim is proper, and the
   * books should say so the moment it is made rather than whenever somebody
   * next opens the entry.
   *
   * It does NOT make the voucher payable. See `forwardDvToTreasury`.
   */
  approveDv: (p: { dvId: Id }) =>
    call<typeof p, { dvId: Id; dvNo: string; jevId: Id; jevNo: string }>('approveDv', p),

  /**
   * Hands an approved voucher over to Treasury to be paid.
   *
   * The second half of what approval used to do in one step. Approving records
   * that the claim is proper; this releases it for payment, and a voucher the
   * office wants to hold back can now be held without withholding approval.
   */
  forwardDvToTreasury: (p: { dvId: Id; remarks?: string }) =>
    call<typeof p, { dvId: Id; dvNo: string | null }>('forwardDvToTreasury', p),

  /**
   * The Accountant takes an approval back so the voucher can be corrected.
   *
   * Refused once a check or advice exists. The posted entry is REVERSED in the
   * same act - the books carry the entry and its reversal, and the voucher
   * goes back to DRAFT.
   */
  unapproveDv: (p: { dvId: Id; reason: string }) =>
    call<
      typeof p,
      {
        dvId: Id;
        dvNo: string | null;
        reversedJevNo: string | null;
        reversingJevNo: string | null;
        reversingJevId: Id | null;
        cancelledJevNo: string | null;
      }
    >('unapproveDv', p),

  cancelDv: (p: { dvId: Id; reason: string }) => call<typeof p, { dvId: Id }>('cancelDv', p),

  /**
   * Patch 131. The Accountant corrects the entry of an approved or paid
   * voucher that is not yet in the General Ledger - accounts, budget lines,
   * particulars - keeping its total. Refused once the entry is posted.
   */
  correctDvEntry: (p: {
    dvId: Id;
    lines: Array<{
      accountCode: string;
      accountName: string;
      fppCode?: string | null;
      fppName?: string | null;
      debit: number;
      credit: number;
      particulars?: string | null;
      subsidiaryType?: string | null;
      subsidiaryId?: string | null;
      subsidiaryName?: string | null;
    }>;
  }) => call<typeof p, { dvId: Id; jevId: Id; lineCount: number }>('correctDvEntry', p),

  /**
   * Posts a JEV to the General Ledger. Validates debit = credit, that the
   * accounting period is open, and that the caller holds a posting role, then
   * writes the immutable ledger entries. Irreversible except by a reversing
   * entry.
   */
  /**
   * Reverse a posted entry and open an editable copy of it, in one act.
   *
   * A posted entry is never edited in place: the ledger is evidence of what
   * was posted. This gives the Accountant the editable screen they wanted
   * without giving up the thing that makes the trial balance worth printing.
   */
  correctJev: (p: { jevId: Id; reason: string }) =>
    call<
      typeof p,
      { originalJevId: Id; reversingJevId: Id; reversingJevNo: string; correctedJevId: Id }
    >('correctJev', p),

  /**
   * Correct a posted entry in place, while its month is still open.
   *
   * The ledger lines are rewritten rather than reversed. The server refuses
   * once the period or the fiscal year is closed, and refuses a changed TOTAL
   * on an entry raised by a document that another officer signed.
   */
  amendPostedJev: (p: {
    jevId: Id;
    jevDate: IsoDate;
    particulars: string;
    lines: unknown[];
    reason: string;
  }) =>
    call<typeof p, { jevId: Id; jevNo: string; ledgerEntryCount: number; replaced: number }>(
      'amendPostedJev',
      p,
    ),

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

  /** Patch 151: reverse the chosen checks of an RCI's entry. */
  reverseRciChecks: (p: {
    jevId: Id;
    /** Check ids on an RCI's entry, ADA ids on a RADAI's (patch 153). */
    documentIds: Id[];
    reason: string;
    reversalDate?: IsoDate;
  }) =>
    call<
      typeof p,
      {
        originalJevId: Id;
        reversingJevId: Id;
        reversingJevNo: string;
        checkNos: string[];
        amount: number;
        fullyReversed: boolean;
      }
    >('reverseRciChecks', p),

  issueCheck: (p: {
    dvId: Id;
    bankAccountId: Id;
    checkNo: string;
    checkDate: IsoDate;
    /** Required only when the payee is one the clearing house refuses. */
    payeeAcknowledgement?: string;
  }) =>
    call<typeof p, { checkId: Id; checkNo: string }>('issueCheck', p),

  cancelCheck: (p: { checkId: Id; reason: string }) =>
    call<typeof p, { checkId: Id; jevId?: Id }>('cancelCheck', p),

  // --- Cash in Bank --------------------------------------------------------
  //
  // Only what the bank originates is keyed. Checks, ADA and deposits are read
  // from their own registers; a second copy typed into a bank book is how two
  // records of one payment come to disagree.

  setBankLedgerOpening: (p: {
    fiscalYear: number;
    bankAccountId: Id;
    beginningBalance: Centavos;
    buffer: Centavos;
  }) => call<typeof p, { ledgerId: Id }>('setBankLedgerOpening', p),

  recordBankLedgerEntry: (p: {
    fiscalYear: number;
    bankAccountId: Id;
    entryDate: IsoDate;
    kind:
      | 'DEPOSIT'
      | 'INTEREST'
      | 'NTA'
      | 'BANK_CHARGE'
      | 'INTEREST_WITHHELD'
      | 'ADJUSTMENT_IN'
      | 'ADJUSTMENT_OUT';
    referenceNo?: string;
    particulars: string;
    amount: Centavos;
    remarks?: string;
  }) => call<typeof p, { entryId: Id }>('recordBankLedgerEntry', p),

  voidBankLedgerEntry: (p: { entryId: Id; reason: string }) =>
    call<typeof p, { entryId: Id }>('voidBankLedgerEntry', p),

  // --- ADA number governance -----------------------------------------------
  //
  // A number, once drawn, is never returned to the pool: the bank may already
  // hold it against an instruction the office withdrew.

  reserveAdaNumbers: (p: {
    fiscalYear: number;
    fundCode: string;
    slotDate: IsoDate;
    count?: number;
    note?: string;
  }) =>
    call<typeof p, { reserved: Array<{ id: Id; adaNo: string; radaiNo: string | null }> }>(
      'reserveAdaNumbers',
      p,
    ),

  retireAdaReservation: (p: { recordId: Id; reason: string }) =>
    call<typeof p, { recordId: Id }>('retireAdaReservation', p),

  voidSkippedAdaNumber: (p: {
    fiscalYear: number;
    fundCode: string;
    adaNo: string;
    slotDate: IsoDate;
    reason: string;
  }) => call<typeof p, { recordId: Id; adaNo: string }>('voidSkippedAdaNumber', p),

  issueAda: (p: { dvId: Id; bankAccountId: Id; adaDate: IsoDate; reservationId?: Id }) =>
    call<typeof p, { adaId: Id; adaNo: string }>('issueAda', p),

  cancelAda: (p: { adaId: Id; reason: string }) => call<typeof p, { adaId: Id }>('cancelAda', p),

  /**
   * Patch 144. The RADAI is posted online by the bank - every advice on it at
   * once; the credits NOT posted become trust liabilities through one draft
   * adjusting entry.
   */
  postRadaiOnline: (p: {
    reportId: Id;
    postedDate: string;
    bankReferenceNo?: string;
    notPosted: Array<{ adaId: Id; lineNo: number }>;
  }) =>
    call<
      typeof p,
      { reportId: Id; adviceCount: number; notPostedAmount: number; notPostedJevId: Id | null }
    >('postRadaiOnline', p),

  /**
   * Patch 137: a saved liquidation report takes its JEV number now ("JEV at
   * save"); the entry is posted under it when the Accountant approves.
   */
  numberLiquidationEntry: (p: { liquidationId: Id }) =>
    call<typeof p, { liquidationId: Id; jevNo: string }>('numberLiquidationEntry', p),

  postLiquidation: (p: { liquidationId: Id }) =>
    call<typeof p, { liquidationId: Id; jevId: Id; jevNo?: string; outstandingBalance: Centavos }>(
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
  certifyTreasuryReport: (p: { reportId: Id; reportNo?: string }) =>
    call<typeof p, { reportId: Id; reportNo: string; totalAmount: number; documentCount: number }>(
      'certifyTreasuryReport',
      p,
    ),

  /** Patch 143: the Treasurer forwards a certified report to Accounting. */
  forwardTreasuryReport: (p: { reportId: Id }) =>
    call<typeof p, { reportId: Id }>('forwardTreasuryReport', p),

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
      subsidiaryType?: string;
      subsidiaryId?: string;
      subsidiaryName?: string;
    }>;
  }) =>
    call<
      typeof p,
      // Patch 157: no JEV for an RCD of deposits only.
      { reportId: Id; reportNo: string; jevId: Id | null; jevNo: string | null }
    >(
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
   * what is therefore posted are all decided on the server against CFMS's own
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
    /** Patch 156: an e-collection file - every receipt of this kind. */
    eCollectionKind?: 'EOR' | 'AR';
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
   * it aside with a note saying how it was handled outside CFMS.
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
      /*
        The subsidiary the balance belongs to - the payee owed, the officer
        holding the advance, the debtor. Written out here because patch 97
        made it a picker over the same records the journal entry uses, and a
        field the engine's own type does not know about is a field a typo
        drops on the floor without a word.
      */
      subsidiaryType?: string | null;
      subsidiaryId?: Id | null;
      subsidiaryName?: string | null;
      referenceNo?: string | null;
      agingDate?: IsoDate | null;
    }>;
  }) =>
    call<
      typeof p,
      { jevId: Id; jevNo: string; lineCount: number; total: number; payableVouchers?: number }
    >(
      'postOpeningBalances',
      p,
    ),

  /**
   * And the way back out.
   *
   * The opening entry is REVERSED, not deleted, and the reversal is dated
   * where the original was raised so that every month in between still reads
   * correctly. The month has to be open for that, which is the whole of the
   * control: a period that has been closed and reported on is corrected by an
   * adjusting entry, not by rewriting what was filed.
   */
  reopenOpeningBalances: (p: { fiscalYear: number; fundCode: string; reason: string }) =>
    call<
      typeof p,
      {
        fiscalYear: number;
        fundCode: string;
        reopened: boolean;
        reversedJevNo: string | null;
        reversingJevNo: string | null;
        reversingJevId: Id | null;
      }
    >('reopenOpeningBalances', p),

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
  /**
   * Close the supporting documents on a transaction, for good.
   *
   * There is deliberately no unlock, for anybody. A closing that can be
   * reopened says nothing about what was closed.
   */
  lockAttachments: (p: { entityType: string; entityId: Id }) =>
    call<typeof p, { entityType: string; entityId: Id; attachmentsLockedAt: string }>(
      'lockAttachments',
      p,
    ),

  /**
   * Patch 121: put every disbursed figure of a year back to what the checks
   * and ADAs say - obligations' paidAmount, budget lines, fund summaries,
   * trust programmes. `apply: false` only reports what differs. Super
   * Administrator only; every document changed is in the audit trail.
   */
  repairBudgetDisbursed: (p: { fiscalYear: number; apply: boolean }) =>
    call<
      typeof p,
      {
        fiscalYear: number;
        applied: boolean;
        repaired?: number;
        obligations: RepairDrift[];
        lines: RepairDrift[];
        summaries: RepairDrift[];
        programmes: RepairDrift[];
      }
    >('repairBudgetDisbursed', p),

  setUserRoles: (p: {
    uid?: Id;
    email?: string;
    roles: string[];
    officeScope?: Id[];
    fundScope?: string[];
  }) =>
    call<typeof p, { uid: Id; roles: string[]; segregationWarnings?: string[] }>('setUserRoles', p),

  /**
   * Creates the Firebase Authentication account as well as granting the role.
   *
   * Separate from setUserRoles on purpose: granting a role and creating
   * credentials are different powers, and the function that does the first
   * should not quietly acquire the second.
   *
   * The password is passed straight through to Firebase Authentication. CFMS
   * does not store it, log it, or put it in the audit trail.
   */
  createUserAccount: (p: {
    email: string;
    displayName: string;
    password: string;
    roles: string[];
    officeScope?: Id[];
    fundScope?: string[];
  }) =>
    call<
      typeof p,
      {
        uid: Id;
        roles: string[];
        segregationWarnings?: string[];
        created: boolean;
        email: string;
      }
    >('createUserAccount', p),

  recordExport: (p: { report: string; format: string; filters?: Record<string, unknown> }) =>
    call<typeof p, { logged: true }>('recordExport', p),

  // --- Primary reports -----------------------------------------------------
  //
  // A secondary belongs to one primary, and a collection day is banked once.
  // Neither check can be a security rule - both have to read every other
  // report for the fund first - so both live in the engine.

  savePrimaryReport: (p: {
    primaryId?: Id;
    fiscalYear: number;
    fundCode: string;
    reportDate: IsoDate;
    reportType: 'COLLECTION' | 'CONSOLIDATED' | 'DEPOSIT';
    accountableOfficerId: Id;
    accountableOfficerName: string;
    accountableOfficerPosition?: string;
    rcdIds?: Id[];
    coveredPrimaryIds?: Id[];
    deposit?: {
      bankAccountId: Id;
      bankName: string;
      bankAccountNumber: string;
      cash: Centavos;
      checks: Array<{ checkNo: string; payor: string; amount: Centavos }>;
      online: Array<{ referenceNo: string; particulars: string; amount: Centavos }>;
    } | null;
    remarks?: string;
  }) => call<typeof p, { primaryId: Id; totalAmount: Centavos }>('savePrimaryReport', p),

  closePrimaryReport: (p: { primaryId: Id }) =>
    call<typeof p, { primaryId: Id; primaryNo: string }>('closePrimaryReport', p),

  reopenPrimaryReport: (p: { primaryId: Id; reason: string }) =>
    call<typeof p, { primaryId: Id }>('reopenPrimaryReport', p),

  cancelPrimaryReport: (p: { primaryId: Id; reason: string }) =>
    call<typeof p, { primaryId: Id }>('cancelPrimaryReport', p),

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
