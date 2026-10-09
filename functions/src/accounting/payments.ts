import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, notFound, invalid, assertFundInScope, type Role } from '../lib/context';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import { createJevInTransaction, type JevLineData } from '../lib/ledger';
import { titleForAccountCode } from '../lib/accountTitles';
import { TRUST_LIABILITIES, cashInBankLine } from '../lib/chartOfAccounts';
import { proposeNotPostedEntry } from '../lib/treasuryEntry';
import { UNNUMBERED_JEV } from '../lib/jevNumbers';
import { clearingObjection, CLEARING_OVERRIDE_MIN_LENGTH } from '../lib/clearing';
import type { Transaction } from 'firebase-admin/firestore';
import { recordTransition, auditInTransaction, notifyInTransaction } from '../lib/audit';
import { issueNumbers, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { planPayments, applyPaymentPlan, type PaidDv } from '../lib/paymentBudget';

const TREASURY: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF', 'MUNICIPAL_ACCOUNTANT'];

/*
 * The obligation is paid - and the budget line, the fund summary and a trust
 * programme are DISBURSED - when the instrument is drawn, not when the
 * voucher was approved. Patch 121: a disbursement is a check or an ADA, and
 * cancelling the instrument takes the disbursement back. The arithmetic is
 * in lib/paymentBudget.ts, shared with the treasury import.
 */

/** The slice of a voucher the payment plan needs. */
function dvAsPaid(dv: PaidDv & { dvNo?: string }, dvId: string): PaidDv {
  return {
    dvNo: dv.dvNo ?? dvId,
    fiscalYear: dv.fiscalYear,
    fundCode: dv.fundCode,
    grossAmount: dv.grossAmount,
    obligationId: dv.obligationId ?? null,
  };
}

export const issueCheck = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY);
  const { dvId, bankAccountId, checkNo, checkDate, payeeAcknowledgement } = (request.data ?? {}) as {
    dvId?: string;
    bankAccountId?: string;
    checkNo?: string;
    checkDate?: string;
    /**
     * A written decision to draw a check the clearing house will refuse. It is
     * an escape hatch, not a formality: it is recorded as a critical audit
     * event against the check.
     */
    payeeAcknowledgement?: string;
  };

  if (!dvId || !bankAccountId || !checkNo?.trim() || !checkDate) {
    throw invalid('A voucher, bank account, check number and check date are all required.');
  }

  const normalisedCheckNo = checkNo.trim().toUpperCase();
  // Deterministic id: uniqueness of (bank account, check number) is a database
  // constraint, not an application check.
  const checkDocId = `${bankAccountId}__${normalisedCheckNo}`;

  return db.runTransaction(async (tx) => {
    const dvRef = db.collection(COL.disbursementVouchers).doc(dvId);
    const dvSnap = await tx.get(dvRef);
    if (!dvSnap.exists) throw notFound('The disbursement voucher');
    const dv = dvSnap.data() as {
      dvNo: string;
      dvDate: string;
      fiscalYear: number;
      fundCode: string;
      payeeId: string;
      payeeName: string;
      particulars: string;
      grossAmount: number;
      totalDeductions: number;
      netAmount: number;
      status: string;
      severalPayees?: boolean;
      checkId?: string;
      obligationId?: string;
      officeId?: string;
      officeName?: string;
      accountLines?: Array<{ accountCode: string; accountName: string; debit: number; credit: number }>;
    };

    if (dv.status !== 'APPROVED' && dv.status !== 'PAID') {
      throw new HttpsError(
        'failed-precondition',
        `A check can only be drawn against an approved voucher. DV ${dv.dvNo} is ${dv.status.toLowerCase()}.`,
      );
    }
    if (dv.checkId) {
      throw new HttpsError(
        'failed-precondition',
        `DV ${dv.dvNo} already has a check drawn against it. Cancel that check before issuing a replacement.`,
      );
    }

    // The clearing house refuses "CASH" and "and/or" payees outright. Caught
    // here, it costs a retype; caught by the bank, it costs three offices a
    // morning each, weeks later, with the RCI already certified.
    /*
     * Patch 138. A check is drawn to one payee. A voucher for several payees
     * ("Payee, et al.") is paid by ADA, which the bank splits into each
     * payee's own account.
     */
    if (dv.severalPayees) {
      throw new HttpsError(
        'failed-precondition',
        `DV ${dv.dvNo} is for several payees (${dv.payeeName}). A check pays one payee - pay it by ADA, which the bank credits to each payee's own account.`,
      );
    }

    const objection = clearingObjection(dv.payeeName);
    const acknowledgement = String(payeeAcknowledgement ?? '').trim();
    if (objection && acknowledgement.length < CLEARING_OVERRIDE_MIN_LENGTH) {
      throw new HttpsError(
        'failed-precondition',
        `The payee on DV ${dv.dvNo} is "${dv.payeeName}". ${objection.message} ` +
          'If the office has decided to draw it anyway, say so in writing and it will be ' +
          'recorded on the check.',
        { clearingObjection: objection.found, payeeName: dv.payeeName },
      );
    }

    const bankSnap = await tx.get(db.collection(COL.bankAccounts).doc(bankAccountId));
    if (!bankSnap.exists) throw notFound('The bank account');
    const bank = bankSnap.data() as {
      bankName: string;
      accountNumber: string;
      fundCode: string;
      active: boolean;
      glAccountCode?: string;
      accountName?: string;
    };

    if (bank.active === false) {
      throw new HttpsError('failed-precondition', 'That bank account is no longer active.');
    }
    if (bank.fundCode !== dv.fundCode) {
      throw new HttpsError(
        'failed-precondition',
        `DV ${dv.dvNo} is drawn on the ${dv.fundCode} fund but the selected bank account belongs to ${bank.fundCode}. Funds must not be commingled.`,
      );
    }
    if (!bank.glAccountCode) {
      // Without this the payment has no cash account to credit, and the JEV
      // cannot be built. Refusing here is far better than issuing a check whose
      // journal entry is missing a side.
      throw new HttpsError(
        'failed-precondition',
        `Bank account ${bank.bankName} ${bank.accountNumber} has no General Ledger account recorded against it. Set it under Master Data - Banks before drawing checks on this account.`,
      );
    }


    /*
     * The obligation, read here so it can be marked paid below.
     *
     * The money leaves the municipality when this check is drawn, not when the
     * voucher was approved - so this is where the obligation stops being
     * "With DV" and becomes paid. Read in the read phase, like everything
     * else the decision needs.
     */
    const payment = await planPayments(tx, [dvAsPaid(dv, dvId)], 1);

    const checkRef = db.collection(COL.checks).doc(checkDocId);
    const existing = await tx.get(checkRef);
    if (existing.exists) {
      const prior = existing.data() as { dvNo?: string; status?: string };
      throw new HttpsError(
        'already-exists',
        `Check number ${normalisedCheckNo} has already been issued on this bank account` +
          (prior.dvNo ? ` for DV ${prior.dvNo}` : '') +
          `. Check numbers must be unique within a bank account.`,
      );
    }

    tx.create(checkRef, {
      checkNo: normalisedCheckNo,
      checkDate,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      bankAccountId,
      bankName: bank.bankName,
      bankAccountNumber: bank.accountNumber,
      dvId,
      dvNo: dv.dvNo,
      payeeId: dv.payeeId,
      payeeName: dv.payeeName,
      particulars: dv.particulars,
      grossAmount: dv.grossAmount,
      totalDeductions: dv.totalDeductions,
      netAmount: dv.netAmount,
      // Kept on the check itself so the register can mark it, and so the
      // decision travels with the document rather than only with the log.
      clearingObjection: objection ? objection.found : null,
      clearingAcknowledgement: objection ? acknowledgement : null,
      status: 'PREPARED',
      createdBy: {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: new Date().toISOString(),
      },
    });

    /*
     * The voucher is PAID from here, and only from here.
     *
     * Drawing the instrument is the act that pays. Posting the journal entry
     * writes the books and used to set this status, which took the voucher out
     * of the Treasury payment queue before anybody had paid it.
     */
    tx.update(dvRef, {
      checkId: checkDocId,
      checkNo: normalisedCheckNo,
      bankAccountId,
      status: 'PAID',
    });

    if (objection) {
      // A decision this deliberate belongs in the audit trail at the level an
      // auditor filters on, not buried in the check's remarks.
      auditInTransaction(tx, {
        caller,
        event: 'CREATE',
        entityType: COL.checks,
        entityId: checkDocId,
        entityRef: `Check ${normalisedCheckNo}`,
        fiscalYear: dv.fiscalYear,
        fundCode: dv.fundCode,
        severity: 'CRITICAL',
        remarks:
          `Drawn to "${dv.payeeName}", which the clearing house refuses ` +
          `(${objection.found}). Reason given: ${acknowledgement}`,
      });
    }

    applyPaymentPlan(tx, payment);

    recordTransition(tx, {
      caller,
      event: 'CREATE',
      entityType: COL.checks,
      entityId: checkDocId,
      entityRef: `Check ${normalisedCheckNo}`,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      action: 'CREATE',
      newStatus: 'PREPARED',
      assignedToRole: 'MUNICIPAL_TREASURER',
      remarks: `Drawn against DV ${dv.dvNo} for ${dv.payeeName}, ${(dv.netAmount / 100).toFixed(2)}. Reported to Accounting on an RCI.`,
    });

    return { checkId: checkDocId, checkNo: normalisedCheckNo };
  });
});

/**
 * cancelCheck - a cancelled check that was already posted needs the books
 * corrected, so this refuses to act alone once the ledger has moved.
 */
/**
 * A cancelled payment must not already be sitting on a certified report.
 *
 * Once the Treasurer has certified the RCI or RADAI that covers this document,
 * the report is a signed statement forwarded to Accounting, and it may already
 * have been journalized. Quietly cancelling a document inside it would leave
 * the report footing to an amount that no longer exists, and the Check
 * Disbursements Journal disagreeing with the check register. So this refuses,
 * and says which report to withdraw first.
 */
async function assertNotReported(
  tx: Transaction,
  reportId: string | undefined,
  label: string,
): Promise<void> {
  if (!reportId) return;

  const snap = await tx.get(db.collection(COL.treasuryReports).doc(reportId));
  if (!snap.exists) return;

  const report = snap.data() as { reportType?: string; reportNo?: string; status?: string };
  if (report.status === 'CANCELLED') return;

  if (report.status === 'JOURNALIZED') {
    throw new HttpsError(
      'failed-precondition',
      `${label} has already been journalized as part of ${report.reportType} ${report.reportNo}. Reverse that report's journal entry first; the ledger has already reported this payment.`,
    );
  }

  throw new HttpsError(
    'failed-precondition',
    `${label} is covered by ${report.reportType} ${report.reportNo}, which the Treasurer has certified. Withdraw that report first, then cancel this document.`,
  );
}

export const cancelCheck = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY);
  const { checkId, reason } = (request.data ?? {}) as { checkId?: string; reason?: string };
  if (!checkId) throw invalid('A check id is required.');
  if (!reason?.trim()) throw invalid('A reason for cancelling the check is required.');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.checks).doc(checkId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The check');
    const check = snap.data() as {
      checkNo: string;
      status: string;
      dvId: string;
      dvNo: string;
      fiscalYear: number;
      fundCode: string;
      treasuryReportId?: string;
    };

    if (check.status === 'CANCELLED') {
      throw new HttpsError('failed-precondition', 'This check is already cancelled.');
    }
    if (check.status === 'CLEARED') {
      throw new HttpsError(
        'failed-precondition',
        `Check ${check.checkNo} has already cleared the bank and cannot be cancelled. If the payment was wrong, record the refund and an adjusting entry.`,
      );
    }

    // Read phase must finish before any write, so this comes before the
    // updates below even though it reads as part of the cancellation.
    await assertNotReported(tx, check.treasuryReportId, `Check ${check.checkNo}`);

    // The disbursement this check made, to be taken back below (patch 121).
    const dvSnap = await tx.get(db.collection(COL.disbursementVouchers).doc(check.dvId));
    const reversal = dvSnap.exists
      ? await planPayments(tx, [dvAsPaid(dvSnap.data() as PaidDv, check.dvId)], -1)
      : null;

    /**
     * A cancelled check stays on its draft report, at nil.
     *
     * The instinct is to take the line off, and it is the wrong one. The RCI
     * reports a run of check serials, and a serial that simply vanishes from
     * it is the one thing an auditor cannot let pass: it looks identical to a
     * check drawn and never reported. So the line is kept, marked excluded so
     * the report still foots, and the replacement check is added to the SAME
     * report - which is why the serial run has no hole in it.
     */
    let reportRef = null;
    let remainingLines: Array<{ sourceId: string; amount: number; excluded?: boolean }> = [];
    if (check.treasuryReportId) {
      const rSnap = await tx.get(db.collection(COL.treasuryReports).doc(check.treasuryReportId));
      if (rSnap.exists && (rSnap.data() as { status?: string }).status === 'DRAFT') {
        reportRef = rSnap.ref;
        remainingLines = ((rSnap.data()?.lines ?? []) as typeof remainingLines).map((l) =>
          l.sourceId === checkId ? { ...l, excluded: true } : l,
        );
      }
    }

    const now = new Date().toISOString();

    if (reportRef) {
      tx.update(reportRef, {
        lines: remainingLines,
        totalAmount: remainingLines.reduce((s, l) => (l.excluded ? s : s + l.amount), 0),
      });
    }
    tx.update(ref, {
      status: 'CANCELLED',
      cancelledReason: reason.trim(),
      cancelledBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });

    // Free the voucher so a replacement check can be drawn. It goes back to
    // APPROVED - unpaid and in the Treasurer's queue - because the check that
    // paid it has been cancelled. Leaving it PAID would hide it from the queue
    // with nothing having been paid.
    tx.update(db.collection(COL.disbursementVouchers).doc(check.dvId), {
      checkId: null,
      checkNo: null,
      status: 'APPROVED',
    });
    // And the registry, the fund summary and the obligation stop counting
    // it as disbursed. A cancelled check is not a disbursement.
    if (reversal) applyPaymentPlan(tx, reversal);

    recordTransition(tx, {
      caller,
      event: 'CANCEL',
      entityType: COL.checks,
      entityId: checkId,
      entityRef: `Check ${check.checkNo}`,
      fiscalYear: check.fiscalYear,
      fundCode: check.fundCode,
      action: 'CANCEL',
      previousStatus: check.status,
      newStatus: 'CANCELLED',
      remarks: reason.trim(),
      severity: 'NOTICE',
    });

    return { checkId };
  });
});

/** issueAda - Advice to Debit Account, the electronic counterpart of a check. */
export const issueAda = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY);
  const { dvId, bankAccountId, adaDate, reservationId } = (request.data ?? {}) as {
    dvId?: string;
    bankAccountId?: string;
    adaDate?: string;
    /**
     * A number reserved earlier, to be consumed instead of drawing a new one.
     * Without this the counter advances and the reserved number is left behind
     * as a hole nobody can explain.
     */
    reservationId?: string;
  };
  if (!dvId || !bankAccountId || !adaDate) {
    throw invalid('A voucher, bank account and ADA date are required.');
  }

  const adaConfig = await loadNumberingConfig('ADA');

  return db.runTransaction(async (tx) => {
    const dvRef = db.collection(COL.disbursementVouchers).doc(dvId);
    const dvSnap = await tx.get(dvRef);
    if (!dvSnap.exists) throw notFound('The disbursement voucher');
    const dv = dvSnap.data() as {
      dvNo: string;
      fiscalYear: number;
      fundCode: string;
      payeeId: string;
      payeeName: string;
      particulars: string;
      grossAmount: number;
      netAmount: number;
      status: string;
      severalPayees?: boolean;
      payees?: Array<{ payeeId: string; payeeName: string; accountNumber: string; amount: number }>;
      adaId?: string;
      obligationId?: string;
      officeId?: string;
      officeName?: string;
      accountLines?: Array<{ accountCode: string; accountName: string; debit: number; credit: number }>;
    };

    if (dv.status !== 'APPROVED' && dv.status !== 'PAID') {
      throw new HttpsError(
        'failed-precondition',
        `An ADA can only be prepared against an approved voucher. DV ${dv.dvNo} is ${dv.status.toLowerCase()}.`,
      );
    }
    if (dv.adaId) {
      throw new HttpsError('failed-precondition', `DV ${dv.dvNo} already has an ADA prepared.`);
    }

    const bankSnap = await tx.get(db.collection(COL.bankAccounts).doc(bankAccountId));
    if (!bankSnap.exists) throw notFound('The bank account');
    const bank = bankSnap.data() as {
      bankName: string;
      accountNumber: string;
      fundCode: string;
      glAccountCode?: string;
      accountName?: string;
    };

    if (bank.fundCode !== dv.fundCode) {
      throw new HttpsError(
        'failed-precondition',
        `DV ${dv.dvNo} is drawn on the ${dv.fundCode} fund but the selected bank account belongs to ${bank.fundCode}.`,
      );
    }
    if (!bank.glAccountCode) {
      throw new HttpsError(
        'failed-precondition',
        `Bank account ${bank.bankName} ${bank.accountNumber} has no General Ledger account recorded against it. Set it under Master Data - Banks before preparing an ADA on this account.`,
      );
    }

    // Read in the read phase: the obligation, budget lines and programmes
    // this advice disburses.
    const payment = await planPayments(tx, [dvAsPaid(dv, dvId)], 1);

    const bookCode = await bookCodeForFund(dv.fundCode);

    /**
     * Consume a reserved number where one was chosen, otherwise draw the next.
     *
     * The reservation was created by drawing from this same counter, so using
     * it here must NOT advance the counter again - doing so would leave the
     * reserved number issued and the next one skipped, which is precisely the
     * kind of hole this whole mechanism exists to prevent.
     */
    let reservedAdaNo: string | null = null;
    let reservationRef = null;
    if (reservationId) {
      reservationRef = db.collection(COL.adaNumbers).doc(String(reservationId));
      const rSnap = await tx.get(reservationRef);
      if (!rSnap.exists) throw notFound('That reserved ADA number');
      const r = rSnap.data() as { state: string; adaNo: string; fundCode: string };
      if (r.state !== 'RESERVED') {
        throw new HttpsError(
          'failed-precondition',
          `ADA ${r.adaNo} is ${r.state.toLowerCase()} and cannot be issued.`,
        );
      }
      if (r.fundCode !== dv.fundCode) {
        throw new HttpsError(
          'failed-precondition',
          `ADA ${r.adaNo} was reserved on the ${r.fundCode} fund, and DV ${dv.dvNo} is drawn on ${dv.fundCode}.`,
        );
      }
      reservedAdaNo = r.adaNo;
    }

    const adaParts = {
      bookCode,
      fundCode: dv.fundCode,
      fiscalYear: dv.fiscalYear,
      month: periodOf(adaDate),
    };

    /*
     * ONE number, not two.
     *
     * This drew a JEV number as well and then threw it away - nothing in this
     * function ever read it. Every ADA issued therefore burned a journal entry
     * number and left a hole in the series that nobody could account for.
     *
     * There is no journal entry here to number. An ADA moves no cash on its
     * own; the entry that credits the bank is raised from the Treasurer's
     * Report of ADA Issued, which is where the ADA Disbursements Journal comes
     * from. Drawing a number here was left over from an earlier design in
     * which it did.
     */
    const [issuedAdaNo] = await issueNumbers(tx, [
      // Skipped when a reserved number is being consumed: that number was
      // already drawn from this counter when it was reserved.
      { cfg: adaConfig, parts: adaParts, skip: Boolean(reservationId) },
    ]);

    const adaNo = reservedAdaNo ?? (issuedAdaNo as string);

    const adaRef = db.collection(COL.ada).doc();
    tx.create(adaRef, {
      adaNo,
      adaDate,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      bankAccountId,
      bankName: bank.bankName,
      bankAccountNumber: bank.accountNumber,
      dvId,
      dvNo: dv.dvNo,
      payeeId: dv.payeeId,
      payeeName: dv.payeeName,
      particulars: dv.particulars,
      amount: dv.netAmount,
      // Patch 138: the voucher's payees travel with the advice - the RADAI
      // clears the payable per payee and the bank file has a row each.
      ...(dv.severalPayees && dv.payees?.length
        ? {
            payees: dv.payees.map((p) => ({
              payeeId: p.payeeId,
              payeeName: p.payeeName,
              accountNumber: p.accountNumber,
              amount: p.amount,
            })),
          }
        : {}),
      status: 'PREPARED',
      createdBy: {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: new Date().toISOString(),
      },
    });

    // Paid, for the same reason as a check: the advice is the instrument.
    tx.update(dvRef, { adaId: adaRef.id, adaNo, bankAccountId, status: 'PAID' });

    if (reservationRef) {
      tx.update(reservationRef, {
        state: 'USED',
        usedByAdaId: adaRef.id,
        usedAt: new Date().toISOString(),
      });
    }

    applyPaymentPlan(tx, payment);

    recordTransition(tx, {
      caller,
      event: 'CREATE',
      entityType: COL.ada,
      entityId: adaRef.id,
      entityRef: `ADA ${adaNo}`,
      fiscalYear: dv.fiscalYear,
      fundCode: dv.fundCode,
      action: 'CREATE',
      newStatus: 'PREPARED',
      remarks: `Prepared against DV ${dv.dvNo}, ${(dv.netAmount / 100).toFixed(2)}. Reported to Accounting on a RADAI.`,
    });

    return { adaId: adaRef.id, adaNo };
  });
});

export const cancelAda = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY);
  const { adaId, reason } = (request.data ?? {}) as { adaId?: string; reason?: string };
  if (!adaId) throw invalid('An ADA id is required.');
  if (!reason?.trim()) throw invalid('A reason for cancelling the ADA is required.');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.ada).doc(adaId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The ADA');
    const ada = snap.data() as {
      adaNo: string;
      status: string;
      dvId: string;
      fiscalYear: number;
      fundCode: string;
      treasuryReportId?: string;
    };

    if (ada.status === 'DEBITED') {
      throw new HttpsError(
        'failed-precondition',
        `ADA ${ada.adaNo} has already been debited by the bank and cannot be cancelled. Record the refund and an adjusting entry instead.`,
      );
    }

    await assertNotReported(tx, ada.treasuryReportId, `ADA ${ada.adaNo}`);

    // The disbursement this advice made, to be taken back below (patch 121).
    const dvSnap = await tx.get(db.collection(COL.disbursementVouchers).doc(ada.dvId));
    const reversal = dvSnap.exists
      ? await planPayments(tx, [dvAsPaid(dvSnap.data() as PaidDv, ada.dvId)], -1)
      : null;

    const now = new Date().toISOString();
    tx.update(ref, {
      status: 'CANCELLED',
      cancelledReason: reason.trim(),
      cancelledBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });
    tx.update(db.collection(COL.disbursementVouchers).doc(ada.dvId), {
      adaId: null,
      adaNo: null,
      status: 'APPROVED',
    });
    if (reversal) applyPaymentPlan(tx, reversal);

    recordTransition(tx, {
      caller,
      event: 'CANCEL',
      entityType: COL.ada,
      entityId: adaId,
      entityRef: `ADA ${ada.adaNo}`,
      fiscalYear: ada.fiscalYear,
      fundCode: ada.fundCode,
      action: 'CANCEL',
      previousStatus: ada.status,
      newStatus: 'CANCELLED',
      remarks: reason.trim(),
      severity: 'NOTICE',
    });

    return { adaId };
  });
});

/**
 * postAdaOnline - patch 143. "Submit to bank" became "Posted online".
 *
 * The Treasury marks the advice posted once the bank's online posting is
 * done, and says which credits the bank did NOT post (an ATM account closed,
 * a wrong number). Every payee is listed - each one of a group advice, or the
 * single payee - and the ones left unticked are recorded on the advice.
 *
 * Those credits never left the bank account, and the municipality still owes
 * the payees - now as money held for them. So an ADJUSTING entry is raised as
 * a DRAFT journal entry for the Accountant to review and post:
 *
 *   Dr Cash in Bank (the advice's account)     total not posted
 *       Cr Trust Liabilities - <payee>         each payee's amount
 *
 * and each payee is repaid by a new voucher of the "Trust liability" kind.
 *
 * Every figure comes from the advice itself; the browser sends only WHICH
 * lines were not posted.
 */
export const postAdaOnline = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY);
  const { adaId, postedDate, bankReferenceNo, notPostedLineNos } = (request.data ?? {}) as {
    adaId?: string;
    postedDate?: string;
    bankReferenceNo?: string;
    notPostedLineNos?: number[];
  };
  if (!adaId) throw invalid('An ADA id is required.');
  if (!postedDate || !/^\d{4}-\d{2}-\d{2}$/.test(postedDate)) {
    throw invalid('The date the bank posted the advice is required.');
  }
  const unposted = new Set((notPostedLineNos ?? []).map((n) => Number(n)));

  // Titles are read before the transaction: they are reference data.
  const trustTitle = (await titleForAccountCode(TRUST_LIABILITIES.code)) ?? TRUST_LIABILITIES.name;

  return db.runTransaction(async (tx) => {
    // ---- READS ------------------------------------------------------------
    const ref = db.collection(COL.ada).doc(adaId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The ADA');
    const ada = snap.data() as {
      adaNo: string;
      status: string;
      fiscalYear: number;
      fundCode: string;
      bankAccountId: string;
      payeeId?: string;
      payeeName: string;
      amount: number;
      payees?: Array<{ lineNo: number; payeeId: string | null; payeeName: string; accountNumber: string; amount: number }>;
      treasuryReportId?: string;
      dvNo?: string;
    };
    assertFundInScope(caller, ada.fundCode);

    if (ada.status !== 'PREPARED') {
      throw new HttpsError(
        'failed-precondition',
        `ADA ${ada.adaNo} is ${ada.status.toLowerCase()} and cannot be marked posted online.`,
      );
    }
    if (!ada.treasuryReportId) {
      throw new HttpsError(
        'failed-precondition',
        `ADA ${ada.adaNo} is not on a certified Report of ADA Issued yet. Prepare the RADAI and have it certified first.`,
      );
    }

    const rows =
      ada.payees && ada.payees.length > 0
        ? ada.payees.map((p, i) => ({ ...p, lineNo: p.lineNo ?? i + 1 }))
        : [
            {
              lineNo: 1,
              payeeId: ada.payeeId ?? null,
              payeeName: ada.payeeName,
              accountNumber: '',
              amount: ada.amount,
            },
          ];
    for (const n of unposted) {
      if (!rows.some((r) => r.lineNo === n)) throw invalid(`ADA ${ada.adaNo} has no line ${n}.`);
    }
    const notPosted = rows.filter((r) => unposted.has(r.lineNo));
    const notPostedAmount = notPosted.reduce((t, r) => t + r.amount, 0);

    let cash: ReturnType<typeof cashInBankLine> = null;
    if (notPosted.length > 0) {
      const period = periodOf(postedDate);
      await assertFiscalYearOpen(ada.fiscalYear, tx);
      await assertPeriodOpen(ada.fiscalYear, period, ada.fundCode, `ADA ${ada.adaNo}`, tx);
      const bankSnap = await tx.get(db.collection(COL.bankAccounts).doc(ada.bankAccountId));
      if (!bankSnap.exists) throw notFound('The bank account of the advice');
      const bank = {
        ...(bankSnap.data() as {
          glAccountCode?: string;
          bankName?: string;
          accountNumber?: string;
          accountName?: string;
        }),
        id: bankSnap.id,
      };
      const glTitle = bank.glAccountCode ? await titleForAccountCode(bank.glAccountCode) : null;
      cash = cashInBankLine(bank, () => glTitle);
      if (!cash) {
        throw new HttpsError(
          'failed-precondition',
          `${bank.bankName ?? 'The bank account'} has no General Ledger account. Set it under Master Data > Banks; the adjusting entry needs it.`,
        );
      }
    }

    // ---- WRITES -----------------------------------------------------------
    const now = new Date().toISOString();
    const by = { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now };

    let notPostedJevId: string | null = null;
    if (notPosted.length > 0 && cash) {
      const proposed = proposeNotPostedEntry({
        adaNo: ada.adaNo,
        cash,
        trustLiability: { code: TRUST_LIABILITIES.code, name: trustTitle },
        credits: notPosted,
      });
      const lines: JevLineData[] = proposed.map((l, i) => ({
        lineNo: i + 1,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        subsidiaryType: l.subsidiaryType ?? null,
        subsidiaryId: l.subsidiaryId ?? null,
        subsidiaryName: l.subsidiaryName ?? null,
        cashFlowClass: 'OPERATING',
        particulars: l.particulars ?? null,
      }));
      const created = createJevInTransaction(tx, caller, {
        jevNo: UNNUMBERED_JEV,
        jevDate: postedDate,
        fiscalYear: ada.fiscalYear,
        period: periodOf(postedDate),
        fundCode: ada.fundCode,
        book: 'GENERAL_JOURNAL',
        sourceType: 'ADA',
        sourceId: adaId,
        referenceNo: ada.adaNo,
        payeeName: ada.payeeName,
        particulars: `To take up ADA ${ada.adaNo} credits not posted online by the bank as trust liabilities, to be repaid by a new voucher.`,
        lines,
      });
      notPostedJevId = created.jevId;

      notifyInTransaction(tx, {
        recipientRole: 'MUNICIPAL_ACCOUNTANT',
        kind: 'ADA_NOT_POSTED',
        title: `ADA ${ada.adaNo}: ${notPosted.length} credit${notPosted.length === 1 ? '' : 's'} not posted`,
        body: `${(notPostedAmount / 100).toFixed(2)} was not posted online by the bank. An adjusting entry to Trust Liabilities is waiting to be posted; repay by a new voucher of the Trust liability kind.`,
        entityType: COL.jevs,
        entityId: created.jevId,
        link: `/accounting/general-transactions/${created.jevId}`,
        severity: 'WARNING',
      });
    }

    tx.update(ref, {
      status: 'SUBMITTED',
      dateSubmittedToBank: postedDate,
      ...(bankReferenceNo?.trim() ? { bankReferenceNo: bankReferenceNo.trim() } : {}),
      notPosted,
      notPostedAmount,
      notPostedJevId,
      postedOnlineBy: by,
    });

    recordTransition(tx, {
      caller,
      event: 'SUBMIT',
      entityType: COL.ada,
      entityId: adaId,
      entityRef: `ADA ${ada.adaNo}`,
      fiscalYear: ada.fiscalYear,
      fundCode: ada.fundCode,
      action: 'SUBMIT',
      previousStatus: 'PREPARED',
      newStatus: 'SUBMITTED',
      remarks: notPosted.length
        ? `Posted online on ${postedDate}; ${notPosted.length} credit(s), ${(notPostedAmount / 100).toFixed(2)}, not posted - taken up as trust liabilities.`
        : `Posted online on ${postedDate}; every credit posted.`,
    });

    return { adaId, notPostedAmount, notPostedJevId };
  });
});
