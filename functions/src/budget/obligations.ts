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
  applyBudgetDeltaRunning,
  applySummaryDelta,
  budgetBalanceRef,
  type BudgetBalanceData,
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

      /*
       * Patch 177: certifying no longer requires the approved form to be
       * attached. The papers are required where the books are written - at
       * the voucher's approval. If something IS attached, certifying closes it
       * as before; with nothing attached the record stays open for the scan.
       */
      const hasPaper = !(
        await tx.get(
          db
            .collection(COL.documents)
            .where('entityType', '==', COL.obligations)
            .where('entityId', '==', obligationId)
            .where('active', '==', true)
            .limit(1),
        )
      ).empty;

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

      const requestedOnLine = new Map<string, number>(); // patch 180
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

        // Patch 180: earlier lines of this obligation on the same budget line
        // count against it too.
        const path = budgetBalanceRef(key).path;
        const earlier = requestedOnLine.get(path) ?? 0;
        requestedOnLine.set(path, earlier + line.amount);

        const check = checkObligationAgainstAllotment({
          allotmentReleased: balance.allotmentReleased,
          alreadyObligated: balance.obligated + earlier,
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
      const obrNo = String(obr.obrNo || obrNoIn || '').trim();
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
      /*
       * A reservation belonging to THIS obligation is not a clash.
       *
       * It is what is left behind when the Budget Officer undoes a
       * certification: the number stays attached to the obligation so that
       * nobody else can take it while the staff correct the lines, and
       * re-certifying must therefore be allowed to walk back on to it.
       */
      const reservedHere =
        reservationSnap.exists &&
        (reservationSnap.data() as { documentId?: string }).documentId === obligationId;

      if (reservationSnap.exists && !reservedHere) {
        throw new HttpsError(
          'already-exists',
          `Obligation Request number ${obrNo} has already been used in ${obr.fiscalYear} for the ${obr.fundCode} fund on another obligation. Each number is used once.`,
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

      const runningBalances = new Map<string, BudgetBalanceData>(); // patch 180
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

        applyBudgetDeltaRunning(
          tx,
          runningBalances,
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
      if (!reservedHere) {
        tx.create(reservationRef, {
          docType: 'OBR',
          number: obrNo,
          fiscalYear: obr.fiscalYear,
          fundCode: obr.fundCode,
          documentId: obligationId,
          assignedBy: { uid: caller.uid, name: caller.name, at: now },
        });
      }

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
        /*
         * The supporting documents close here too.
         *
         * The certificate says this officer saw those papers and committed
         * the municipality's allotment on them. A scan that could be swapped
         * afterwards is not evidence of anything, and the signature would be
         * attached to a file nobody can prove was there.
         *
         * Written as the same field the manual closing writes, so the rule on
         * /documents has one thing to consult. The screen used to work this
         * out from the status alone, which left the database accepting an
         * upload the screen had refused.
         *
         * Not cleared by uncertifyObligation. Taking a certification back
         * lets the FIGURES be corrected; it does not unsee the papers, and a
         * closing that can be reopened proves nothing about what was closed.
         */
        ...(hasPaper
          ? {
              attachmentsLockedAt: now,
              attachmentsLockedBy: {
                uid: caller.uid,
                name: caller.name,
                position: caller.position ?? null,
                at: now,
              },
            }
          : {}),
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
     * WHERE THE LINE IS DRAWN: the Municipal Accountant's approval.
     *
     * An APPROVED or PAID voucher has committed the obligation - the entry is
     * raised, the money may already be out - and no cancellation here can
     * undo that. It is refused, and the voucher is named so the user knows
     * what to deal with first.
     *
     * A voucher still in DRAFT, SUBMITTED or REVIEWED has committed nothing.
     * Those are cancelled along with the obligation rather than standing in
     * its way, because the alternative is worse in both directions: leaving
     * them alive points them at an obligation that has released its allotment
     * back to the budget, and the first anybody would know of it is the
     * voucher failing at approval days later with no obvious cause; refusing
     * the cancellation over a draft makes the Budget Office chase an
     * unfinished voucher in another section before it can correct its own
     * register.
     *
     * Outside the transaction, because Firestore cannot run a query inside
     * one. The window is a voucher raised in the seconds between this read
     * and the commit.
     */
    const drawnOn = await db
      .collection(COL.disbursementVouchers)
      .where('obligationId', '==', obligationId)
      .get();

    const live = drawnOn.docs
      .map((d) => ({ id: d.id, ...(d.data() as { dvNo?: string; status?: string }) }))
      .filter((d) => d.status !== 'CANCELLED');

    const committed = live.filter((d) => d.status === 'APPROVED' || d.status === 'PAID');
    const unfinished = live.filter((d) => d.status !== 'APPROVED' && d.status !== 'PAID');

    if (committed.length > 0) {
      const named = committed
        .map((d) => d.dvNo)
        .filter(Boolean)
        .join(', ');
      throw new HttpsError(
        'failed-precondition',
        `The Municipal Accountant has already approved ${
          committed.length === 1 ? 'a disbursement voucher' : `${committed.length} disbursement vouchers`
        }${named ? ` (${named})` : ''} against this obligation, so it cannot be cancelled. Undo the approval, or cancel the voucher, and the obligation is free again.`,
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

      // Patch 180: fund scope, the year open, and the vouchers re-read inside
      // the transaction - one approved since the query above is not cancelled.
      assertFundInScope(caller, obr.fundCode);
      await assertFiscalYearOpen(obr.fiscalYear, tx);
      const unfinishedSnaps = await Promise.all(
        unfinished.map((d) => tx.get(db.collection(COL.disbursementVouchers).doc(d.id))),
      );
      const nowCommitted = unfinishedSnaps.find((d) =>
        ['APPROVED', 'PAID'].includes(String(d.data()?.status ?? '')),
      );
      if (nowCommitted) {
        throw new HttpsError(
          'failed-precondition',
          `DV ${String(nowCommitted.data()?.dvNo ?? '')} was approved a moment ago against this obligation. Undo that approval first.`,
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
        const runningBalances = new Map<string, BudgetBalanceData>(); // patch 180
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
          applyBudgetDeltaRunning(
            tx,
            runningBalances,
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

      /*
       * The unfinished vouchers go with it.
       *
       * None of them has committed anything - consumption happens at the
       * Accountant's approval, and the guard above has already refused if any
       * voucher reached it - so there is nothing to reverse. What there is, is
       * a voucher pointing at an obligation that no longer carries a balance,
       * and leaving it alive only defers the discovery to the day somebody
       * tries to approve it.
       */
      for (const dv of unfinished.filter((_, k) => unfinishedSnaps[k]?.data()?.status !== 'CANCELLED')) {
        tx.update(db.collection(COL.disbursementVouchers).doc(dv.id), {
          status: 'CANCELLED',
          cancelledReason: `The obligation it draws on was cancelled: ${reason.trim()}`,
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
          entityType: COL.disbursementVouchers,
          entityId: dv.id,
          entityRef: `DV ${dv.dvNo ?? dv.id}`,
          fiscalYear: obr.fiscalYear,
          fundCode: obr.fundCode,
          action: 'CANCEL',
          previousStatus: dv.status ?? 'DRAFT',
          newStatus: 'CANCELLED',
          remarks: `Cancelled with OBR ${obr.obrNo ?? obligationId}. ${reason.trim()}`,
          severity: 'NOTICE',
        });
      }

      return {
        obligationId,
        cancelledVouchers: unfinished.map((d) => d.dvNo ?? d.id),
      };
    });
  },
);

/**
 * uncertifyObligation - the Budget Officer takes the certification back.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT "CANCEL"
 * ---------------------------------------------------------------------------
 * An officer who certifies an obligation and then sees that a line is wrong
 * has, until now, had one route: cancel it and encode the whole thing again.
 * That is a heavy price for a typo, and the predictable result is that nobody
 * pays it - the wrong figure is left alone and corrected by a second
 * obligation later, which is how a registry fills with entries nobody can
 * reconcile against a single request.
 *
 * So the certification can be taken back. The obligation returns to DRAFT, the
 * allotment it committed goes back to the budget line, and the staff correct
 * it and submit it again.
 *
 * ---------------------------------------------------------------------------
 * THE LINE IT MAY NOT CROSS
 * ---------------------------------------------------------------------------
 * Not once the Accountant has approved a disbursement voucher against it. At
 * that point the voucher has consumed part of the obligation, a journal entry
 * has been prepared on it, and a payment is on its way out of the municipality
 * - and an obligation that can be edited underneath all of that is an
 * obligation that proves nothing.
 *
 * A voucher that is still a draft, or submitted, or reviewed, does NOT stop
 * this: nothing has been committed on it yet. It is named in the refusal-free
 * path anyway, because the staff correcting the obligation need to know the
 * voucher exists and may now disagree with it.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBER STAYS
 * ---------------------------------------------------------------------------
 * The OBR keeps its number and its reservation. The Budget Office wrote that
 * number in its book against this request; releasing it would let another
 * obligation take it while this one is being corrected, and the book and CFMS
 * would then disagree about which request it belongs to. Certifying again
 * walks back on to the same reservation.
 */
export const uncertifyObligation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, CERTIFYING_ROLES);
    const { obligationId, reason } = (request.data ?? {}) as {
      obligationId?: string;
      reason?: string;
    };

    if (!obligationId) throw invalid('An obligation id is required.');
    if (!reason?.trim()) {
      throw invalid(
        'A reason is required. Undoing a certification is a reversal of a budget control and is recorded as one.',
      );
    }

    // Outside the transaction: Firestore cannot run a query inside one.
    const vouchers = await db
      .collection(COL.disbursementVouchers)
      .where('obligationId', '==', obligationId)
      .get();

    const live = vouchers.docs
      .map((d) => d.data() as { dvNo?: string; status?: string })
      .filter((d) => d.status !== 'CANCELLED');

    const committed = live.filter((d) => d.status === 'APPROVED' || d.status === 'PAID');
    if (committed.length > 0) {
      const named = committed.map((d) => d.dvNo).filter(Boolean).join(', ');
      throw new HttpsError(
        'failed-precondition',
        `The Municipal Accountant has already approved ${
          committed.length === 1 ? 'a disbursement voucher' : `${committed.length} disbursement vouchers`
        }${named ? ` (${named})` : ''} against this obligation, so the certification cannot be taken back. Cancel the voucher first, or correct the figure with a second obligation.`,
      );
    }

    return db.runTransaction(async (tx) => {
      // ---- READ PHASE -------------------------------------------------------
      const ref = db.collection(COL.obligations).doc(obligationId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The obligation');

      const obr = snap.data() as {
        obrNo?: string;
        fiscalYear: number;
        fundCode: string;
        status: string;
        totalAmount: number;
        disbursedAmount?: number;
        lines: Array<
          BudgetKey & {
            lineNo: number;
            officeName: string;
            accountName: string;
            appropriatedAccountCode?: string;
            trustProgramId?: string;
            expenseClass: string;
            amount: number;
          }
        >;
      };

      assertFundInScope(caller, obr.fundCode); // patch 180
      if (obr.status !== 'OBLIGATED') {
        throw new HttpsError(
          'failed-precondition',
          `Only a certified obligation can be uncertified. This one is ${obr.status
            .toLowerCase()
            .replace('_', ' ')}.`,
        );
      }
      if ((obr.disbursedAmount ?? 0) > 0) {
        throw new HttpsError(
          'failed-precondition',
          `OBR ${obr.obrNo} has ${((obr.disbursedAmount ?? 0) / 100).toFixed(2)} disbursed against it. The certification cannot be taken back.`,
        );
      }

      await assertFiscalYearOpen(obr.fiscalYear, tx);

      const isTrust = String(obr.fundCode ?? '').trim().toUpperCase() === 'TF';
      const balances = new Map<number, Awaited<ReturnType<typeof readBudgetBalance>>>();
      const trustPrograms = new Map<string, TrustProgramData>();
      const trustAmounts = new Map<string, number>();

      if (isTrust) {
        for (const line of obr.lines) {
          const programId = String(line.trustProgramId ?? '').trim();
          if (!programId) continue;
          trustAmounts.set(programId, (trustAmounts.get(programId) ?? 0) + line.amount);
        }
        for (const programId of trustAmounts.keys()) {
          trustPrograms.set(programId, await readTrustProgram(tx, programId));
        }
      } else {
        for (const line of obr.lines) {
          balances.set(line.lineNo, await readBudgetBalance(tx, budgetKeyForLine(obr, line)));
        }
      }

      // ---- WRITE PHASE ------------------------------------------------------
      if (!isTrust) {
        const runningBalances = new Map<string, BudgetBalanceData>(); // patch 180
        for (const line of obr.lines) {
          applyBudgetDeltaRunning(
            tx,
            runningBalances,
            budgetKeyForLine(obr, line),
            balances.get(line.lineNo)!,
            { obligated: -line.amount },
            {
              officeName: line.officeName,
              accountName: line.accountName,
              expenseClass: line.expenseClass,
            },
          );
        }
        applySummaryDelta(tx, obr.fiscalYear, obr.fundCode, { obligated: -obr.totalAmount });
      }

      for (const [programId, amount] of trustAmounts) {
        applyTrustDelta(tx, programId, trustPrograms.get(programId)!, { utilised: -amount });
      }

      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'DRAFT',
        // The certification is gone, so the record of who made it goes with
        // it - but not silently: the workflow history below keeps both acts.
        certifiedAt: null,
        certifiedBy: null,
        unpaidAmount: 0,
        uncertifiedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
          reason: reason.trim(),
        },
      });

      recordTransition(tx, {
        caller,
        event: 'BUDGET_OVERRIDE',
        entityType: COL.obligations,
        entityId: obligationId,
        entityRef: `OBR ${obr.obrNo ?? obligationId}`,
        fiscalYear: obr.fiscalYear,
        fundCode: obr.fundCode,
        action: 'REOPEN',
        previousStatus: 'OBLIGATED',
        newStatus: 'DRAFT',
        remarks: `Certification taken back, ${(obr.totalAmount / 100).toFixed(2)} of allotment released. Reason: ${reason.trim()}${
          live.length > 0
            ? `. Note: ${live.length} voucher(s) already draw on this obligation (${live.map((d) => d.dvNo ?? 'draft').join(', ')}).`
            : ''
        }`,
        // A control being reversed is exactly what an auditor filters for.
        severity: 'CRITICAL',
      });

      return {
        obligationId,
        obrNo: obr.obrNo ?? null,
        vouchersDrawingOnIt: live.map((d) => d.dvNo ?? 'draft'),
      };
    });
  },
);

/**
 * The budget key an obligation line draws on.
 *
 * Keyed on the object code the APPROPRIATION carried, which is empty on a
 * project line - never the object this line commits. On a third of the FY2025
 * ordinance those differ, and keying on the wrong one would look for a balance
 * that does not exist.
 */
function budgetKeyForLine(
  obr: { fiscalYear: number; fundCode: string },
  line: BudgetKey & { appropriatedAccountCode?: string },
): BudgetKey {
  return {
    fiscalYear: line.fiscalYear ?? obr.fiscalYear,
    fundCode: line.fundCode ?? obr.fundCode,
    officeId: line.officeId,
    responsibilityCenterId: line.responsibilityCenterId ?? null,
    programId: line.programId ?? null,
    projectId: line.projectId ?? null,
    activityId: line.activityId ?? null,
    fppCode: line.fppCode,
    accountCode: line.appropriatedAccountCode ?? '',
  };
}
