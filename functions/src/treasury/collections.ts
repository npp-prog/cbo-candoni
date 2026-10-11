import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { cashInBankLine, CASH_LOCAL_TREASURY } from '../lib/chartOfAccounts';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { assertFundInScope, requireCaller, notFound, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import {
  issueNumber,
  issueNumbers,
  loadNumberingConfig,
  bookCodeForFund,
  prepareDocumentNumber,
} from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import { createJevInTransaction, postJevInTransaction, type JevLineData } from '../lib/ledger';
import { TRUST_FUND_CODE } from '../lib/trustPrograms';
import {
  applyTrustDelta,
  readTrustProgram,
  type TrustProgramData,
} from '../accounting/trustPrograms';

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
/**
 * Refuses, rather than naming an account CFMS cannot name.
 *
 * Reached only when a bank account posts to a code that is in no chart and is
 * none of the accounts CFMS posts to by name. Posting it under an invented
 * title is the fault this whole path exists to avoid, and a deposit is not
 * urgent enough to be worth it.
 */
function unnamedBankAccount(code: string): never {
  throw new HttpsError(
    'failed-precondition',
    `This bank account says its General Ledger account is ${code}, and there is no account with that code. Correct it under Master Data > Banks, or add the account to the Chart of Accounts. The entry cannot name an account that does not exist.`,
  );
}

export const postRcd = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY_APPROVERS);
  const { rcdId } = (request.data ?? {}) as { rcdId?: string };
  if (!rcdId) throw invalid('An RCD id is required.');

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
    assertFundInScope(caller, rcd.fundCode); // patch 180

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
    // Patch 180: a receipt listed twice was counted twice.
    if (new Set(rcd.collectionIds).size !== rcd.collectionIds.length) {
      throw invalid('A receipt is listed twice on this RCD. Remove the repeated line.');
    }

    // Verify each collection: exists, right fund, not already in another RCD.
    let verifiedTotal = 0;
    /** Trust Fund only: what each programme received on this report. */
    const receivedByProgram = new Map<string, number>();
    /** Patch 180: what the receipts themselves credit, per account. */
    const byAccount = new Map<string, number>();
    let linesComplete = true;
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
        treasuryReportId?: string | null;
        lines?: Array<{ amount: number; accountCode?: string; trustProgramId?: string | null }>;
      };
      // Patch 180: a receipt already on a treasury-report RCD is booked there.
      if (c.treasuryReportId) {
        throw invalid(
          `Official Receipt ${c.orNumber} is already on a Report of Collections and Deposits under Collections and Deposits. A collection can only be reported once.`,
        );
      }
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
      for (const line of c.lines ?? []) {
        if (!line.accountCode) {
          linesComplete = false;
          continue;
        }
        byAccount.set(line.accountCode, (byAccount.get(line.accountCode) ?? 0) + (line.amount || 0));
      }
      if (!c.lines?.length) linesComplete = false;

      /*
       * The Trust Fund's Receipt side, worked rather than stated.
       *
       * Taken from the collection documents themselves, which this loop is
       * already reading to verify them - so it costs nothing, and more to the
       * point the figures come from the receipts rather than from a summary
       * the browser assembled. The programme a peso of trust money arrived
       * under is not something the client gets to assert.
       *
       * Only the Trust Fund has programmes. A link on a General Fund receipt
       * would be a mistake, and it is ignored rather than acted on.
       */
      if (rcd.fundCode === TRUST_FUND_CODE) {
        for (const line of c.lines ?? []) {
          const programId = line.trustProgramId;
          if (!programId) continue;
          receivedByProgram.set(programId, (receivedByProgram.get(programId) ?? 0) + line.amount);
        }
      }
    }

    if (verifiedTotal !== rcd.totalCollections) {
      throw invalid(
        `The collections listed total ${(verifiedTotal / 100).toFixed(2)} but the report states ${(rcd.totalCollections / 100).toFixed(2)}.`,
      );
    }

    /*
     * Patch 180: the revenue accounts credited are the receipts' own, not a
     * split the browser typed. Checked whenever every receipt carries its
     * account lines.
     */
    if (linesComplete) {
      const summary = new Map<string, number>();
      for (const a of rcd.accountSummary) {
        summary.set(a.accountCode, (summary.get(a.accountCode) ?? 0) + a.amount);
      }
      const codes = new Set([...summary.keys(), ...byAccount.keys()]);
      for (const code of codes) {
        if ((summary.get(code) ?? 0) !== (byAccount.get(code) ?? 0)) {
          throw invalid(
            `The account summary credits ${code} with ${((summary.get(code) ?? 0) / 100).toFixed(2)}, but the receipts on this RCD credit it with ${((byAccount.get(code) ?? 0) / 100).toFixed(2)}. Rebuild the RCD from the receipts.`,
          );
        }
      }
    }

    /*
     * Every read must come before any write, and issuing the RCD and JEV
     * numbers below writes to the counters - so the programmes are read here,
     * while reading is still allowed.
     */
    const trustPrograms = new Map<string, TrustProgramData>();
    for (const programId of receivedByProgram.keys()) {
      trustPrograms.set(programId, await readTrustProgram(tx, programId));
    }

    const bookCode = await bookCodeForFund(rcd.fundCode);
    const parts = {
      bookCode,
      fundCode: rcd.fundCode,
      fiscalYear: rcd.fiscalYear,
      month: period,
    };

    /*
     * The RCD number is the collecting officer's own, typed on the draft.
     * CFMS refuses a duplicate rather than issuing its own series beside the
     * office's. Read before the JEV counter is drawn, written after it: a
     * transaction does every read before any write (patch 135).
     */
    const rcdNumber = await prepareDocumentNumber(tx, {
      kind: 'RCD',
      fiscalYear: rcd.fiscalYear,
      fundCode: rcd.fundCode,
      number: rcd.rcdNo ?? '',
      documentId: rcdId,
      label: 'Report of Collections and Deposits',
    });

    const [issuedJevNo] = await issueNumbers(tx, [{ cfg: jevConfig, parts }]);
    const jevNo = issuedJevNo as string;
    rcdNumber.commit();
    const rcdNo = rcdNumber.number;

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

    /*
     * The Trust Fund's Receipt side. Written here, after every read, from the
     * figures this transaction took off the collection documents.
     *
     * Nothing else writes `receivedPosted`, and there is no path that takes it
     * back: an RCD has no cancellation, and a correction to posted collections
     * goes through a reversing journal voucher like any other. So this is the
     * sum of the receipts actually reported, which is what the registry wants.
     */
    for (const [programId, amount] of receivedByProgram) {
      applyTrustDelta(tx, programId, trustPrograms.get(programId)!, { receivedPosted: amount });
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
/** Patch 159: Deposits > Post is retired; the RCD books the deposit. */
const DEPOSITS_BOOKED_BY_RCD = true as boolean;

export const recordDeposit = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, TREASURY_APPROVERS);
  const { depositId } = (request.data ?? {}) as { depositId?: string };
  if (!depositId) throw invalid('A deposit id is required.');
  /*
   * Patch 159: every deposit is reported - and booked - by an RCD. Posting
   * one on its own would book it twice once its RCD is journalized.
   */
  if (DEPOSITS_BOOKED_BY_RCD) {
    throw new HttpsError(
      'failed-precondition',
      'A deposit is booked by the RCD that reports it. Prepare an RCD and tick this deposit under "Deposits to report"; its entry books Cash in Bank.',
    );
  }

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
    const bank = bankSnap.data() as {
      glAccountCode: string;
      fundCode: string;
      accountNumber: string;
      accountName?: string;
      bankName?: string;
    };

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
        /*
         * Named from the code, not written out here.
         *
         * This line carried the title "Cash in Bank - Local Currency, Current
         * Account" as a literal while taking the CODE from the bank account.
         * An office whose account posts to the savings code got a line reading
         * 10102020 under the current account's title - balanced, valid, and
         * naming the wrong account in every ledger entry it wrote.
         */
        ...(cashInBankLine({
          id: dep.bankAccountId,
          glAccountCode: bank.glAccountCode,
          accountName: bank.accountName,
          bankName: bank.bankName ?? dep.bankName,
          accountNumber: bank.accountNumber,
        }) ?? unnamedBankAccount(bank.glAccountCode)),
        debit: dep.amount,
        credit: 0,
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
