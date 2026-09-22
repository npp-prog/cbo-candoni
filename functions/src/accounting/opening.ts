import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertFiscalYearOpen } from '../lib/period';
import {
  createJevInTransaction,
  postJevInTransaction,
  type JevData,
  type JevLineData,
} from '../lib/ledger';

/**
 * Opening balances.
 *
 * A municipality does not start its books at zero. When CBO takes over from
 * whatever came before, every account carries a balance, and those balances
 * have to get into the General Ledger somehow.
 *
 * The tempting way is to let someone type the figures onto the trial balance.
 * CBO does not do that, and this file is where the alternative lives. Opening
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
  particulars?: string | null;
}

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
        const account = snap.data() as { name: string; postable?: boolean; active?: boolean };

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
          particulars: line.particulars ?? `Opening balance as at ${asOfDate}`,
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
          `Opening balances of the ${fundCode} fund as at ${asOfDate}, on conversion to CBO.`,
        lines,
        totalDebit,
        totalCredit,
        status: 'DRAFT',
      };

      const { jevId } = createJevInTransaction(tx, caller, jevData);
      postJevInTransaction(tx, caller, jevId, jevData);

      const now = new Date().toISOString();

      tx.create(markerRef, {
        fiscalYear,
        fundCode,
        asOfDate,
        jevId,
        jevNo,
        lineCount: lines.length,
        totalDebit,
        totalCredit,
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

      return { jevId, jevNo, lineCount: lines.length, total: totalDebit };
    });
  },
);
