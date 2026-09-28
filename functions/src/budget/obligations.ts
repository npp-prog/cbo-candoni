import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import {
  requireCaller,
  CERTIFYING_ROLES,
  assertFundInScope,
  notFound,
  invalid,
} from '../lib/context';
import { recordTransition, auditInTransaction, notifyInTransaction } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import {
  readBudgetBalance,
  applyBudgetDelta,
  applySummaryDelta,
  type BudgetKey,
} from '../lib/budget';
import { checkObligationAgainstAllotment } from '../lib/rules';

/**
 * certifyObligation - the budget control gate.
 *
 * This is the function the architectural rule in the specification is about.
 * The client sends an obligation id and, at most, a request to override. It
 * does NOT send the available allotment, and if it did, the figure would be
 * ignored. Every balance used in the decision below is read from Firestore
 * inside the transaction that will commit the certification.
 *
 * What happens here, in order:
 *   1. Authorise: only the Budget Officer (or an administrator) may certify.
 *   2. Read the obligation and confirm it is in a certifiable state.
 *   3. Confirm the accounting period and fiscal year are open.
 *   4. For every line, read the authoritative budget balance and test the
 *      obligation against the available allotment.
 *   5. If any line fails and no valid override was supplied, refuse - with a
 *      message naming the line and the shortfall, because "insufficient
 *      allotment" with no figures is useless to the person who has to fix it.
 *   6. Draw the OBR number from the counter, inside the same transaction.
 *   7. Write the obligation, the updated balances, the workflow event and the
 *      audit record atomically.
 *
 * Any failure at any step rolls all of it back. There is no state in which an
 * OBR number has been consumed but the obligation was not certified.
 */
export const certifyObligation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, CERTIFYING_ROLES);
    const { obligationId, override } = (request.data ?? {}) as {
      obligationId?: string;
      override?: { reason?: string };
    };

    if (!obligationId) throw invalid('An obligation id is required.');
    if (override && !override.reason?.trim()) {
      throw invalid('An override requires a written reason. It is recorded on the OBR and in the audit trail.');
    }

    // Settings and numbering config are read outside the transaction: they are
    // configuration, not balances, and reading them inside would add needless
    // contention.
    const settingsSnap = await db.collection(COL.settings).doc('general').get();
    const settings = settingsSnap.data() ?? {};
    const overrideAllowed =
      settings.allowBudgetOverride !== false &&
      (Array.isArray(settings.budgetOverrideRoles)
        ? caller.roles.some((r) => settings.budgetOverrideRoles.includes(r))
        : caller.roles.includes('SUPER_ADMIN'));

    if (override && !overrideAllowed) {
      throw new HttpsError(
        'permission-denied',
        'Your role may not obligate beyond the available allotment. The Municipal Budget Officer or an administrator must certify this obligation.',
      );
    }

    const numberingConfig = await loadNumberingConfig('OBR');

    return db.runTransaction(async (tx) => {
      // ---- READ PHASE -------------------------------------------------------
      // Firestore forbids reads after writes inside a transaction, so every
      // read the decision needs happens first.

      const obrRef = db.collection(COL.obligations).doc(obligationId);
      const obrSnap = await tx.get(obrRef);
      if (!obrSnap.exists) throw notFound('The obligation');

      const obr = obrSnap.data() as {
        obrNo?: string;
        obrDate: string;
        attachmentCount?: number;
        fiscalYear: number;
        fundCode: string;
        officeId: string;
        officeName: string;
        payeeName: string;
        particulars: string;
        status: string;
        totalAmount: number;
        lines: Array<
          BudgetKey & {
            lineNo: number;
            officeName: string;
            accountName: string;
            expenseClass: string;
            amount: number;
          }
        >;
      };

      if (!['DRAFT', 'SUBMITTED', 'BUDGET_REVIEWED', 'RETURNED'].includes(obr.status)) {
        throw new HttpsError(
          'failed-precondition',
          `This obligation is ${obr.status.toLowerCase().replace('_', ' ')} and cannot be certified again.`,
        );
      }

      assertFundInScope(caller, obr.fundCode);

      /**
       * The approved form has to be on file before the number is issued.
       *
       * The form is the Obligation Request and Status in the General and
       * Special Education Funds, and the Funding Utilization Request and
       * Status in the Trust Fund - where the money is held for somebody else
       * and is not the municipality's own appropriation to obligate.
       *
       * Certifying consumes a serial from a gapless series. A number issued
       * against a commitment whose approved form is in nobody's file leaves a
       * permanent entry that the RAAO foots and the auditor cannot trace, and
       * cancelling it afterwards does not give the number back. The browser
       * disables the button for the same reason, but the browser is not the
       * authority: this is.
       */
      if (!(obr.attachmentCount ?? 0)) {
        const formName = obr.fundCode?.trim().toUpperCase() === 'TF' ? 'FURS' : 'OBR';
        throw new HttpsError(
          'failed-precondition',
          `Attach the approved ${formName} before certifying. Certifying consumes a number from a gapless series, and a numbered commitment with no approved form behind it cannot be traced or given back.`,
        );
      }

      const period = periodOf(obr.obrDate);
      await assertFiscalYearOpen(obr.fiscalYear, tx);
      await assertPeriodOpen(
        obr.fiscalYear,
        period,
        obr.fundCode,
        `Obligation dated ${obr.obrDate}`,
        tx,
      );

      if (!obr.lines?.length) {
        throw invalid('The obligation has no budget lines.');
      }

      // Recompute the total from the lines. The stored total is a
      // convenience field written by the client and is not trusted.
      const computedTotal = obr.lines.reduce((s, l) => s + l.amount, 0);
      if (computedTotal !== obr.totalAmount) {
        throw invalid(
          `The obligation total of ${(obr.totalAmount / 100).toFixed(2)} does not match the sum of its lines, ${(computedTotal / 100).toFixed(2)}. Reopen and re-save the OBR.`,
        );
      }

      // Read every budget line's authoritative balance.
      const balances = new Map<number, Awaited<ReturnType<typeof readBudgetBalance>>>();
      const shortfalls: Array<{
        lineNo: number;
        accountCode: string;
        accountName: string;
        available: number;
        requested: number;
        excess: number;
      }> = [];

      for (const line of obr.lines) {
        const key: BudgetKey = {
          fiscalYear: line.fiscalYear ?? obr.fiscalYear,
          fundCode: line.fundCode ?? obr.fundCode,
          officeId: line.officeId,
          responsibilityCenterId: line.responsibilityCenterId ?? null,
          programId: line.programId ?? null,
          projectId: line.projectId ?? null,
          activityId: line.activityId ?? null,
          accountCode: line.accountCode,
        };

        const balance = await readBudgetBalance(tx, key);
        balances.set(line.lineNo, balance);

        const check = checkObligationAgainstAllotment({
          allotmentReleased: balance.allotmentReleased,
          alreadyObligated: balance.obligated,
          requestedObligation: line.amount,
        });

        if (!check.ok) {
          const d = check.violations[0].details as Record<string, number> | undefined;
          shortfalls.push({
            lineNo: line.lineNo,
            accountCode: line.accountCode,
            accountName: line.accountName,
            available: d?.available ?? balance.allotmentReleased - balance.obligated,
            requested: line.amount,
            excess: d?.excess ?? 0,
          });
        }
      }

      // Draw the OBR number. Read of the counter happens here, still in the
      // read phase of this transaction.
      const bookCode = obr.obrNo ? '' : await bookCodeForFund(obr.fundCode);
      const obrNo =
        obr.obrNo ??
        (await issueNumber(tx, numberingConfig, {
          bookCode,
          fundCode: obr.fundCode,
          fiscalYear: obr.fiscalYear,
          month: period,
        }));

      // ---- DECISION ---------------------------------------------------------

      if (shortfalls.length > 0 && !override) {
        const worst = shortfalls[0];
        throw new HttpsError(
          'failed-precondition',
          `Insufficient allotment on line ${worst.lineNo} (${worst.accountCode} ${worst.accountName}): ` +
            `${(worst.requested / 100).toFixed(2)} requested against ${(worst.available / 100).toFixed(2)} available, ` +
            `short by ${(worst.excess / 100).toFixed(2)}. Release additional allotment, realign the budget, ` +
            `or reduce the obligation.`,
          { shortfalls },
        );
      }

      // ---- WRITE PHASE ------------------------------------------------------

      const now = new Date().toISOString();
      const totalExcess = shortfalls.reduce((s, f) => s + f.excess, 0);

      for (const line of obr.lines) {
        const key: BudgetKey = {
          fiscalYear: line.fiscalYear ?? obr.fiscalYear,
          fundCode: line.fundCode ?? obr.fundCode,
          officeId: line.officeId,
          responsibilityCenterId: line.responsibilityCenterId ?? null,
          programId: line.programId ?? null,
          projectId: line.projectId ?? null,
          activityId: line.activityId ?? null,
          accountCode: line.accountCode,
        };

        applyBudgetDelta(
          tx,
          key,
          balances.get(line.lineNo)!,
          { obligated: line.amount },
          {
            officeName: line.officeName,
            accountName: line.accountName,
            expenseClass: line.expenseClass,
          },
        );
      }

      applySummaryDelta(tx, obr.fiscalYear, obr.fundCode, { obligated: computedTotal });

      tx.update(obrRef, {
        obrNo,
        status: 'OBLIGATED',
        certifiedAt: now,
        certifiedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
        disbursedAmount: 0,
        unpaidAmount: computedTotal,
        ...(shortfalls.length > 0 && override
          ? {
              override: {
                by: {
                  uid: caller.uid,
                  name: caller.name,
                  position: caller.position ?? null,
                  at: now,
                },
                reason: override.reason!.trim(),
                availableAtOverride: shortfalls.reduce((s, f) => s + f.available, 0),
                amountExceeded: totalExcess,
              },
            }
          : {}),
      });

      recordTransition(tx, {
        caller,
        event: 'CERTIFY',
        entityType: COL.obligations,
        entityId: obligationId,
        entityRef: `OBR ${obrNo}`,
        fiscalYear: obr.fiscalYear,
        fundCode: obr.fundCode,
        action: 'CERTIFY',
        previousStatus: obr.status,
        newStatus: 'OBLIGATED',
        assignedToRole: 'ACCOUNTING_ENCODER',
        remarks: `Certified as to availability of allotment. ${obr.payeeName}, ${(computedTotal / 100).toFixed(2)}.`,
      });

      // An override gets its own CRITICAL audit record in addition to the
      // certification record, so that a review filtered to critical events
      // surfaces every instance without needing to know what to look for.
      if (shortfalls.length > 0 && override) {
        auditInTransaction(tx, {
          caller,
          event: 'BUDGET_OVERRIDE',
          entityType: COL.obligations,
          entityId: obligationId,
          entityRef: `OBR ${obrNo}`,
          fiscalYear: obr.fiscalYear,
          fundCode: obr.fundCode,
          severity: 'CRITICAL',
          remarks:
            `Obligated ${(totalExcess / 100).toFixed(2)} beyond available allotment. ` +
            `Reason given: ${override.reason!.trim()}`,
          changes: shortfalls.map((f) => ({
            field: `line ${f.lineNo} ${f.accountCode}`,
            previous: { availableAllotment: f.available },
            next: { obligated: f.requested, excess: f.excess },
          })),
        });

        notifyInTransaction(tx, {
          recipientRole: 'MUNICIPAL_ACCOUNTANT',
          kind: 'DEADLINE',
          title: 'Obligation certified beyond available allotment',
          body: `OBR ${obrNo} (${obr.officeName}) exceeded available allotment by ${(totalExcess / 100).toFixed(2)}. Reason: ${override.reason!.trim()}`,
          entityType: COL.obligations,
          entityId: obligationId,
          link: `/budget/obligations/${obligationId}`,
          severity: 'CRITICAL',
        });
      }

      return {
        obrNo,
        lines: obr.lines.map((l) => ({
          lineNo: l.lineNo,
          availableAllotment:
            (balances.get(l.lineNo)?.allotmentReleased ?? 0) -
            (balances.get(l.lineNo)?.obligated ?? 0) -
            l.amount,
        })),
      };
    });
  },
);

/**
 * cancelObligation - releases the committed allotment back to the line.
 *
 * Refused once any part of the obligation has been disbursed: the money has
 * left, and the correct treatment is a refund or an adjusting entry, not a
 * cancellation that would silently restore budget authority already spent.
 */
export const cancelObligation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, CERTIFYING_ROLES);
    const { obligationId, reason } = (request.data ?? {}) as {
      obligationId?: string;
      reason?: string;
    };

    if (!obligationId) throw invalid('An obligation id is required.');
    if (!reason?.trim()) throw invalid('A reason for cancellation is required.');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.obligations).doc(obligationId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The obligation');

      const obr = snap.data() as {
        obrNo?: string;
        obrDate: string;
        fiscalYear: number;
        fundCode: string;
        status: string;
        totalAmount: number;
        disbursedAmount: number;
        lines: Array<BudgetKey & { lineNo: number; officeName: string; accountName: string; expenseClass: string; amount: number }>;
      };

      if (obr.status === 'CANCELLED') {
        throw new HttpsError('failed-precondition', 'This obligation is already cancelled.');
      }
      if ((obr.disbursedAmount ?? 0) > 0) {
        throw new HttpsError(
          'failed-precondition',
          `OBR ${obr.obrNo} already has ${(obr.disbursedAmount / 100).toFixed(2)} disbursed against it and cannot be cancelled. Cancel or reverse the disbursement vouchers first.`,
        );
      }

      const wasObligated = obr.status === 'OBLIGATED';
      const balances = new Map<number, Awaited<ReturnType<typeof readBudgetBalance>>>();

      if (wasObligated) {
        for (const line of obr.lines) {
          const key: BudgetKey = {
            fiscalYear: line.fiscalYear ?? obr.fiscalYear,
            fundCode: line.fundCode ?? obr.fundCode,
            officeId: line.officeId,
            responsibilityCenterId: line.responsibilityCenterId ?? null,
            programId: line.programId ?? null,
            projectId: line.projectId ?? null,
            activityId: line.activityId ?? null,
            accountCode: line.accountCode,
          };
          balances.set(line.lineNo, await readBudgetBalance(tx, key));
        }
      }

      if (wasObligated) {
        for (const line of obr.lines) {
          const key: BudgetKey = {
            fiscalYear: line.fiscalYear ?? obr.fiscalYear,
            fundCode: line.fundCode ?? obr.fundCode,
            officeId: line.officeId,
            responsibilityCenterId: line.responsibilityCenterId ?? null,
            programId: line.programId ?? null,
            projectId: line.projectId ?? null,
            activityId: line.activityId ?? null,
            accountCode: line.accountCode,
          };
          applyBudgetDelta(
            tx,
            key,
            balances.get(line.lineNo)!,
            { obligated: -line.amount },
            { officeName: line.officeName, accountName: line.accountName, expenseClass: line.expenseClass },
          );
        }
        applySummaryDelta(tx, obr.fiscalYear, obr.fundCode, { obligated: -obr.totalAmount });
      }

      tx.update(ref, {
        status: 'CANCELLED',
        cancelledReason: reason.trim(),
        unpaidAmount: 0,
        cancelledBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: new Date().toISOString(),
        },
      });

      recordTransition(tx, {
        caller,
        event: 'CANCEL',
        entityType: COL.obligations,
        entityId: obligationId,
        entityRef: `OBR ${obr.obrNo ?? obligationId}`,
        fiscalYear: obr.fiscalYear,
        fundCode: obr.fundCode,
        action: 'CANCEL',
        previousStatus: obr.status,
        newStatus: 'CANCELLED',
        remarks: reason.trim(),
        severity: 'NOTICE',
      });

      return { obligationId };
    });
  },
);
