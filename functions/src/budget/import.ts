import { programDocId } from '../lib/budgetPrograms';
import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { assertActDocumented } from './actGate';
import { actKindOfInstrument } from '../lib/budgetActs';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, invalid, hasRole, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { assertFiscalYearOpen } from '../lib/period';
import {
  readBudgetBalance,
  budgetKeyId,
  applyBudgetDelta,
  applySummaryDelta,
  type BudgetKey,
  type BudgetBalanceData,
} from '../lib/budget';
import {
  checkAllotmentAgainstAppropriation,
  checkAugmentationExpenseClass,
  checkRealignmentSet,
  checkRealignableBalances,
  heldTakenByRealignment,
} from '../lib/rules';
import { findSector } from '../lib/sectors';
import { postingFromPreparedSet, preparedSetId, type PreparedSet } from './preparedSets';
import type { DocumentReference, Timestamp } from 'firebase-admin/firestore';

/**
 * Uploading the appropriation ordinance and allotment releases.
 *
 * A municipal budget is four to six hundred lines - every account, for every
 * office - and it already exists as a spreadsheet annexed to the ordinance the
 * Sanggunian enacted. Typing it in a second time is a week of work and a
 * guarantee that the two copies will differ somewhere nobody looks.
 *
 * ---------------------------------------------------------------------------
 * Why this one refuses the whole file, where the treasury upload does not
 * ---------------------------------------------------------------------------
 *
 * The RCI upload holds the rows it cannot place and lets the rest through,
 * because the usual cause is another office being behind on its encoding and
 * refusing forty rows over one would stop the office using the upload at all.
 *
 * This is the opposite case and takes the opposite rule. An appropriation
 * ordinance is ONE authority. Posting 380 of its 400 lines does not give the
 * municipality a partial budget - it gives it a WRONG budget, one that appears
 * complete, foots to a total nobody will reconcile against the ordinance, and
 * silently under-authorises twenty lines until an office is refused an
 * obligation months later for no visible reason.
 *
 * And unlike a missing voucher, every reason a budget row fails is fixable on
 * the spot by the people doing the upload: add the office, add the account to
 * the Chart of Accounts, correct the spelling. Nobody is waiting on anybody.
 *
 * So: all of it posts, or none of it does, and the reply names every row that
 * has to be fixed rather than the first one.
 *
 * ---------------------------------------------------------------------------
 * Posting the same ordinance twice
 * ---------------------------------------------------------------------------
 *
 * This is the failure that would do real damage, and it is easy to reach - a
 * slow upload, an uncertain click, a second attempt. Appropriations are
 * additive, so a repeat does not error: it silently doubles the municipality's
 * spending authority, and the budget looks plausible at every level except the
 * ordinance itself.
 *
 * Each line therefore has a document id derived from the authority reference
 * and its row number. A second upload of the same ordinance finds those ids
 * already taken and is refused before it writes anything, naming them. That is
 * a database constraint rather than a check that could be forgotten.
 */

const BUDGET_APPROVERS: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER'];

/**
 * Who may PREPARE allotment from a file. Budget Staff as well as the Budget
 * Officer, since patch 110: an allotment upload no longer releases anything,
 * it fills prepared orders that only the Budget Officer can approve - which is
 * the same division of work as an order typed by hand. An appropriation upload
 * still posts enacted authority and stays with the approvers.
 */
const BUDGET_PREPARERS: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER', 'BUDGET_STAFF'];

type ImportKind = 'APPROPRIATION' | 'ALLOTMENT';

/**
 * Rows per call.
 *
 * Firestore allows 500 writes in a transaction. Each row writes its own
 * document and contributes to one budget-balance document, so 150 rows is at
 * most 300 writes with the summary and the audit trail alongside. A larger
 * ordinance is sent in several calls, each atomic in itself; the browser drives
 * that and the deterministic ids stop a repeated part from posting twice.
 */
const MAX_ROWS = 150;

interface RawRow {
  lineNo?: number;
  office?: string;
  /** The FPP as the ordinance writes it: an object code, or a project name. */
  fpp?: string;
  fppName?: string;
  sector?: string;
  serviceSector?: string;
  accountCode?: string;
  expenseClass?: string;
  amount?: number;
  particulars?: string;
}

interface Resolved {
  lineNo: number;
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  sector: string;
  serviceSector: string | null;
  /** Empty on a project line: the ordinance named no object of expenditure. */
  accountCode: string;
  accountName: string;
  expenseClass: string;
  amount: number;
  particulars: string | null;
  /** True when the FPP is a programme rather than an object code. */
  isProgramme: boolean;
}

/** An object code of the Revised Chart of Accounts, e.g. 5-02-03-010. */
const OBJECT_CODE = /^\d-\d\d-\d\d-\d\d\d$/;

const peso = (c: number) => (c / 100).toFixed(2);

/** A reference made safe for a document id, which may not contain a slash. */
function slug(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

export const importBudgetLines = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, BUDGET_PREPARERS);
    const data = (request.data ?? {}) as {
      kind?: string;
      fiscalYear?: number;
      fundCode?: string;
      appropriationKind?: string;
      reference?: string;
      date?: string;
      fileName?: string;
      /** For a realignment: which instrument it was made under. */
      instrument?: string;
      rows?: unknown;
      /**
       * Approving a PREPARED augmentation or realignment: the set's id, and
       * nothing else. Every other field is read from the stored set and
       * whatever the request carries is overwritten. Patch 112.
       */
      draftId?: string;
    };

    const kind = data.kind as ImportKind;
    if (kind !== 'APPROPRIATION' && kind !== 'ALLOTMENT') {
      throw invalid('An upload is either appropriations or allotments.');
    }

    /*
     * ---------------------------------------------------------------------
     * WHAT THIS CALL MAY POST, SINCE PATCH 112
     * ---------------------------------------------------------------------
     * Exactly one thing: a PREPARED augmentation or realignment, named by its
     * id, approved by the Budget Officer. Everything else that comes through
     * here only PREPARES, and so is open to Budget Staff:
     *
     *   an ordinance file           lands its lines as DRAFT appropriations,
     *                               approved on the Appropriations screen
     *   a realignment or            lands as one prepared set, approved on
     *   augmentation file           the same screen as one typed by hand
     *   an allotment file           lands as prepared release orders (p110)
     *
     * The approval reads the set from the database - the request's own rows,
     * reference and date are replaced by the stored set's - so what is posted
     * is what was prepared.
     */
    const draftId = String(data.draftId ?? '').trim() || null;
    let fromDraft: { ref: DocumentReference; updateTime: Timestamp | undefined } | null = null;
    if (draftId) {
      if (kind !== 'APPROPRIATION') {
        throw invalid('Only a prepared augmentation or realignment is approved by its id here.');
      }
      if (!hasRole(caller, ...BUDGET_APPROVERS)) {
        throw new HttpsError(
          'permission-denied',
          "Approving an augmentation or a realignment is the Budget Officer's. Budget Staff may " +
            'prepare one; the Budget Officer approves it.',
        );
      }
      const snap = await db.collection(COL.augmentationDrafts).doc(draftId).get();
      if (!snap.exists) {
        throw new HttpsError(
          'not-found',
          'That prepared set is no longer there - it has already been posted, or it was ' +
            'discarded. Nothing was posted.',
        );
      }
      const posting = postingFromPreparedSet(snap.data() as PreparedSet);
      data.fiscalYear = posting.fiscalYear;
      data.fundCode = posting.fundCode;
      data.appropriationKind = posting.appropriationKind;
      data.instrument = posting.instrument;
      data.reference = posting.reference;
      data.date = posting.date;
      data.fileName = posting.fileName;
      data.rows = posting.rows;
      fromDraft = { ref: snap.ref, updateTime: snap.updateTime };
    }

    const fiscalYear = Number(data.fiscalYear);
    if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');
    const fundCode = String(data.fundCode ?? '').trim();
    if (!fundCode) throw invalid('A fund is required.');

    const reference = String(data.reference ?? '').trim();
    if (!reference) {
      throw invalid(
        kind === 'APPROPRIATION'
          ? 'The ordinance or resolution number is required. It is what stops the same ordinance being posted twice.'
          : 'A reference for this release is required. It is what stops the same release being posted twice.',
      );
    }
    const refSlug = slug(reference);
    if (!refSlug) throw invalid('That reference has no letters or digits in it.');

    /*
     * Patch 123: a prepared realignment or augmentation is posted only under
     * a recorded act with its signed copy attached. Its sources are its own
     * lines - the set must come to zero, checked below.
     */
    if (fromDraft) {
      await assertActDocumented({
        fiscalYear: Number(data.fiscalYear),
        fundCode: String(data.fundCode ?? '').trim(),
        kind: actKindOfInstrument(String(data.instrument ?? '')),
        reference,
      });
    }

    const date = String(data.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw invalid('A date is required, as year-month-day - for example 2026-01-05.');
    }

    const appropriationKind = String(data.appropriationKind ?? 'ORIGINAL').toUpperCase();
    if (
      kind === 'APPROPRIATION' &&
      !['ORIGINAL', 'SUPPLEMENTAL', 'CONTINUING', 'REALIGNMENT'].includes(appropriationKind)
    ) {
      // TRANSFER is deliberately absent. It was withdrawn from the screen as a
      // choice, and a kind the office cannot pick but the server still accepts
      // is a restriction that only looks like one. Appropriations already
      // recorded as transfers are untouched and still approve normally: this
      // guards new uploads, not history.
      throw invalid(
        appropriationKind === 'TRANSFER'
          ? 'Transfers are no longer recorded as an appropriation type. A movement of authority between offices is a realignment, which must come to zero.'
          : appropriationKind === 'ADJUSTMENT'
            ? // Patch 129: withdrawn at the office's request, as TRANSFER was.
              'Adjustments are no longer recorded. Authority changes by an act - an ordinance, an augmentation or a continuing appropriation - recorded under Appropriations > Authorities.'
            : `Unknown appropriation type ${appropriationKind}.`,
      );
    }
    const signed = appropriationKind === 'REALIGNMENT';
    const isRealignment = kind === 'APPROPRIATION' && appropriationKind === 'REALIGNMENT';
    /** An appropriation call that is not the approval of a prepared set: it prepares. */
    const preparing = kind === 'APPROPRIATION' && !fromDraft;

    /**
     * Which of the two acts this is.
     *
     * Defaulting to the realignment would be the permissive choice - a
     * realignment may cross expense classes - and it would let a call that
     * simply omitted the field escape the augmentation rule entirely. So it
     * must SAY, and an unrecognised value is refused rather than falling back
     * to the one that checks less.
     */
    const instrument = String(data.instrument ?? '').trim().toUpperCase();
    // SUPPLEMENTAL is the value this field carried for a realignment before
    // the two acts were named properly. Still accepted so that anything
    // recorded under it keeps working; nothing writes it any more.
    if (isRealignment && !['REALIGNMENT', 'SUPPLEMENTAL', 'AUGMENTATION'].includes(instrument)) {
      throw invalid(
        'This must say which of the two acts it is. An AUGMENTATION under Section 336 moves ' +
          'savings within ONE expense class - Personal Services to Personal Services, MOOE to ' +
          'MOOE, Capital Outlay to Capital Outlay - and the Local Chief Executive signs it under ' +
          'the omnibus authority in the General Provisions. A REALIGNMENT under Section 321 moves ' +
          'authority ACROSS expense classes and takes an ordinance of the Sanggunian.',
      );
    }

    const raw = data.rows;
    if (!Array.isArray(raw) || raw.length === 0) throw invalid('The file has no rows to post.');
    if (raw.length > MAX_ROWS) {
      throw invalid(
        isRealignment
          ? `A realignment must be sent whole so that it can be checked as one set, and one call takes at most ${MAX_ROWS} rows; this one carried ${raw.length}. Split it into separate balanced realignments.`
          : `One call takes at most ${MAX_ROWS} rows; this one carried ${raw.length}.`,
      );
    }

    assertFundInScope(caller, fundCode);

    // ---- resolve every row against master data ----------------------------
    //
    // Offices and the Chart of Accounts are read outside the transaction. They
    // are master data - they do not change while an ordinance is being posted -
    // and reading them per row inside the transaction would be hundreds of
    // reads to answer the same few questions.

    const [officeSnap, accountSnap] = await Promise.all([
      db.collection(COL.offices).get(),
      db.collection(COL.accounts).get(),
    ]);

    const offices = new Map<string, { id: string; name: string }>();
    for (const doc of officeSnap.docs) {
      const o = doc.data() as { code?: string; name?: string; shortName?: string; active?: boolean };
      if (o.active === false) continue;
      const entry = { id: doc.id, name: o.name ?? doc.id };
      for (const alias of [o.code, o.name, o.shortName]) {
        if (alias) offices.set(alias.trim().toUpperCase(), entry);
      }
    }

    const accounts = new Map<
      string,
      { name: string; postable?: boolean; active?: boolean; expenseClass?: string }
    >();
    for (const doc of accountSnap.docs) {
      const a = doc.data() as {
        code?: string;
        name?: string;
        postable?: boolean;
        active?: boolean;
        expenseClass?: string;
      };
      if (a.code) accounts.set(a.code.trim(), a as never);
    }

    const problems: Array<{ lineNo: number; problem: string }> = [];
    const resolved: Resolved[] = [];

    (raw as RawRow[]).forEach((row, i) => {
      const lineNo = Number(row.lineNo ?? i + 1);
      const add = (problem: string) => problems.push({ lineNo, problem });

      const amount = Math.round(Number(row.amount));
      if (!Number.isFinite(amount) || amount === 0) {
        add('no readable amount');
        return;
      }
      if (amount < 0 && !signed) {
        add(
          `a negative amount of ${peso(amount)}, which only a realignment, transfer or adjustment may carry`,
        );
        return;
      }

      const officeKey = String(row.office ?? '').trim().toUpperCase();
      if (!officeKey) {
        add('no office');
        return;
      }
      const office = offices.get(officeKey);
      if (!office) {
        add(`office "${row.office}" is not in Master Data`);
        return;
      }

      /**
       * The FPP, and what kind of FPP it is.
       *
       * An object code from the Revised Chart of Accounts means the ordinance
       * appropriated by object of expenditure, and the object IS the budget
       * line. Anything else means it appropriated by project, and there is no
       * object of expenditure until an obligation is raised.
       *
       * Both are FPPs. Which kind it is decides only where the name comes from
       * and whether an account code is required.
       */
      const fppCode = String(row.fpp ?? '').trim();
      if (!fppCode) {
        add('no FPP');
        return;
      }
      const isObjectCode = OBJECT_CODE.test(fppCode);

      // An explicit account code column wins; otherwise the FPP is the object
      // code when it looks like one, and there is none when it does not.
      const accountCode = String(row.accountCode ?? '').trim() || (isObjectCode ? fppCode : '');

      let account: { name?: string; postable?: boolean; active?: boolean; expenseClass?: string } | undefined;
      if (accountCode) {
        account = accounts.get(accountCode);
        if (!account) {
          add(`account ${accountCode} is not in the Chart of Accounts`);
          return;
        }
        if (account.postable === false) {
          add(`account ${accountCode} is a grouping account and cannot carry a budget`);
          return;
        }
        if (account.active === false) {
          add(`account ${accountCode} has been deactivated`);
          return;
        }
      }

      const expenseClass = String(row.expenseClass ?? account?.expenseClass ?? '')
        .trim()
        .toUpperCase();
      if (!['PS', 'MOOE', 'FE', 'CO'].includes(expenseClass)) {
        add(
          `no expense classification - the file does not say and there is no account code to take one from`,
        );
        return;
      }

      /**
       * Personnel services are appropriated by object of expenditure. Always.
       *
       * Nineteen lines of the FY2025 ordinance carry the FPP "Year End" and two
       * carry "V/L Leave Benefit/Monetization of Leave Credits" - personnel
       * objects whose codes exist in the Revised Chart of Accounts and were
       * simply left out of the spreadsheet. Accepting them as projects would
       * put the year-end bonus in the SRE among the capital projects, and by
       * the time an obligation had been raised against it, moving it would mean
       * unwinding the obligation as well.
       */
      if (expenseClass === 'PS' && !accountCode) {
        add(
          `"${fppCode}" has no account code, and personnel services are appropriated by object of expenditure - give this line its code from the Revised Chart of Accounts`,
        );
        return;
      }

      /**
       * The sector, and the two that are not sectors.
       *
       * The SRE has four expenditure buckets and the 20% Development Fund and
       * the LDRRMF are neither of them - they are where the money came from,
       * not what it bought. A project under one of those must say which
       * service it delivers, or it cannot be reported at all.
       */
      const sector = String(row.sector ?? '').trim();
      if (!sector) {
        add('no sector');
        return;
      }
      const sectorDef = findSector(sector);
      if (!sectorDef) {
        add(`sector "${sector}" is not one CFMS knows`);
        return;
      }
      const serviceSector = String(row.serviceSector ?? '').trim() || null;
      if (sectorDef.fundingSource) {
        if (!serviceSector) {
          add(
            `"${sector}" is a funding source, not a service - this line must also name the service sector it delivers`,
          );
          return;
        }
        const service = findSector(serviceSector);
        if (!service || service.fundingSource) {
          add(`"${serviceSector}" is not a service sector`);
          return;
        }
      }

      resolved.push({
        lineNo,
        officeId: office.id,
        officeName: office.name,
        fppCode,
        fppName: String(row.fppName ?? '').trim() || account?.name || fppCode,
        sector: sectorDef.name,
        serviceSector: sectorDef.fundingSource ? serviceSector : null,
        accountCode,
        accountName: account?.name ?? '',
        expenseClass,
        amount,
        particulars: String(row.particulars ?? '').trim() || null,
        isProgramme: !accountCode,
      });
    });

    if (problems.length) {
      throw new HttpsError(
        'failed-precondition',
        `${problems.length} row${problems.length === 1 ? '' : 's'} cannot be posted, so none of the file was. ` +
          `An ordinance goes in whole or not at all - a budget missing a few lines looks complete and is not. ` +
          `Fix these and upload again: ` +
          problems
            .slice(0, 12)
            .map((p) => `row ${p.lineNo} has ${p.problem}`)
            .join('; ') +
          (problems.length > 12 ? `; and ${problems.length - 12} more.` : '.'),
        { problems },
      );
    }

    /**
     * A realignment is judged as a set, and this is the only place that can do
     * it honestly.
     *
     * The browser runs the same rule so the Budget Officer sees the figure it
     * is out by, but the browser is not the authority: a call assembled by
     * hand could carry one side of a realignment and nothing else. Because the
     * whole set arrives in one call - the client is not allowed to chunk a
     * realignment, and a file too long for one call is refused above - the sum
     * seen here IS the sum of the realignment.
     */
    if (isRealignment) {
      const balanced = checkRealignmentSet(
        resolved.map((r) => ({ lineNo: r.lineNo, amount: r.amount })),
      );
      if (!balanced.ok) {
        throw new HttpsError(
          'failed-precondition',
          `${balanced.violations[0].message} A realignment moves authority between lines; it never creates or destroys any, so none of this file was posted.`,
          { violations: balanced.violations },
        );
      }

      /*
       * An augmentation may not cross an expense class.
       *
       * Checked here for the same reason the balance is: the browser runs the
       * same rule so the Budget Officer sees it before sending, but a call
       * assembled by hand could carry any instrument it liked. The whole set
       * arrives in one call, so the classes seen here are the classes of the
       * augmentation.
       */
      if (instrument === 'AUGMENTATION') {
        const withinClass = checkAugmentationExpenseClass(
          resolved.map((r) => ({
            lineNo: r.lineNo,
            expenseClass: r.expenseClass,
            amount: r.amount,
          })),
        );
        if (!withinClass.ok) {
          throw new HttpsError('failed-precondition', withinClass.violations[0].message, {
            violations: withinClass.violations,
          });
        }
      }
    }

    /*
     * ---------------------------------------------------------------------
     * AN ALLOTMENT UPLOAD PREPARES; IT DOES NOT RELEASE
     * ---------------------------------------------------------------------
     * Since patch 110 allotment is released only when the Budget Officer
     * approves a prepared Allotment Release Order. This upload used to release
     * straight away - with no order, no purpose and nobody's approval - which
     * by the rule already written into `releaseAllotment` ("released by order,
     * and only by order") was a door left open beside the one being guarded.
     *
     * So a file of allotments now fills prepared orders, one per expense
     * class because each class has its own LBE form, and they wait on the
     * Allotments screen for approval exactly like an order typed by hand.
     * Nothing in the books moves here.
     *
     * A WITHDRAWAL cannot go on an order - an order releases authority - so a
     * negative row is refused here, before anything is read, and pointed at
     * the place withdrawals are recorded.
     */
    if (kind === 'ALLOTMENT') {
      const negative = resolved.filter((r) => r.amount < 0);
      if (negative.length) {
        throw invalid(
          `Row${negative.length === 1 ? '' : 's'} ${negative.slice(0, 8).map((r) => r.lineNo).join(', ')}` +
            `${negative.length > 8 ? ', …' : ''} ${negative.length === 1 ? 'is a' : 'are'} negative. ` +
            'This upload prepares Allotment Release Orders, and an order releases authority. ' +
            'Record a withdrawal of allotment on its own, from Withdraw allotment on the Allotments screen.',
        );
      }
    }


    // ---- post ---------------------------------------------------------------

    return db.runTransaction(async (tx) => {
      await assertFiscalYearOpen(fiscalYear, tx);

      const collection = kind === 'APPROPRIATION' ? COL.appropriations : COL.allotments;
      const docId = (lineNo: number) =>
        kind === 'APPROPRIATION'
          ? `${fiscalYear}__${fundCode}__${appropriationKind}__${refSlug}__${lineNo}`
          : `${fiscalYear}__${fundCode}__${refSlug}__${lineNo}`;

      /*
       * Two rows of one ordinance may fall on the same budget line - the same
       * office and the same account, split across two programmes in the annex.
       * Their effects are summed before anything is read.
       *
       * Doing this per row instead would be wrong in a way that never raises an
       * error: each row would read the same balance, compute its own new total
       * from it, and the last write would win. The line would end up carrying
       * one row's appropriation instead of both, and the budget would simply be
       * short by an amount nobody could trace.
       */
      const byLine = new Map<string, { key: BudgetKey; rows: Resolved[]; amount: number }>();
      for (const r of resolved) {
        const key: BudgetKey = {
          fiscalYear,
          fundCode,
          officeId: r.officeId,
          responsibilityCenterId: null,
          programId: null,
          projectId: null,
          activityId: null,
          fppCode: r.fppCode,
          accountCode: r.accountCode,
        };
        // Two rows of one ordinance fall on the same line when they share the
        // office, the FPP and the object code. The FPP is part of that: two
        // projects in one office are two lines however alike their objects.
        const id = `${r.officeId}__${r.fppCode}__${r.accountCode}`;
        const entry = byLine.get(id) ?? { key, rows: [], amount: 0 };
        entry.rows.push(r);
        entry.amount += r.amount;
        byLine.set(id, entry);
      }

      // ---- reads ------------------------------------------------------------

      const existing = await Promise.all(
        resolved.map((r) => tx.get(db.collection(collection).doc(docId(r.lineNo)))),
      );
      const alreadyPosted = resolved.filter((_, i) => existing[i].exists);
      if (alreadyPosted.length) {
        throw new HttpsError(
          'already-exists',
          `${kind === 'APPROPRIATION' ? 'Ordinance' : 'Release'} ${reference} has already been uploaded - ` +
            `${alreadyPosted.length} of these rows ${alreadyPosted.length === 1 ? 'is' : 'are'} already there, ` +
            `waiting for approval or approved ` +
            `(row${alreadyPosted.length === 1 ? '' : 's'} ${alreadyPosted.slice(0, 8).map((r) => r.lineNo).join(', ')}` +
            `${alreadyPosted.length > 8 ? ', …' : ''}). ` +
            `Nothing was posted a second time. If this is a different ordinance, give it its own reference; ` +
            `if it is a correction, record it as a supplemental appropriation or an adjustment.`,
        );
      }

      /*
       * A realignment or augmentation FILE becomes one prepared set, under an
       * id made from its reference - so the same file uploaded twice finds the
       * first one waiting and is refused.
       */
      const uploadedSetRef =
        isRealignment && preparing
          ? db
              .collection(COL.augmentationDrafts)
              .doc(preparedSetId(fiscalYear, fundCode, instrument, refSlug))
          : null;
      if (uploadedSetRef && (await tx.get(uploadedSetRef)).exists) {
        throw new HttpsError(
          'already-exists',
          `${reference} has already been uploaded and is waiting for approval on the ` +
            'Appropriations screen. Nothing was prepared a second time. Correct that one, or ' +
            'discard it first if this file is meant to replace it.',
        );
      }

      /*
       * Approving a prepared set: read it AGAIN, here, where it is posted. If
       * it was edited or discarded after the approval began, what would be
       * posted is no longer what the Budget Officer was looking at.
       */
      if (fromDraft) {
        const now = await tx.get(fromDraft.ref);
        if (!now.exists) {
          throw new HttpsError(
            'not-found',
            'That prepared set was posted or discarded a moment ago. Nothing was posted again.',
          );
        }
        if (
          fromDraft.updateTime &&
          now.updateTime &&
          !now.updateTime.isEqual(fromDraft.updateTime)
        ) {
          throw new HttpsError(
            'aborted',
            'That prepared set was changed while it was being approved. Nothing was posted. ' +
              'Read it again and approve it again.',
          );
        }
      }

      /*
       * And for an allotment upload, the prepared orders this file would fill.
       * Their ids are made from the reference and the expense class, so the
       * same file uploaded twice lands on the same orders and is refused -
       * whether the first upload is still waiting or has since been approved.
       * (The check above still catches a file released before patch 110, when
       * an upload wrote allotment lines directly.)
       */
      const aroDraftId = (expenseClass: string) =>
        `${fiscalYear}__${fundCode}__${refSlug}__${expenseClass}`;
      const uploadClasses =
        kind === 'ALLOTMENT' ? [...new Set(resolved.map((r) => r.expenseClass))] : [];
      if (uploadClasses.length) {
        const prepared = await Promise.all(
          uploadClasses.map((c) => tx.get(db.collection(COL.aroDrafts).doc(aroDraftId(c)))),
        );
        const taken = prepared.filter((d) => d.exists);
        if (taken.length) {
          const released = taken.find((d) => d.get('status') === 'APPROVED');
          throw new HttpsError(
            'already-exists',
            released
              ? `Release ${reference} has already been prepared and approved as ARO ${released.get('aroNo') ?? ''}. ` +
                  'Nothing was prepared a second time. Give a different release its own reference.'
              : `Release ${reference} has already been prepared and is waiting for approval on the ` +
                  'Allotments screen. Nothing was prepared a second time. Correct that order, or ' +
                  'discard it first if this file is meant to replace it.',
          );
        }
      }

      const lines = [...byLine.values()];
      const balances = await Promise.all(lines.map((l) => readBudgetBalance(tx, l.key)));
      /** Patch 131: how much of each source comes out of a hold, and from which order lines. */
      const heldTaken: number[] = lines.map(() => 0);
      const heldPlans: Array<
        Array<{ ref: DocumentReference; held: number; take: number; prior: unknown[] }>
      > = lines.map(() => []);

      /*
       * WHAT A SOURCE MAY GIVE UP. Patch 130.
       *
       * The part of its appropriation not yet allotted - appropriation less
       * allotment released and held for later release - and nothing else.
       * Neil, correcting patch 128: "the available amount to be realigned and
       * augmented is the difference of Appropriation and Allotment only. When
       * it hits zero it can withdraw the amount of the release order."
       *
       * So a realignment or augmentation now moves APPROPRIATION ONLY. Since
       * patch 53 it had carried the allotment with it (planAugmentationAllotment);
       * that is withdrawn. Allotment is freed by its own act, a withdrawal on
       * the Allotments screen, which is refused if it would leave the allotment
       * below what is obligated against it.
       */
      if (kind === 'APPROPRIATION' && appropriationKind === 'REALIGNMENT') {
        const within = checkRealignableBalances(
          lines.map((l, i) => ({
            lineNo: i,
            label: `${l.rows[0].accountCode || l.rows[0].fppCode} ${l.rows[0].accountName || l.rows[0].fppName || ''} in ${l.rows[0].officeName}`
              .replace(/\s+/g, ' ')
              .trim(),
            amount: l.amount,
            appropriationRevised: balances[i].appropriationRevised,
            allotmentReleased: balances[i].allotmentReleased,
            forLaterRelease: balances[i].forLaterRelease ?? 0,
          })),
        );
        if (!within.ok) {
          throw new HttpsError(
            'failed-precondition',
            `${within.violations[0].message} Nothing was posted.`,
            within.violations[0].details,
          );
        }

        /*
         * PATCH 131 - A HOLD IS REALIGNABLE. Neil: "Yes they are realignable."
         *
         * What a source gives up comes first from appropriation neither
         * released nor held; only the rest is taken out of the hold. That
         * part cancels the hold on the release order lines that carry it -
         * latest order first - so the hold can never later be released for
         * money that has been realigned away, and the nightly rebuild (which
         * sums the holds off the allotment lines) agrees with the balance.
         * Read here, before any write.
         */
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].amount >= 0) continue;
          const fromHeld = heldTakenByRealignment(balances[i], -lines[i].amount);
          heldTaken[i] = fromHeld;
          if (fromHeld === 0) continue;
          const k = lines[i].key;
          const snap = await tx.get(
            db
              .collection(COL.allotments)
              .where('fiscalYear', '==', k.fiscalYear)
              .where('fundCode', '==', k.fundCode)
              .where('officeId', '==', k.officeId)
              .where('fppCode', '==', k.fppCode)
              .where('accountCode', '==', k.accountCode),
          );
          const holding = snap.docs
            .filter((d) => (d.get('forLaterRelease') ?? 0) > 0 && d.get('status') !== 'CANCELLED')
            .sort((a, b) =>
              String(b.get('allotmentDate') ?? '').localeCompare(String(a.get('allotmentDate') ?? '')),
            );
          let left = fromHeld;
          const plan: Array<{ ref: DocumentReference; held: number; take: number; prior: unknown[] }> = [];
          for (const d of holding) {
            if (left <= 0) break;
            const held = Number(d.get('forLaterRelease') ?? 0);
            const take = Math.min(held, left);
            plan.push({ ref: d.ref, held, take, prior: (d.get('heldRealigned') as unknown[]) ?? [] });
            left -= take;
          }
          if (left > 0) {
            const r = lines[i].rows[0];
            throw new HttpsError(
              'failed-precondition',
              `${r.accountCode || r.fppCode} ${r.accountName || r.fppName || ''} in ${r.officeName} shows ${peso(balances[i].forLaterRelease ?? 0)} held for later release, ` +
                `but the release orders behind it hold only ${peso(fromHeld - left)}. Run Administration > Settings > Budget figures: Check, Repair, then try again. Nothing was posted.`,
            );
          }
          heldPlans[i] = plan;
        }
      }

      // ---- the invariant, checked on the summed amount ----------------------

      if (kind === 'ALLOTMENT') {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.amount < 0) continue;
          const check = checkAllotmentAgainstAppropriation({
            appropriationRevised: balances[i].appropriationRevised,
            // The hold the Budget Officer placed with an Allotment Release
            // Order. It was not read here, so a bulk upload released straight
            // through an amount that had been deliberately withheld.
            forLaterRelease: balances[i].forLaterRelease ?? 0,
            allotmentAlreadyReleased: balances[i].allotmentReleased,
            requestedRelease: line.amount,
          });
          if (!check.ok) {
            const d = check.violations[0].details as Record<string, number>;
            const r = line.rows[0];
            throw new HttpsError(
              'failed-precondition',
              `Insufficient appropriation for ${r.accountCode} ${r.accountName} in ${r.officeName}: ` +
                `${peso(line.amount)} requested against ${peso(d.available)} available, short by ${peso(d.excess)}. ` +
                `Nothing was released. A supplemental appropriation or a realignment is needed first.`,
              check.violations[0].details,
            );
          }
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          const resulting = balances[i].appropriationRevised + lines[i].amount;
          const r = lines[i].rows[0];
          if (resulting < 0) {
            throw new HttpsError(
              'failed-precondition',
              `This file would drive the appropriation for ${r.accountCode} ${r.accountName} in ${r.officeName} to ${peso(resulting)}. An appropriation cannot be negative. Nothing was posted.`,
            );
          }
          // The allotment as it will stand once this posting is applied: a
          // realignment takes some of it back in the same transaction, so the
          // figure to test against is the one after that withdrawal, not the
          // one before it.
          const resultingAllotment =
            balances[i].allotmentReleased + (balances[i].forLaterRelease ?? 0) - heldTaken[i];
          if (resulting < resultingAllotment) {
            throw new HttpsError(
              'failed-precondition',
              `This file would reduce the appropriation for ${r.accountCode} ${r.accountName} in ${r.officeName} to ${peso(resulting)}, below the ${peso(resultingAllotment)} released as allotment. Withdraw the allotment first. Nothing was posted.`,
            );
          }
        }
      }

      // ---- writes -----------------------------------------------------------

      if (kind === 'ALLOTMENT') {
        const now = new Date().toISOString();
        const stamp = {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        };

        let prepared = 0;
        let total = 0;
        for (const expenseClass of uploadClasses) {
          const inClass = lines
            .map((l, i) => ({ l, b: balances[i] }))
            .filter(({ l }) => l.rows[0].expenseClass === expenseClass);
          if (!inClass.length) continue;

          tx.create(db.collection(COL.aroDrafts).doc(aroDraftId(expenseClass)), {
            fiscalYear,
            fundCode,
            expenseClass,
            /*
             * A file carries no purpose, and an order may not be released
             * without one - it is printed on the face of the ARO. The
             * reference stands in until the Budget Officer writes the real
             * purpose while checking the order, which a prepared order can.
             */
            purpose: `Allotment release ${reference}`,
            date,
            reference,
            importFileName: data.fileName ?? null,
            source: 'UPLOAD',
            lines: inClass.map(({ l }) => {
              const r = l.rows[0];
              total += l.amount;
              return {
                balanceId: budgetKeyId(l.key),
                officeId: r.officeId,
                officeName: r.officeName,
                fppCode: r.fppCode,
                fppName: r.fppName,
                accountCode: r.accountCode,
                accountName: r.accountName,
                amount: l.amount,
                forLaterRelease: 0,
              };
            }),
            status: 'DRAFT',
            createdBy: stamp,
            createdAt: now,
          });
          prepared += 1;
        }

        recordTransition(tx, {
          caller,
          event: 'UPLOAD',
          entityType: COL.aroDrafts,
          entityId: refSlug,
          entityRef: `Allotment release ${reference} - prepared`,
          fiscalYear,
          fundCode,
          action: 'SUBMIT',
          newStatus: 'DRAFT',
          remarks:
            `${prepared} prepared order${prepared === 1 ? '' : 's'}, ${lines.length} budget line` +
            `${lines.length === 1 ? '' : 's'}, ${peso(total)}${data.fileName ? `, from ${data.fileName}` : ''}. ` +
            'Nothing released until approved.',
        });

        return {
          posted: 0,
          budgetLines: lines.length,
          total,
          allotmentNo: null,
          reference,
          allotmentMoved: 0,
          preparedOrders: prepared,
        };
      }

      /* From here on the upload is an appropriation; an allotment upload returned above. */
      const allotmentNo: string | null = null;

      const now = new Date().toISOString();
      const stamp = {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: now,
      };

      let total = 0;

      /*
       * A REALIGNMENT OR AUGMENTATION FILE: one prepared set, and nothing in
       * the books moves. Every check above has already run, so a file that
       * could not post is refused now rather than at approval; approval runs
       * them all again against the books as they then stand.
       */
      if (uploadedSetRef) {
        tx.create(uploadedSetRef, {
          fiscalYear,
          fundCode,
          instrument: instrument === 'AUGMENTATION' ? 'AUGMENTATION' : 'REALIGNMENT',
          authorityReference: reference,
          authorityDate: date,
          importFileName: data.fileName ?? null,
          source: 'UPLOAD',
          lines: resolved.map((r, i) => ({
            lineNo: i + 1,
            officeId: r.officeId,
            officeName: r.officeName,
            lineId: budgetKeyId({
              fiscalYear,
              fundCode,
              officeId: r.officeId,
              responsibilityCenterId: null,
              programId: null,
              projectId: null,
              activityId: null,
              fppCode: r.fppCode,
              accountCode: r.accountCode,
            }),
            fppCode: r.fppCode,
            fppName: r.fppName,
            sector: r.sector,
            serviceSector: r.serviceSector ?? '',
            accountCode: r.accountCode,
            accountName: r.accountName,
            expenseClass: r.expenseClass,
            amount: r.amount,
            particulars: r.particulars ?? '',
          })),
          status: 'DRAFT',
          createdBy: stamp,
          createdAt: now,
        });

        recordTransition(tx, {
          caller,
          event: 'UPLOAD',
          entityType: COL.augmentationDrafts,
          entityId: uploadedSetRef.id,
          entityRef: `${instrument === 'AUGMENTATION' ? 'Augmentation' : 'Realignment'} ${reference} - prepared`,
          fiscalYear,
          fundCode,
          action: 'SUBMIT',
          newStatus: 'DRAFT',
          remarks:
            `${resolved.length} lines${data.fileName ? `, from ${data.fileName}` : ''}. ` +
            'Nothing posted until approved.',
        });

        return {
          posted: 0,
          drafted: 0,
          preparedSet: uploadedSetRef.id,
          budgetLines: lines.length,
          total: 0,
          allotmentNo: null,
          reference,
          allotmentMoved: 0,
        };
      }

      /*
       * AN ORDINANCE FILE lands its lines as DRAFTS, since patch 112. They
       * appear in the Appropriation Ledger marked Draft, foot to nothing, and
       * become authority only when the Budget Officer approves them - one at a
       * time, or the whole upload at once - through approveAppropriation,
       * which checks each again. The ids are the same as before, so the same
       * ordinance uploaded twice is still refused.
       */
      const asDrafts = preparing;

      for (let i = 0; i < lines.length && !asDrafts; i++) {
        const line = lines[i];
        const first = line.rows[0];

        const delta: Partial<BudgetBalanceData> = {};
        if (appropriationKind === 'ORIGINAL') {
          delta.appropriationOriginal = line.amount;
        } else if (appropriationKind === 'SUPPLEMENTAL') {
          delta.appropriationSupplemental = line.amount;
        } else if (appropriationKind === 'CONTINUING') {
          delta.appropriationContinuing = line.amount;
        } else {
          delta.appropriationAdjustments = line.amount;
        }

        // Patch 130: a realignment moves appropriation only; no allotment moves.
        // Patch 131: what it takes out of a hold cancels that much of the hold.
        if (heldTaken[i] > 0) {
          delta.forLaterRelease = -heldTaken[i];
          for (const h of heldPlans[i]) {
            tx.update(h.ref, {
              forLaterRelease: h.held - h.take,
              heldRealigned: [
                ...h.prior,
                { reference, amount: h.take, at: now, by: caller.name ?? caller.uid },
              ],
            });
          }
        }

        applyBudgetDelta(tx, line.key, balances[i], delta, {
          officeName: first.officeName,
          accountName: first.accountName,
          fppName: first.fppName,
          sector: first.sector,
          serviceSector: first.serviceSector,
          expenseClass: first.expenseClass,
        });
      }

      /**
       * Programme FPPs go onto the masterlist as they are encountered.
       *
       * The ordinance is the authority that creates a programme, so the act of
       * loading the ordinance is the right moment for the programme to exist.
       * Requiring the Budget Office to type two hundred programme names into
       * master data first, exactly as they appear in the annex, and then
       * upload the annex, would be asking for the same list twice and would
       * fail on the first spelling difference.
       *
       * `merge` so that a name edited by hand afterwards is not overwritten by
       * a later upload of the same ordinance.
       */
      if (kind === 'APPROPRIATION') {
        const seen = new Set<string>();
        for (const r of resolved) {
          if (!r.isProgramme || seen.has(r.fppCode)) continue;
          seen.add(r.fppCode);
          /*
           * The id carries the YEAR as well as the code - see
           * lib/budgetPrograms.ts for why, and it is not a small why: while
           * the id was the code alone, uploading the FY2027 ordinance
           * overwrote the FY2026 programme of the same code, so the name
           * changed underneath last year's appropriations and nothing said so.
           *
           * `merge` within a year is still right: loading the same ordinance
           * twice updates the programme rather than creating a second copy,
           * and a name edited by hand afterwards is not overwritten.
           */
          tx.set(
            db.collection(COL.programs).doc(programDocId(fiscalYear, r.fppCode)),
            {
              code: r.fppCode,
              name: r.fppName,
              fiscalYear,
              active: true,
              sourceReference: reference,
              updatedAt: now,
            },
            { merge: true },
          );
        }
      }

      for (const r of resolved) {
        total += r.amount;
        const base = {
          fiscalYear,
          fundCode,
          officeId: r.officeId,
          officeName: r.officeName,
          responsibilityCenterId: null,
          programId: null,
          projectId: null,
          activityId: null,
          instrument: isRealignment ? instrument : null,
          fppCode: r.fppCode,
          fppName: r.fppName,
          sector: r.sector,
          serviceSector: r.serviceSector,
          accountCode: r.accountCode,
          accountName: r.accountName,
          expenseClass: r.expenseClass,
          amount: r.amount,
          particulars: r.particulars,
          ...(asDrafts
            ? { status: 'DRAFT', createdBy: stamp, createdAt: now }
            : { status: 'APPROVED', postedAt: now, createdBy: stamp, approvedBy: stamp }),
          /** Which upload this line came from, for tracing it back. */
          importReference: reference,
          importLineNo: r.lineNo,
          importFileName: data.fileName ?? null,
        };

        tx.create(
          db.collection(collection).doc(docId(r.lineNo)),
          kind === 'APPROPRIATION'
            ? {
                ...base,
                kind: appropriationKind,
                authorityReference: reference,
                authorityDate: date,
              }
            : {
                ...base,
                allotmentNo,
                allotmentDate: date,
              },
        );
      }

      if (!asDrafts) {
        applySummaryDelta(
          tx,
          fiscalYear,
          fundCode,
          kind === 'APPROPRIATION' ? { appropriationRevised: total } : { allotmentReleased: total },
        );
      }

      /* The prepared set has become posted lines; it goes in the same act. */
      if (fromDraft) tx.delete(fromDraft.ref);

      recordTransition(tx, {
        caller,
        event: 'UPLOAD',
        entityType: collection,
        entityId: refSlug,
        entityRef:
          kind === 'APPROPRIATION'
            ? `${appropriationKind} appropriation - ${reference}`
            : `Allotment release ${allotmentNo ?? reference}`,
        fiscalYear,
        fundCode,
        action: asDrafts ? 'SUBMIT' : 'APPROVE',
        newStatus: asDrafts ? 'DRAFT' : 'APPROVED',
        remarks:
          `${resolved.length} lines on ${lines.length} budget line${lines.length === 1 ? '' : 's'}, ` +
          `${peso(total)}${data.fileName ? `, from ${data.fileName}` : ''}.` +
          (asDrafts ? ' Uploaded as drafts; nothing is authority until approved.' : ''),
      });

      return {
        posted: asDrafts ? 0 : resolved.length,
        drafted: asDrafts ? resolved.length : 0,
        budgetLines: lines.length,
        total,
        allotmentNo,
        reference,
        /** Since patch 130 a realignment moves no allotment; kept for callers that read it. */
        allotmentMoved: 0,
      };
    });
  },
);
