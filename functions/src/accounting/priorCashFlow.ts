import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, assertFundInScope, type Role } from '../lib/context';
import { auditInTransaction } from '../lib/audit';
import {
  cashOn,
  priorCashFlowId,
  priorCashFlowTotals,
  unknownCaptions,
  type PriorCashFlowLine,
} from '../lib/priorCashFlow';
import { priorTbId } from '../lib/priorTrialBalance';

/**
 * Patch 170 - savePriorCashFlow.
 *
 * Stores the preceding year's Statement of Cash Flows of a fund, by caption,
 * for the comparative column. See src/lib/priorCashFlow.ts.
 *
 * A callable, with the collection closed to the browser, for the same reason
 * as the prior trial balances: these are financial figures and the browser is
 * not the authority for them. The engine checks every caption against the
 * fund's statement and works out the cash at the end of the year itself; that
 * must be the cash the next year opened with - on the Opening Balances entry,
 * and on the post-closing (or pre-closing) trial balance where one is
 * uploaded. Nothing is posted.
 */

const ACCOUNTANT: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];
const SECTIONS = ['OPERATING', 'INVESTING', 'FINANCING'];

const peso = (c: number) =>
  (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const savePriorCashFlow = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ACCOUNTANT);
    const { fiscalYear, fundCode, beginningCash, lines } = (request.data ?? {}) as {
      fiscalYear?: number;
      fundCode?: string;
      beginningCash?: number;
      lines?: Array<Partial<PriorCashFlowLine>>;
    };

    if (!Number.isInteger(fiscalYear) || fiscalYear! < 2000 || fiscalYear! > 2100) {
      throw invalid('The year of the statement is required.');
    }
    if (!fundCode || typeof fundCode !== 'string') throw invalid('The fund is required.');
    assertFundInScope(caller, fundCode);
    const year = fiscalYear!;

    const beginning = Math.round(Number(beginningCash ?? 0));
    if (!Number.isFinite(beginning) || beginning < 0) {
      throw invalid('The cash balance at the beginning of the year is not a positive figure.');
    }
    if (!Array.isArray(lines) || lines.length > 200) throw invalid('The captions are missing.');

    const clean: PriorCashFlowLine[] = [];
    for (const l of lines) {
      const amount = Math.round(Number(l.amount ?? 0));
      const caption = String(l.caption ?? '').trim();
      if (
        !SECTIONS.includes(String(l.section)) ||
        (l.direction !== 'IN' && l.direction !== 'OUT')
      ) {
        throw invalid(`"${caption}" is not on a section of the statement.`);
      }
      if (!Number.isFinite(amount) || amount < 0) {
        throw invalid(`"${caption}" carries an amount that is not a positive figure.`);
      }
      clean.push({
        section: l.section as PriorCashFlowLine['section'],
        direction: l.direction,
        caption,
        amount,
      });
    }
    const unknown = unknownCaptions(fundCode, clean);
    if (unknown.length) {
      throw invalid(`Not a caption of this fund's statement: ${unknown.slice(0, 5).join(', ')}.`);
    }

    const totals = priorCashFlowTotals(clean, beginning);
    const ref = db.collection(COL.priorCashFlows).doc(priorCashFlowId(year, fundCode));
    const markerRef = db.collection(COL.openingBalances).doc(`${year + 1}__${fundCode}`);
    const postRef = db.collection(COL.priorTrialBalances).doc(priorTbId(year, fundCode, 'POST'));
    const preRef = db.collection(COL.priorTrialBalances).doc(priorTbId(year, fundCode, 'PRE'));

    return db.runTransaction(async (tx) => {
      // --- reads ---------------------------------------------------------------
      const [marker, post, pre] = await Promise.all([
        tx.get(markerRef),
        tx.get(postRef),
        tx.get(preRef),
      ]);
      const markerData = marker.exists
        ? (marker.data() as { jevId?: string; jevNo?: string })
        : null;
      const jev = markerData?.jevId
        ? await tx.get(db.collection(COL.jevs).doc(markerData.jevId))
        : null;

      // --- the year must end on the cash the next year opened with -----------
      const checkedAgainst: string[] = [];
      const refuse = (where: string, cash: number) =>
        invalid(
          `The cash at the end of ${year} works out to ${peso(totals.endingCash)} (beginning ${peso(
            beginning,
          )}, net flows ${peso(totals.netFlows)}), but ${where} carries ${peso(
            cash,
          )} of cash - a difference of ${peso(totals.endingCash - cash)}.`,
        );

      if (markerData && jev?.exists) {
        const cash = cashOn(
          (
            jev.data() as {
              lines?: Array<{ accountCode: string; debit?: number; credit?: number }>;
            }
          ).lines ?? [],
        );
        if (cash !== totals.endingCash) {
          throw refuse(`the Opening Balances of ${year + 1} (JEV ${markerData.jevNo ?? ''})`, cash);
        }
        checkedAgainst.push(`Opening Balances ${year + 1} (JEV ${markerData.jevNo ?? ''})`);
      }
      const tb = post.exists ? post : pre.exists ? pre : null;
      if (tb) {
        const cash = cashOn(
          (tb.data() as { lines?: Array<{ accountCode: string; debit?: number; credit?: number }> })
            .lines ?? [],
        );
        const which = post.exists ? 'post-closing' : 'pre-closing';
        if (cash !== totals.endingCash) throw refuse(`the ${which} trial balance of ${year}`, cash);
        checkedAgainst.push(`${which} trial balance ${year}`);
      }

      // --- write ---------------------------------------------------------------
      const now = new Date().toISOString();
      tx.set(ref, {
        fiscalYear: year,
        fundCode,
        beginningCash: beginning,
        lines: clean,
        netFlows: totals.netFlows,
        endingCash: totals.endingCash,
        checkedAgainst,
        savedAt: now,
        savedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null },
      });

      auditInTransaction(tx, {
        caller,
        event: 'EDIT',
        entityType: COL.priorCashFlows,
        entityId: ref.id,
        entityRef: `Prior year cash flows ${fundCode} ${year}`,
        fiscalYear: year,
        fundCode,
        remarks: `Beginning ${peso(beginning)}, net flows ${peso(totals.netFlows)}, ending ${peso(
          totals.endingCash,
        )}.${checkedAgainst.length ? ` Agrees with ${checkedAgainst.join(' and ')}.` : ' Nothing yet to check it against.'}`,
        severity: 'NOTICE',
      });

      return { id: ref.id, endingCash: totals.endingCash, checkedAgainst };
    });
  },
);
