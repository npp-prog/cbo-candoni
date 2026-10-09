import { HttpsError } from 'firebase-functions/v2/https';
import { titleForAccountCode } from '../lib/accountTitles';
import { isLiquidatableAccount } from '../lib/chartOfAccounts';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, APPROVING_ROLES, notFound, invalid } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { hasJevNumber } from '../lib/jevNumbers';
import {
  issueNumbers,
  loadNumberingConfig,
  bookCodeForFund,
  prepareDocumentNumber,
} from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import { createJevInTransaction, postJevInTransaction, type JevData, type JevLineData } from '../lib/ledger';
import { checkLiquidation, outstandingAdvance } from '../lib/rules';

/**
 * postLiquidation - settles a cash advance against actual expenditure.
 *
 * The accounting shape is:
 *   Dr  the expense accounts actually incurred
 *   (no line for a refund - the Treasury posts it with its collections; patch 135)
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

  return db.runTransaction(async (tx) => {
    const ref = db.collection(COL.liquidations).doc(liquidationId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('The liquidation report');

    const liq = snap.data() as {
      liquidationNo?: string;
      /** Patch 137: drawn when the report was saved (numberLiquidationEntry). */
      jevNo?: string | null;
      liquidationDate: string;
      fiscalYear: number;
      fundCode: string;
      cashAdvanceId: string;
      advanceSource?: string;
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

    /*
     * THE ADVANCE. Patch 133: read off the General Ledger.
     *
     * The `cashAdvances` register this used to read was never written by
     * anything, so no liquidation could ever be posted. An advance is now the
     * ledger entry that granted it - a debit to an account the Chart of
     * Accounts marks "Advance subject to liquidation", naming the officer as
     * its subsidiary - and what it may be relieved of is the officer's balance
     * on that account in the General Ledger, read here, in the transaction,
     * not taken from the report. An old `cashAdvances` record is still honoured.
     */
    const caRef = db.collection(COL.cashAdvances).doc(liq.cashAdvanceId);
    const caSnap = liq.advanceSource === 'LEDGER' ? null : await tx.get(caRef);
    let ca: {
      dvNo: string;
      amountGranted: number;
      amountLiquidated: number;
      amountRefunded: number;
      glAccountCode: string;
      status: string;
    };
    let officer: { type: string; id: string | null; name: string } = {
      type: 'EMPLOYEE',
      id: liq.accountableOfficerId,
      name: liq.accountableOfficerName,
    };
    let fromLedger = false;
    if (caSnap?.exists) {
      ca = caSnap.data() as typeof ca;
    } else {
      const grantSnap = await tx.get(db.collection(COL.ledgerEntries).doc(liq.cashAdvanceId));
      if (!grantSnap.exists) {
        throw new HttpsError(
          'failed-precondition',
          'The advance this report liquidates is no longer in the General Ledger - its journal entry was corrected after the report was drafted. Raise the report again and choose the advance.',
        );
      }
      const g = grantSnap.data() as {
        fiscalYear: number;
        fundCode: string;
        accountCode: string;
        debit: number;
        jevNo: string;
        referenceNo?: string | null;
        subsidiaryType?: string | null;
        subsidiaryId?: string | null;
        subsidiaryName?: string | null;
      };
      if (g.fundCode !== liq.fundCode || g.fiscalYear !== liq.fiscalYear) {
        throw invalid('The advance is in another fund or fiscal year than this report.');
      }
      if (!(g.debit > 0)) throw invalid('That ledger entry did not grant an advance.');
      const acctSnap = await tx.get(db.collection(COL.accounts).doc(g.accountCode));
      const acct = acctSnap.exists
        ? (acctSnap.data() as { code?: string; name?: string; liquidatable?: boolean | null })
        : null;
      if (!isLiquidatableAccount({ code: g.accountCode, name: acct?.name ?? '', liquidatable: acct?.liquidatable })) {
        throw new HttpsError(
          'failed-precondition',
          `Account ${g.accountCode} is not marked "Advance subject to liquidation" in the Chart of Accounts, so nothing posted to it is liquidated.`,
        );
      }
      if (!g.subsidiaryId && !g.subsidiaryName) {
        throw new HttpsError(
          'failed-precondition',
          'The advance was posted with no accountable officer as its subsidiary, so there is nobody to liquidate it. Correct its journal entry first.',
        );
      }
      // The officer's balance on the account, this fiscal year, from the ledger.
      // By the officer's name (normalised) or the same subsidiary id - the
      // same rule as src/lib/advances.ts, so a refund the Treasury's RCD
      // credited to the advance by the officer's name is counted.
      const norm = (v: unknown) =>
        String(v ?? '')
          .trim()
          .toUpperCase()
          .replace(/\s+/g, ' ');
      const accountEntries = await tx.get(
        db
          .collection(COL.ledgerEntries)
          .where('fiscalYear', '==', g.fiscalYear)
          .where('fundCode', '==', g.fundCode)
          .where('accountCode', '==', g.accountCode),
      );
      const officerEntries = {
        docs: accountEntries.docs.filter(
          (d) =>
            (g.subsidiaryName && norm(d.get('subsidiaryName')) === norm(g.subsidiaryName)) ||
            (g.subsidiaryId && d.get('subsidiaryId') === g.subsidiaryId),
        ),
      };
      const balance = officerEntries.docs.reduce(
        (t, d) => t + Number(d.get('debit') ?? 0) - Number(d.get('credit') ?? 0),
        0,
      );
      ca = {
        dvNo: g.referenceNo || g.jevNo,
        amountGranted: balance,
        amountLiquidated: 0,
        amountRefunded: 0,
        glAccountCode: g.accountCode,
        status: 'OUTSTANDING',
      };
      officer = {
        type: g.subsidiaryType || 'EMPLOYEE',
        id: g.subsidiaryId ?? null,
        name: g.subsidiaryName ?? liq.accountableOfficerName,
      };
      fromLedger = true;
    }

    /*
     * The titles of the two accounts whose CODE comes from a record rather
     * than from this file. Read before any write, as the ordering requires.
     */
    const advanceTitle = await titleForAccountCode(ca.glAccountCode);
    if (!advanceTitle) {
      throw new HttpsError(
        'failed-precondition',
        `The cash advance posts to account ${ca.glAccountCode}, and there is no account with that code in the Chart of Accounts. The entry cannot name an account that does not exist.`,
      );
    }

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
    const parts = {
      bookCode,
      fundCode: liq.fundCode,
      fiscalYear: liq.fiscalYear,
      month: period,
    };

    /*
     * The liquidation report number is assigned by Accounting from its own
     * book and typed on the draft. CFMS refuses a duplicate.
     *
     * Read here, written after the JEV number is drawn. Patch 135: this used
     * to draw the JEV number (a counter write) and THEN read the reservation,
     * and Firestore refused every liquidation - "transactions require all
     * reads to be executed before all writes".
     */
    const liqNumber = await prepareDocumentNumber(tx, {
      kind: 'LIQ',
      fiscalYear: liq.fiscalYear,
      fundCode: liq.fundCode,
      number: liq.liquidationNo ?? '',
      documentId: liquidationId,
      label: 'Liquidation report',
    });

    /*
     * Patch 137 - Neil: "JEV at save." The number was drawn when the report
     * was saved and is used here as it stands. A report saved before patch
     * 137 has none, and draws one now as before.
     */
    const jevNo = hasJevNumber(liq.jevNo)
      ? String(liq.jevNo)
      : ((await issueNumbers(tx, [{ cfg: jevConfig, parts }]))[0] as string);
    liqNumber.commit();
    const liquidationNo = liqNumber.number;

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

    /*
     * NO LINE FOR A REFUND. Patch 135 - Neil: "Any refund should have no
     * accounting entry, since it will be reflected in the collections
     * submitted by the Treasury." The officer hands the cash to the
     * Treasury, which issues an Official Receipt for it; the RCD that
     * reports that receipt posts it. Posting it here as well would put the
     * same refund in the books twice. The report still records the refund,
     * and still counts it when checking the liquidation against the advance.
     */

    if ((liq.reimbursementAmount ?? 0) > 0) {
      lines.push({
        lineNo: lineNo++,
        accountCode: '20101020',
        accountName: 'Due to Officers and Employees',
        debit: 0,
        credit: liq.reimbursementAmount,
        subsidiaryType: officer.type,
        subsidiaryId: officer.id ?? undefined,
        subsidiaryName: officer.name,
        officeId: liq.officeId,
        officeName: liq.officeName,
        cashFlowClass: 'OPERATING',
        particulars: `Reimbursement due to ${liq.accountableOfficerName}`,
      });
    }

    // The refund is credited to the advance by the Treasury's collection, not here.
    const advanceSettled = computedLiquidated - (liq.reimbursementAmount ?? 0);

    lines.push({
      lineNo: lineNo++,
      accountCode: ca.glAccountCode,
      // The code comes from the cash advance; so must the title. An advance
      // posting to the payroll advance account was being labelled "Advances
      // to Officers and Employees" regardless.
      accountName: advanceTitle,
      debit: 0,
      credit: advanceSettled,
      // The SAME subsidiary the advance was granted under, so the officer's
      // balance on the account goes down - not a second officer of the same name.
      subsidiaryType: officer.type,
      subsidiaryId: officer.id ?? undefined,
      subsidiaryName: officer.name,
      officeId: liq.officeId,
      officeName: liq.officeName,
      cashFlowClass: 'OPERATING',
      particulars: `Liquidation of cash advance ${fromLedger ? 'granted by' : 'under DV'} ${ca.dvNo}`,
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

    if (!fromLedger) tx.update(caRef, {
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
      jevNo,
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

    return { liquidationId, jevId, jevNo, outstandingBalance: outstanding };
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


/**
 * numberLiquidationEntry - gives a saved liquidation report its JEV number.
 * Patch 137.
 *
 * Neil: "JEV at save." The report is saved in the browser (a draft the
 * security rules let the office write); this, called straight after, draws
 * the number from the JEV series in the engine - a browser never writes a
 * document counter - and stores it on the report. The entry itself is still
 * built and posted when the Accountant approves the report, under this
 * number. Called again for a report that already has one, it returns it.
 *
 * The cost, accepted: a report saved and then discarded leaves its number
 * unused in the series. The Approval history records the drawing.
 */
export const numberLiquidationEntry = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, [
      'SUPER_ADMIN',
      'MUNICIPAL_ACCOUNTANT',
      'ACCOUNTING_REVIEWER',
      'ACCOUNTING_ENCODER',
      'DEPARTMENT_USER',
    ]);
    const { liquidationId } = (request.data ?? {}) as { liquidationId?: string };
    if (!liquidationId) throw invalid('A liquidation id is required.');
    const jevConfig = await loadNumberingConfig('JEV');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.liquidations).doc(liquidationId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The liquidation report');
      const liq = snap.data() as {
        jevNo?: string | null;
        liquidationDate: string;
        liquidationNo?: string;
        fiscalYear: number;
        fundCode: string;
        status: string;
      };
      if (hasJevNumber(liq.jevNo)) return { liquidationId, jevNo: String(liq.jevNo) };
      if (!['DRAFT', 'RETURNED', 'SUBMITTED', 'REVIEWED'].includes(liq.status)) {
        throw new HttpsError(
          'failed-precondition',
          `This liquidation is ${liq.status.toLowerCase()}; its JEV number is given when it is posted.`,
        );
      }
      const bookCode = await bookCodeForFund(liq.fundCode);
      const [jevNo] = await issueNumbers(tx, [
        {
          cfg: jevConfig,
          parts: {
            bookCode,
            fundCode: liq.fundCode,
            fiscalYear: liq.fiscalYear,
            month: periodOf(liq.liquidationDate),
          },
        },
      ]);
      const now = new Date().toISOString();
      tx.update(ref, { jevNo, jevNoDrawnAt: now });
      recordTransition(tx, {
        caller,
        event: 'EDIT',
        entityType: COL.liquidations,
        entityId: liquidationId,
        entityRef: `Liquidation ${liq.liquidationNo ?? liquidationId}`,
        fiscalYear: liq.fiscalYear,
        fundCode: liq.fundCode,
        action: 'CREATE',
        previousStatus: liq.status,
        newStatus: liq.status,
        remarks: `JEV ${jevNo} given on saving; the entry is posted under it when the Accountant approves.`,
      });
      return { liquidationId, jevNo: jevNo as string };
    });
  },
);
