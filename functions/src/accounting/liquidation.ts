import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, APPROVING_ROLES, notFound, invalid } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import { createJevInTransaction, postJevInTransaction, type JevData, type JevLineData } from '../lib/ledger';
import { checkLiquidation, outstandingAdvance } from '../lib/rules';

/**
 * postLiquidation - settles a cash advance against actual expenditure.
 *
 * The accounting shape is:
 *   Dr  the expense accounts actually incurred
 *   Dr  Cash in Vault / Cash in Bank      (for any refund returned)
 *   Dr  Due to Officers and Employees     (for a reimbursement owed)
 *       Cr  Advances to Officers and Employees   (the cash advance account)
 *
 * The control that matters: the total applied against the advance may not
 * exceed the advance itself unless the excess is explicitly a reimbursement
 * claim - a separate payable to the officer, not a liquidation. Without that
 * distinction an over-liquidation silently creates a credit balance in the
 * advances account, which nobody notices until year end.
 */
export const postLiquidation = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, APPROVING_ROLES);
  const { liquidationId } = (request.data ?? {}) as { liquidationId?: string };
  if (!liquidationId) throw invalid('A liquidation id is required.');

  const jevConfig = await loadNumberingConfig('JEV');
  const liqConfig = await loadNumberingConfig('LIQ');

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.liquidations).doc(liquidationId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The liquidation report');

    const liq = snap.data() as {
      liquidationNo?: string;
      liquidationDate: string;
      fiscalYear: number;
      fundCode: string;
      cashAdvanceId: string;
      accountableOfficerId: string;
      accountableOfficerName: string;
      officeId: string;
      officeName: string;
      purpose: string;
      status: string;
      lines: Array<{ lineNo: number; accountCode: string; accountName: string; amount: number; particulars: string }>;
      amountLiquidated: number;
      refundAmount: number;
      reimbursementAmount: number;
    };

    if (!['SUBMITTED', 'REVIEWED', 'DRAFT'].includes(liq.status)) {
      throw new HttpsError(
        'failed-precondition',
        `This liquidation is ${liq.status.toLowerCase()} and cannot be posted.`,
      );
    }

    const caRef = db.collection(COL.cashAdvances).doc(liq.cashAdvanceId);
    const caSnap = await tx.get(caRef);
    if (!caSnap.exists) throw notFound('The cash advance');
    const ca = caSnap.data() as {
      dvNo: string;
      amountGranted: number;
      amountLiquidated: number;
      amountRefunded: number;
      glAccountCode: string;
      status: string;
    };

    const period = periodOf(liq.liquidationDate);
    await assertFiscalYearOpen(liq.fiscalYear, tx);
    await assertPeriodOpen(
      liq.fiscalYear,
      period,
      liq.fundCode,
      `Liquidation dated ${liq.liquidationDate}`,
      tx,
    );

    // Recompute from the lines; the stored total is not trusted.
    const computedLiquidated = liq.lines.reduce((s, l) => s + l.amount, 0);
    if (computedLiquidated !== liq.amountLiquidated) {
      throw invalid(
        `The liquidated amount of ${(liq.amountLiquidated / 100).toFixed(2)} does not match the sum of its lines, ${(computedLiquidated / 100).toFixed(2)}.`,
      );
    }

    const check = checkLiquidation({
      amountGranted: ca.amountGranted,
      previouslyLiquidated: ca.amountLiquidated ?? 0,
      previouslyRefunded: ca.amountRefunded ?? 0,
      amountLiquidated: computedLiquidated,
      refundAmount: liq.refundAmount ?? 0,
      reimbursementAmount: liq.reimbursementAmount ?? 0,
    });
    if (!check.ok) {
      throw new HttpsError('failed-precondition', check.violations[0].message, {
        violations: check.violations,
      });
    }

    const bookCode = await bookCodeForFund(liq.fundCode);
    const liquidationNo =
      liq.liquidationNo ??
      (await issueNumber(tx, liqConfig, {
        bookCode,
        fundCode: liq.fundCode,
        fiscalYear: liq.fiscalYear,
        month: period,
      }));
    const jevNo = await issueNumber(tx, jevConfig, {
      bookCode,
      fundCode: liq.fundCode,
      fiscalYear: liq.fiscalYear,
      month: period,
    });

    // ---- Build the entry ----------------------------------------------------

    const lines: JevLineData[] = [];
    let lineNo = 1;

    for (const l of liq.lines) {
      lines.push({
        lineNo: lineNo++,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: l.amount,
        credit: 0,
        officeId: liq.officeId,
        officeName: liq.officeName,
        cashFlowClass: 'OPERATING',
        particulars: l.particulars,
      });
    }

    if ((liq.refundAmount ?? 0) > 0) {
      lines.push({
        lineNo: lineNo++,
        accountCode: '10101010',
        accountName: 'Cash in Vault',
        debit: liq.refundAmount,
        credit: 0,
        officeId: liq.officeId,
        officeName: liq.officeName,
        cashFlowClass: 'OPERATING',
        particulars: `Refund of unexpended cash advance, ${liq.accountableOfficerName}`,
      });
    }

    if ((liq.reimbursementAmount ?? 0) > 0) {
      lines.push({
        lineNo: lineNo++,
        accountCode: '20101020',
        accountName: 'Due to Officers and Employees',
        debit: 0,
        credit: liq.reimbursementAmount,
        subsidiaryType: 'EMPLOYEE',
        subsidiaryId: liq.accountableOfficerId,
        subsidiaryName: liq.accountableOfficerName,
        officeId: liq.officeId,
        officeName: liq.officeName,
        cashFlowClass: 'OPERATING',
        particulars: `Reimbursement due to ${liq.accountableOfficerName}`,
      });
    }

    const advanceSettled =
      computedLiquidated + (liq.refundAmount ?? 0) - (liq.reimbursementAmount ?? 0);

    lines.push({
      lineNo: lineNo++,
      accountCode: ca.glAccountCode,
      accountName: 'Advances to Officers and Employees',
      debit: 0,
      credit: advanceSettled,
      subsidiaryType: 'EMPLOYEE',
      subsidiaryId: liq.accountableOfficerId,
      subsidiaryName: liq.accountableOfficerName,
      officeId: liq.officeId,
      officeName: liq.officeName,
      cashFlowClass: 'OPERATING',
      particulars: `Liquidation of cash advance under DV ${ca.dvNo}`,
    });

    const { jevId } = createJevInTransaction(tx, caller, {
      jevNo,
      jevDate: liq.liquidationDate,
      fiscalYear: liq.fiscalYear,
      period,
      fundCode: liq.fundCode,
      book: 'GENERAL_JOURNAL',
      sourceType: 'LIQUIDATION',
      sourceId: liquidationId,
      referenceNo: liquidationNo,
      payeeName: liq.accountableOfficerName,
      particulars: `Liquidation of cash advance: ${liq.purpose}`,
      lines,
    });

    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const jevData: JevData = {
      jevNo,
      jevDate: liq.liquidationDate,
      fiscalYear: liq.fiscalYear,
      period,
      fundCode: liq.fundCode,
      book: 'GENERAL_JOURNAL',
      sourceType: 'LIQUIDATION',
      sourceId: liquidationId,
      referenceNo: liquidationNo,
      particulars: `Liquidation of cash advance: ${liq.purpose}`,
      lines,
      totalDebit,
      totalCredit: totalDebit,
      status: 'DRAFT',
    };

    postJevInTransaction(tx, caller, jevId, jevData);

    const newLiquidated = (ca.amountLiquidated ?? 0) + computedLiquidated;
    const newRefunded = (ca.amountRefunded ?? 0) + (liq.refundAmount ?? 0);
    const outstanding = outstandingAdvance({
      amountGranted: ca.amountGranted,
      amountLiquidated: newLiquidated,
      amountRefunded: newRefunded,
    });

    tx.update(caRef, {
      amountLiquidated: newLiquidated,
      amountRefunded: newRefunded,
      outstandingBalance: outstanding,
      status:
        outstanding <= 0
          ? 'FULLY_LIQUIDATED'
          : newLiquidated > 0
            ? 'PARTIALLY_LIQUIDATED'
            : 'OUTSTANDING',
    });

    const now = new Date().toISOString();
    tx.update(ref, {
      liquidationNo,
      status: 'POSTED',
      jevId,
      outstandingBalance: outstanding,
      approvedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
    });

    recordTransition(tx, {
      caller,
      event: 'POST',
      entityType: COL.liquidations,
      entityId: liquidationId,
      entityRef: `Liquidation ${liquidationNo}`,
      fiscalYear: liq.fiscalYear,
      fundCode: liq.fundCode,
      action: 'POST',
      previousStatus: liq.status,
      newStatus: 'POSTED',
      remarks: `${liq.accountableOfficerName}: liquidated ${(computedLiquidated / 100).toFixed(2)}, outstanding ${(outstanding / 100).toFixed(2)}.`,
    });

    return { liquidationId, jevId, outstandingBalance: outstanding };
  });
});


/**
 * postPayroll was removed.
 *
 * A payroll used to raise its own journal entry - Dr Salaries and Wages, Cr the
 * deductions, Cr Due to Officers and Employees - and the cash that paid it was
 * *also* reported on a Report of Cash Disbursement, which raises a journal
 * entry of its own. The same salaries reached the General Ledger twice, and
 * nothing would have caught it: both entries balance.
 *
 * There is now one entry, raised by Accounting from the certified RCDisb. The
 * payroll record is a Treasury working document: it states the gross, the
 * deductions and the net, and it is what the RCDisb is built from. It posts
 * nothing by itself. See functions/src/treasury/reports.ts.
 */
