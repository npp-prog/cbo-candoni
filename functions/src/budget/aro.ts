import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, invalid, type Role, type Caller } from '../lib/context';
import type { Transaction } from 'firebase-admin/firestore';
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
 * Until now CFMS could not tell a withheld appropriation from a fully released
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

/**
 * An order, read and checked, before anything is read from the books.
 *
 * Everything here is about the ORDER on its face - one expense class, a
 * purpose, a date, lines that name a budget line and carry no negative amount.
 * None of it needs the books, so none of it is inside the transaction, and the
 * same reading serves a hand-typed order and one filled from an uploaded file.
 */
export interface AroOrder {
  fiscalYear: number;
  fundCode: string;
  expenseClass: string;
  purpose: string;
  date: string;
  /** Lines of the order summed by budget line - see the note on `byLine`. */
  entries: Array<{ key: BudgetKey; amount: number; forLaterRelease: number; indexes: number[] }>;
}

export function parseAroOrder(data: {
  fiscalYear?: unknown;
  fundCode?: unknown;
  expenseClass?: unknown;
  purpose?: unknown;
  date?: unknown;
  lines?: unknown;
}): AroOrder {
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

  return { fiscalYear, fundCode, expenseClass, purpose, date, entries: [...byLine.values()] };
}

/** Who did a thing, as stamped on a document. */
interface Stamp {
  uid: string;
  name: string;
  position: string | null;
  at: string;
}

/**
 * Releasing an order against the books, inside a transaction the caller owns.
 *
 * READS FIRST, then writes, as Firestore requires: the fiscal year, every
 * budget line, then the number. A caller that has its own document to read -
 * the prepared order, in `approveAro` - reads it BEFORE calling this.
 *
 * `preparedBy` is whoever prepared the order and `caller` whoever approves it.
 * They used to be one stamp written twice, because issuing an order was one act
 * by one officer. They are two people now, and the allotment says so.
 */
async function postAroInTransaction(
  tx: Transaction,
  caller: Caller,
  order: AroOrder,
  numberingConfig: Awaited<ReturnType<typeof loadNumberingConfig>>,
  bookCode: string,
  preparedBy: Stamp | null,
): Promise<{ aroNo: string; form: string; lineCount: number; totalReleased: number; totalHeld: number }> {
  const { fiscalYear, fundCode, expenseClass, purpose, date, entries } = order;

  await assertFiscalYearOpen(fiscalYear, tx);

  // ---- READ PHASE -----------------------------------------------------------

  const balances = await Promise.all(entries.map((e) => readBudgetBalance(tx, e.key)));

  // ---- the invariant, on the summed amount ----------------------------------

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
     * The hold is applied BEFORE the release is tested against it. An order
     * that holds back three hundred thousand and releases eight hundred out
     * of a million must fail, and it only fails if the new hold counts.
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

  // ---- WRITE PHASE ----------------------------------------------------------

  const aroNo = await issueNumber(tx, numberingConfig, {
    bookCode,
    fundCode,
    fiscalYear,
    month: Number(date.slice(5, 7)),
  });

  const now = new Date().toISOString();
  const approvedBy: Stamp = {
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
     * allotment reads oddly in the register. But the hold would then move the
     * budget balance with no document behind it, and the balance is a CACHE -
     * `verifyBudgetBalances` rebuilds it nightly from exactly these documents
     * and reports what it cannot account for. A hold with no source document
     * would be reported as a discrepancy every night, and the first person to
     * "correct" it would quietly hand the department back the authority the
     * Budget Officer withheld.
     */
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
      createdBy: preparedBy ?? approvedBy,
      approvedBy,
    });
  }

  applySummaryDelta(tx, fiscalYear, fundCode, { allotmentReleased: totalReleased });

  recordTransition(tx, {
    caller,
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
      (preparedBy ? `. Prepared by ${preparedBy.name}` : '') +
      `. ${purpose}`,
  });

  return {
    aroNo,
    form: FORM_OF[expenseClass],
    lineCount: entries.length,
    totalReleased,
    totalHeld,
  };
}

/**
 * issueAro - kept only to say where releasing went.
 *
 * ---------------------------------------------------------------------------
 * AN ORDER IS PREPARED, AND THEN APPROVED
 * ---------------------------------------------------------------------------
 * This released allotment the moment it was pressed: the lines landed
 * APPROVED, the balances moved, and recording an order and approving it were
 * one act by one officer. The Budget Office asked for the two to be separate,
 * so that a recorded order waits for the Budget Officer's approval before any
 * authority moves - and so that Budget Staff, who could not record an order at
 * all, can now prepare one for the Budget Officer to approve.
 *
 * So an order is saved as a PREPARED order (`aroDrafts`), which moves nothing,
 * and released by `approveAro`. This callable is not deleted, because deleting
 * a deployed function is a separate and easily-missed step; it refuses, and
 * says what to do instead. A door left open beside the new one would be the
 * thing this change exists to close.
 */
export const issueAro = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    await requireCaller(request, BUDGET_APPROVERS);
    throw new HttpsError(
      'failed-precondition',
      'An Allotment Release Order is now prepared first and released when the Budget Officer ' +
        'approves it. Save it as a prepared order on the Allotments screen, then approve it there.',
    );
  },
);

/**
 * approveAro - the Budget Officer releases a prepared order.
 *
 * ---------------------------------------------------------------------------
 * WHY APPROVAL READS THE ORDER ITSELF RATHER THAN BEING SENT IT
 * ---------------------------------------------------------------------------
 * The browser sends only WHICH prepared order. The lines, the amounts, the
 * purpose are read from the stored order inside the transaction that releases
 * them. If the browser sent the order, the figures approved would be whatever
 * the browser said at the moment of approval, and a prepared order could be
 * approved as something other than what was prepared.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT CANNOT RELEASE THE SAME ORDER TWICE
 * ---------------------------------------------------------------------------
 * The prepared order is read in the same transaction that releases it and is
 * marked released in that transaction too. Two approvals pressed together -
 * two tabs, a double click - collide: Firestore runs one, and the other finds
 * the order already released and is refused. Every release issues a fresh ARO
 * number, so without this a second press would release the whole order again
 * under a second number, and nothing would look wrong.
 *
 * The order is kept, marked APPROVED with its number, rather than deleted.
 * That is the record of who prepared it, and it is what stops an uploaded file
 * being prepared and released a second time under the same reference.
 */
export const approveAro = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, BUDGET_APPROVERS);
    const { draftId } = (request.data ?? {}) as { draftId?: string };
    if (!draftId) throw invalid('Which prepared order is being approved?');

    const ref = db.collection(COL.aroDrafts).doc(draftId);

    /*
     * Read once outside the transaction for the fund - the numbering series
     * and the book code depend on it and are loaded before the transaction
     * starts. Everything that DECIDES anything is read again inside it.
     */
    const first = await ref.get();
    if (!first.exists) {
      throw new HttpsError('not-found', 'That prepared order no longer exists.');
    }
    const fundForSeries = String((first.data() as { fundCode?: string }).fundCode ?? '');
    assertFundInScope(caller, fundForSeries);

    const numberingConfig = await loadNumberingConfig('ARO');
    const bookCode = await bookCodeForFund(fundForSeries);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'That prepared order no longer exists.');
      }
      const draft = snap.data() as {
        status?: string;
        aroNo?: string;
        fiscalYear?: number;
        fundCode?: string;
        expenseClass?: string;
        purpose?: string;
        date?: string;
        lines?: unknown;
        createdBy?: Partial<Stamp>;
      };

      if (draft.status !== 'DRAFT') {
        throw new HttpsError(
          'failed-precondition',
          draft.aroNo
            ? `This order has already been released as ARO ${draft.aroNo}. Nothing was released a second time.`
            : 'This order is no longer a prepared order, so it cannot be approved.',
        );
      }
      if (draft.fundCode !== fundForSeries) {
        throw new HttpsError(
          'aborted',
          'The prepared order changed while it was being approved. Open it again and approve it once more.',
        );
      }

      const order = parseAroOrder(draft);

      const preparedBy: Stamp | null = draft.createdBy?.uid
        ? {
            uid: String(draft.createdBy.uid),
            name: String(draft.createdBy.name ?? ''),
            position: draft.createdBy.position ? String(draft.createdBy.position) : null,
            at: String(draft.createdBy.at ?? ''),
          }
        : null;

      const result = await postAroInTransaction(
        tx,
        caller,
        order,
        numberingConfig,
        bookCode,
        preparedBy,
      );

      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'APPROVED',
        aroNo: result.aroNo,
        approvedAt: now,
        approvedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      return result;
    });
  },
);

/**
 * releaseHeldAllotment — releasing what was held back for later.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING RELEASED, AND WHY IT WAS HELD
 * ---------------------------------------------------------------------------
 * Column 5 of the Allotment Release Order is "For Later Release", and the
 * Budget Operations Manual is explicit about what it is for: it exists "to
 * provide safeguards for shortfalls in the collection of revenues". The
 * Sanggunian appropriates against an estimate of what the municipality will
 * collect. If the collections do not come in, the appropriation is still on
 * the books and the obligation would still be legal - so the Budget Officer
 * withholds part of the release until the money is actually there.
 *
 * `issueAro` records the holding back. This is the other half: putting the
 * authority into the offices' hands once the collections have arrived.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 * The screen shows actual collections against the Estimated Receipts, and the
 * Budget Officer decides. The engine checks the arithmetic - that the amount
 * is really held, that the year is open, that the authority exists - and
 * records who released it and on what collection figure.
 *
 * It does not refuse on the collection figure itself, and that is deliberate.
 * A release may be right for a reason the figure does not show: a receipt
 * certain but not yet deposited, a grant confirmed in writing, a reallocation
 * the Sanggunian has approved. Refusing on the arithmetic would mean the
 * Budget Officer worked around CFMS on exactly the occasions that matter most,
 * and nothing would be recorded at all. What is recorded instead is the figure
 * as it stood when they decided, so the decision can be read afterwards
 * against what was known at the time.
 */
export const releaseHeldAllotment = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, BUDGET_APPROVERS);
    const { allotmentId, amount, date, reason, collectionsAtRelease, estimateAtRelease } =
      (request.data ?? {}) as {
        allotmentId?: string;
        amount?: number;
        date?: string;
        reason?: string;
        collectionsAtRelease?: number;
        estimateAtRelease?: number;
      };

    if (!allotmentId) throw invalid('An allotment line is required.');
    if (!reason?.trim()) {
      throw invalid(
        'Say why the held allotment is being released. It is recorded against the release and in the audit trail.',
      );
    }

    const releasing = Math.round(Number(amount ?? 0));
    if (!Number.isFinite(releasing) || releasing <= 0) {
      throw invalid('The amount to release must be a positive figure.');
    }

    return db.runTransaction(async (tx) => {
      // ---- READ PHASE -------------------------------------------------------
      const ref = db.collection(COL.allotments).doc(allotmentId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFoundAllotment();

      const line = snap.data() as {
        fiscalYear: number;
        fundCode: string;
        officeId: string;
        officeName?: string;
        fppCode: string;
        fppName?: string;
        accountCode: string;
        accountName?: string;
        sector?: string | null;
        serviceSector?: string | null;
        expenseClass: string;
        allotmentNo?: string;
        aroNo?: string;
        aroPurpose?: string;
        forLaterRelease?: number;
        status?: string;
      };

      const held = Math.round(Number(line.forLaterRelease ?? 0));
      if (held <= 0) {
        throw new HttpsError(
          'failed-precondition',
          `Nothing is held back on ${line.aroNo ? `ARO ${line.aroNo}` : 'this allotment'}. There is no later release to make.`,
        );
      }
      if (releasing > held) {
        throw new HttpsError(
          'failed-precondition',
          `Only ${(held / 100).toFixed(2)} is held for later release on this line; the release asks for ${(releasing / 100).toFixed(2)}. Release what is held, or issue a fresh Allotment Release Order against the appropriation.`,
        );
      }
      if (line.status === 'CANCELLED') {
        throw new HttpsError(
          'failed-precondition',
          'That allotment line has been cancelled. Nothing can be released from it.',
        );
      }

      assertFundInScope(caller, line.fundCode);
      await assertFiscalYearOpen(line.fiscalYear, tx);

      const key: BudgetKey = {
        fiscalYear: line.fiscalYear,
        fundCode: line.fundCode,
        officeId: line.officeId,
        fppCode: line.fppCode,
        accountCode: line.accountCode,
      };
      const balance = await readBudgetBalance(tx, key);

      /*
       * The balance is the authority, not the line.
       *
       * A line says what THIS order held back; the balance says what is held
       * across every order on this budget line. Releasing against the line
       * alone would let two releases from two orders take the same held peso
       * out twice, and the registry would show more released than was ever
       * appropriated.
       */
      const heldOnBalance = Math.round(Number(balance?.forLaterRelease ?? 0));
      if (releasing > heldOnBalance) {
        throw new HttpsError(
          'failed-precondition',
          `This budget line holds ${(heldOnBalance / 100).toFixed(2)} for later release in total, and the release asks for ${(releasing / 100).toFixed(2)}. Another order may already have released part of it.`,
        );
      }

      // ---- WRITE PHASE ------------------------------------------------------
      const now = new Date().toISOString();
      const releaseDate = String(date ?? now.slice(0, 10)).slice(0, 10);
      const stamp = {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: now,
      };

      /*
       * A release is a NEW allotment line, not an edit of the old one.
       *
       * The register is a ledger: it shows the order that held the money back
       * and, separately, the act that let it go, each with its own date and
       * its own authority. Reducing the original in place would leave a
       * register in which the holding back had never happened.
       */
      tx.create(db.collection(COL.allotments).doc(), {
        fiscalYear: line.fiscalYear,
        fundCode: line.fundCode,
        allotmentNo: line.allotmentNo ?? line.aroNo ?? '',
        aroNo: line.aroNo ?? null,
        aroPurpose: line.aroPurpose ?? null,
        allotmentDate: releaseDate,
        officeId: line.officeId,
        officeName: line.officeName ?? '',
        fppCode: line.fppCode,
        fppName: line.fppName ?? '',
        sector: line.sector ?? null,
        serviceSector: line.serviceSector ?? null,
        accountCode: line.accountCode,
        accountName: line.accountName ?? '',
        expenseClass: line.expenseClass,
        amount: releasing,
        forLaterRelease: 0,
        particulars: `Release of allotment held for later release. ${reason.trim()}`,
        /*
         * What was known when the decision was taken. The engine does not
         * refuse on these figures - see the note at the head of this function -
         * so recording them is what makes the decision readable afterwards.
         */
        releasedFromHeld: {
          allotmentId,
          collections: Math.round(Number(collectionsAtRelease ?? 0)),
          estimate: Math.round(Number(estimateAtRelease ?? 0)),
          reason: reason.trim(),
        },
        status: 'APPROVED',
        postedAt: now,
        createdBy: stamp,
        approvedBy: stamp,
      });

      tx.update(ref, { forLaterRelease: held - releasing });

      applyBudgetDelta(
        tx,
        key,
        balance,
        { forLaterRelease: -releasing, allotmentReleased: releasing },
        {
          officeName: balance.officeName ?? line.officeName ?? '',
          accountName: balance.accountName ?? line.accountName ?? '',
          fppName: balance.fppName ?? line.fppName ?? '',
          sector: balance.sector ?? line.sector ?? null,
          serviceSector: balance.serviceSector ?? line.serviceSector ?? null,
          expenseClass: line.expenseClass as never,
        },
      );
      applySummaryDelta(tx, line.fiscalYear, line.fundCode, { allotmentReleased: releasing });

      recordTransition(tx, {
        caller,
        event: 'APPROVE',
        entityType: COL.allotments,
        entityId: allotmentId,
        entityRef: line.aroNo ? `ARO ${line.aroNo}` : 'Allotment',
        fiscalYear: line.fiscalYear,
        fundCode: line.fundCode,
        action: 'APPROVE',
        previousStatus: 'APPROVED',
        newStatus: 'APPROVED',
        remarks:
          `Released ${(releasing / 100).toFixed(2)} held for later release on ${line.accountCode || line.fppCode}. ` +
          `Collections ${((Number(collectionsAtRelease ?? 0)) / 100).toFixed(2)} against an estimate of ` +
          `${((Number(estimateAtRelease ?? 0)) / 100).toFixed(2)} at the time. ${reason.trim()}`,
        severity: 'CRITICAL',
      });

      return {
        allotmentId,
        released: releasing,
        stillHeld: held - releasing,
      };
    });
  },
);

function notFoundAllotment(): HttpsError {
  return new HttpsError('not-found', 'That allotment line no longer exists.');
}
