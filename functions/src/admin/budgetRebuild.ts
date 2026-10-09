import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid } from '../lib/context';
import { auditInTransaction } from '../lib/audit';
import { budgetKeyId } from '../lib/budget';
import { allocateDvShares } from '../lib/dvShares';
import { isTrustFund, obligationStatusFor } from '../lib/paymentBudget';

/**
 * Rebuilding the budget figures from their source documents. Patch 120,
 * redrawn in patch 121 when the disbursement moved to the check.
 *
 * ---------------------------------------------------------------------------
 * ONE REBUILD, TWO READERS
 * ---------------------------------------------------------------------------
 * The nightly verifier (`verifyBudgetBalances`) rebuilds every balance of
 * the year from the approved appropriations, the approved allotments and the
 * committed obligations, and compares it with the stored figure. The repair
 * below rebuilds the same way and WRITES what is found to drift.
 *
 * They share this function so that what the repair writes is exactly what
 * the verifier will check the next night. Two rebuilds that differ by a
 * rounding rule would have the repair "fixing" a balance the verifier then
 * reports again, every night, for ever.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DISBURSED FIGURE COMES FROM
 * ---------------------------------------------------------------------------
 * Since patch 121 a disbursement is a check or an ADA. An obligation's
 * `paidAmount` is what its vouchers' instruments have paid; a budget line's
 * `disbursed` is the obligations' paidAmount spread over their lines. The
 * vouchered figure (`disbursedAmount`, its old name kept) is not a
 * disbursement and is not rebuilt here.
 */

/**
 * The statuses in which an obligation has committed allotment.
 *
 * MUST match COMMITTED in src/lib/budgetPeriods.ts, less the
 * pre-certification ones this never sees. Listed rather than derived because
 * a Firestore `in` needs literals - and checked against the client's list by
 * check-rules.
 */
export const COMMITTED_OBLIGATION_STATUSES = ['OBLIGATED', 'WITH_DV', 'PAID', 'CLOSED'];

export interface RebuiltFigures {
  appropriation: number;
  allotment: number;
  forLaterRelease: number;
  obligated: number;
  disbursed: number;
}

/** The document id of a budget balance, by the SAME function the writers use. */
export function balanceKeyOf(d: Record<string, unknown>): string {
  return budgetKeyId({
    fiscalYear: d.fiscalYear as number,
    fundCode: d.fundCode as string,
    officeId: d.officeId as string,
    responsibilityCenterId: (d.responsibilityCenterId as string | null) ?? null,
    programId: (d.programId as string | null) ?? null,
    projectId: (d.projectId as string | null) ?? null,
    activityId: (d.activityId as string | null) ?? null,
    fppCode: (d.fppCode as string) ?? '',
    accountCode: (d.accountCode as string) ?? '',
  });
}

type ObligationLine = Record<string, unknown> & { lineNo: number; amount: number };

function linesOf(o: Record<string, unknown>): ObligationLine[] {
  return ((o.lines as Array<Record<string, unknown>>) ?? []).map((l) => ({
    ...l,
    lineNo: (l.lineNo as number) ?? 0,
    amount: (l.amount as number) ?? 0,
  }));
}

/**
 * @param paidOverride  paidAmount per obligation id, used by the repair to
 *                      rebuild from the figure it is about to write rather
 *                      than the one stored.
 */
export async function rebuildBudgetFigures(
  year: number,
  paidOverride?: Map<string, number>,
): Promise<{ balances: Map<string, RebuiltFigures>; programmes: Map<string, number> }> {
  const [appropriations, allotments, obligations] = await Promise.all([
    db
      .collection(COL.appropriations)
      .where('fiscalYear', '==', year)
      .where('status', '==', 'APPROVED')
      .get(),
    db
      .collection(COL.allotments)
      .where('fiscalYear', '==', year)
      .where('status', '==', 'APPROVED')
      .get(),
    db
      .collection(COL.obligations)
      .where('fiscalYear', '==', year)
      .where('status', 'in', COMMITTED_OBLIGATION_STATUSES)
      .get(),
  ]);

  const balances = new Map<string, RebuiltFigures>();
  const programmes = new Map<string, number>();
  const bump = (key: string, field: keyof RebuiltFigures, amount: number) => {
    const cur = balances.get(key) ?? {
      appropriation: 0,
      allotment: 0,
      forLaterRelease: 0,
      obligated: 0,
      disbursed: 0,
    };
    cur[field] += amount;
    balances.set(key, cur);
  };

  for (const doc of appropriations.docs)
    bump(balanceKeyOf(doc.data()), 'appropriation', doc.data().amount ?? 0);
  for (const doc of allotments.docs) {
    const a = doc.data();
    bump(balanceKeyOf(a), 'allotment', (a.amount as number) ?? 0);
    // The hold the Allotment Release Order placed on the line. It is carried
    // on the allotment document precisely so that it can be rebuilt here.
    bump(balanceKeyOf(a), 'forLaterRelease', (a.forLaterRelease as number) ?? 0);
  }
  for (const doc of obligations.docs) {
    const o = doc.data();
    const total = (o.totalAmount as number) ?? 0;
    const paid = paidOverride?.get(doc.id) ?? (o.paidAmount as number) ?? 0;
    const trust = isTrustFund(o.fundCode as string);
    // The SAME allocation the payments use, remainder on the last line, so a
    // centavo of rounding never reads as a discrepancy.
    for (const { line, share } of allocateDvShares(linesOf(o), total, paid)) {
      if (trust) {
        const programId = String(line.trustProgramId ?? '').trim();
        if (programId) programmes.set(programId, (programmes.get(programId) ?? 0) + share);
        continue;
      }
      // An obligation line is keyed on the object code the APPROPRIATION
      // carried, not on the object being bought - they differ on every
      // project line, where the appropriation named no object at all.
      const key = balanceKeyOf({ ...line, accountCode: line.appropriatedAccountCode ?? '' });
      bump(key, 'obligated', line.amount);
      bump(key, 'disbursed', share);
    }
  }

  return { balances, programmes };
}

export interface Drift {
  id: string;
  label: string;
  fundCode: string;
  stored: number;
  rebuilt: number;
  /** Obligations only: the vouchered figure, for the status that follows. */
  obligated?: number;
}

/**
 * repairBudgetDisbursed - put every disbursed figure of a year back to what
 * the checks and ADAs say.
 *
 * In order: each obligation's `paidAmount` from the vouchers that have a
 * check or an ADA drawn and live; each budget line's `disbursed` from those;
 * each fund summary's `disbursed` as the sum of its lines; each trust
 * programme's `disbursed` from the trust obligations.
 *
 * `apply: false` only reports what differs, so the administrator sees what
 * will change before anything does. `apply: true` writes it, one transaction
 * per document, re-reading inside it so a payment made between the report
 * and the repair is not overwritten.
 *
 * Only the Super Administrator. This is the one place a budget figure is
 * written from a rebuild rather than from a transaction, and every document
 * it changes goes into the audit trail with the figure before and after.
 */
export const repairBudgetDisbursed = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK, timeoutSeconds: 300, memory: '1GiB' },
  async (request) => {
    const caller = await requireCaller(request, ['SUPER_ADMIN']);
    const { fiscalYear, apply } = (request.data ?? {}) as { fiscalYear?: number; apply?: boolean };
    if (!fiscalYear || !Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

    // ---- 1. what the instruments say each obligation has been paid --------
    const dvs = await db
      .collection(COL.disbursementVouchers)
      .where('fiscalYear', '==', fiscalYear)
      .get();
    const paidByObligation = new Map<string, number>();
    for (const doc of dvs.docs) {
      const dv = doc.data();
      if (dv.status === 'CANCELLED') continue;
      if (!dv.checkId && !dv.adaId) continue;
      const obrId = dv.obligationId as string | undefined;
      if (!obrId) continue;
      paidByObligation.set(
        obrId,
        (paidByObligation.get(obrId) ?? 0) + ((dv.grossAmount as number) ?? 0),
      );
    }

    const obligationDrifts: Drift[] = [];
    const obligations = await db
      .collection(COL.obligations)
      .where('fiscalYear', '==', fiscalYear)
      .where('status', 'in', COMMITTED_OBLIGATION_STATUSES)
      .get();
    for (const doc of obligations.docs) {
      const o = doc.data();
      const stored = (o.paidAmount as number) ?? 0;
      const rebuilt = paidByObligation.get(doc.id) ?? 0;
      if (stored === rebuilt) continue;
      obligationDrifts.push({
        id: doc.id,
        label: `OBR ${(o.obrNo as string) ?? doc.id}`,
        fundCode: (o.fundCode as string) ?? '',
        stored,
        rebuilt,
        obligated: (o.totalAmount as number) ?? 0,
      });
    }

    // ---- 2. the budget lines, summaries and programmes from that ----------
    const { balances, programmes } = await rebuildBudgetFigures(fiscalYear, paidByObligation);

    const lineDrifts: Drift[] = [];
    const stored = await db
      .collection(COL.budgetBalances)
      .where('fiscalYear', '==', fiscalYear)
      .get();
    const summaryRebuilt = new Map<string, number>();
    for (const doc of stored.docs) {
      const s = doc.data();
      // A balance no committed obligation touches has nothing disbursed.
      const r = balances.get(doc.id)?.disbursed ?? 0;
      const fund = (s.fundCode as string) ?? '';
      summaryRebuilt.set(fund, (summaryRebuilt.get(fund) ?? 0) + r);
      const current = (s.disbursed as number) ?? 0;
      if (current === r) continue;
      lineDrifts.push({
        id: doc.id,
        label:
          `${(s.officeName as string) ?? (s.officeId as string) ?? ''} - ${(s.accountCode as string) || (s.fppCode as string) || ''} ${(s.accountName as string) ?? ''}`.trim(),
        fundCode: fund,
        stored: current,
        rebuilt: r,
      });
    }

    const summaryDrifts: Drift[] = [];
    const summaries = await db
      .collection(COL.budgetSummaries)
      .where('fiscalYear', '==', fiscalYear)
      .get();
    for (const doc of summaries.docs) {
      const s = doc.data();
      const fund = (s.fundCode as string) ?? '';
      const r = summaryRebuilt.get(fund) ?? 0;
      const current = (s.disbursed as number) ?? 0;
      if (current === r) continue;
      summaryDrifts.push({
        id: doc.id,
        label: `${fund} fund summary`,
        fundCode: fund,
        stored: current,
        rebuilt: r,
      });
    }

    /*
     * A trust programme runs across years, so its disbursed figure is the sum
     * over EVERY year's trust obligations - this year's from the figure about
     * to be written, other years' from what is stored (run the repair for
     * each year in turn and they are right too).
     */
    const trustObligations = await db
      .collection(COL.obligations)
      .where('fundCode', '==', 'TF')
      .where('status', 'in', COMMITTED_OBLIGATION_STATUSES)
      .get();
    const programmesAllYears = new Map<string, number>();
    for (const doc of trustObligations.docs) {
      const o = doc.data();
      const paid =
        (o.fiscalYear as number) === fiscalYear
          ? (paidByObligation.get(doc.id) ?? 0)
          : ((o.paidAmount as number) ?? 0);
      for (const { line, share } of allocateDvShares(
        linesOf(o),
        (o.totalAmount as number) ?? 0,
        paid,
      )) {
        const programId = String(line.trustProgramId ?? '').trim();
        if (programId)
          programmesAllYears.set(programId, (programmesAllYears.get(programId) ?? 0) + share);
      }
    }
    void programmes;

    const programmeDrifts: Drift[] = [];
    const trust = await db.collection(COL.trustPrograms).get();
    for (const doc of trust.docs) {
      const p = doc.data();
      const r = programmesAllYears.get(doc.id) ?? 0;
      const current = (p.disbursed as number) ?? 0;
      if (current === r) continue;
      programmeDrifts.push({
        id: doc.id,
        label: `${(p.programCode as string) ?? ''} ${(p.programName as string) ?? ''}`.trim(),
        fundCode: 'TF',
        stored: current,
        rebuilt: r,
      });
    }

    const report = {
      fiscalYear,
      obligations: obligationDrifts,
      lines: lineDrifts,
      summaries: summaryDrifts,
      programmes: programmeDrifts,
    };
    if (!apply) return { ...report, applied: false };

    // ---- 3. write, one transaction per document, each re-read -------------
    const changed = (label: string) =>
      new HttpsError(
        'aborted',
        `${label} changed while the repair was running. Check again and repair from the new report.`,
      );

    let repaired = 0;
    const write = async (
      collection: string,
      d: Drift,
      field: string,
      extra: (data: Record<string, unknown>) => Record<string, unknown>,
      remarks: string,
    ) => {
      await db.runTransaction(async (tx) => {
        const ref = db.collection(collection).doc(d.id);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const data = snap.data() as Record<string, unknown>;
        if (((data[field] as number) ?? 0) !== d.stored) throw changed(d.label);
        tx.update(ref, { [field]: d.rebuilt, ...extra(data) });
        auditInTransaction(tx, {
          caller,
          event: 'BUDGET_OVERRIDE',
          entityType: collection,
          entityId: d.id,
          entityRef: d.label,
          fiscalYear,
          fundCode: d.fundCode,
          changes: [{ field, previous: d.stored, next: d.rebuilt }],
          remarks,
          severity: 'CRITICAL',
        });
        repaired += 1;
      });
    };

    for (const d of obligationDrifts) {
      await write(
        COL.obligations,
        d,
        'paidAmount',
        (o) => ({
          status: obligationStatusFor(
            (o.status as string) ?? 'OBLIGATED',
            (o.totalAmount as number) ?? 0,
            (o.disbursedAmount as number) ?? 0,
            d.rebuilt,
          ),
        }),
        'Paid amount put back to the sum of the vouchers with a check or an ADA drawn and live (patch 121).',
      );
    }
    for (const d of lineDrifts) {
      await write(
        COL.budgetBalances,
        d,
        'disbursed',
        (b) => ({ unpaidObligations: ((b.obligated as number) ?? 0) - d.rebuilt }),
        'Disbursed put back to what the checks and ADAs drawn on this line have paid (patch 121).',
      );
    }
    for (const d of summaryDrifts) {
      await write(
        COL.budgetSummaries,
        d,
        'disbursed',
        () => ({}),
        "Disbursed put back to the sum of the fund's budget lines (patch 121).",
      );
    }
    for (const d of programmeDrifts) {
      await write(
        COL.trustPrograms,
        d,
        'disbursed',
        () => ({}),
        'Disbursed put back to what the checks and ADAs drawn on this programme have paid (patch 121).',
      );
    }

    return { ...report, applied: true, repaired };
  },
);
