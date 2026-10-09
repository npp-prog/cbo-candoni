import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import {
  requireCaller,
  APPROVING_ROLES,
  assertOfficeInScope,
  assertFundInScope,
  assertNotSelfApproval,
  notFound,
  invalid,
  type Role,
} from '../lib/context';
import { recordTransition, notifyInTransaction } from '../lib/audit';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf, todayPh } from '../lib/period';
import { readBudgetBalance, applyBudgetDelta, applySummaryDelta, type BudgetKey } from '../lib/budget';
import { allocateDvShares, obligationLineKey } from '../lib/dvShares';
import { checkDvCategory, checkDvMath } from '../lib/rules';
import {
  createJevInTransaction,
  postJevInTransaction,
  buildReversalLines,
  type JevLineData,
} from '../lib/ledger';
import { loadNumberingConfig, issueNumbers, bookCodeForFund } from '../lib/numbering';
import {
  readTrustProgram,
  applyTrustDelta,
  type TrustProgramData,
} from './trustPrograms';

const ENCODERS: Role[] = [
  'SUPER_ADMIN',
  'MUNICIPAL_ACCOUNTANT',
  'ACCOUNTING_REVIEWER',
  'ACCOUNTING_ENCODER',
  'DEPARTMENT_USER',
];

const REVIEWERS: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT', 'ACCOUNTING_REVIEWER'];

/**
 * The voucher's category, held to what it says it is.
 *
 * An OBLIGATED voucher pays an expenditure and must draw on a certified
 * Obligation Request. A TRUST_LIABILITY voucher settles money the
 * municipality is only holding - retention, a bond, a remittance - and must
 * not draw on one, nor debit an expense.
 *
 * Both halves are checked here rather than only on the screen, because the
 * screen is a courtesy. Before the category existed a voucher with no
 * obligation simply went through, and nothing distinguished a deliberate
 * trust settlement from an obligation somebody forgot - which is the whole
 * budget control, missing and invisible.
 *
 * The Chart of Accounts is read only when a trust-liability voucher has a
 * debit to check. An obligated voucher never needs it.
 */
async function assertDvCategory(dv: DvDoc): Promise<void> {
  const lines = (dv.accountLines ?? []).map((l) => ({
    lineNo: l.lineNo,
    accountCode: l.accountCode,
    debit: l.debit ?? 0,
    credit: l.credit ?? 0,
    fppCode: l.fppCode ?? null,
  }));

  let isExpense = (_code: string) => false;

  if (dv.dvCategory === 'TRUST_LIABILITY' && lines.some((l) => l.debit > 0)) {
    const snap = await db.collection(COL.accounts).get();
    const expense = new Set<string>();
    for (const doc of snap.docs) {
      const a = doc.data() as { code?: string; accountClass?: string };
      if (a.code && a.accountClass === 'EXPENSE') expense.add(a.code.trim());
    }
    isExpense = (code: string) => expense.has(code);
  }

  /*
   * In the Trust Fund every voucher utilises a programme, so every voucher
   * carries a FURS. There is no trust-liability voucher there: the whole fund
   * is money held for somebody else, and the utilisation IS the control.
   */
  if (
    String(dv.fundCode ?? '').trim().toUpperCase() === 'TF' &&
    dv.dvCategory === 'TRUST_LIABILITY'
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Every Trust Fund voucher must draw on a Funding Utilization Request. The trust-liability ' +
        'kind is for the General and Special Education Funds, where it settles money held ' +
        'inside an appropriated fund; in the Trust Fund the utilisation is the control and ' +
        'nothing may be paid without one.',
    );
  }

  const check = checkDvCategory(
    {
      category: String(dv.dvCategory ?? ''),
      hasObligation: Boolean(dv.obligationId),
      lines,
    },
    isExpense,
  );

  if (!check.ok) {
    throw new HttpsError('failed-precondition', check.violations[0].message, {
      violations: check.violations,
    });
  }
}


interface DvDoc {
  dvNo?: string;
  /** OBLIGATED or TRUST_LIABILITY. Absent on a voucher raised before it existed. */
  dvCategory?: string;
  dvDate: string;
  fiscalYear: number;
  fundCode: string;
  officeId: string;
  officeName: string;
  obligationId?: string;
  obrNo?: string;
  payeeId: string;
  payeeName: string;
  particulars: string;
  grossAmount: number;
  deductions: Array<{ amount: number; accountCode: string; accountName: string; description: string }>;
  totalDeductions: number;
  netAmount: number;
  accountLines: Array<{
    lineNo: number;
    accountCode: string;
    accountName: string;
    /** The budget line this expense is charged to, carried from the obligation. */
    fppCode?: string;
    fppName?: string;
    debit: number;
    credit: number;
    officeId?: string;
    responsibilityCenterId?: string;
    subsidiaryType?: string;
    subsidiaryId?: string;
    subsidiaryName?: string;
    particulars?: string;
  }>;
  status: string;
  attachmentCount: number;
  createdBy?: { uid: string };
  jevId?: string;
  jevNo?: string;
  checkId?: string;
  adaId?: string;
}

/** The subset of an obligation this module needs in order to consume it. */
interface ObligationDoc {
  obrNo?: string;
  fiscalYear: number;
  fundCode: string;
  status: string;
  totalAmount: number;
  disbursedAmount: number;
  lines: Array<
    BudgetKey & {
      lineNo: number;
      officeName: string;
      accountName: string;
      /** The object code the appropriation carried; empty on a project line. */
      appropriatedAccountCode?: string;
      /** Trust Fund only: the programme this line utilises. */
      trustProgramId?: string;
      expenseClass: string;
      amount: number;
    }
  >;
}

/**
 * Attachments a disbursement voucher must carry before it can be submitted.
 * Kept here rather than in the UI so the requirement cannot be bypassed by
 * calling the function directly - a voucher with no supporting documents is
 * the most common audit finding there is.
 */
/**
 * Document types a voucher must carry before it may be submitted.
 *
 * Empty for now - the office has not settled which attachments it will enforce,
 * and enforcing a guess would only teach people to attach something named
 * correctly. It was previously keyed by payment method, which no longer exists
 * on the voucher; the requirement belongs to what is being bought, not to how
 * it is paid.
 */
const REQUIRED_ATTACHMENTS: string[] = [];

export const submitDv = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, ENCODERS);
  const { dvId } = (request.data ?? {}) as { dvId?: string };
  if (!dvId) throw invalid('A disbursement voucher id is required.');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.disbursementVouchers).doc(dvId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The disbursement voucher');
    const dv = snap.data() as DvDoc;

    if (!['DRAFT', 'RETURNED'].includes(dv.status)) {
      throw new HttpsError(
        'failed-precondition',
        `This voucher is ${dv.status.toLowerCase()} and cannot be submitted again.`,
      );
    }

    assertOfficeInScope(caller, dv.officeId);
    assertFundInScope(caller, dv.fundCode);

    // Arithmetic and double entry, re-derived from the stored lines.
    const math = checkDvMath({
      grossAmount: dv.grossAmount,
      deductions: dv.deductions ?? [],
      netAmount: dv.netAmount,
      accountLines: (dv.accountLines ?? []).map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
      })),
    });
    if (!math.ok) {
      throw new HttpsError('failed-precondition', math.violations[0].message, {
        violations: math.violations,
      });
    }

    // What kind of voucher this is, and whether it is held to it. Checked
    // before the attachments so the encoder is told the structural thing
    // first - attaching documents to a voucher of the wrong kind is wasted
    // work.
    await assertDvCategory(dv);

    if ((dv.attachmentCount ?? 0) === 0) {
      throw new HttpsError(
        'failed-precondition',
        'Attach the supporting documents before submitting this voucher. A disbursement without supporting documents cannot be reviewed or audited.',
      );
    }

    const required = REQUIRED_ATTACHMENTS;
    if (required.length > 0) {
      const docs = await tx.get(
        db
          .collection(COL.documents)
          .where('entityType', '==', COL.disbursementVouchers)
          .where('entityId', '==', dvId)
          .where('active', '==', true),
      );
      const present = new Set(docs.docs.map((d) => d.data().documentType as string));
      const missing = required.filter((r) => !present.has(r));
      if (missing.length) {
        throw new HttpsError(
          'failed-precondition',
          `Missing required supporting documents: ${missing.join(', ')}.`,
          { missing },
        );
      }
    }

    tx.update(ref, {
      status: 'SUBMITTED',
      assignedToRole: 'ACCOUNTING_REVIEWER',
      submittedBy: {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: new Date().toISOString(),
      },
    });

    recordTransition(tx, {
      caller,
      event: 'SUBMIT',
      entityType: COL.disbursementVouchers,
      entityId: dvId,
      entityRef: `DV ${dv.dvNo ?? '(unnumbered)'}`,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      action: 'SUBMIT',
      previousStatus: dv.status,
      newStatus: 'SUBMITTED',
      assignedToRole: 'ACCOUNTING_REVIEWER',
      remarks: `${dv.payeeName}, net ${(dv.netAmount / 100).toFixed(2)}`,
    });

    notifyInTransaction(tx, {
      recipientRole: 'ACCOUNTING_REVIEWER',
      kind: 'PENDING_REVIEW',
      title: 'Disbursement voucher awaiting review',
      body: `${dv.officeName}: ${dv.payeeName}, ${(dv.netAmount / 100).toFixed(2)}`,
      entityType: COL.disbursementVouchers,
      entityId: dvId,
      link: `/accounting/disbursements/${dvId}`,
    });

    return { dvNo: dv.dvNo ?? null };
  });
});

export const reviewDv = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, REVIEWERS);
  const { dvId, decision, remarks } = (request.data ?? {}) as {
    dvId?: string;
    decision?: 'REVIEWED' | 'RETURNED';
    remarks?: string;
  };

  if (!dvId) throw invalid('A disbursement voucher id is required.');
  if (decision !== 'REVIEWED' && decision !== 'RETURNED') {
    throw invalid('The review decision must be REVIEWED or RETURNED.');
  }
  if (decision === 'RETURNED' && !remarks?.trim()) {
    throw invalid('Say why the voucher is being returned so the originating office can correct it.');
  }

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.disbursementVouchers).doc(dvId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The disbursement voucher');
    const dv = snap.data() as DvDoc;

    if (dv.status !== 'SUBMITTED') {
      throw new HttpsError(
        'failed-precondition',
        `Only a submitted voucher can be reviewed. This one is ${dv.status.toLowerCase()}.`,
      );
    }

    await assertNotSelfApproval(caller, dv.createdBy?.uid, `DV ${dv.dvNo ?? dvId}`);

    const now = new Date().toISOString();
    tx.update(ref, {
      status: decision,
      assignedToRole: decision === 'REVIEWED' ? 'MUNICIPAL_ACCOUNTANT' : null,
      returnedReason: decision === 'RETURNED' ? remarks!.trim() : null,
      reviewedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });

    recordTransition(tx, {
      caller,
      event: 'REVIEW',
      entityType: COL.disbursementVouchers,
      entityId: dvId,
      entityRef: `DV ${dv.dvNo ?? '(unnumbered)'}`,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      action: decision === 'REVIEWED' ? 'REVIEW' : 'RETURN',
      previousStatus: dv.status,
      newStatus: decision,
      assignedToRole: decision === 'REVIEWED' ? 'MUNICIPAL_ACCOUNTANT' : undefined,
      remarks: remarks?.trim(),
    });

    if (decision === 'RETURNED') {
      notifyInTransaction(tx, {
        recipientUid: dv.createdBy?.uid,
        kind: 'RETURNED',
        title: 'Disbursement voucher returned',
        body: remarks!.trim(),
        entityType: COL.disbursementVouchers,
        entityId: dvId,
        link: `/accounting/disbursements/${dvId}`,
        severity: 'WARNING',
      });
    } else {
      notifyInTransaction(tx, {
        recipientRole: 'MUNICIPAL_ACCOUNTANT',
        kind: 'PENDING_REVIEW',
        title: 'Disbursement voucher awaiting approval',
        body: `${dv.payeeName}, ${(dv.netAmount / 100).toFixed(2)}`,
        entityType: COL.disbursementVouchers,
        entityId: dvId,
        link: `/accounting/disbursements/${dvId}`,
      });
    }

    return { dvId, status: decision };
  });
});

/**
 * approveDv - assigns the DV number, consumes the obligation and builds the
 * proposed journal entry.
 *
 * The generated JEV is created in DRAFT, not posted. Approving a voucher
 * authorises the payment; posting writes to the General Ledger. Those are
 * separate acts in COA practice and are separate acts here.
 *
 * Note what is re-verified rather than trusted: the arithmetic of the voucher,
 * the balance of its accounting lines, the remaining unpaid balance of the
 * obligation it draws on, and whether the period is still open. The client may
 * have displayed all of these correctly an hour ago; none of that matters now.
 */
export const approveDv = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, APPROVING_ROLES);
  const { dvId } = (request.data ?? {}) as { dvId?: string };
  if (!dvId) throw invalid('A disbursement voucher id is required.');

  return db.runTransaction(async (tx) => {
    // ---- READ PHASE ---------------------------------------------------------
    const ref = db.collection(COL.disbursementVouchers).doc(dvId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The disbursement voucher');
    const dv = snap.data() as DvDoc;

    if (!['REVIEWED', 'SUBMITTED'].includes(dv.status)) {
      throw new HttpsError(
        'failed-precondition',
        `A voucher must be reviewed before approval. This one is ${dv.status.toLowerCase()}.`,
      );
    }

    assertFundInScope(caller, dv.fundCode);
    await assertNotSelfApproval(caller, dv.createdBy?.uid, `DV ${dv.dvNo ?? dvId}`);

    /*
     * Re-checked here and not only at submission.
     *
     * Approval is the act that assigns a number, consumes the obligation and
     * writes the journal entry - and between submission and approval the
     * voucher's lines and its obligation can both be edited. A category
     * verified an hour ago says nothing about the document being approved now.
     */
    await assertDvCategory(dv);

    const period = periodOf(dv.dvDate);
    await assertFiscalYearOpen(dv.fiscalYear, tx);
    await assertPeriodOpen(dv.fiscalYear, period, dv.fundCode, `DV dated ${dv.dvDate}`, tx);

    const math = checkDvMath({
      grossAmount: dv.grossAmount,
      deductions: dv.deductions ?? [],
      netAmount: dv.netAmount,
      accountLines: (dv.accountLines ?? []).map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
      })),
    });
    if (!math.ok) {
      throw new HttpsError('failed-precondition', math.violations[0].message, {
        violations: math.violations,
      });
    }

    // Obligation consumption: read the OBR and every budget line it touches.
    let obligation: ObligationDoc | null = null;
    const obligationBalances = new Map<number, Awaited<ReturnType<typeof readBudgetBalance>>>();

    /*
     * Trust Fund only.
     *
     * A utilisation consumes its programme, not a budget line - there is no
     * appropriation behind it. Read here, in the read phase, exactly as the
     * budget balances are.
     */
    const obligationIsTrust = String(dv.fundCode ?? '').trim().toUpperCase() === 'TF';
    const trustPrograms = new Map<string, TrustProgramData>();

    if (dv.obligationId) {
      const obrRef = db.collection(COL.obligations).doc(dv.obligationId);
      const obrSnap = await tx.get(obrRef);
      if (!obrSnap.exists) throw notFound(`The obligation ${dv.obrNo ?? ''}`.trim());
      obligation = obrSnap.data() as ObligationDoc;

      if (obligation.status === 'CANCELLED') {
        throw new HttpsError(
          'failed-precondition',
          `OBR ${obligation.obrNo} has been cancelled and cannot be drawn against.`,
        );
      }

      const remaining = obligation.totalAmount - (obligation.disbursedAmount ?? 0);
      if (dv.grossAmount > remaining) {
        throw new HttpsError(
          'failed-precondition',
          `This voucher of ${(dv.grossAmount / 100).toFixed(2)} exceeds the unpaid balance of OBR ${obligation.obrNo}, which is ${(remaining / 100).toFixed(2)}. Raise a supplementary obligation or reduce the voucher.`,
          { obligationTotal: obligation.totalAmount, alreadyDisbursed: obligation.disbursedAmount, remaining },
        );
      }

      for (const line of obligationIsTrust ? [] : obligation.lines ?? []) {
        // Keyed on the object the APPROPRIATION carried - see obligationLineKey.
        obligationBalances.set(line.lineNo, await readBudgetBalance(tx, obligationLineKey(obligation, line)));
      }

      if (obligationIsTrust) {
        for (const line of obligation.lines ?? []) {
          const programId = String(line.trustProgramId ?? '').trim();
          if (!programId || trustPrograms.has(programId)) continue;
          trustPrograms.set(programId, await readTrustProgram(tx, programId));
        }
      }
    }

    /*
     * ---- THE DV NUMBER IS TYPED IN, NOT DRAWN -------------------------
     *
     * Accounting staff assign it from the office's own book when they encode
     * the voucher, exactly as the Budget Office assigns the OBR number. The
     * number on the paper that is signed is the number this record must
     * carry, and a system that issued its own would quietly keep a second
     * series that disagrees with the office's.
     *
     * What CFMS does is refuse a DUPLICATE, by reserving the number in the
     * same transaction as the approval. Uniqueness is a database constraint,
     * not a check a race can slip past.
     *
     * A reservation belonging to THIS voucher is not a clash: it is what is
     * left behind when an approval is undone, so that nobody else can take
     * the number while the voucher is corrected.
     */
    const dvNo = String(dv.dvNo ?? '').trim();
    if (!dvNo) {
      throw invalid(
        'A disbursement voucher number is required. Assign it on the voucher from the accounting book before approving.',
      );
    }
    if (dvNo.length > 40) throw invalid('That voucher number is too long.');

    const dvReservationRef = db
      .collection(COL.documentNumbers)
      .doc(`DV__${dv.fiscalYear}__${dv.fundCode}__${dvNo.toUpperCase()}`);
    const dvReservationSnap = await tx.get(dvReservationRef);
    const dvReservedHere =
      dvReservationSnap.exists &&
      (dvReservationSnap.data() as { documentId?: string }).documentId === dvId;

    if (dvReservationSnap.exists && !dvReservedHere) {
      throw new HttpsError(
        'already-exists',
        `Disbursement voucher number ${dvNo} has already been used in ${dv.fiscalYear} for the ${dv.fundCode} fund on another voucher. Each number is used once.`,
      );
    }

    /*
     * ---- THE JEV NUMBER, DRAWN HERE -----------------------------------
     *
     * Approving a voucher now MAKES its journal entry rather than preparing
     * one, so the number is drawn here, in the read phase, before any write.
     *
     * It used to be left until the Accountant pressed Post, and the reasoning
     * was a series with no gaps: a number drawn for an entry that is never
     * posted is a number the office cannot account for. What happened in
     * practice was worse than a gap. Posting was a second act on a second
     * screen, and vouchers approved on a Friday sat unposted - so the General
     * Ledger lagged the vouchers by however long it took somebody to remember,
     * and every report drawn in between was short by the vouchers nobody had
     * got to.
     *
     * The gap the old rule guarded against is now covered by what replaced it:
     * taking back an approval REVERSES the posted entry rather than cancelling
     * an unposted one, so the number is not freed and not lost - it is spent
     * on an entry that exists, with its reversal beside it. That is a series an
     * auditor can read straight through.
     *
     * Drawn before any write, as the transaction ordering requires. This is
     * the only number this transaction issues: the voucher's own number is
     * typed by staff and reserved above, not issued from a series.
     */
    const jevCfg = await loadNumberingConfig('JEV');
    const jevBookCode = await bookCodeForFund(dv.fundCode);
    const [issuedJevNo] = await issueNumbers(tx, [
      {
        cfg: jevCfg,
        parts: {
          bookCode: jevBookCode,
          fundCode: dv.fundCode,
          fiscalYear: dv.fiscalYear,
          month: period,
        },
      },
    ]);
    const jevNo = issuedJevNo as string;

    // ---- WRITE PHASE --------------------------------------------------------

    const jevLines: JevLineData[] = dv.accountLines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      accountName: l.accountName,
      // Carried from the voucher line, which carried it from the obligation.
      // Not derived here from the obligation: a voucher may draw on an
      // obligation with several lines, and guessing which one this expense
      // belongs to would put the spending against the wrong budget line in the
      // one report built to compare them.
      fppCode: l.fppCode ?? null,
      fppName: l.fppName ?? null,
      debit: l.debit,
      credit: l.credit,
      officeId: l.officeId ?? dv.officeId,
      officeName: dv.officeName,
      responsibilityCenterId: l.responsibilityCenterId ?? null,
      subsidiaryType: l.subsidiaryType ?? null,
      subsidiaryId: l.subsidiaryId ?? null,
      subsidiaryName: l.subsidiaryName ?? null,
      cashFlowClass: 'OPERATING',
      particulars: l.particulars ?? dv.particulars,
    }));

    const jevData = {
      jevNo,
      jevDate: dv.dvDate,
      fiscalYear: dv.fiscalYear,
      period,
      fundCode: dv.fundCode,
      /*
       * The General Journal, whatever the voucher is eventually paid with.
       *
       * This entry recognises a liability - the expense is debited and Accounts
       * Payable credited - and no cash moves in it. The disbursement journals
       * are for the entries that credit cash, and those are raised from the
       * Treasurer's reports: the Check Disbursements Journal from the RCI, the
       * ADA Disbursements Journal from the RADAI.
       *
       * It used to be chosen from a payment method recorded on the voucher.
       * That put a payable in the Check Disbursements Journal on the strength
       * of a guess made in Accounting days before the Treasurer decided how to
       * pay it - and when the guess was wrong, the check register and the
       * journal that was supposed to agree with it did not.
       */
      book: 'GENERAL_JOURNAL',
      sourceType: 'DV',
      sourceId: dvId,
      referenceNo: dvNo,
      payeeId: dv.payeeId,
      payeeName: dv.payeeName,
      particulars: dv.particulars,
      lines: jevLines,
    } as const;

    const { jevId, totalDebit, totalCredit } = createJevInTransaction(tx, caller, jevData);

    /*
     * ---- AND POSTED, IN THE SAME ACT -------------------------------------
     *
     * Approving a voucher writes the books. Posting is no longer a second
     * button on a second screen that somebody has to remember.
     *
     * This does NOT make the voucher payable. The Treasurer sees it only once
     * somebody sends it over - see `awaitingTransferToTreasury` below. Writing
     * the entry and releasing the money are still two acts; what has been
     * joined is approving and recording, which were never two decisions.
     */
    postJevInTransaction(tx, caller, jevId, {
      ...jevData,
      totalDebit,
      totalCredit,
      status: 'DRAFT',
    });

    // Consume the obligation proportionally across its lines. Where a DV
    // partially draws an OBR, each line is reduced in the same proportion, so
    // the SAOB continues to show a coherent picture per account.
    if (obligation) {
      const obr = obligation;

      /** Trust Fund only: what this voucher pays per programme. */
      const trustShares = new Map<string, number>();

      // The same allocation cancelDv, unapproveDv and the nightly verifier
      // use - patch 120. It must be, or the shares given back differ from the
      // shares taken by a centavo and the budget line drifts.
      for (const { line, share } of allocateDvShares(obr.lines ?? [], obr.totalAmount, dv.grossAmount)) {
        if (obligationIsTrust) {
          const programId = String(line.trustProgramId ?? '').trim();
          if (programId) {
            trustShares.set(programId, (trustShares.get(programId) ?? 0) + share);
          }
          continue;
        }

        applyBudgetDelta(
          tx,
          obligationLineKey(obr, line),
          obligationBalances.get(line.lineNo)!,
          { disbursed: share },
          { officeName: line.officeName, accountName: line.accountName, expenseClass: line.expenseClass },
        );
      }

      /*
       * A trust voucher moves the programme and nothing in the budget.
       *
       * No budget balance and no budget summary: writing one would put trust
       * spending into the Statement of Comparison of Budget and Actual Amounts
       * against an appropriation that does not exist.
       */
      for (const [programId, share] of trustShares) {
        applyTrustDelta(tx, programId, trustPrograms.get(programId)!, { disbursed: share });
      }

      if (!obligationIsTrust) {
        applySummaryDelta(tx, dv.fiscalYear, dv.fundCode, { disbursed: dv.grossAmount });
      }

      const newDisbursed = (obr.disbursedAmount ?? 0) + dv.grossAmount;
      /*
       * WITH_DV, not PAID.
       *
       * Approving a voucher pays nobody. The money leaves when the Treasurer
       * draws the check or the bank debits the account, which is a day or a
       * week later - and until this was separated, the Budget Office's
       * registry showed obligations marked paid against which no check had
       * ever been drawn, and the unpaid obligations figure was understated by
       * every voucher sitting in Treasury's hands.
       *
       * issueCheck and issueAda carry it the rest of the way.
       */
      tx.update(db.collection(COL.obligations).doc(dv.obligationId!), {
        disbursedAmount: newDisbursed,
        unpaidAmount: obr.totalAmount - newDisbursed,
        status: newDisbursed >= obr.totalAmount ? 'WITH_DV' : 'OBLIGATED',
      });
    }

    const now = new Date().toISOString();

    if (!dvReservedHere) {
      tx.create(dvReservationRef, {
        docType: 'DV',
        number: dvNo,
        fiscalYear: dv.fiscalYear,
        fundCode: dv.fundCode,
        documentId: dvId,
        assignedBy: { uid: caller.uid, name: caller.name, at: now },
      });
    }

    tx.update(ref, {
      dvNo,
      status: 'APPROVED',
      /*
       * THE SUPPORTING PAPERS ARE FIXED HERE.
       *
       * Approving posts the entry to the General Ledger and says the officer
       * saw these documents and committed the municipality's money on them. A
       * scan that can be swapped or taken off the record afterwards is not
       * evidence of anything, and the approval would be attached to a file
       * nobody can prove was there.
       *
       * The same field the manual closing and certifyObligation write, so the
       * rule on /documents has one thing to consult. Not cleared by
       * unapproveDv: taking an approval back lets the FIGURES be corrected; it
       * does not unsee the papers.
       */
      attachmentsLockedAt: now,
      attachmentsLockedBy: {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: now,
      },

      /*
       * It stays with Accounting. The voucher is approved and in the books,
       * and the one thing left is a decision somebody in this office makes:
       * whether to send it over to be paid.
       */
      assignedToRole: 'MUNICIPAL_ACCOUNTANT',
      jevId,
      jevNo,
      jevPostedAt: now,
      /*
       * ---- NOT YET THE TREASURER'S ---------------------------------------
       *
       * Approval used to drop the voucher straight into Disbursements for
       * Payment. It no longer does: somebody presses Send to Treasury, and
       * until they do the voucher is approved, recorded, and nobody's to pay.
       *
       * Written as TRUE on approval rather than left absent, and that detail
       * matters for the vouchers already in the database. A voucher approved
       * before this patch has no such field at all, so it reads as falsy and
       * stays in the Treasurer's queue where it has been sitting - rather than
       * vanishing from it and leaving a supplier owed and invisible.
       */
      awaitingTransferToTreasury: true,
      approvedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });

    recordTransition(tx, {
      caller,
      event: 'APPROVE',
      entityType: COL.disbursementVouchers,
      entityId: dvId,
      entityRef: `DV ${dvNo}`,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      action: 'APPROVE',
      previousStatus: dv.status,
      newStatus: 'APPROVED',
      assignedToRole: 'MUNICIPAL_ACCOUNTANT',
      remarks: `Approved and posted to the General Ledger as JEV ${jevNo}. Not yet sent to Treasury.`,
    });

    return { dvId, dvNo, jevId, jevNo };
  });
});

/**
 * forwardDvToTreasury - hand an approved voucher over to be paid.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN ACT AND NOT A CONSEQUENCE
 * ---------------------------------------------------------------------------
 * Approval used to do two things at once: it recorded that the claim was
 * proper, and it put the voucher in front of the Treasurer to be paid. Those
 * read as one step and are not.
 *
 * A voucher can be perfectly proper and still not be one the municipality
 * wants paid this week - cash on hand, a supplier query, a document promised
 * and not yet produced, a batch somebody wants released together. Under the
 * old arrangement the only way to hold one back was to not approve it, which
 * meant the books waited on a cash decision and the Accountant's approval was
 * being used to say something it does not mean.
 *
 * So approving now records, and this releases. The Treasurer's queue shows
 * what Accounting has actually sent over, which is the question that queue is
 * supposed to answer.
 *
 * Accounting's own act, deliberately: the office that approved the claim is
 * the one that decides when it goes. The Treasurer decides HOW and WHEN to pay
 * what arrives - that half is unchanged.
 */
export const forwardDvToTreasury = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, APPROVING_ROLES);
    const { dvId, remarks } = (request.data ?? {}) as { dvId?: string; remarks?: string };
    if (!dvId) throw invalid('A disbursement voucher id is required.');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.disbursementVouchers).doc(dvId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The disbursement voucher');
      const dv = snap.data() as DvDoc & { awaitingTransferToTreasury?: boolean };

      if (dv.status !== 'APPROVED') {
        throw new HttpsError(
          'failed-precondition',
          `Only an approved voucher can be sent to Treasury. DV ${dv.dvNo ?? dvId} is ${dv.status.toLowerCase()}.`,
        );
      }
      if (!dv.awaitingTransferToTreasury) {
        throw new HttpsError(
          'failed-precondition',
          `DV ${dv.dvNo} is already with Treasury. It is in Disbursements for Payment there.`,
        );
      }

      assertFundInScope(caller, dv.fundCode);

      const now = new Date().toISOString();

      tx.update(ref, {
        awaitingTransferToTreasury: false,
        assignedToRole: 'MUNICIPAL_TREASURER',
        forwardedToTreasury: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      recordTransition(tx, {
        caller,
        event: 'APPROVE',
        entityType: COL.disbursementVouchers,
        entityId: dvId,
        entityRef: `DV ${dv.dvNo ?? dvId}`,
        fiscalYear: dv.fiscalYear,
        fundCode: dv.fundCode,
        action: 'FORWARD',
        previousStatus: 'APPROVED',
        newStatus: 'APPROVED',
        assignedToRole: 'MUNICIPAL_TREASURER',
        remarks: remarks?.trim()
          ? `Sent to Treasury for payment. ${remarks.trim()}`
          : 'Sent to Treasury for payment.',
      });

      notifyInTransaction(tx, {
        recipientRole: 'MUNICIPAL_TREASURER',
        kind: 'PENDING_REVIEW',
        title: 'Voucher for payment',
        body: `DV ${dv.dvNo} for ${dv.payeeName} has been sent over by Accounting.`,
        entityType: COL.disbursementVouchers,
        entityId: dvId,
        link: `/treasury/payments`,
      });

      return { dvId, dvNo: dv.dvNo ?? null };
    });
  },
);

export const cancelDv = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, APPROVING_ROLES);
  const { dvId, reason } = (request.data ?? {}) as { dvId?: string; reason?: string };
  if (!dvId) throw invalid('A disbursement voucher id is required.');
  if (!reason?.trim()) throw invalid('A reason for cancellation is required.');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.disbursementVouchers).doc(dvId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The disbursement voucher');
    const dv = snap.data() as DvDoc;

    if (dv.status === 'CANCELLED') {
      throw new HttpsError('failed-precondition', 'This voucher is already cancelled.');
    }

    // A voucher whose JEV is posted has already moved the books. Cancelling it
    // silently would leave the ledger asserting a payment the voucher denies.
    if (dv.jevId) {
      const jevSnap = await tx.get(db.collection(COL.jevs).doc(dv.jevId));
      if (jevSnap.exists && jevSnap.data()?.status === 'POSTED') {
        throw new HttpsError(
          'failed-precondition',
          `DV ${dv.dvNo} has already been posted to the General Ledger as JEV ${dv.jevNo}. Reverse the journal entry first; the reversal will release the obligation.`,
        );
      }
    }

    /*
     * Give the obligation back what an APPROVED voucher took.
     *
     * This was missing. Cancelling an approved voucher left the obligation
     * still showing the money as disbursed - so the balance could never be
     * drawn on again, the unpaid figure was wrong for the rest of the
     * obligation's life, and nothing anywhere said why. A replacement voucher
     * for the same expense would have been refused for want of a balance that
     * had never actually been spent.
     *
     * Read before any write, as always.
     */
    const consumed = dv.status === 'APPROVED' ? await readDvConsumption(tx, dv) : null;

    const now = new Date().toISOString();

    if (consumed) applyDvConsumption(tx, dv, consumed, -1);

    tx.update(ref, {
      status: 'CANCELLED',
      cancelledReason: reason.trim(),
      assignedToRole: null,
      cancelledBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });

    if (dv.jevId) {
      tx.update(db.collection(COL.jevs).doc(dv.jevId), {
        status: 'CANCELLED',
        cancelledReason: `Source voucher DV ${dv.dvNo} cancelled: ${reason.trim()}`,
      });
    }

    recordTransition(tx, {
      caller,
      event: 'CANCEL',
      entityType: COL.disbursementVouchers,
      entityId: dvId,
      entityRef: `DV ${dv.dvNo ?? dvId}`,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      action: 'CANCEL',
      previousStatus: dv.status,
      newStatus: 'CANCELLED',
      remarks: reason.trim(),
      severity: 'NOTICE',
    });

    return { dvId };
  });
});

/**
 * unapproveDv - the Municipal Accountant takes an approval back.
 *
 * ---------------------------------------------------------------------------
 * WHY, AND WHERE IT STOPS
 * ---------------------------------------------------------------------------
 * An Accountant who approves a voucher and then sees a wrong figure has had
 * one route: cancel it and encode the whole thing again, which is a heavy
 * price for a typo and so does not get paid. The voucher is left alone and
 * patched with a second one, and the Index of Payments fills with pairs nobody
 * can reconcile.
 *
 * So the approval can be taken back. The voucher returns to a draft, the
 * obligation gets its unpaid balance back, and the journal entry that was
 * prepared on it is cancelled.
 *
 * It stops at the point money is on its way out, which is the moment the
 * Treasurer draws a check or prepares an advice - and at the point the books
 * have been written, which is posting. Either one and the answer is no.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBER STAYS, THE JEV NUMBER DOES NOT
 * ---------------------------------------------------------------------------
 * The voucher keeps its number and its reservation, so nobody else can take it
 * while this one is corrected and re-approving walks back on to it.
 *
 * The JEV number is NOT kept. The entry is cancelled rather than deleted and
 * re-approval draws the next number, so the journal series carries a cancelled
 * entry where that number was. A number that simply vanished would be a hole
 * an auditor could not account for; a cancelled entry is a hole with its
 * reason attached.
 */
/** Just enough of a posted entry to reverse it. */
interface JevDocForReversal {
  jevNo: string;
  book: string;
  status: string;
  reversedByJevId?: string;
  lines: JevLineData[];
}

export const unapproveDv = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, APPROVING_ROLES);
    const { dvId, reason } = (request.data ?? {}) as { dvId?: string; reason?: string };
    if (!dvId) throw invalid('A disbursement voucher id is required.');
    if (!reason?.trim()) {
      throw invalid(
        'A reason is required. Taking back an approval reverses a control and is recorded as one.',
      );
    }

    return db.runTransaction(async (tx) => {
      // ---- READ PHASE -------------------------------------------------------
      const ref = db.collection(COL.disbursementVouchers).doc(dvId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The disbursement voucher');
      const dv = snap.data() as DvDoc;

      if (dv.status !== 'APPROVED') {
        throw new HttpsError(
          'failed-precondition',
          `Only an approved voucher can be unapproved. DV ${dv.dvNo ?? dvId} is ${dv.status.toLowerCase()}.`,
        );
      }
      if (dv.checkId || dv.adaId) {
        throw new HttpsError(
          'failed-precondition',
          `A ${dv.checkId ? 'check has been drawn' : 'advice has been prepared'} against DV ${dv.dvNo}, so the approval cannot be taken back. Undo the payment in Treasury first - the voucher then returns to Disbursements for Payment.`,
        );
      }

      /*
       * ---- THE ENTRY IS POSTED, AND THAT IS NOW THE NORMAL CASE ----------
       *
       * This used to refuse outright: "reverse the journal entry instead; an
       * approval cannot be taken back once the books are written." That was a
       * fair rule when approval only PREPARED the entry, so the posted case
       * was the unusual one. Approval now posts, so refusing would mean an
       * approval could never be taken back at all - a control removed by a
       * side effect of a different change, which is how controls quietly go
       * missing.
       *
       * So this does in one act what the Accountant would otherwise do in
       * three: it posts a reversing entry dated today, releases the obligation,
       * and puts the voucher back in the originating office's hands. The books
       * carry the entry AND its reversal, which is what actually happened and
       * what an auditor expects to be able to read.
       *
       * Nothing is deleted. The reversal is why the JEV number drawn at
       * approval is not a gap in the series.
       */
      let posted: JevDocForReversal | null = null;
      if (dv.jevId) {
        const jevSnap = await tx.get(db.collection(COL.jevs).doc(dv.jevId));
        if (jevSnap.exists) {
          const jev = jevSnap.data() as JevDocForReversal;
          if (jev.status === 'POSTED') {
            if (jev.reversedByJevId) {
              throw new HttpsError(
                'failed-precondition',
                `JEV ${dv.jevNo} has already been reversed. The approval cannot be taken back twice.`,
              );
            }
            posted = jev;
          }
        }
      }

      await assertFiscalYearOpen(dv.fiscalYear, tx);

      /*
       * The reversal is dated TODAY and must land in an open month. Dating it
       * back to the original would quietly reopen a month that has been
       * reported on; reopening one is a deliberate act, not a side effect of
       * taking back an approval.
       */
      const revDate = todayPh();
      const revPeriod = periodOf(revDate);
      const revYear = Number(revDate.slice(0, 4));
      let reversingNo: string | null = null;

      if (posted) {
        await assertFiscalYearOpen(revYear, tx);
        await assertPeriodOpen(
          revYear,
          revPeriod,
          dv.fundCode,
          `Reversal of JEV ${dv.jevNo}`,
          tx,
        );
        const cfg = await loadNumberingConfig('JEV');
        const bookCode = await bookCodeForFund(dv.fundCode);
        const [issued] = await issueNumbers(tx, [
          {
            cfg,
            parts: {
              bookCode,
              fundCode: dv.fundCode,
              fiscalYear: revYear,
              month: revPeriod,
            },
          },
        ]);
        reversingNo = issued as string;
      }

      const reversal = await readDvConsumption(tx, dv);

      // ---- WRITE PHASE ------------------------------------------------------
      applyDvConsumption(tx, dv, reversal, -1);

      let reversingJevId: string | null = null;

      if (posted && reversingNo) {
        const reversingLines = buildReversalLines(posted.lines);
        const reversingData = {
          jevNo: reversingNo,
          jevDate: revDate,
          fiscalYear: revYear,
          period: revPeriod,
          fundCode: dv.fundCode,
          book: posted.book,
          sourceType: 'REVERSING' as const,
          sourceId: dv.jevId!,
          referenceNo: posted.jevNo,
          payeeId: dv.payeeId ?? null,
          payeeName: dv.payeeName ?? null,
          particulars: `Reversal of JEV ${posted.jevNo} - approval of DV ${dv.dvNo} taken back. ${reason.trim()}`,
          lines: reversingLines,
        };

        const created = createJevInTransaction(tx, caller, reversingData);
        reversingJevId = created.jevId;

        postJevInTransaction(tx, caller, created.jevId, {
          ...reversingData,
          totalDebit: created.totalDebit,
          totalCredit: created.totalCredit,
          status: 'DRAFT',
        });

        // The original stays POSTED and points at what undid it. A reversed
        // entry is not a cancelled one: both are in the books.
        tx.update(db.collection(COL.jevs).doc(dv.jevId!), {
          reversedByJevId: created.jevId,
        });
      } else if (dv.jevId) {
        // An entry that never reached the ledger - a voucher approved before
        // patch 85, when approval only prepared the entry.
        tx.update(db.collection(COL.jevs).doc(dv.jevId), {
          status: 'CANCELLED',
          cancelledReason: `Approval of DV ${dv.dvNo} taken back: ${reason.trim()}`,
        });
      }

      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'DRAFT',
        assignedToRole: null,
        awaitingTransferToTreasury: false,
        forwardedToTreasury: null,
        // The approval is gone. The ENTRY is not: it was posted, and a posted
        // entry is reversed rather than erased. The voucher stops pointing at
        // it because a draft voucher has no entry - the entry and its reversal
        // are findable in the journal, under the voucher's own number.
        approvedBy: null,
        jevId: null,
        jevNo: null,
        jevPostedAt: null,
        unapprovedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
          reason: reason.trim(),
        },
      });

      recordTransition(tx, {
        caller,
        event: 'BUDGET_OVERRIDE',
        entityType: COL.disbursementVouchers,
        entityId: dvId,
        entityRef: `DV ${dv.dvNo ?? dvId}`,
        fiscalYear: dv.fiscalYear,
        fundCode: dv.fundCode,
        action: 'REOPEN',
        previousStatus: 'APPROVED',
        newStatus: 'DRAFT',
        remarks: `Approval taken back, ${(dv.grossAmount / 100).toFixed(2)} released back to ${
          dv.obrNo ? `OBR ${dv.obrNo}` : 'the obligation'
        }${
          reversingNo
            ? `. JEV ${dv.jevNo} reversed by JEV ${reversingNo}`
            : dv.jevNo
              ? `, JEV ${dv.jevNo} cancelled`
              : ''
        }. Reason: ${reason.trim()}`,
        severity: 'CRITICAL',
      });

      return {
        dvId,
        dvNo: dv.dvNo ?? null,
        reversedJevNo: reversingNo ? (dv.jevNo ?? null) : null,
        reversingJevNo: reversingNo,
        reversingJevId,
        cancelledJevNo: reversingNo ? null : (dv.jevNo ?? null),
      };
    });
  },
);

/**
 * What an approved voucher consumed, read in the read phase.
 *
 * Used by unapproveDv and by cancelDv. Those two were doing different things
 * to the same figures, and only one of them was right: cancelling an APPROVED
 * voucher left the obligation still showing the money as disbursed, so the
 * balance could never be drawn on again and nothing said why.
 */
async function readDvConsumption(
  tx: FirebaseFirestore.Transaction,
  dv: DvDoc,
): Promise<{
  obrSnap: FirebaseFirestore.DocumentSnapshot | null;
  trust: Map<string, TrustProgramData>;
  shares: Map<string, number>;
  /**
   * Every budget line the voucher's approval added to, with its stored
   * balance and the share it was given - read here so the write phase can
   * take exactly that share back. Empty for a trust voucher, which moved
   * programmes and no budget line.
   */
  budgetLines: Array<{
    key: BudgetKey;
    balance: Awaited<ReturnType<typeof readBudgetBalance>>;
    share: number;
    labels: { officeName: string; accountName: string; expenseClass: string };
  }>;
}> {
  const trust = new Map<string, TrustProgramData>();
  const shares = new Map<string, number>();
  const budgetLines: Awaited<ReturnType<typeof readDvConsumption>>['budgetLines'] = [];

  if (!dv.obligationId) return { obrSnap: null, trust, shares, budgetLines };

  const obrSnap = await tx.get(db.collection(COL.obligations).doc(dv.obligationId));
  if (!obrSnap.exists) return { obrSnap: null, trust, shares, budgetLines };

  const obr = obrSnap.data() as ObligationDoc;
  const isTrust = String(dv.fundCode ?? '').trim().toUpperCase() === 'TF';

  for (const { line, share } of allocateDvShares(obr.lines ?? [], obr.totalAmount, dv.grossAmount)) {
    if (isTrust) {
      const programId = String(line.trustProgramId ?? '').trim();
      if (programId) shares.set(programId, (shares.get(programId) ?? 0) + share);
      continue;
    }
    /*
     * This read was missing. Cancelling an approved voucher gave the money
     * back to the obligation and to the fund summary, and left the BUDGET
     * LINE still showing it disbursed. Cancel the obligation after that and
     * the registry read more disbursed than obligated - Neil's screenshot of
     * 09 Oct 2026: obligations 37,000.00, disbursements 51,000.00, unpaid
     * -14,000.00 on the Accountant's office supplies line.
     */
    const key = obligationLineKey(obr, line);
    budgetLines.push({
      key,
      balance: await readBudgetBalance(tx, key),
      share,
      labels: { officeName: line.officeName, accountName: line.accountName, expenseClass: line.expenseClass },
    });
  }

  for (const programId of shares.keys()) {
    trust.set(programId, await readTrustProgram(tx, programId));
  }

  return { obrSnap, trust, shares, budgetLines };
}

/** `sign` is -1 to give it all back, which is the only use today. */
function applyDvConsumption(
  tx: FirebaseFirestore.Transaction,
  dv: DvDoc,
  read: Awaited<ReturnType<typeof readDvConsumption>>,
  sign: 1 | -1,
): void {
  const { obrSnap, trust, shares, budgetLines } = read;
  if (!obrSnap?.exists) return;

  const obr = obrSnap.data() as ObligationDoc;
  const isTrust = String(dv.fundCode ?? '').trim().toUpperCase() === 'TF';

  for (const [programId, share] of shares) {
    applyTrustDelta(tx, programId, trust.get(programId)!, { disbursed: sign * share });
  }

  // The budget lines: the same shares approval added, with the sign turned.
  for (const { key, balance, share, labels } of budgetLines) {
    applyBudgetDelta(tx, key, balance, { disbursed: sign * share }, labels);
  }

  if (!isTrust) {
    applySummaryDelta(tx, dv.fiscalYear, dv.fundCode, { disbursed: sign * dv.grossAmount });
  }

  const newDisbursed = Math.max(0, (obr.disbursedAmount ?? 0) + sign * dv.grossAmount);
  tx.update(obrSnap.ref, {
    disbursedAmount: newDisbursed,
    unpaidAmount: obr.totalAmount - newDisbursed,
    status: newDisbursed >= obr.totalAmount ? 'WITH_DV' : 'OBLIGATED',
  });
}
