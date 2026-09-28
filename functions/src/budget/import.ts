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
  type BudgetKey,
  type BudgetBalanceData,
} from '../lib/budget';
import { checkAllotmentAgainstAppropriation, checkRealignmentSet } from '../lib/rules';

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
  accountCode?: string;
  expenseClass?: string;
  amount?: number;
  particulars?: string;
}

interface Resolved {
  lineNo: number;
  officeId: string;
  officeName: string;
  accountCode: string;
  accountName: string;
  expenseClass: string;
  amount: number;
  particulars: string | null;
}

const peso = (c: number) => (c / 100).toFixed(2);

/** A reference made safe for a document id, which may not contain a slash. */
function slug(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

export const importBudgetLines = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, BUDGET_APPROVERS);
    const data = (request.data ?? {}) as {
      kind?: string;
      fiscalYear?: number;
      fundCode?: string;
      appropriationKind?: string;
      reference?: string;
      date?: string;
      fileName?: string;
      rows?: unknown;
    };

    const kind = data.kind as ImportKind;
    if (kind !== 'APPROPRIATION' && kind !== 'ALLOTMENT') {
      throw invalid('An upload is either appropriations or allotments.');
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

    const date = String(data.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw invalid('A date is required, as year-month-day - for example 2026-01-05.');
    }

    const appropriationKind = String(data.appropriationKind ?? 'ORIGINAL').toUpperCase();
    if (
      kind === 'APPROPRIATION' &&
      !['ORIGINAL', 'SUPPLEMENTAL', 'CONTINUING', 'REALIGNMENT', 'ADJUSTMENT'].includes(
        appropriationKind,
      )
    ) {
      // TRANSFER is deliberately absent. It was withdrawn from the screen as a
      // choice, and a kind the office cannot pick but the server still accepts
      // is a restriction that only looks like one. Appropriations already
      // recorded as transfers are untouched and still approve normally: this
      // guards new uploads, not history.
      throw invalid(
        appropriationKind === 'TRANSFER'
          ? 'Transfers are no longer recorded as an appropriation type. A movement of authority between offices is a realignment, which must come to zero.'
          : `Unknown appropriation type ${appropriationKind}.`,
      );
    }
    const signed = ['REALIGNMENT', 'ADJUSTMENT'].includes(appropriationKind);
    const isRealignment = kind === 'APPROPRIATION' && appropriationKind === 'REALIGNMENT';

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

      const accountCode = String(row.accountCode ?? '').trim();
      if (!accountCode) {
        add('no account code');
        return;
      }
      const account = accounts.get(accountCode);
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

      const expenseClass = String(row.expenseClass ?? account.expenseClass ?? '')
        .trim()
        .toUpperCase();
      if (!['PS', 'MOOE', 'FE', 'CO'].includes(expenseClass)) {
        add(
          `no expense classification - the file does not say and account ${accountCode} has none recorded against it`,
        );
        return;
      }

      resolved.push({
        lineNo,
        officeId: office.id,
        officeName: office.name,
        accountCode,
        accountName: account.name ?? accountCode,
        expenseClass,
        amount,
        particulars: String(row.particulars ?? '').trim() || null,
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
    }

    const numberingConfig =
      kind === 'ALLOTMENT' ? await loadNumberingConfig('ALLOT') : null;
    const bookCode = kind === 'ALLOTMENT' ? await bookCodeForFund(fundCode) : '';

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
          accountCode: r.accountCode,
        };
        const id = `${r.officeId}__${r.accountCode}`;
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
          `${kind === 'APPROPRIATION' ? 'Ordinance' : 'Release'} ${reference} has already been posted - ` +
            `${alreadyPosted.length} of these rows ${alreadyPosted.length === 1 ? 'is' : 'are'} already in the books ` +
            `(row${alreadyPosted.length === 1 ? '' : 's'} ${alreadyPosted.slice(0, 8).map((r) => r.lineNo).join(', ')}` +
            `${alreadyPosted.length > 8 ? ', …' : ''}). ` +
            `Nothing was posted a second time. If this is a different ordinance, give it its own reference; ` +
            `if it is a correction, record it as a supplemental appropriation or an adjustment.`,
        );
      }

      const lines = [...byLine.values()];
      const balances = await Promise.all(lines.map((l) => readBudgetBalance(tx, l.key)));

      // ---- the invariant, checked on the summed amount ----------------------

      if (kind === 'ALLOTMENT') {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.amount < 0) continue;
          const check = checkAllotmentAgainstAppropriation({
            appropriationRevised: balances[i].appropriationRevised,
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
          if (resulting < balances[i].allotmentReleased) {
            throw new HttpsError(
              'failed-precondition',
              `This file would reduce the appropriation for ${r.accountCode} ${r.accountName} in ${r.officeName} to ${peso(resulting)}, below the ${peso(balances[i].allotmentReleased)} already released as allotment. Withdraw the allotment first. Nothing was posted.`,
            );
          }
        }
      }

      // ---- writes -----------------------------------------------------------

      const allotmentNo =
        kind === 'ALLOTMENT' && numberingConfig
          ? await issueNumber(tx, numberingConfig, {
              bookCode,
              fundCode,
              fiscalYear,
              month: Number(date.slice(5, 7)),
            })
          : null;

      const now = new Date().toISOString();
      const stamp = {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: now,
      };

      let total = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const first = line.rows[0];

        const delta: Partial<BudgetBalanceData> = {};
        if (kind === 'ALLOTMENT') {
          delta.allotmentReleased = line.amount;
        } else if (appropriationKind === 'ORIGINAL') {
          delta.appropriationOriginal = line.amount;
        } else if (appropriationKind === 'SUPPLEMENTAL') {
          delta.appropriationSupplemental = line.amount;
        } else if (appropriationKind === 'CONTINUING') {
          delta.appropriationContinuing = line.amount;
        } else {
          delta.appropriationAdjustments = line.amount;
        }

        applyBudgetDelta(tx, line.key, balances[i], delta, {
          officeName: first.officeName,
          accountName: first.accountName,
          expenseClass: first.expenseClass,
        });
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
          accountCode: r.accountCode,
          accountName: r.accountName,
          expenseClass: r.expenseClass,
          amount: r.amount,
          particulars: r.particulars,
          status: 'APPROVED',
          postedAt: now,
          createdBy: stamp,
          approvedBy: stamp,
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

      applySummaryDelta(
        tx,
        fiscalYear,
        fundCode,
        kind === 'APPROPRIATION' ? { appropriationRevised: total } : { allotmentReleased: total },
      );

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
        action: 'APPROVE',
        newStatus: 'APPROVED',
        remarks:
          `${resolved.length} lines on ${lines.length} budget line${lines.length === 1 ? '' : 's'}, ` +
          `${peso(total)}${data.fileName ? `, from ${data.fileName}` : ''}.`,
      });

      return {
        posted: resolved.length,
        budgetLines: lines.length,
        total,
        allotmentNo,
        reference,
      };
    });
  },
);
