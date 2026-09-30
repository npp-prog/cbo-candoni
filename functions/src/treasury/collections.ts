import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { CASH_LOCAL_TREASURY } from '../lib/chartOfAccounts';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, notFound, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import { createJevInTransaction, postJevInTransaction, type JevLineData } from '../lib/ledger';

const TREASURY_APPROVERS: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'MUNICIPAL_ACCOUNTANT'];

/**
 * postRcd - recognises a day's collections in the books.
 *
 *   Dr  Cash - Collecting Officer          (total collected)
 *       Cr  the revenue accounts collected  (per account summary)
 *
 * The deposit is a separate later entry (Cash in Bank / Cash - Collecting
 * Officer), because collection and deposit are separate events and the gap
 * between them is exactly what the undeposited-collections control is for.
 *
 * Two things are verified rather than trusted: that the account summary sums to
 * the reported total, and that every collection listed actually exists, belongs
 * to this fund and has not already been reported in another RCD. Double-counted
 * collections are the classic way a cash shortage is concealed.
 */
export const postRcd = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY_APPROVERS);
  const { rcdId } = (request.data ?? {}) as { rcdId?: string };
  if (!rcdId) throw invalid('An RCD id is required.');

  const rcdConfig = await loadNumberingConfig('RCD');
  const jevConfig = await loadNumberingConfig('JEV');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.rcds).doc(rcdId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The report of collections and deposits');

    const rcd = snap.data() as {
      rcdNo?: string;
      rcdDate: string;
      fiscalYear: number;
      fundCode: string;
      collectingOfficerId: string;
      collectingOfficerName: string;
      collectionIds: string[];
      accountSummary: Array<{ accountCode: string; accountName: string; amount: number }>;
      totalCollections: number;
      status: string;
    };

    if (!['DRAFT', 'SUBMITTED', 'VERIFIED'].includes(rcd.status)) {
      throw new HttpsError('failed-precondition', `This RCD is ${rcd.status.toLowerCase()} and cannot be posted.`);
    }

    const period = periodOf(rcd.rcdDate);
    await assertFiscalYearOpen(rcd.fiscalYear, tx);
    await assertPeriodOpen(rcd.fiscalYear, period, rcd.fundCode, `RCD dated ${rcd.rcdDate}`, tx);

    const summaryTotal = rcd.accountSummary.reduce((s, a) => s + a.amount, 0);
    if (summaryTotal !== rcd.totalCollections) {
      throw invalid(
        `The account summary totals ${(summaryTotal / 100).toFixed(2)} but the report states ${(rcd.totalCollections / 100).toFixed(2)}.`,
      );
    }

    if (!rcd.collectionIds?.length) {
      throw invalid('The RCD lists no collections.');
    }

    // Verify each collection: exists, right fund, not already in another RCD.
    let verifiedTotal = 0;
    const collectionDocs = await Promise.all(
      rcd.collectionIds.map((id) => tx.get(db.collection(COL.collections).doc(id))),
    );

    for (let i = 0; i < collectionDocs.length; i++) {
      const cSnap = collectionDocs[i];
      if (!cSnap.exists) {
        throw invalid(`Collection ${rcd.collectionIds[i]} listed in this RCD no longer exists.`);
      }
      const c = cSnap.data() as {
        orNumber: string;
        fundCode: string;
        totalAmount: number;
        status: string;
        rcdId?: string;
      };
      if (c.status === 'CANCELLED') {
        throw invalid(`Official Receipt ${c.orNumber} has been cancelled and cannot be reported.`);
      }
      if (c.fundCode !== rcd.fundCode) {
        throw invalid(
          `Official Receipt ${c.orNumber} belongs to the ${c.fundCode} fund but this RCD covers ${rcd.fundCode}.`,
        );
      }
      if (c.rcdId && c.rcdId !== rcdId) {
        throw invalid(
          `Official Receipt ${c.orNumber} has already been reported in another RCD. A collection can only be reported once.`,
        );
      }
      verifiedTotal += c.totalAmount;
    }

    if (verifiedTotal !== rcd.totalCollections) {
      throw invalid(
        `The collections listed total ${(verifiedTotal / 100).toFixed(2)} but the report states ${(rcd.totalCollections / 100).toFixed(2)}.`,
      );
    }

    const bookCode = await bookCodeForFund(rcd.fundCode);
    const rcdNo =
      rcd.rcdNo ??
      (await issueNumber(tx, rcdConfig, {
        bookCode,
        fundCode: rcd.fundCode,
        fiscalYear: rcd.fiscalYear,
        month: period,
      }));
    const jevNo = await issueNumber(tx, jevConfig, {
      bookCode,
      fundCode: rcd.fundCode,
      fiscalYear: rcd.fiscalYear,
      month: period,
    });

    const lines: JevLineData[] = [
      {
        lineNo: 1,
        accountCode: CASH_LOCAL_TREASURY.code,
        accountName: CASH_LOCAL_TREASURY.name,
        debit: rcd.totalCollections,
        credit: 0,
        subsidiaryType: 'EMPLOYEE',
        subsidiaryId: rcd.collectingOfficerId,
        subsidiaryName: rcd.collectingOfficerName,
        cashFlowClass: 'OPERATING',
        particulars: `Collections per RCD ${rcdNo}`,
      },
      ...rcd.accountSummary.map((a, i) => ({
        lineNo: i + 2,
        accountCode: a.accountCode,
        accountName: a.accountName,
        debit: 0,
        credit: a.amount,
        cashFlowClass: 'OPERATING' as const,
        particulars: `Collections per RCD ${rcdNo}`,
      })),
    ];

    const { jevId } = createJevInTransaction(tx, caller, {
      jevNo,
      jevDate: rcd.rcdDate,
      fiscalYear: rcd.fiscalYear,
      period,
      fundCode: rcd.fundCode,
      book: 'CASH_RECEIPTS_JOURNAL',
      sourceType: 'RCD',
      sourceId: rcdId,
      referenceNo: rcdNo,
      particulars: `Collections of ${rcd.collectingOfficerName} per RCD ${rcdNo}`,
      lines,
    });

    postJevInTransaction(tx, caller, jevId, {
      jevNo,
      jevDate: rcd.rcdDate,
      fiscalYear: rcd.fiscalYear,
      period,
      fundCode: rcd.fundCode,
      book: 'CASH_RECEIPTS_JOURNAL',
      sourceType: 'RCD',
      sourceId: rcdId,
      referenceNo: rcdNo,
      particulars: `Collections per RCD ${rcdNo}`,
      lines,
      totalDebit: rcd.totalCollections,
      totalCredit: rcd.totalCollections,
      status: 'DRAFT',
    });

    for (const id of rcd.collectionIds) {
      tx.update(db.collection(COL.collections).doc(id), { rcdId, rcdNo, status: 'IN_RCD' });
    }

    tx.update(ref, { rcdNo, status: 'POSTED', jevId });

    recordTransition(tx, {
      caller,
      event: 'POST',
      entityType: COL.rcds,
      entityId: rcdId,
      entityRef: `RCD ${rcdNo}`,
      fiscalYear: rcd.fiscalYear,
      fundCode: rcd.fundCode,
      action: 'POST',
      previousStatus: rcd.status,
      newStatus: 'POSTED',
      remarks: `${rcd.collectionIds.length} receipts, ${(rcd.totalCollections / 100).toFixed(2)}.`,
    });

    return { rcdId, rcdNo, jevId };
  });
});

/**
 * recordDeposit - moves collected cash from the collecting officer to the bank.
 *
 *   Dr  Cash in Bank - Local Currency, Current Account
 *       Cr  Cash - Collecting Officers
 *
 * The deposit remains "in transit" until reconciliation matches it to a bank
 * credit. That intermediate state is what makes deposits-in-transit a real
 * figure on the reconciliation statement rather than a manual adjustment.
 */
export const recordDeposit = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY_APPROVERS);
  const { depositId } = (request.data ?? {}) as { depositId?: string };
  if (!depositId) throw invalid('A deposit id is required.');

  const jevConfig = await loadNumberingConfig('JEV');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.deposits).doc(depositId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The deposit');

    const dep = snap.data() as {
      depositDate: string;
      fiscalYear: number;
      fundCode: string;
      bankAccountId: string;
      bankName: string;
      depositSlipNo: string;
      amount: number;
      rcdId?: string;
      rcdNo?: string;
      collectingOfficerId?: string;
      collectingOfficerName?: string;
      status: string;
      jevId?: string;
    };

    if (dep.jevId) {
      throw new HttpsError('failed-precondition', 'This deposit has already been recorded in the books.');
    }
    if (dep.status === 'CANCELLED') {
      throw new HttpsError('failed-precondition', 'This deposit is cancelled.');
    }

    const period = periodOf(dep.depositDate);
    await assertFiscalYearOpen(dep.fiscalYear, tx);
    await assertPeriodOpen(dep.fiscalYear, period, dep.fundCode, `Deposit dated ${dep.depositDate}`, tx);

    const bankSnap = await tx.get(db.collection(COL.bankAccounts).doc(dep.bankAccountId));
    if (!bankSnap.exists) throw notFound('The bank account');
    const bank = bankSnap.data() as { glAccountCode: string; fundCode: string; accountNumber: string };

    if (bank.fundCode !== dep.fundCode) {
      throw invalid(
        `This deposit is for the ${dep.fundCode} fund but the bank account belongs to ${bank.fundCode}. Funds must not be commingled.`,
      );
    }

    const bookCode = await bookCodeForFund(dep.fundCode);
    const jevNo = await issueNumber(tx, jevConfig, {
      bookCode,
      fundCode: dep.fundCode,
      fiscalYear: dep.fiscalYear,
      month: period,
    });

    const lines: JevLineData[] = [
      {
        lineNo: 1,
        accountCode: bank.glAccountCode,
        accountName: 'Cash in Bank - Local Currency, Current Account',
        debit: dep.amount,
        credit: 0,
        subsidiaryType: 'BANK_ACCOUNT',
        subsidiaryId: dep.bankAccountId,
        subsidiaryName: `${dep.bankName} ${bank.accountNumber}`,
        cashFlowClass: 'OPERATING',
        particulars: `Deposit slip ${dep.depositSlipNo}`,
      },
      {
        lineNo: 2,
        accountCode: CASH_LOCAL_TREASURY.code,
        accountName: CASH_LOCAL_TREASURY.name,
        debit: 0,
        credit: dep.amount,
        subsidiaryType: 'EMPLOYEE',
        subsidiaryId: dep.collectingOfficerId ?? null,
        subsidiaryName: dep.collectingOfficerName ?? null,
        cashFlowClass: 'OPERATING',
        particulars: `Deposit of collections${dep.rcdNo ? ` per RCD ${dep.rcdNo}` : ''}`,
      },
    ];

    const { jevId } = createJevInTransaction(tx, caller, {
      jevNo,
      jevDate: dep.depositDate,
      fiscalYear: dep.fiscalYear,
      period,
      fundCode: dep.fundCode,
      book: 'CASH_RECEIPTS_JOURNAL',
      sourceType: 'RCD',
      sourceId: depositId,
      referenceNo: dep.depositSlipNo,
      particulars: `Deposit to ${dep.bankName}, slip ${dep.depositSlipNo}`,
      lines,
    });

    postJevInTransaction(tx, caller, jevId, {
      jevNo,
      jevDate: dep.depositDate,
      fiscalYear: dep.fiscalYear,
      period,
      fundCode: dep.fundCode,
      book: 'CASH_RECEIPTS_JOURNAL',
      sourceType: 'RCD',
      sourceId: depositId,
      referenceNo: dep.depositSlipNo,
      particulars: `Deposit to ${dep.bankName}`,
      lines,
      totalDebit: dep.amount,
      totalCredit: dep.amount,
      status: 'DRAFT',
    });

    tx.update(ref, { jevId, status: 'IN_TRANSIT' });

    if (dep.rcdId) {
      tx.update(db.collection(COL.rcds).doc(dep.rcdId), {
        depositIds: [depositId],
      });
    }

    recordTransition(tx, {
      caller,
      event: 'POST',
      entityType: COL.deposits,
      entityId: depositId,
      entityRef: `Deposit slip ${dep.depositSlipNo}`,
      fiscalYear: dep.fiscalYear,
      fundCode: dep.fundCode,
      action: 'POST',
      previousStatus: dep.status,
      newStatus: 'IN_TRANSIT',
      remarks: `${(dep.amount / 100).toFixed(2)} to ${dep.bankName}. In transit until matched on the bank statement.`,
    });

    return { depositId, jevId };
  });
});
