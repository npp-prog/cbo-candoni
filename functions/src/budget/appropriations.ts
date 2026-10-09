import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, notFound, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertFiscalYearOpen } from '../lib/period';
import { appropriationApprovalProblems, appropriationLineLabel } from '../lib/budgetLines';
import {
  readBudgetBalance,
  budgetBalanceRef,
  budgetKeyId,
  EMPTY_BALANCE,
  applyBudgetDelta,
  applySummaryDelta,
  type BudgetKey,
  type BudgetBalanceData,
} from '../lib/budget';
import { checkAllotmentWithdrawal } from '../lib/rules';
import { planAppropriationApproval, type ApprovalLine } from './appropriationApproval';
import { assertActReady } from './actGate';
import { actKindOfLine } from '../lib/budgetActs';
import type { DocumentSnapshot } from 'firebase-admin/firestore';

const BUDGET_APPROVERS: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER'];

/**
 * approveAppropriation - records enacted budget authority.
 *
 * An appropriation is the only figure in the budget chain with no upstream
 * control: it comes from an ordinance of the Sangguniang Bayan, and the system
 * records it rather than validating it against anything. What the system does
 * enforce is that everything downstream stays inside it.
 *
 * Realignments and transfers arrive as signed pairs. The function does not
 * require the pair to be submitted together (they often are not), but a
 * realignment that would drive a line's appropriation negative is refused,
 * because that is always a data-entry error rather than a real budget act.
 */
export const approveAppropriation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, BUDGET_APPROVERS);
    const { appropriationId, upload } = (request.data ?? {}) as {
      appropriationId?: string;
      /** Approve every draft line of one uploaded ordinance. Patch 112. */
      upload?: { fiscalYear?: number; fundCode?: string; reference?: string };
    };
    if (upload) return approveUploadedOrdinance(caller, upload);
    if (!appropriationId) throw invalid('An appropriation id is required.');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.appropriations).doc(appropriationId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The appropriation');

      const a = snap.data() as BudgetKey & {
        kind: string;
        amount: number;
        status: string;
        officeName: string;
        accountName: string;
        fppCode: string;
        fppName?: string;
        sector?: string;
        serviceSector?: string;
        expenseClass: string;
        authorityReference?: string;
        instrument?: string;
      };

      if (a.status !== 'DRAFT') {
        throw new HttpsError(
          'failed-precondition',
          `This appropriation is already ${a.status.toLowerCase()}. Record a supplemental appropriation or an adjustment instead of re-approving.`,
        );
      }

      /*
       * A draft is written by the browser, and a draft written by an older
       * build - or loaded from a spreadsheet - can be missing a field this
       * function needs. Name what is missing, all of it: a draft that is wrong
       * in two ways is corrected once if it is told both. Silence here becomes
       * an unreadable failure deeper in, and a budget line with no expense
       * class disappears from the registry that is cut by class.
       *
       * THIS USED TO DEMAND AN ACCOUNT CODE OUTRIGHT, which refused every line
       * appropriated BY PROGRAMME - the shape where the ordinance named a
       * project and no object, and the object code is empty on purpose. The
       * ordinance upload had understood that shape since patch 86 and posted
       * such lines happily; approval did not, so a by-programme line recorded
       * on the screen could be saved and then never approved. The rule is in
       * one file now, shared with the browser. See lib/budgetLines.
       */
      const missing = appropriationApprovalProblems({
        fundCode: a.fundCode,
        officeId: a.officeId,
        fppCode: a.fppCode,
        accountCode: a.accountCode,
        expenseClass: a.expenseClass,
      });

      if (missing.length > 0) {
        throw new HttpsError(
          'failed-precondition',
          `This appropriation is missing its ${missing.join(', ')}, so it cannot be approved. Record it again on the Appropriations screen - a draft saved by an earlier version of CFMS, or loaded from a file, may not carry every field.`,
          { missing },
        );
      }

      if (typeof a.amount !== 'number' || !Number.isFinite(a.amount)) {
        throw new HttpsError(
          'failed-precondition',
          'This appropriation carries no usable amount, so nothing can be approved against it. Record it again on the Appropriations screen.',
        );
      }

      assertFundInScope(caller, a.fundCode);
      await assertFiscalYearOpen(a.fiscalYear, tx);

      /*
       * Patch 123: the act this line was made by must be recorded, its signed
       * copy attached, and its sources must finance it - this line included.
       * An adjustment is a correction, not an act, and is not gated.
       */
      const act = actKindOfLine(a);
      if (!act) {
        /*
         * Patch 129: adjustments (and transfers before them) are withdrawn.
         * Every appropriation is now made by an act, and an act is checked;
         * a draft of another kind would be authority that nothing checked.
         */
        throw new HttpsError(
          'failed-precondition',
          `${a.kind === 'ADJUSTMENT' ? 'Adjustments are' : `${a.kind} lines are`} no longer approved. Authority changes by an act - an ordinance, an augmentation or a continuing appropriation - recorded under Appropriations > Authorities. Discard this draft.`,
        );
      }
      {
        await assertActReady(
          { fiscalYear: a.fiscalYear, fundCode: a.fundCode, kind: act, reference: a.authorityReference ?? '' },
          a.amount,
          tx,
        );
      }

      const key: BudgetKey = {
        fiscalYear: a.fiscalYear,
        fundCode: a.fundCode,
        officeId: a.officeId,
        responsibilityCenterId: a.responsibilityCenterId ?? null,
        programId: a.programId ?? null,
        projectId: a.projectId ?? null,
        activityId: a.activityId ?? null,
        fppCode: a.fppCode,
        accountCode: a.accountCode,
      };

      const balance = await readBudgetBalance(tx, key);

      const delta: Partial<BudgetBalanceData> = {};
      switch (a.kind) {
        case 'ORIGINAL':
          delta.appropriationOriginal = a.amount;
          break;
        case 'SUPPLEMENTAL':
          delta.appropriationSupplemental = a.amount;
          break;
        case 'CONTINUING':
          delta.appropriationContinuing = a.amount;
          break;
        default:
          // REALIGNMENT, TRANSFER, ADJUSTMENT all land in adjustments and may
          // be negative.
          delta.appropriationAdjustments = a.amount;
      }

      const resultingRevised =
        balance.appropriationRevised + (a.amount ?? 0);

      if (resultingRevised < 0) {
        throw new HttpsError(
          'failed-precondition',
          `This adjustment would drive the appropriation for ${appropriationLineLabel(a)} to ${(resultingRevised / 100).toFixed(2)}. An appropriation cannot be negative.`,
        );
      }

      // A downward adjustment may not cut below allotments already released.
      if (resultingRevised < balance.allotmentReleased) {
        throw new HttpsError(
          'failed-precondition',
          `This adjustment would reduce the appropriation for ${appropriationLineLabel(a)} to ${(resultingRevised / 100).toFixed(2)}, below the ${(balance.allotmentReleased / 100).toFixed(2)} already released as allotment. Withdraw the allotment first.`,
        );
      }

      applyBudgetDelta(tx, key, balance, delta, {
        officeName: a.officeName ?? '',
        accountName: a.accountName ?? '',
        fppName: a.fppName ?? '',
        sector: a.sector ?? null,
        serviceSector: a.serviceSector ?? null,
        expenseClass: a.expenseClass,
      });

      applySummaryDelta(tx, a.fiscalYear, a.fundCode, { appropriationRevised: a.amount });

      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'APPROVED',
        postedAt: now,
        approvedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
      });

      recordTransition(tx, {
        caller,
        event: 'APPROVE',
        entityType: COL.appropriations,
        entityId: appropriationId,
        entityRef: `${a.kind} appropriation ${a.accountCode}`,
        fiscalYear: a.fiscalYear,
        fundCode: a.fundCode,
        action: 'APPROVE',
        previousStatus: 'DRAFT',
        newStatus: 'APPROVED',
        remarks: `${a.authorityReference ?? 'No authority reference'} - ${(a.amount / 100).toFixed(2)}`,
      });

      return {
        appropriationId,
        budgetBalanceId: `${key.fiscalYear}__${key.fundCode}__${key.officeId}`,
      };
    });
  },
);

/**
 * releaseAllotment - the first budget control gate.
 *
 * Enforces: cumulative allotments <= revised appropriation, per budget line.
 * As with obligations, the appropriation figure is read here, transactionally,
 * and never taken from the request.
 */
export const releaseAllotment = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, BUDGET_APPROVERS);
    const { allotmentId } = (request.data ?? {}) as { allotmentId?: string };
    if (!allotmentId) throw invalid('An allotment id is required.');

    const numberingConfig = await loadNumberingConfig('ALLOT');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.allotments).doc(allotmentId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The allotment');

      const al = snap.data() as BudgetKey & {
        allotmentNo?: string;
        allotmentDate: string;
        amount: number;
        status: string;
        officeName: string;
        accountName: string;
        fppName?: string;
        sector?: string;
        serviceSector?: string;
        expenseClass: string;
      };

      if (al.status !== 'DRAFT') {
        throw new HttpsError(
          'failed-precondition',
          `This allotment is already ${al.status.toLowerCase()}.`,
        );
      }

      assertFundInScope(caller, al.fundCode);
      await assertFiscalYearOpen(al.fiscalYear, tx);

      const key: BudgetKey = {
        fiscalYear: al.fiscalYear,
        fundCode: al.fundCode,
        officeId: al.officeId,
        responsibilityCenterId: al.responsibilityCenterId ?? null,
        programId: al.programId ?? null,
        projectId: al.projectId ?? null,
        activityId: al.activityId ?? null,
        fppCode: al.fppCode,
        accountCode: al.accountCode,
      };

      const balance = await readBudgetBalance(tx, key);

      if (al.amount >= 0) {
        /*
         * -------------------------------------------------------------------
         * AN ALLOTMENT IS RELEASED BY ORDER, AND ONLY BY ORDER
         * -------------------------------------------------------------------
         * The Budget Operations Manual releases allotment on an Allotment
         * Release Order - LBE Form No. 1 and its three siblings - recommended
         * by the Local Budget Officer and approved by the Local Chief
         * Executive. There is no other instrument.
         *
         * This callable used to release a single line on its own, with no
         * order number, no purpose and no approval. Worse, it did not read
         * the For Later Release hold at all: an amount the Budget Officer had
         * deliberately withheld could be released straight through here, and
         * nothing anywhere said so. A safeguard with a door beside it is not
         * a safeguard.
         *
         * What is left is the WITHDRAWAL of allotment, below. That genuinely
         * is not an order - it takes authority back rather than giving it -
         * and it has its own rule.
         */
        throw new HttpsError(
          'failed-precondition',
          'An allotment is released on an Allotment Release Order, not one line at a time. ' +
            'Use Budget \u203a Allotment Release Orders, where the order carries its number, its ' +
            'purpose, the approval of the Local Chief Executive and the For Later Release column. ' +
            'This screen records a WITHDRAWAL of allotment, which is a negative amount.',
        );
      } else {
        const check = checkAllotmentWithdrawal({
          allotmentAlreadyReleased: balance.allotmentReleased,
          obligated: balance.obligated,
          requestedWithdrawal: al.amount,
        });
        if (!check.ok) {
          throw new HttpsError(
            'failed-precondition',
            `Cannot withdraw ${(Math.abs(al.amount) / 100).toFixed(2)} from ${al.accountCode} ${al.accountName}: ` +
              `that would leave ${((balance.allotmentReleased + al.amount) / 100).toFixed(2)} released against ` +
              `${(balance.obligated / 100).toFixed(2)} already obligated. Cancel the obligations first.`,
            check.violations[0].details,
          );
        }
      }

      const bookCode = al.allotmentNo ? '' : await bookCodeForFund(al.fundCode);
      const allotmentNo =
        al.allotmentNo ??
        (await issueNumber(tx, numberingConfig, {
          bookCode,
          fundCode: al.fundCode,
          fiscalYear: al.fiscalYear,
          month: Number(al.allotmentDate.slice(5, 7)),
        }));

      const updated = applyBudgetDelta(
        tx,
        key,
        balance,
        { allotmentReleased: al.amount },
        { officeName: al.officeName, accountName: al.accountName, expenseClass: al.expenseClass },
      );

      applySummaryDelta(tx, al.fiscalYear, al.fundCode, { allotmentReleased: al.amount });

      const now = new Date().toISOString();
      tx.update(ref, {
        allotmentNo,
        status: 'APPROVED',
        postedAt: now,
        approvedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
      });

      recordTransition(tx, {
        caller,
        event: 'APPROVE',
        entityType: COL.allotments,
        entityId: allotmentId,
        entityRef: `Allotment ${allotmentNo}`,
        fiscalYear: al.fiscalYear,
        fundCode: al.fundCode,
        action: 'APPROVE',
        previousStatus: 'DRAFT',
        newStatus: 'APPROVED',
        remarks: `${al.accountCode} ${al.accountName}: ${(al.amount / 100).toFixed(2)}`,
      });

      return {
        allotmentId,
        allotmentNo,
        availableAppropriation: updated.availableAppropriation,
      };
    });
  },
);


/*
 * ---------------------------------------------------------------------------
 * APPROVING AN UPLOADED ORDINANCE, WHOLE
 * ---------------------------------------------------------------------------
 * Since patch 112 an ordinance file lands its lines as DRAFTS. Four hundred
 * lines approved one press at a time is not a control, it is a chore that
 * gets skipped - so the Budget Officer may approve the whole upload at once,
 * having read it in the ledger.
 *
 * ALL OR NOTHING, as the upload is. Every line is checked first - what it must
 * carry, and the arithmetic against the books - and if any line fails, none is
 * approved and every failing line is named. Only then is it posted, in
 * transactions of at most BATCH lines (Firestore takes 500 writes in one), each
 * re-reading the lines and the balances it posts against. A line approved by
 * itself in the meantime is skipped, not approved twice.
 */
const BATCH = 150;

type Caller = Awaited<ReturnType<typeof requireCaller>>;

interface StoredLine extends BudgetKey {
  kind: string;
  amount: number;
  status: string;
  officeName?: string;
  accountName?: string;
  fppName?: string;
  sector?: string | null;
  serviceSector?: string | null;
  expenseClass: string;
  importLineNo?: number;
  authorityReference?: string;
}

const keyOf = (a: StoredLine): BudgetKey => ({
  fiscalYear: a.fiscalYear,
  fundCode: a.fundCode,
  officeId: a.officeId,
  responsibilityCenterId: a.responsibilityCenterId ?? null,
  programId: a.programId ?? null,
  projectId: a.projectId ?? null,
  activityId: a.activityId ?? null,
  fppCode: a.fppCode,
  accountCode: a.accountCode,
});

const toApprovalLine = (id: string, a: StoredLine): ApprovalLine => ({
  id,
  keyId: budgetKeyId(keyOf(a)),
  kind: a.kind,
  amount: a.amount,
  label: `row ${a.importLineNo ?? '?'} (${appropriationLineLabel(a)}, ${a.officeName ?? a.officeId})`,
});

async function approveUploadedOrdinance(
  caller: Caller,
  upload: { fiscalYear?: number; fundCode?: string; reference?: string },
) {
  const fiscalYear = Number(upload.fiscalYear);
  const fundCode = String(upload.fundCode ?? '').trim();
  const reference = String(upload.reference ?? '').trim();
  if (!Number.isInteger(fiscalYear) || !fundCode || !reference) {
    throw invalid('The fiscal year, the fund and the ordinance reference are all required.');
  }
  assertFundInScope(caller, fundCode);

  const query = db
    .collection(COL.appropriations)
    .where('fiscalYear', '==', fiscalYear)
    .where('fundCode', '==', fundCode)
    .where('importReference', '==', reference)
    .where('status', '==', 'DRAFT');

  // ---- check every line, before any is approved ---------------------------
  const all = await query.get();
  if (all.empty) {
    throw new HttpsError(
      'not-found',
      `Nothing from ${reference} is waiting for approval. It may already have been approved.`,
    );
  }

  const problems: string[] = [];
  for (const doc of all.docs) {
    const a = doc.data() as StoredLine;
    const missing = appropriationApprovalProblems({
      fundCode: a.fundCode,
      officeId: a.officeId,
      fppCode: a.fppCode,
      accountCode: a.accountCode,
      expenseClass: a.expenseClass,
    });
    if (missing.length)
      problems.push(`row ${a.importLineNo ?? doc.id} is missing its ${missing.join(', ')}`);
    if (typeof a.amount !== 'number' || !Number.isFinite(a.amount)) {
      problems.push(`row ${a.importLineNo ?? doc.id} has no usable amount`);
    }
  }

  /*
   * Patch 123: the act behind the upload - recorded, signed copy attached,
   * financed for the whole of what is being approved. Checked before any
   * line, so an ordinance is refused whole rather than half approved.
   */
  if (!problems.length) {
    const acts = new Map<string, { kind: ReturnType<typeof actKindOfLine>; reference: string; adding: number }>();
    for (const d of all.docs) {
      const a = d.data() as StoredLine & { instrument?: string; importReference?: string };
      const kind = actKindOfLine(a);
      if (!kind) {
        // Patch 129: no ungated kind becomes authority.
        problems.push(`row ${a.importLineNo ?? d.id} is a ${a.kind.toLowerCase()}, which is no longer approved`);
        continue;
      }
      const ref = (a.authorityReference ?? a.importReference ?? reference).trim();
      const k = `${kind}|${ref}`;
      const cur = acts.get(k) ?? { kind, reference: ref, adding: 0 };
      cur.adding += a.amount ?? 0;
      acts.set(k, cur);
    }
    if (!problems.length) {
      for (const act of acts.values()) {
        await assertActReady({ fiscalYear, fundCode, kind: act.kind!, reference: act.reference }, act.adding);
      }
    }
  }

  if (!problems.length) {
    const lines = all.docs.map((d) => toApprovalLine(d.id, d.data() as StoredLine));
    const keys = new Map<string, BudgetKey>();
    for (const d of all.docs) {
      const k = keyOf(d.data() as StoredLine);
      keys.set(budgetKeyId(k), k);
    }
    const snaps = await db.getAll(...[...keys.values()].map((k) => budgetBalanceRef(k)));
    const balances = new Map(
      [...keys.keys()].map((id, i) => [id, { ...EMPTY_BALANCE, ...(snaps[i].data() ?? {}) }]),
    );
    problems.push(...planAppropriationApproval(lines, balances).problems);
  }

  if (problems.length) {
    throw new HttpsError(
      'failed-precondition',
      `${problems.length} line${problems.length === 1 ? '' : 's'} of ${reference} cannot be ` +
        'approved, so none was. An ordinance becomes authority whole or not at all. ' +
        problems.slice(0, 10).join('; ') +
        (problems.length > 10 ? `; and ${problems.length - 10} more.` : '.'),
      { problems },
    );
  }

  // ---- post, in transactions of at most BATCH lines -----------------------
  const ids = all.docs.map((d) => d.id);
  let approved = 0;
  let total = 0;

  for (let start = 0; start < ids.length; start += BATCH) {
    const chunk = ids.slice(start, start + BATCH);
    const result = await db.runTransaction(async (tx) => {
      await assertFiscalYearOpen(fiscalYear, tx);

      const refs = chunk.map((id) => db.collection(COL.appropriations).doc(id));
      const docs = (await tx.getAll(...refs)) as DocumentSnapshot[];
      const waiting = docs.filter((d) => d.exists && (d.data() as StoredLine).status === 'DRAFT');
      if (!waiting.length) return { approved: 0, total: 0 };

      const stored = waiting.map((d) => ({ id: d.id, a: d.data() as StoredLine }));
      const keys = new Map<string, BudgetKey>();
      for (const { a } of stored) keys.set(budgetKeyId(keyOf(a)), keyOf(a));
      const keyIds = [...keys.keys()];
      const balanceList = await Promise.all(
        keyIds.map((id) => readBudgetBalance(tx, keys.get(id)!)),
      );
      const balances = new Map(keyIds.map((id, i) => [id, balanceList[i]]));

      const plan = planAppropriationApproval(
        stored.map(({ id, a }) => toApprovalLine(id, a)),
        balances,
      );
      if (!plan.ok) {
        throw new HttpsError(
          'failed-precondition',
          `The books moved while ${reference} was being approved: ${plan.problems[0]}. ` +
            `${approved} line${approved === 1 ? '' : 's'} had been approved before this; the rest were not.`,
        );
      }

      // ---- writes ----------------------------------------------------------
      const byId = new Map(stored.map(({ id, a }) => [id, a]));
      for (const [keyId, entry] of plan.byKey) {
        const first = byId.get(entry.lineIds[0])!;
        applyBudgetDelta(tx, keys.get(keyId)!, balances.get(keyId)!, entry.delta, {
          officeName: first.officeName ?? '',
          accountName: first.accountName ?? '',
          fppName: first.fppName ?? '',
          sector: first.sector ?? null,
          serviceSector: first.serviceSector ?? null,
          expenseClass: first.expenseClass,
        });
      }
      applySummaryDelta(tx, fiscalYear, fundCode, { appropriationRevised: plan.total });

      const now = new Date().toISOString();
      const approvedBy = {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: now,
      };
      for (const { id } of stored) {
        tx.update(db.collection(COL.appropriations).doc(id), {
          status: 'APPROVED',
          postedAt: now,
          approvedBy,
        });
      }

      recordTransition(tx, {
        caller,
        event: 'APPROVE',
        entityType: COL.appropriations,
        entityId: reference,
        entityRef: `Ordinance ${reference} - approved as uploaded`,
        fiscalYear,
        fundCode,
        action: 'APPROVE',
        previousStatus: 'DRAFT',
        newStatus: 'APPROVED',
        remarks: `${stored.length} lines, ${(plan.total / 100).toFixed(2)}.`,
      });

      return { approved: stored.length, total: plan.total };
    });
    approved += result.approved;
    total += result.total;
  }

  return { approved, total, reference };
}
