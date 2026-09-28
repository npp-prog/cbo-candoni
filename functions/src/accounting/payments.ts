import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, notFound, invalid, type Role } from '../lib/context';
import { clearingObjection, CLEARING_OVERRIDE_MIN_LENGTH } from '../lib/clearing';
import type { Transaction } from 'firebase-admin/firestore';
import { recordTransition, auditInTransaction } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { periodOf } from '../lib/period';

const TREASURY: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF', 'MUNICIPAL_ACCOUNTANT'];

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
      checkId?: string;
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

    tx.update(dvRef, { checkId: checkDocId, checkNo: normalisedCheckNo, bankAccountId });

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

    // Free the voucher so a replacement check can be drawn.
    tx.update(db.collection(COL.disbursementVouchers).doc(check.dvId), {
      checkId: null,
      checkNo: null,
    });

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
  const adaJevConfig = await loadNumberingConfig('JEV');

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
      netAmount: number;
      status: string;
      adaId?: string;
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

    const bookCode = await bookCodeForFund(dv.fundCode);

    /**
     * Consume a reserved number where one was chosen, otherwise draw the next.
     *
     * The reservation was created by drawing from this same counter, so using
     * it here must NOT advance the counter again - doing so would leave the
     * reserved number issued and the next one skipped, which is precisely the
     * kind of hole this whole mechanism exists to prevent.
     */
    let adaNo: string;
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
      adaNo = r.adaNo;
    } else {
      adaNo = await issueNumber(tx, adaConfig, {
        bookCode,
        fundCode: dv.fundCode,
        fiscalYear: dv.fiscalYear,
        month: periodOf(adaDate),
      });
    }
    const adaJevNo = await issueNumber(tx, adaJevConfig, {
      bookCode,
      fundCode: dv.fundCode,
      fiscalYear: dv.fiscalYear,
      month: periodOf(adaDate),
    });

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
      status: 'PREPARED',
      createdBy: {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: new Date().toISOString(),
      },
    });

    tx.update(dvRef, { adaId: adaRef.id, adaNo, bankAccountId });

    if (reservationRef) {
      tx.update(reservationRef, {
        state: 'USED',
        usedByAdaId: adaRef.id,
        usedAt: new Date().toISOString(),
      });
    }

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

    const now = new Date().toISOString();
    tx.update(ref, {
      status: 'CANCELLED',
      cancelledReason: reason.trim(),
      cancelledBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });
    tx.update(db.collection(COL.disbursementVouchers).doc(ada.dvId), { adaId: null, adaNo: null });

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
