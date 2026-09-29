import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertFiscalYearOpen } from '../lib/period';
import {
  readBudgetBalance,
  applyBudgetDelta,
  applySummaryDelta,
  budgetKeyId,
  type BudgetKey,
  type BudgetBalanceData,
} from '../lib/budget';
import { checkAllotmentAgainstAppropriation } from '../lib/rules';

/**
 * issueAro — the Allotment Release Order.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 4 of Part II, Step
 * 1: LBE Form No. 1 for Personal Services, 1A for MOOE, 1B for Financial
 * Expenses, 1C for Capital Outlay. Recommended by the Local Budget Officer,
 * approved by the Local Chief Executive.
 *
 * ---------------------------------------------------------------------------
 * ONE EXPENSE CLASS PER ORDER, BECAUSE THE MANUAL HAS FOUR FORMS
 * ---------------------------------------------------------------------------
 * There is no single ARO form. There are four, one per expense class, each
 * released on its own schedule - PS comprehensively or quarterly, Capital
 * Outlay on the basis of the work programme and the ranking of projects in the
 * approved AIP. An order spanning two classes could not be printed onto any of
 * the four, and it would hide the fact that two different release decisions
 * had been made at once.
 *
 * ---------------------------------------------------------------------------
 * FOR LATER RELEASE IS THE POINT OF THIS FUNCTION
 * ---------------------------------------------------------------------------
 * The manual's column 5. It exists "to provide safeguards for shortfalls in
 * the collection of revenues": the Budget Officer releases part of an
 * appropriation and deliberately withholds the rest.
 *
 * Until now CBO could not tell a withheld appropriation from a fully released
 * one - a department reading its available balance would see authority the
 * Budget Officer had decided it could not yet have, and would obligate against
 * it. The hold is recorded on the budget line and subtracted from what may be
 * released, by the same rule the browser runs.
 *
 * It is NOT a reduction of the appropriation. The Sanggunian enacted that
 * figure and the registry must agree with the ordinance on its face; the hold
 * is a decision of the executive about timing, and it can be lifted.
 * ---------------------------------------------------------------------------
 */

const BUDGET_APPROVERS: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER'];

const EXPENSE_CLASSES = ['PS', 'MOOE', 'FE', 'CO'];

/** Which of the manual's four forms an order prints onto. */
const FORM_OF: Record<string, string> = {
  PS: 'LBE Form No. 1',
  MOOE: 'LBE Form No. 1A',
  FE: 'LBE Form No. 1B',
  CO: 'LBE Form No. 1C',
};

interface RawLine {
  officeId?: string;
  fppCode?: string;
  accountCode?: string;
  amount?: number;
  forLaterRelease?: number;
}

const peso = (c: number) => (c / 100).toFixed(2);

export const issueAro = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, BUDGET_APPROVERS);
    const data = (request.data ?? {}) as {
      fiscalYear?: number;
      fundCode?: string;
      expenseClass?: string;
      purpose?: string;
      date?: string;
      notes?: string;
      lines?: unknown;
    };

    const fiscalYear = Number(data.fiscalYear);
    if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

    const fundCode = String(data.fundCode ?? '').trim();
    if (!fundCode) throw invalid('A fund is required.');

    const expenseClass = String(data.expenseClass ?? '').trim().toUpperCase();
    if (!EXPENSE_CLASSES.includes(expenseClass)) {
      throw invalid(
        'An Allotment Release Order covers one expense class: PS, MOOE, FE or CO. The manual has ' +
          'a separate form for each, released on its own schedule.',
      );
    }

    const purpose = String(data.purpose ?? '').trim();
    if (!purpose) {
      throw invalid(
        'The purpose is required. It is printed on the face of the order, and the allotment may be ' +
          'used solely for the purpose indicated.',
      );
    }

    const date = String(data.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw invalid('A date of issue is required, as year-month-day.');
    }

    const raw = data.lines;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalid('An order with no lines releases nothing.');
    }
    if (raw.length > 200) {
      throw invalid(`One order takes at most 200 lines; this one carried ${raw.length}.`);
    }

    assertFundInScope(caller, fundCode);

    // ---- read the lines being released ------------------------------------

    const lines = (raw as RawLine[]).map((l, i) => ({
      index: i + 1,
      officeId: String(l.officeId ?? '').trim(),
      fppCode: String(l.fppCode ?? '').trim(),
      accountCode: String(l.accountCode ?? '').trim(),
      amount: Math.round(Number(l.amount ?? 0)),
      forLaterRelease: Math.round(Number(l.forLaterRelease ?? 0)),
    }));

    for (const l of lines) {
      if (!l.officeId || !l.fppCode) {
        throw invalid(`Line ${l.index} does not name an office and a budget line.`);
      }
      if (!Number.isFinite(l.amount) || !Number.isFinite(l.forLaterRelease)) {
        throw invalid(`Line ${l.index} has an unreadable amount.`);
      }
      if (l.amount < 0 || l.forLaterRelease < 0) {
        throw invalid(
          `Line ${l.index} carries a negative amount. An order releases authority; withdrawing it ` +
            'is a withdrawal of allotment, recorded on its own.',
        );
      }
      if (l.amount === 0 && l.forLaterRelease === 0) {
        throw invalid(`Line ${l.index} releases nothing and holds nothing back.`);
      }
    }

    /*
     * Two lines of one order on the same budget line are summed before
     * anything is read.
     *
     * Per row instead would be wrong in a way that raises no error: each would
     * read the same balance, compute its own new total from it, and the last
     * write would win. The line would carry one row's release instead of both,
     * and the office would be short by an amount nobody could trace.
     */
    const byLine = new Map<
      string,
      { key: BudgetKey; amount: number; forLaterRelease: number; indexes: number[] }
    >();
    for (const l of lines) {
      const key: BudgetKey = {
        fiscalYear,
        fundCode,
        officeId: l.officeId,
        responsibilityCenterId: null,
        programId: null,
        projectId: null,
        activityId: null,
        fppCode: l.fppCode,
        accountCode: l.accountCode,
      };
      const id = budgetKeyId(key);
      const entry = byLine.get(id) ?? { key, amount: 0, forLaterRelease: 0, indexes: [] };
      entry.amount += l.amount;
      entry.forLaterRelease += l.forLaterRelease;
      entry.indexes.push(l.index);
      byLine.set(id, entry);
    }

    const numberingConfig = await loadNumberingConfig('ARO');
    const bookCode = await bookCodeForFund(fundCode);

    return db.runTransaction(async (tx) => {
      await assertFiscalYearOpen(fiscalYear, tx);

      // ---- READ PHASE -----------------------------------------------------

      const entries = [...byLine.values()];
      const balances = await Promise.all(entries.map((e) => readBudgetBalance(tx, e.key)));

      // ---- the invariant, on the summed amount ----------------------------

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const balance = balances[i];

        if (balance.appropriationRevised === 0) {
          throw new HttpsError(
            'failed-precondition',
            `Line ${entry.indexes.join(', ')} draws on ${entry.key.fppCode}, which has no ` +
              'appropriation. An allotment may only be released against authority the Sanggunian ' +
              'enacted. Nothing was released.',
          );
        }

        if (balance.expenseClass && balance.expenseClass !== expenseClass) {
          throw new HttpsError(
            'failed-precondition',
            `Line ${entry.indexes.join(', ')} is ${balance.expenseClass}, and this is an ` +
              `${expenseClass} order. The manual has a separate form for each expense class; ` +
              'release it on its own order. Nothing was released.',
          );
        }

        /*
         * The hold is applied BEFORE the release is tested against it. An
         * order that holds back three hundred thousand and releases eight
         * hundred out of a million must fail, and it only fails if the new
         * hold counts.
         */
        const check = checkAllotmentAgainstAppropriation({
          appropriationRevised: balance.appropriationRevised,
          forLaterRelease: (balance.forLaterRelease ?? 0) + entry.forLaterRelease,
          allotmentAlreadyReleased: balance.allotmentReleased,
          requestedRelease: entry.amount,
        });

        if (!check.ok) {
          const d = check.violations[0].details as Record<string, number>;
          throw new HttpsError(
            'failed-precondition',
            `Line ${entry.indexes.join(', ')} on ${entry.key.fppCode}: ${peso(entry.amount)} ` +
              `requested against ${peso(d.available)} available, short by ${peso(d.excess)}. ` +
              'Nothing was released.',
            check.violations[0].details,
          );
        }
      }

      // ---- WRITE PHASE ----------------------------------------------------

      const aroNo = await issueNumber(tx, numberingConfig, {
        bookCode,
        fundCode,
        fiscalYear,
        month: Number(date.slice(5, 7)),
      });

      const now = new Date().toISOString();
      const stamp = {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: now,
      };

      let totalReleased = 0;
      let totalHeld = 0;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const balance = balances[i];
        totalReleased += entry.amount;
        totalHeld += entry.forLaterRelease;

        const delta: Partial<BudgetBalanceData> = {};
        if (entry.amount !== 0) delta.allotmentReleased = entry.amount;
        if (entry.forLaterRelease !== 0) delta.forLaterRelease = entry.forLaterRelease;

        applyBudgetDelta(tx, entry.key, balance, delta, {
          officeName: balance.officeName ?? '',
          accountName: balance.accountName ?? '',
          fppName: balance.fppName ?? '',
          sector: balance.sector ?? null,
          serviceSector: balance.serviceSector ?? null,
          expenseClass,
        });

        /*
         * One allotment document per line of the order - including a line that
         * releases nothing and only holds an amount back.
         *
         * Skipping the hold-only line was the tempting shortcut: a zero-peso
         * allotment reads oddly in the register. But the hold would then move
         * the budget balance with no document behind it, and the balance is a
         * CACHE - `verifyBudgetBalances` rebuilds it nightly from exactly these
         * documents and reports what it cannot account for. A hold with no
         * source document would be reported as a discrepancy every night, and
         * the first person to "correct" it would quietly hand the department
         * back the authority the Budget Officer withheld.
         */
        {
          tx.create(db.collection(COL.allotments).doc(), {
            fiscalYear,
            fundCode,
            allotmentNo: aroNo,
            aroNo,
            aroPurpose: purpose,
            allotmentDate: date,
            officeId: entry.key.officeId,
            officeName: balance.officeName ?? '',
            fppCode: entry.key.fppCode,
            fppName: balance.fppName ?? '',
            sector: balance.sector ?? null,
            serviceSector: balance.serviceSector ?? null,
            accountCode: entry.key.accountCode,
            accountName: balance.accountName ?? '',
            expenseClass,
            amount: entry.amount,
            forLaterRelease: entry.forLaterRelease,
            particulars: purpose,
            status: 'APPROVED',
            postedAt: now,
            createdBy: stamp,
            approvedBy: stamp,
          });
        }
      }

      applySummaryDelta(tx, fiscalYear, fundCode, { allotmentReleased: totalReleased });

      recordTransition(tx, {
        caller,
        // An ARO is approved by the Local Chief Executive, so it is an APPROVE
        // in the audit trail rather than a new verb of its own.
        event: 'APPROVE',
        entityType: COL.allotments,
        entityId: aroNo,
        entityRef: `ARO ${aroNo}`,
        fiscalYear,
        fundCode,
        action: 'APPROVE',
        previousStatus: 'DRAFT',
        newStatus: 'APPROVED',
        remarks:
          `${FORM_OF[expenseClass]} · ${entries.length} line${entries.length === 1 ? '' : 's'} · ` +
          `${peso(totalReleased)} released` +
          (totalHeld > 0 ? `, ${peso(totalHeld)} held for later release` : '') +
          `. ${purpose}`,
      });

      return {
        aroNo,
        form: FORM_OF[expenseClass],
        lineCount: entries.length,
        totalReleased,
        totalHeld,
      };
    });
  },
);
