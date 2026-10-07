import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { assertFiscalYearOpen } from '../lib/period';
import {
  annualOf,
  checkReceiptSet,
  receiptKeyId,
  type IncomeClass,
  type ReceiptLineInput,
} from '../lib/estimatedReceipts';

/**
 * recordEstimatedReceipts — the financing side of the budget year.
 *
 * LBP Form No. 1, section II. What the Local Finance Committee certified as
 * "reasonably projected as collectible for the Budget Year", per revenue
 * account per fund, split by quarter.
 *
 * ---------------------------------------------------------------------------
 * WHY A CALLABLE AND NOT A CLIENT WRITE
 * ---------------------------------------------------------------------------
 * These are not ledger balances and they authorise nothing, so the case for
 * putting them behind the server is not the usual one. It is this: they become
 * the budget column of the Statement of Receipts and Expenditures, which is
 * submitted to the DOF-BLGF, and the base of two statutory limits. A figure
 * that leaves the municipality on a signed form should not be writable from a
 * browser console, and the duplicate-account rule below cannot be enforced
 * from the client at all, because the client cannot see the other tabs.
 *
 * ---------------------------------------------------------------------------
 * ONE CALL, WHOLE FILE, ALL OR NOTHING
 * ---------------------------------------------------------------------------
 * The whole set arrives in one call and is checked before anything is written.
 * Row by row would let a file fail halfway and leave the municipality's
 * estimate half old and half new, with no record of which rows were which -
 * and the duplicate check, the one that actually matters here, is only
 * possible when the rows are seen together.
 *
 * A REPLACE rather than a merge, deliberately. Re-uploading a corrected LBP
 * Form No. 1 should leave the estimate matching the form, and a merge would
 * leave behind every account the correction deleted.
 * ---------------------------------------------------------------------------
 */

const RECEIPT_RECORDERS: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER', 'MUNICIPAL_TREASURER'];

/**
 * Only the Budget Officer re-opens a closed schedule.
 *
 * Narrower than RECEIPT_RECORDERS on purpose. The Treasurer may RECORD the
 * year's estimate - they are the officer who knows what the municipality will
 * collect - but re-opening one the office has already closed is a budget
 * decision, and the Budget Officer owns it.
 */
const RECEIPT_UNLOCKERS: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER'];

/**
 * The lock marker for one fund's schedule in one year.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCHEDULE CLOSES WHEN IT IS SAVED
 * ---------------------------------------------------------------------------
 * The estimated receipts are not a working note. Two statutory limits rest on
 * their total - the LDRRMF and the Personal Services cap - and the SRE reports
 * actual collections against them. A figure that quietly changes after the
 * appropriation has been drawn against it changes the ceiling the Sanggunian
 * appropriated under, with nothing on the record saying it moved.
 *
 * The commonest way that happens is not a decision. It is a second upload: the
 * same schedule, corrected in the spreadsheet, loaded again in REPLACE mode by
 * somebody who does not know the first one is already in use.
 *
 * So saving closes it, and re-opening is a deliberate act by the Budget
 * Officer with a reason attached and a CRITICAL line in the audit trail. The
 * lock does not stop the Budget Officer doing anything; it stops it happening
 * by accident, and it leaves a record when it happens on purpose.
 */
const lockId = (fiscalYear: number, fundCode: string) => `${fiscalYear}__${fundCode}`;

interface ReceiptLock {
  fiscalYear: number;
  fundCode: string;
  lockedAt: string;
  lockedBy: { uid: string; name: string; position?: string | null };
  lineCount: number;
  total: number;
}

/** Firestore's own ceiling is 500 writes to a transaction; this stays inside it. */
const MAX_LINES = 400;

interface RawLine {
  accountCode?: string;
  accountName?: string;
  incomeClass?: string;
  q1?: number;
  q2?: number;
  q3?: number;
  q4?: number;
  particulars?: string;
}

const peso = (c: number) => (c / 100).toFixed(2);

export const recordEstimatedReceipts = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, RECEIPT_RECORDERS);
    const data = (request.data ?? {}) as {
      fiscalYear?: number;
      fundCode?: string;
      /** REPLACE wipes the year's lines for this fund first; MERGE does not. */
      mode?: string;
      fileName?: string;
      lines?: unknown;
    };

    const fiscalYear = Number(data.fiscalYear);
    if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

    const fundCode = String(data.fundCode ?? '').trim();
    if (!fundCode) throw invalid('A fund is required.');

    const mode = String(data.mode ?? 'MERGE').trim().toUpperCase();
    if (mode !== 'MERGE' && mode !== 'REPLACE') {
      throw invalid('The mode is either MERGE or REPLACE.');
    }

    const raw = data.lines;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalid('Nothing was sent. An estimate with no lines is not an estimate.');
    }
    if (raw.length > MAX_LINES) {
      throw invalid(
        `One call takes at most ${MAX_LINES} lines; this one carried ${raw.length}. ` +
          'Split the file by fund, or by income class.',
      );
    }

    assertFundInScope(caller, fundCode);

    const lines: Array<ReceiptLineInput & { accountName: string; particulars: string }> = (
      raw as RawLine[]
    ).map((l, i) => ({
      lineNo: i + 1,
      accountCode: String(l.accountCode ?? '').trim(),
      accountName: String(l.accountName ?? '').trim(),
      incomeClass: String(l.incomeClass ?? 'REGULAR').trim().toUpperCase(),
      particulars: String(l.particulars ?? '').trim(),
      q1: Math.round(Number(l.q1 ?? 0)),
      q2: Math.round(Number(l.q2 ?? 0)),
      q3: Math.round(Number(l.q3 ?? 0)),
      q4: Math.round(Number(l.q4 ?? 0)),
    }));

    // The shared rule, the same one the browser ran before sending. Negative
    // quarters, an unknown income class, a repeated account, a file of zeroes.
    const check = checkReceiptSet(lines);
    if (!check.ok) {
      throw new HttpsError(
        'failed-precondition',
        `${check.violations[0].message} Nothing was recorded.`,
        { violations: check.violations.slice(0, 20) },
      );
    }

    /*
     * Every account must exist in the Chart of Accounts, and none may be an
     * expense account.
     *
     * The second half is not pedantry. An expense code in the receipts
     * schedule would be added into total estimated income, inflate the base of
     * the LDRRMF and Personal Services tests, and show on the SRE as revenue
     * the municipality never expected to receive - all without a single
     * arithmetic error anywhere.
     */
    const codes = [...new Set(lines.map((l) => l.accountCode))];
    const accountSnaps = await Promise.all(
      codes.map((code) => db.collection(COL.accounts).where('code', '==', code).limit(1).get()),
    );

    const accountByCode = new Map<string, { name: string; accountClass: string }>();
    const unknown: string[] = [];
    const expenseCodes: string[] = [];

    for (let i = 0; i < codes.length; i++) {
      const snap = accountSnaps[i];
      if (snap.empty) {
        unknown.push(codes[i]);
        continue;
      }
      const d = snap.docs[0].data() as { name?: string; accountClass?: string };
      if (d.accountClass === 'EXPENSE') expenseCodes.push(codes[i]);
      accountByCode.set(codes[i], {
        name: String(d.name ?? ''),
        accountClass: String(d.accountClass ?? ''),
      });
    }

    if (unknown.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        `${unknown.length} account code${unknown.length === 1 ? ' is' : 's are'} not in the ` +
          `Chart of Accounts: ${unknown.slice(0, 8).join(', ')}` +
          `${unknown.length > 8 ? ', …' : ''}. Nothing was recorded.`,
        { unknown },
      );
    }

    if (expenseCodes.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        `${expenseCodes.slice(0, 8).join(', ')} ${
          expenseCodes.length === 1 ? 'is an expense account' : 'are expense accounts'
        }. This is the receipts schedule - an expense code here would be counted as estimated ` +
          'income and would raise the base of the LDRRMF and Personal Services limits. Nothing ' +
          'was recorded.',
        { expenseCodes },
      );
    }

    const existing = await db
      .collection(COL.estimatedReceipts)
      .where('fiscalYear', '==', fiscalYear)
      .where('fundCode', '==', fundCode)
      .get();

    const now = new Date().toISOString();
    const stamp = { uid: caller.uid, name: caller.name };
    const fileName = String(data.fileName ?? '').trim();

    const lockRef = db.collection(COL.estimatedReceiptLocks).doc(lockId(fiscalYear, fundCode));

    const written = await db.runTransaction(async (tx) => {
      /*
       * READ BEFORE ANY WRITE, as every transaction in this engine does.
       * Reading the lock inside the transaction is what makes it a lock: two
       * uploads arriving together cannot both find it open.
       */
      const lockSnap = await tx.get(lockRef);
      await assertFiscalYearOpen(fiscalYear, tx);

      if (lockSnap.exists) {
        const lock = lockSnap.data() as ReceiptLock;
        throw new HttpsError(
          'failed-precondition',
          `The ${fundCode} receipts schedule for ${fiscalYear} was closed by ` +
            `${lock.lockedBy?.name ?? 'an officer'} on ${String(lock.lockedAt).slice(0, 10)} ` +
            `and cannot be changed. Two statutory limits and the SRE are worked out from its ` +
            `total, so it is not re-opened by uploading over it. The Budget Officer can re-open ` +
            `it from Budget, Estimated Receipts - the reason is recorded. Nothing was recorded.`,
        );
      }

      const keep = new Set(
        lines.map((l) =>
          receiptKeyId({ fiscalYear, fundCode, accountCode: l.accountCode }),
        ),
      );

      let removed = 0;
      if (mode === 'REPLACE') {
        for (const docSnap of existing.docs) {
          if (keep.has(docSnap.id)) continue;
          tx.delete(docSnap.ref);
          removed += 1;
        }
      }

      let total = 0;
      for (const line of lines) {
        const id = receiptKeyId({ fiscalYear, fundCode, accountCode: line.accountCode });
        const annual = annualOf(line);
        total += annual;

        tx.set(db.collection(COL.estimatedReceipts).doc(id), {
          fiscalYear,
          fundCode,
          accountCode: line.accountCode,
          // The Chart of Accounts is the authority on the name, not the
          // spreadsheet - a file typed last March would otherwise freeze a
          // name the office has since corrected.
          accountName: accountByCode.get(line.accountCode)?.name || line.accountName,
          incomeClass: line.incomeClass as IncomeClass,
          q1: line.q1,
          q2: line.q2,
          q3: line.q3,
          q4: line.q4,
          annual,
          particulars: line.particulars || null,
          sourceFile: fileName || null,
          updatedAt: now,
          updatedBy: stamp,
        });
      }

      recordTransition(tx, {
        caller,
        event: 'SETTINGS_CHANGE',
        entityType: COL.estimatedReceipts,
        entityId: `${fiscalYear}__${fundCode}`,
        entityRef: `Estimated receipts ${fundCode} ${fiscalYear}`,
        fiscalYear,
        fundCode,
        action: 'APPROVE',
        previousStatus: 'DRAFT',
        newStatus: 'APPROVED',
        remarks:
          `${mode === 'REPLACE' ? 'Replaced' : 'Updated'} ${lines.length} line` +
          `${lines.length === 1 ? '' : 's'}` +
          `${removed > 0 ? `, removed ${removed}` : ''}. Total estimated receipts ` +
          `${peso(total)}${fileName ? ` · ${fileName}` : ''}.`,
      });

      /*
       * Closed in the SAME transaction that wrote the lines. Closing it
       * afterwards would leave a window in which a second upload could land on
       * an open schedule that already has figures in it.
       */
      tx.set(lockRef, {
        fiscalYear,
        fundCode,
        lockedAt: now,
        lockedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null },
        lineCount: lines.length,
        total,
      });

      return { lineCount: lines.length, removed, total };
    });

    return {
      fiscalYear,
      fundCode,
      mode,
      ...written,
    };
  },
);

/**
 * unlockEstimatedReceipts - the Budget Officer re-opens a closed schedule.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It is not a control against the Budget Officer. They can re-open any
 * schedule, which is right: they own the budget, and an estimate that turned
 * out wrong has to be correctable.
 *
 * What it is: a stop on the schedule changing BY ACCIDENT - a second upload of
 * a corrected spreadsheet landing on figures the appropriation has already
 * been drawn against - and a record when it changes on purpose. The reason is
 * required for the same reason a cancellation reason is: in a year's time the
 * question will be why the year's estimated income moved, and "somebody
 * re-uploaded it" is not an answer anybody can act on.
 *
 * Recorded CRITICAL. Two statutory limits rest on the total this re-opens.
 */
export const unlockEstimatedReceipts = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, RECEIPT_UNLOCKERS);
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
        'A reason for re-opening the schedule is required. The LDRRMF and Personal Services ' +
          'limits are worked out from its total, so a change to it has to be answerable.',
      );
    }

    assertFundInScope(caller, fundCode);

    const ref = db.collection(COL.estimatedReceiptLocks).doc(lockId(fiscalYear, fundCode));

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      await assertFiscalYearOpen(fiscalYear, tx);

      if (!snap.exists) {
        throw new HttpsError(
          'failed-precondition',
          `The ${fundCode} receipts schedule for ${fiscalYear} is already open.`,
        );
      }

      const lock = snap.data() as ReceiptLock;
      tx.delete(ref);

      recordTransition(tx, {
        caller,
        event: 'SETTINGS_CHANGE',
        entityType: COL.estimatedReceipts,
        entityId: lockId(fiscalYear, fundCode),
        entityRef: `Estimated receipts ${fundCode} ${fiscalYear}`,
        fiscalYear,
        fundCode,
        // REOPEN, which already means exactly this elsewhere in the engine.
        action: 'REOPEN',
        previousStatus: 'APPROVED',
        newStatus: 'DRAFT',
        severity: 'CRITICAL',
        remarks:
          `Re-opened for editing. Closed by ${lock.lockedBy?.name ?? 'an officer'} on ` +
          `${String(lock.lockedAt).slice(0, 10)} at ${peso(lock.total ?? 0)} over ` +
          `${lock.lineCount ?? 0} line${lock.lineCount === 1 ? '' : 's'}. Reason: ${why}`,
      });

      return { fiscalYear, fundCode, reopened: true };
    });
  },
);
