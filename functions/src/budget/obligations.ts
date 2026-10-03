import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import {
  requireCaller,
  CERTIFYING_ROLES,
  assertFundInScope,
  notFound,
  invalid,
} from '../lib/context';
import { recordTransition, auditInTransaction, notifyInTransaction } from '../lib/audit';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import {
  readBudgetBalance,
  applyBudgetDelta,
  applySummaryDelta,
  type BudgetKey,
} from '../lib/budget';
import { checkObligationAgainstAllotment } from '../lib/rules';
import { checkFursAgainstProgram } from '../lib/trustPrograms';
import {
  readTrustProgram,
  applyTrustDelta,
  type TrustProgramData,
} from '../accounting/trustPrograms';

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
    const { obligationId, obrNo: obrNoIn, override } = (request.data ?? {}) as {
      obligationId?: string;
      obrNo?: string;
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
            /** The object code the appropriation carried; empty on a project line. */
            appropriatedAccountCode?: string;
            /**
             * The Trust Fund programme this line utilises.
             *
             * Present only in the Trust Fund, where there is no appropriation
             * and no allotment and the programme is what the commitment is
             * checked against.
             */
            trustProgramId?: string;
            trustProgramName?: string;
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

      /*
       * ---------------------------------------------------------------------
       * WHICH CONTROL APPLIES
       * ---------------------------------------------------------------------
       * The General and Special Education Funds are controlled by the
       * appropriation the Sanggunian enacted, released as allotment. The Trust
       * Fund has no ordinance behind it at all - the money is not the
       * municipality's - so it is controlled by the programme it was received
       * under, and its commitment is a Funding Utilization Request rather than
       * an Obligation Request.
       *
       * Until this branch existed, every fund was checked against
       * `allotmentReleased`, the Trust Fund included. A FURS could therefore
       * not be certified unless somebody first invented an appropriation and
       * an Allotment Release Order for trust money - and those invented
       * figures would have gone into the Statement of Receipts and
       * Expenditures and into the bases of the Personal Services cap and the
       * LDRRMF as though the municipality had been given money it had not.
       */
      const isTrust = String(obr.fundCode ?? '').trim().toUpperCase() === 'TF';

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

      /** Trust Fund only: the programmes touched, read once each. */
      const trustPrograms = new Map<string, TrustProgramData>();
      /** Trust Fund only: what this FURS utilises per programme. */
      const trustRequested = new Map<string, number>();

      if (isTrust) {
        /*
         * Lines on the same programme are summed before the programme is read.
         *
         * Checking each line against the same balance would let two lines of
         * one FURS, each fitting on its own, together pass the programmed
         * amount - and both would be written, because neither read sees the
         * other.
         */
        for (const line of obr.lines) {
          const programId = String(line.trustProgramId ?? '').trim();
          if (!programId) {
            throw new HttpsError(
              'failed-precondition',
              `Line ${line.lineNo} names no trust programme. A utilisation in the Trust Fund is ` +
                'charged to the programme the money was received under - there is no ' +
                'appropriation to charge it to.',
            );
          }
          trustRequested.set(programId, (trustRequested.get(programId) ?? 0) + line.amount);
        }

        for (const [programId, requested] of trustRequested) {
          const program = await readTrustProgram(tx, programId);
          trustPrograms.set(programId, program);

          const check = checkFursAgainstProgram({
            programmed: program.programmed,
            alreadyUtilised: program.utilised,
            requestedUtilisation: requested,
            status: program.status,
          });

          if (!check.ok) {
            /*
             * No override here, unlike the allotment check below.
             *
             * An over-obligation in the General Fund is a decision the
             * municipality may take about its own appropriation, recorded and
             * answered for. Trust money is not the municipality's to decide
             * about: passing the programmed amount spends somebody else's
             * money beyond the plan they approved, and no official of this
             * municipality can authorise that.
             */
            throw new HttpsError(
              'failed-precondition',
              `${program.programCode} ${program.programName}: ${check.violations[0].message} ` +
                'Nothing was certified.',
              { violations: check.violations, programId, programCode: program.programCode },
            );
          }
        }
      }

      for (const line of isTrust ? [] : obr.lines) {
        const key: BudgetKey = {
          fiscalYear: line.fiscalYear ?? obr.fiscalYear,
          fundCode: line.fundCode ?? obr.fundCode,
          officeId: line.officeId,
          responsibilityCenterId: line.responsibilityCenterId ?? null,
          programId: line.programId ?? null,
          projectId: line.projectId ?? null,
          activityId: line.activityId ?? null,
          fppCode: line.fppCode,
          // The object code the APPROPRIATION carried, which is empty on a
          // project line - never the object this line commits. On a third of
          // the FY2025 ordinance those differ, and keying on the wrong one
          // would look for a balance that does not exist.
          accountCode: line.appropriatedAccountCode ?? '',
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
      /*
       * ---- THE OBR NUMBER IS TYPED IN, NOT DRAWN ------------------------
       *
       * The Budget Office assigns it from its own book before certifying.
       * CFMS does not generate it, because the number on the paper the Head
       * of Office signed is the number this record has to carry - and a
       * system that issues its own would quietly produce a second series
       * that disagrees with the office's.
       *
       * What CFMS does instead is refuse a DUPLICATE. The reservation
       * document below has a deterministic id, so two certifications on the
       * same number cannot both create it: uniqueness is a database
       * constraint, not an application check that a race can slip past.
       *
       * Read here, in the read phase. The create is in the write phase.
       */
      /*
       * The number is on the DRAFT, put there by the budget staff who encoded
       * it from the office's book. What arrives in the request is a fallback
       * for an older draft that has none.
       *
       * IT IS ALWAYS RESERVED HERE, never skipped. An earlier version skipped
       * the reservation when the obligation already carried a number, on the
       * reasoning that a numbered obligation had already been certified. That
       * stopped being true the moment staff could type the number on the
       * draft - and the effect would have been that every obligation numbered
       * before certification bypassed the uniqueness check entirely, which is
       * the one thing the reservation exists for. The status guard above is
       * what prevents a second certification, not the presence of a number.
       */
      const obrNo = String(obr.obrNo ?? obrNoIn ?? '').trim();
      if (!obrNo) {
        throw invalid(
          'An Obligation Request number is required. Assign it on the obligation from the Budget Office book before certifying.',
        );
      }
      if (obrNo.length > 40) {
        throw invalid('That Obligation Request number is too long.');
      }

      const reservationRef = db
        .collection(COL.documentNumbers)
        .doc(`OBR__${obr.fiscalYear}__${obr.fundCode}__${obrNo.toUpperCase()}`);
      const reservationSnap = await tx.get(reservationRef);
      if (reservationSnap.exists) {
        const prior = reservationSnap.data() as { documentId?: string };
        throw new HttpsError(
          'already-exists',
          `Obligation Request number ${obrNo} has already been used in ${obr.fiscalYear} for the ${obr.fundCode} fund${
            prior.documentId === obligationId ? '' : ' on another obligation'
          }. Each number is used once.`,
        );
      }

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

      for (const line of isTrust ? [] : obr.lines) {
        const key: BudgetKey = {
          fiscalYear: line.fiscalYear ?? obr.fiscalYear,
          fundCode: line.fundCode ?? obr.fundCode,
          officeId: line.officeId,
          responsibilityCenterId: line.responsibilityCenterId ?? null,
          programId: line.programId ?? null,
          projectId: line.projectId ?? null,
          activityId: line.activityId ?? null,
          fppCode: line.fppCode,
          // The object code the APPROPRIATION carried, which is empty on a
          // project line - never the object this line commits. On a third of
          // the FY2025 ordinance those differ, and keying on the wrong one
          // would look for a balance that does not exist.
          accountCode: line.appropriatedAccountCode ?? '',
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

      /*
       * A utilisation moves the programme and NOTHING in the budget.
       *
       * No budget balance, no budget summary. Trust money was never
       * appropriated, and a figure written into `budgetBalances` for it would
       * surface as expenditure in the Statement of Comparison of Budget and
       * Actual Amounts against an appropriation that does not exist.
       */
      for (const [programId, requested] of trustRequested) {
        applyTrustDelta(tx, programId, trustPrograms.get(programId)!, { utilised: requested });
      }

      if (!isTrust) {
        applySummaryDelta(tx, obr.fiscalYear, obr.fundCode, { obligated: computedTotal });
      }

      // The reservation, created in the same transaction as the certification.
      // Either both land or neither does, so there is no state in which a
      // number is reserved against an obligation that was not certified.
      tx.create(reservationRef, {
        docType: 'OBR',
        number: obrNo,
        fiscalYear: obr.fiscalYear,
        fundCode: obr.fundCode,
        documentId: obligationId,
        assignedBy: { uid: caller.uid, name: caller.name, at: now },
      });

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
        entityRef: `${isTrust ? 'FURS' : 'OBR'} ${obrNo}`,
        fiscalYear: obr.fiscalYear,
        fundCode: obr.fundCode,
        action: 'CERTIFY',
        previousStatus: obr.status,
        newStatus: 'OBLIGATED',
        assignedToRole: 'ACCOUNTING_ENCODER',
        // The Trust Fund has no allotment, so certifying one is not a
        // certification as to its availability. Saying so anyway would put a
        // sentence in the audit trail that describes a control that was never
        // applied.
        remarks:
          (isTrust
            ? 'Certified as to availability of the trust programme.'
            : 'Certified as to availability of allotment.') +
          ` ${obr.payeeName}, ${(computedTotal / 100).toFixed(2)}.`,
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

    /*
     * ---- AN OBLIGATION THAT IS ALREADY ON A VOUCHER IS NOT CANCELLED ----
     *
     * `disbursedAmount` only moves when a voucher is APPROVED, so a check on
     * that alone let an OBR be cancelled out from under a voucher that was
     * already drawn on it and sitting in Accounting for review. The voucher
     * would then refer to an obligation that had released its allotment back
     * to the budget - and the first anybody would know of it is the voucher
     * failing at approval, days later, with no obvious cause.
     *
     * So: ANY voucher that is not cancelled stops this, draft included.
     *
     * Outside the transaction, because Firestore cannot run a query inside
     * one. The window is a voucher raised in the seconds between this read
     * and the commit, and the consequence of losing that race is the thing
     * that happens today in every case.
     */
    const drawnOn = await db
      .collection(COL.disbursementVouchers)
      .where('obligationId', '==', obligationId)
      .get();

    const live = drawnOn.docs
      .map((d) => d.data() as { dvNo?: string; status?: string })
      .filter((d) => d.status !== 'CANCELLED');

    if (live.length > 0) {
      const named = live
        .map((d) => d.dvNo)
        .filter(Boolean)
        .join(', ');
      throw new HttpsError(
        'failed-precondition',
        `This obligation is already on ${live.length === 1 ? 'a disbursement voucher' : `${live.length} disbursement vouchers`}${
          named ? ` (${named})` : ''
        } and cannot be cancelled. Cancel the voucher first; the obligation is then free again.`,
      );
    }

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
        lines: Array<
          BudgetKey & {
            lineNo: number;
            officeName: string;
            accountName: string;
            /** The object code the appropriation carried; empty on a project line. */
            appropriatedAccountCode?: string;
            /** Trust Fund only: the programme this line utilises. */
            trustProgramId?: string;
            expenseClass: string;
            amount: number;
          }
        >;
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
      const cancelIsTrust = String(obr.fundCode ?? '').trim().toUpperCase() === 'TF';
      const balances = new Map<number, Awaited<ReturnType<typeof readBudgetBalance>>>();

      /*
       * Cancelling a utilisation must give the programme back what it took.
       *
       * Missing this is the shape of bug that never errors: the FURS goes to
       * CANCELLED, the register looks right, and the programme quietly keeps
       * the commitment for the rest of its life. The money would be
       * unspendable and nothing would say why.
       */
      const cancelTrustPrograms = new Map<string, TrustProgramData>();
      const cancelTrustAmounts = new Map<string, number>();

      if (wasObligated && cancelIsTrust) {
        for (const line of obr.lines) {
          const programId = String(line.trustProgramId ?? '').trim();
          if (!programId) continue;
          cancelTrustAmounts.set(
            programId,
            (cancelTrustAmounts.get(programId) ?? 0) + line.amount,
          );
        }
        for (const programId of cancelTrustAmounts.keys()) {
          cancelTrustPrograms.set(programId, await readTrustProgram(tx, programId));
        }
      }

      if (wasObligated && !cancelIsTrust) {
        for (const line of obr.lines) {
          const key: BudgetKey = {
            fiscalYear: line.fiscalYear ?? obr.fiscalYear,
            fundCode: line.fundCode ?? obr.fundCode,
            officeId: line.officeId,
            responsibilityCenterId: line.responsibilityCenterId ?? null,
            programId: line.programId ?? null,
            projectId: line.projectId ?? null,
            activityId: line.activityId ?? null,
            fppCode: line.fppCode,
            // The object code the APPROPRIATION carried, which is empty on a
            // project line - never the object this line commits. On a third of
            // the FY2025 ordinance those differ, and keying on the wrong one
            // would look for a balance that does not exist.
            accountCode: line.appropriatedAccountCode ?? '',
          };
          balances.set(line.lineNo, await readBudgetBalance(tx, key));
        }
      }

      if (wasObligated && !cancelIsTrust) {
        for (const line of obr.lines) {
          const key: BudgetKey = {
            fiscalYear: line.fiscalYear ?? obr.fiscalYear,
            fundCode: line.fundCode ?? obr.fundCode,
            officeId: line.officeId,
            responsibilityCenterId: line.responsibilityCenterId ?? null,
            programId: line.programId ?? null,
            projectId: line.projectId ?? null,
            activityId: line.activityId ?? null,
            fppCode: line.fppCode,
            // The object code the APPROPRIATION carried, which is empty on a
            // project line - never the object this line commits. On a third of
            // the FY2025 ordinance those differ, and keying on the wrong one
            // would look for a balance that does not exist.
            accountCode: line.appropriatedAccountCode ?? '',
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

      for (const [programId, amount] of cancelTrustAmounts) {
        applyTrustDelta(tx, programId, cancelTrustPrograms.get(programId)!, {
          utilised: -amount,
        });
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
