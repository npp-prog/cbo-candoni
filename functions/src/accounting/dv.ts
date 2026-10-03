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
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import { readBudgetBalance, applyBudgetDelta, applySummaryDelta, type BudgetKey } from '../lib/budget';
import { checkDvCategory, checkDvMath } from '../lib/rules';
import { createJevInTransaction, type JevLineData } from '../lib/ledger';
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

  const numberingConfig = await loadNumberingConfig('DV');
  const jevConfig = await loadNumberingConfig('JEV');

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
        const key: BudgetKey = {
          fiscalYear: line.fiscalYear ?? obligation.fiscalYear,
          fundCode: line.fundCode ?? obligation.fundCode,
          officeId: line.officeId,
          responsibilityCenterId: line.responsibilityCenterId ?? null,
          programId: line.programId ?? null,
          projectId: line.projectId ?? null,
          activityId: line.activityId ?? null,
          fppCode: line.fppCode,
          // The object code the APPROPRIATION carried, which is empty on a
          // project line - never the object this line commits. On a third of
          // the FY2025 ordinance those differ, and keying on the wrong one
          // would look for a balance that does not exist.
          accountCode: line.appropriatedAccountCode ?? '',
        };
        obligationBalances.set(line.lineNo, await readBudgetBalance(tx, key));
      }

      if (obligationIsTrust) {
        for (const line of obligation.lines ?? []) {
          const programId = String(line.trustProgramId ?? '').trim();
          if (!programId || trustPrograms.has(programId)) continue;
          trustPrograms.set(programId, await readTrustProgram(tx, programId));
        }
      }
    }

    const bookCode = await bookCodeForFund(dv.fundCode);
    const dvNo =
      dv.dvNo ??
      (await issueNumber(tx, numberingConfig, {
        bookCode,
        fundCode: dv.fundCode,
        fiscalYear: dv.fiscalYear,
        month: period,
      }));

    const jevNo = await issueNumber(tx, jevConfig, {
      bookCode,
      fundCode: dv.fundCode,
      fiscalYear: dv.fiscalYear,
      month: period,
    });

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

    const { jevId } = createJevInTransaction(tx, caller, {
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
    });

    // Consume the obligation proportionally across its lines. Where a DV
    // partially draws an OBR, each line is reduced in the same proportion, so
    // the SAOB continues to show a coherent picture per account.
    if (obligation) {
      const obr = obligation;
      const obrTotal = obr.totalAmount || 1;
      let allocated = 0;
      const lines = obr.lines ?? [];

      /** Trust Fund only: what this voucher pays per programme. */
      const trustShares = new Map<string, number>();

      lines.forEach((line, idx) => {
        const isLast = idx === lines.length - 1;
        // The last line absorbs the rounding remainder so the allocation sums
        // exactly to the voucher amount.
        const share = isLast
          ? dv.grossAmount - allocated
          : Math.round((line.amount / obrTotal) * dv.grossAmount);
        allocated += share;

        if (obligationIsTrust) {
          const programId = String(line.trustProgramId ?? '').trim();
          if (programId) {
            trustShares.set(programId, (trustShares.get(programId) ?? 0) + share);
          }
          return;
        }

        const key: BudgetKey = {
          fiscalYear: line.fiscalYear ?? obr.fiscalYear,
          fundCode: line.fundCode ?? obr.fundCode,
          officeId: line.officeId,
          responsibilityCenterId: line.responsibilityCenterId ?? null,
          programId: line.programId ?? null,
          projectId: line.projectId ?? null,
          activityId: line.activityId ?? null,
          fppCode: line.fppCode,
          // The object code the APPROPRIATION carried, which is empty on a
          // project line - never the object this line commits. On a third of
          // the FY2025 ordinance those differ, and keying on the wrong one
          // would look for a balance that does not exist.
          accountCode: line.appropriatedAccountCode ?? '',
        };

        applyBudgetDelta(
          tx,
          key,
          obligationBalances.get(line.lineNo)!,
          { disbursed: share },
          { officeName: line.officeName, accountName: line.accountName, expenseClass: line.expenseClass },
        );
      });

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
      tx.update(db.collection(COL.obligations).doc(dv.obligationId!), {
        disbursedAmount: newDisbursed,
        unpaidAmount: obr.totalAmount - newDisbursed,
        status: newDisbursed >= obr.totalAmount ? 'PAID' : 'OBLIGATED',
      });
    }

    const now = new Date().toISOString();
    tx.update(ref, {
      dvNo,
      status: 'APPROVED',
      assignedToRole: 'MUNICIPAL_TREASURER',
      jevId,
      jevNo,
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
      assignedToRole: 'MUNICIPAL_TREASURER',
      remarks: `Approved for payment. JEV ${jevNo} prepared for posting.`,
    });

    notifyInTransaction(tx, {
      recipientRole: 'MUNICIPAL_ACCOUNTANT',
      kind: 'PENDING_REVIEW',
      title: 'Journal entry awaiting posting',
      body: `JEV ${jevNo} was generated from DV ${dvNo} and is ready to post.`,
      entityType: COL.jevs,
      entityId: jevId,
      link: `/accounting/jev/${jevId}`,
    });

    return { dvId, dvNo, jevId, jevNo };
  });
});

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

    const now = new Date().toISOString();
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
