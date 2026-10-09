import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, assertFundInScope, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertFiscalYearOpen, assertPeriodOpen } from '../lib/period';
import {
  createJevInTransaction,
  postJevInTransaction,
  buildReversalLines,
  type JevData,
  type JevLineData,
} from '../lib/ledger';
import { ACCOUNTS_PAYABLE } from '../lib/chartOfAccounts';
import { openingPayableVouchers, type OpeningPayableLine } from '../lib/openingPayables';

/**
 * Opening balances.
 *
 * A municipality does not start its books at zero. When CFMS takes over from
 * whatever came before, every account carries a balance, and those balances
 * have to get into the General Ledger somehow.
 *
 * The tempting way is to let someone type the figures onto the trial balance.
 * CFMS does not do that, and this file is where the alternative lives. Opening
 * balances enter as an ordinary **journal entry**, posted like any other, and
 * every figure on every later report is computed from the ledger as usual. The
 * reasons are worth stating plainly, because the shortcut looks harmless:
 *
 *   - A typed statement balance has no author, no date and no audit trail. A
 *     posted JEV has all three, and an auditor asking "where did this
 *     4,215,332.10 come from" gets an answer.
 *   - A typed balance can disagree with the ledger. A posted one cannot,
 *     because it *is* the ledger.
 *   - Corrections stay honest. A wrong opening figure is corrected by an
 *     adjusting entry that shows the correction, not by editing a number until
 *     the statement looks right.
 *
 * So the convenience the office needs - encoding a long list, or uploading it
 * from the spreadsheet the previous system produced - is provided. What is not
 * provided is a way for a balance to exist outside the ledger.
 *
 * Entered once per fiscal year and fund. A second attempt is refused and points
 * at the adjusting entry, because an opening balance that can be re-entered is
 * an opening balance that can be quietly changed after the fact.
 */

const ACCOUNTANT: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

interface OpeningLine {
  accountCode: string;
  accountName?: string;
  debit?: number;
  credit?: number;
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
  /**
   * The document behind this balance: the voucher still unpaid, the cash
   * advance not yet liquidated, the assessment not yet collected.
   */
  referenceNo?: string | null;
  /**
   * When this item arose. For a payable carried forward it is the date the
   * voucher was approved, not the date of conversion - that is what the aging
   * report needs, and it is the one fact the previous system holds that cannot
   * be reconstructed afterwards.
   */
  agingDate?: string | null;
  particulars?: string | null;
}

const SUBSIDIARY_TYPES = ['PAYEE', 'EMPLOYEE', 'OFFICE', 'PROJECT', 'BANK_ACCOUNT'];

export const postOpeningBalances = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ACCOUNTANT);
    const {
      fiscalYear,
      fundCode,
      asOfDate,
      lines: submitted,
      remarks,
    } = (request.data ?? {}) as {
      fiscalYear?: number;
      fundCode?: string;
      asOfDate?: string;
      lines?: OpeningLine[];
      remarks?: string;
    };

    if (!fiscalYear || !fundCode) throw invalid('A fiscal year and fund are required.');
    if (!asOfDate) throw invalid('The date the balances are as at is required.');
    if (!submitted?.length) throw invalid('No opening balances were supplied.');

    const jevConfig = await loadNumberingConfig('JEV');
    const bookCode = await bookCodeForFund(fundCode);

    return db.runTransaction(async (tx) => {
      await assertFiscalYearOpen(fiscalYear, tx);

      // --- once only -------------------------------------------------------
      //
      // The marker is a document whose id is derived from the year and fund, so
      // Firestore's create-if-absent semantics enforce the rule rather than a
      // read-then-write race.
      const markerRef = db
        .collection(COL.openingBalances)
        .doc(`${fiscalYear}__${fundCode}`);
      const marker = await tx.get(markerRef);
      if (marker.exists) {
        const prior = marker.data() as { jevNo?: string };
        throw new HttpsError(
          'already-exists',
          `Opening balances for ${fundCode} ${fiscalYear} have already been posted as JEV ${prior.jevNo ?? ''}. They are entered once. To correct a figure, record an adjusting entry under Accounting - Others, so the change is visible.`,
        );
      }

      // --- validate every account against the chart ------------------------

      const accountSnaps = await Promise.all(
        submitted.map((l) => tx.get(db.collection(COL.accounts).doc(l.accountCode))),
      );

      const lines: JevLineData[] = [];
      /** Patch 152: what each line was, for the payables carried forward. */
      const sources: OpeningPayableLine[] = [];
      let totalDebit = 0;
      let totalCredit = 0;

      for (let i = 0; i < submitted.length; i++) {
        const line = submitted[i];
        const snap = accountSnaps[i];
        const debit = Math.round(line.debit ?? 0);
        const credit = Math.round(line.credit ?? 0);

        if (debit === 0 && credit === 0) continue;

        if (!snap.exists) {
          throw invalid(
            `Account ${line.accountCode} is not in the Chart of Accounts. Add it first, or correct the code.`,
          );
        }
        const account = snap.data() as {
          name: string;
          postable?: boolean;
          active?: boolean;
          requiresSubsidiary?: boolean;
        };

        if (account.active === false) {
          throw invalid(`Account ${line.accountCode} ${account.name} is deactivated.`);
        }
        if (account.postable === false) {
          throw invalid(
            `Account ${line.accountCode} ${account.name} is a grouping account and cannot carry a balance. Use the accounts beneath it.`,
          );
        }
        if (debit < 0 || credit < 0) {
          throw invalid(
            `Account ${line.accountCode} carries a negative amount. Put it on the other side instead.`,
          );
        }
        if (debit > 0 && credit > 0) {
          throw invalid(
            `Account ${line.accountCode} carries both a debit and a credit. Use one side, or two lines.`,
          );
        }

        // ---- subsidiary detail on control accounts -------------------------
        //
        // A payable or a receivable carried forward is only useful if it names
        // the party. "Accounts Payable 4,215,332.10" tells the office nothing it
        // can act on; "Accounts Payable - Negros Hardware - DV 2025-08-0142 -
        // 41,200.00, outstanding since 14 August" is something a Treasurer can
        // settle and an auditor can test. The chart already marks which accounts
        // are controls; where it does, the party is required rather than
        // encouraged, because a balance encoded without one can never be split
        // apart later - the detail is gone.
        if (account.requiresSubsidiary === true && !line.subsidiaryName) {
          throw invalid(
            `Account ${line.accountCode} ${account.name} is a control account and needs the party each balance belongs to. Encode one line per payee, officer or debtor rather than one line for the account.`,
          );
        }
        if (line.subsidiaryType && !SUBSIDIARY_TYPES.includes(line.subsidiaryType)) {
          throw invalid(
            `Unknown subsidiary type "${line.subsidiaryType}" on account ${line.accountCode}.`,
          );
        }

        // The aging date may precede the conversion, and usually does, but a
        // balance that arose after the books were struck is a contradiction.
        const agingDate = line.agingDate?.trim() || null;
        if (agingDate) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(agingDate)) {
            throw invalid(
              `The date on account ${line.accountCode} is "${agingDate}". Dates are written as YYYY-MM-DD.`,
            );
          }
          if (agingDate > asOfDate) {
            throw invalid(
              `Account ${line.accountCode} carries a balance dated ${agingDate}, which is after the conversion date ${asOfDate}. An opening balance cannot arise after the books were opened.`,
            );
          }
        }

        totalDebit += debit;
        totalCredit += credit;

        lines.push({
          lineNo: lines.length + 1,
          accountCode: line.accountCode,
          accountName: account.name,
          debit,
          credit,
          officeId: null,
          officeName: null,
          responsibilityCenterId: null,
          subsidiaryType: line.subsidiaryType ?? null,
          subsidiaryId: line.subsidiaryId ?? null,
          subsidiaryName: line.subsidiaryName ?? null,
          cashFlowClass: 'OPERATING',
          agingDate,
          particulars:
            line.particulars ??
            [
              line.subsidiaryName,
              line.referenceNo,
              `outstanding as at ${asOfDate}`,
            ]
              .filter(Boolean)
              .join(' - '),
        });
        sources.push({
          accountCode: line.accountCode,
          accountName: account.name,
          credit,
          subsidiaryType: line.subsidiaryType ?? null,
          subsidiaryId: line.subsidiaryId ?? null,
          subsidiaryName: line.subsidiaryName ?? null,
          referenceNo: line.referenceNo ?? null,
          agingDate,
          particulars: line.particulars ?? null,
        });
      }

      if (!lines.length) throw invalid('Every line was blank.');

      if (totalDebit !== totalCredit) {
        const difference = totalDebit - totalCredit;
        throw invalid(
          `The opening balances do not balance. Debits ${(totalDebit / 100).toFixed(2)}, credits ${(totalCredit / 100).toFixed(2)}, out by ${(Math.abs(difference) / 100).toFixed(2)}. A trial balance that does not foot cannot be the opening position of a set of books.`,
        );
      }

      // --- post -------------------------------------------------------------

      const jevNo = await issueNumber(tx, jevConfig, {
        bookCode,
        fundCode,
        fiscalYear,
        month: 1,
      });

      const jevData: JevData = {
        jevNo,
        jevDate: asOfDate,
        fiscalYear,
        period: 1,
        fundCode,
        book: 'GENERAL_JOURNAL',
        sourceType: 'OPENING',
        sourceId: markerRef.id,
        referenceNo: `Opening ${fundCode} ${fiscalYear}`,
        particulars:
          remarks?.trim() ||
          `Opening balances of the ${fundCode} fund as at ${asOfDate}, on conversion to CFMS.`,
        lines,
        totalDebit,
        totalCredit,
        status: 'DRAFT',
      };

      const { jevId } = createJevInTransaction(tx, caller, jevData);
      postJevInTransaction(tx, caller, jevId, jevData);

      const now = new Date().toISOString();

      /*
       * Patch 152. Every Accounts Payable carried forward becomes an unpaid
       * voucher in Treasury's payment queue - see lib/openingPayables.ts. No
       * obligation and no expense lines: paying it settles the payable only.
       */
      const payables = openingPayableVouchers(sources, {
        payableAccountCode: ACCOUNTS_PAYABLE.code,
        fiscalYear,
        fundCode,
        asOfDate,
      });
      for (const v of payables) {
        tx.create(db.collection(COL.disbursementVouchers).doc(v.id), {
          dvNo: v.dvNo,
          dvDate: v.dvDate,
          fiscalYear,
          period: 1,
          fundCode,
          openingPayable: true,
          openingBalanceId: markerRef.id,
          // Patch 153: the liability it is carried on; only Accounts Payable
          // is an outstanding unpaid voucher. A payment of any other debits
          // that liability (the check / ADA carries it to the RCI / RADAI).
          outstandingUnpaid: v.outstandingUnpaid,
          ...(v.outstandingUnpaid
            ? {}
            : { payableAccountCode: v.accountCode, payableAccountName: v.accountName }),
          obligationId: null,
          obrNo: null,
          officeId: '',
          officeName: 'Carried forward',
          payeeId: v.payeeId,
          payeeName: v.payeeName,
          particulars: v.particulars,
          grossAmount: v.amount,
          deductions: [],
          totalDeductions: 0,
          netAmount: v.amount,
          accountLines: [],
          status: 'APPROVED',
          awaitingTransferToTreasury: false,
          jevId,
          jevNo,
          jevPostedAt: now,
          createdAt: now,
          createdBy: {
            uid: caller.uid,
            name: caller.name,
            position: caller.position ?? null,
            at: now,
          },
        });
      }

      tx.create(markerRef, {
        fiscalYear,
        fundCode,
        asOfDate,
        jevId,
        jevNo,
        lineCount: lines.length,
        totalDebit,
        totalCredit,
        payableVoucherIds: payables.map((v) => v.id),
        remarks: remarks?.trim() ?? null,
        postedAt: now,
        postedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      recordTransition(tx, {
        caller,
        event: 'POST',
        entityType: COL.openingBalances,
        entityId: markerRef.id,
        entityRef: `Opening balances ${fundCode} ${fiscalYear}`,
        fiscalYear,
        fundCode,
        action: 'POST',
        newStatus: 'POSTED',
        remarks: `${lines.length} accounts, ${(totalDebit / 100).toFixed(2)}. JEV ${jevNo}.`,
        severity: 'CRITICAL',
      });

      return {
        jevId,
        jevNo,
        lineCount: lines.length,
        total: totalDebit,
        payableVouchers: payables.length,
      };
    });
  },
);

/** Just enough of the posted opening entry to reverse it. */
interface OpeningJevForReversal {
  jevNo: string;
  book: string;
  status: string;
  period?: number;
  reversedByJevId?: string;
  lines: JevLineData[];
}

/**
 * ---------------------------------------------------------------------------
 * reopenOpeningBalances - the Accountant takes the opening position back.
 * ---------------------------------------------------------------------------
 *
 * Posting opening balances was deliberately a one-way door, and the reason it
 * was stands: an opening balance that can be re-entered is one that can be
 * quietly changed after the fact, and every figure in the books rests on it.
 *
 * But a one-way door with nothing behind it is not a control, it is a trap.
 * The realistic case is not fraud, it is the first week: a fund is converted,
 * a whole column turns out to have been read from the wrong trial balance, and
 * the office is told its only remedy is to adjust forty accounts one entry at
 * a time. Faced with that, offices do the other thing - they start keeping the
 * real opening position in a spreadsheet beside the system. A control that
 * pushes the books out of the books is worse than no control.
 *
 * So the door opens, under conditions that keep it honest:
 *
 *   THE ENTRY IS REVERSED, NEVER DELETED. The opening JEV stays posted and
 *   gains a reversing entry. Both are in the General Ledger afterwards, which
 *   is what actually happened. Nothing this function does removes a line an
 *   auditor has already seen.
 *
 *   THE REVERSAL IS DATED AS THE ORIGINAL, not today. This is the one place
 *   where the engine's usual rule - reverse into the current month, never
 *   backdate - gives the wrong answer, and it is worth saying why. An opening
 *   balance is not an event that happened on a date; it is the STATE OF THE
 *   BOOKS at conversion. Reversed into October, the original would still sit
 *   in period 1 and every trial balance from January to September would keep
 *   showing the figures now known to be wrong, while October carried a
 *   correction belonging to none of them. Reversed where it was raised, the
 *   two cancel exactly, and every month reads correctly once the corrected
 *   balances are posted.
 *
 *   WHICH MEANS THE MONTH MUST BE OPEN. Backdating into a closed period is
 *   the thing CFMS refuses everywhere else, and it is refused here too. If
 *   period 1 has been closed and reported on, the opening position has been
 *   relied upon by somebody outside this office, and the remedy is an
 *   adjusting entry in an open month - not a rewrite of a month that has been
 *   filed. The message says so rather than failing obscurely.
 *
 *   AND THE REASON IS KEPT. Recorded CRITICAL, with the figures that were
 *   taken back, because in a year's time the question will be why the books
 *   opened at one number and then another.
 *
 * Afterwards the marker is gone, so Opening Balances accepts a fresh set - the
 * same screen, the same validation, the same once-only rule from there on.
 */
export const reopenOpeningBalances = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ACCOUNTANT);
    const { fiscalYear: yearIn, fundCode: fundIn, reason } = (request.data ?? {}) as {
      fiscalYear?: number;
      fundCode?: string;
      reason?: string;
    };

    const fiscalYear = Number(yearIn);
    if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

    const fundCode = String(fundIn ?? '').trim();
    if (!fundCode) throw invalid('A fund is required.');

    const why = String(reason ?? '').trim();
    if (!why) {
      throw invalid(
        'A reason for re-opening the opening balances is required. Every balance in this ' +
          'fund is carried from them, so a change to them has to be answerable.',
      );
    }

    assertFundInScope(caller, fundCode);

    const jevConfig = await loadNumberingConfig('JEV');
    const bookCode = await bookCodeForFund(fundCode);

    return db.runTransaction(async (tx) => {
      // ---- READ PHASE ------------------------------------------------------
      const markerRef = db
        .collection(COL.openingBalances)
        .doc(`${fiscalYear}__${fundCode}`);
      const markerSnap = await tx.get(markerRef);

      if (!markerSnap.exists) {
        throw new HttpsError(
          'failed-precondition',
          `No opening balances have been posted for ${fundCode} ${fiscalYear}, so there is nothing to re-open. The screen is already accepting them.`,
        );
      }

      const marker = markerSnap.data() as {
        jevId?: string;
        jevNo?: string;
        asOfDate?: string;
        lineCount?: number;
        totalDebit?: number;
        postedBy?: { name?: string };
        postedAt?: string;
      };

      await assertFiscalYearOpen(fiscalYear, tx);

      /*
       * Patch 152. The unpaid vouchers the opening payables became. Re-opening
       * takes them away with the balances - unless one has been paid: a check
       * or an ADA drawn on it pays a payable that would no longer be in the
       * books. Then the payment is undone first (cancel the check or ADA).
       */
      const payableSnap = await tx.get(
        db.collection(COL.disbursementVouchers).where('openingBalanceId', '==', markerRef.id),
      );
      const paid = payableSnap.docs
        .map((d) => d.data() as { dvNo?: string; checkNo?: string; adaNo?: string; checkId?: string; adaId?: string })
        .filter((d) => d.checkId || d.adaId);
      if (paid.length > 0) {
        throw new HttpsError(
          'failed-precondition',
          `The payables carried forward have started to be paid: ${paid
            .map((d) => `DV ${d.dvNo ?? ''} by ${d.checkNo ? `check ${d.checkNo}` : `ADA ${d.adaNo ?? ''}`}`)
            .join('; ')}. Cancel ${paid.length === 1 ? 'that payment' : 'those payments'} before re-opening the opening balances.`,
        );
      }

      /*
       * The period the original was raised in. It is written on the entry; the
       * 1 is the fallback for the marker whose entry has gone missing, and
       * matches what postOpeningBalances writes.
       */
      let posted: OpeningJevForReversal | null = null;
      if (marker.jevId) {
        const jevSnap = await tx.get(db.collection(COL.jevs).doc(marker.jevId));
        if (jevSnap.exists) {
          const jev = jevSnap.data() as OpeningJevForReversal;
          if (jev.status === 'POSTED' && !jev.reversedByJevId) posted = jev;

          if (jev.status === 'POSTED' && jev.reversedByJevId) {
            /*
             * Already reversed, marker still standing. Nothing to reverse a
             * second time, and refusing would leave the office unable to post
             * a corrected set at all - stuck between a reversed entry and a
             * door that will not open. The marker is cleared and the audit
             * line says that is what happened.
             */
            posted = null;
          }
        }
      }

      const period = posted?.period ?? 1;

      let reversingNo: string | null = null;
      if (posted) {
        await assertPeriodOpen(
          fiscalYear,
          period,
          fundCode,
          `Reversal of the opening balances of ${fundCode} ${fiscalYear}`,
          tx,
        );
        reversingNo = await issueNumber(tx, jevConfig, {
          bookCode,
          fundCode,
          fiscalYear,
          month: period,
        });
      }

      // ---- WRITE PHASE -----------------------------------------------------
      let reversingJevId: string | null = null;
      let reversingJevNo: string | null = null;

      if (posted && reversingNo) {
        const reversingLines = buildReversalLines(posted.lines);
        const reversingData = {
          jevNo: reversingNo,
          jevDate: marker.asOfDate ?? `${fiscalYear}-01-01`,
          fiscalYear,
          period,
          fundCode,
          book: posted.book,
          sourceType: 'REVERSING' as const,
          sourceId: marker.jevId!,
          referenceNo: posted.jevNo,
          particulars:
            `Reversal of JEV ${posted.jevNo} - the opening balances of the ${fundCode} fund ` +
            `for ${fiscalYear} were re-opened. ${why}`,
          lines: reversingLines,
        };

        const created = createJevInTransaction(tx, caller, reversingData);
        reversingJevId = created.jevId;
        reversingJevNo = reversingNo;

        postJevInTransaction(tx, caller, created.jevId, {
          ...reversingData,
          totalDebit: created.totalDebit,
          totalCredit: created.totalCredit,
          status: 'DRAFT',
        });

        // The original stays POSTED and points at what undid it. A reversed
        // entry is not a cancelled one: both are in the books.
        tx.update(db.collection(COL.jevs).doc(marker.jevId!), {
          reversedByJevId: created.jevId,
        });
      }

      // Patch 152: the unpaid vouchers go with the balances they came from.
      for (const d of payableSnap.docs) tx.delete(d.ref);

      // The door. Everything above it is what makes opening it safe.
      tx.delete(markerRef);

      recordTransition(tx, {
        caller,
        event: 'POST',
        entityType: COL.openingBalances,
        entityId: markerRef.id,
        entityRef: `Opening balances ${fundCode} ${fiscalYear}`,
        fiscalYear,
        fundCode,
        action: 'REOPEN',
        previousStatus: 'POSTED',
        newStatus: 'DRAFT',
        severity: 'CRITICAL',
        remarks:
          `Re-opened for re-encoding. Posted by ${marker.postedBy?.name ?? 'an officer'} on ` +
          `${String(marker.postedAt ?? '').slice(0, 10)} as JEV ${marker.jevNo ?? '(none)'}, ` +
          `${marker.lineCount ?? 0} account${marker.lineCount === 1 ? '' : 's'}, ` +
          `${((marker.totalDebit ?? 0) / 100).toFixed(2)}. ` +
          (reversingJevNo
            ? `Reversed by JEV ${reversingJevNo} in period ${period}.`
            : 'The entry was already reversed; nothing further was posted.') +
          ` Reason: ${why}`,
      });

      return {
        fiscalYear,
        fundCode,
        reopened: true,
        reversedJevNo: marker.jevNo ?? null,
        reversingJevNo,
        reversingJevId,
      };
    });
  },
);
