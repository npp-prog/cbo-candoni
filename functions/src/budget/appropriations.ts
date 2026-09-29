import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, notFound, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertFiscalYearOpen } from '../lib/period';
import {
  readBudgetBalance,
  applyBudgetDelta,
  applySummaryDelta,
  type BudgetKey,
  type BudgetBalanceData,
} from '../lib/budget';
import { checkAllotmentAgainstAppropriation, checkAllotmentWithdrawal } from '../lib/rules';

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
    const { appropriationId } = (request.data ?? {}) as { appropriationId?: string };
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
      };

      if (a.status !== 'DRAFT') {
        throw new HttpsError(
          'failed-precondition',
          `This appropriation is already ${a.status.toLowerCase()}. Record a supplemental appropriation or an adjustment instead of re-approving.`,
        );
      }

      assertFundInScope(caller, a.fundCode);
      await assertFiscalYearOpen(a.fiscalYear, tx);

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
          `This adjustment would drive the appropriation for ${a.accountCode} ${a.accountName} to ${(resultingRevised / 100).toFixed(2)}. An appropriation cannot be negative.`,
        );
      }

      // A downward adjustment may not cut below allotments already released.
      if (resultingRevised < balance.allotmentReleased) {
        throw new HttpsError(
          'failed-precondition',
          `This adjustment would reduce the appropriation for ${a.accountCode} ${a.accountName} to ${(resultingRevised / 100).toFixed(2)}, below the ${(balance.allotmentReleased / 100).toFixed(2)} already released as allotment. Withdraw the allotment first.`,
        );
      }

      applyBudgetDelta(tx, key, balance, delta, {
        officeName: a.officeName,
        accountName: a.accountName,
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
        const check = checkAllotmentAgainstAppropriation({
          appropriationRevised: balance.appropriationRevised,
          allotmentAlreadyReleased: balance.allotmentReleased,
          requestedRelease: al.amount,
        });
        if (!check.ok) {
          const d = check.violations[0].details as Record<string, number>;
          throw new HttpsError(
            'failed-precondition',
            `Insufficient appropriation for ${al.accountCode} ${al.accountName}: ` +
              `${(al.amount / 100).toFixed(2)} requested against ${(d.available / 100).toFixed(2)} available, ` +
              `short by ${(d.excess / 100).toFixed(2)}. A supplemental appropriation or a realignment is needed first.`,
            check.violations[0].details,
          );
        }
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
