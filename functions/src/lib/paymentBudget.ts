import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { db, COL } from './firebase';
import {
  readBudgetBalance,
  applyBudgetDelta,
  applySummaryDelta,
  budgetKeyId,
  type BudgetKey,
  type BudgetBalanceData,
  type BudgetLabels,
} from './budget';
import { allocateDvShares, obligationLineKey } from './dvShares';
import {
  readTrustProgram,
  applyTrustDelta,
  type TrustProgramData,
} from '../accounting/trustPrograms';

/**
 * A disbursement is a check or an ADA. Patch 121.
 *
 * ---------------------------------------------------------------------------
 * TWO FIGURES ON AN OBLIGATION, AND WHICH ONE THE REGISTRY SHOWS
 * ---------------------------------------------------------------------------
 * An obligation is drawn on twice. First a VOUCHER is approved against it:
 * that is `disbursedAmount` on the obligation (kept under its old name, for
 * the voucher picker and the "exceeds the unpaid balance" check that read
 * it), and it is what stops two vouchers drawing the same money. Then a
 * CHECK or an ADA is issued for the voucher: that is `paidAmount`, and THAT
 * is the disbursement - the Registry's Disbursements column, the fund
 * summary, and a trust programme's disbursed figure all move here and
 * nowhere else.
 *
 * Until this patch they moved when the voucher was approved, so a voucher
 * waiting in the Treasurer's queue read as disbursed, and a cancelled check
 * took nothing back. Neil, 09 Oct 2026: "Actual disbursement if there is
 * Check or ADA."
 *
 * ---------------------------------------------------------------------------
 * ONE PLAN, READ THEN WRITTEN
 * ---------------------------------------------------------------------------
 * `planPayments` reads everything a set of payments touches - each
 * obligation once, each budget line once, each programme once - and adds up
 * the shares. `applyPaymentPlan` writes it. Separating the two is what lets
 * the treasury import pay forty vouchers in one transaction without reading
 * a balance twice and losing one of the two deltas; and `sign` is what makes
 * the cancellation of a check the exact reverse of its issue.
 */

export interface PaidDv {
  dvNo?: string;
  fiscalYear: number;
  fundCode: string;
  grossAmount: number;
  obligationId?: string | null;
}

interface ObligationData {
  obrNo?: string;
  fiscalYear: number;
  fundCode: string;
  status: string;
  totalAmount: number;
  disbursedAmount?: number;
  paidAmount?: number;
  lines?: Array<
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
}

export interface PaymentPlan {
  obligations: Map<string, { ref: DocumentReference; data: ObligationData; delta: number }>;
  budget: Map<
    string,
    { key: BudgetKey; balance: BudgetBalanceData; labels: BudgetLabels; delta: number }
  >;
  summary: Map<string, { fiscalYear: number; fundCode: string; delta: number }>;
  trust: Map<string, { data: TrustProgramData; delta: number }>;
}

export const isTrustFund = (fundCode: string | undefined) =>
  String(fundCode ?? '')
    .trim()
    .toUpperCase() === 'TF';

/** Read phase. `sign` is +1 when the instrument is issued, -1 when it is cancelled. */
export async function planPayments(
  tx: Transaction,
  dvs: PaidDv[],
  sign: 1 | -1,
): Promise<PaymentPlan> {
  const plan: PaymentPlan = {
    obligations: new Map(),
    budget: new Map(),
    summary: new Map(),
    trust: new Map(),
  };

  for (const dv of dvs) {
    if (!dv.obligationId) continue;

    let obr = plan.obligations.get(dv.obligationId);
    if (!obr) {
      const ref = db.collection(COL.obligations).doc(dv.obligationId);
      const snap = await tx.get(ref);
      if (!snap.exists) continue;
      obr = { ref, data: snap.data() as ObligationData, delta: 0 };
      plan.obligations.set(dv.obligationId, obr);
    }
    obr.delta += sign * dv.grossAmount;

    const trust = isTrustFund(dv.fundCode);
    for (const { line, share } of allocateDvShares(
      obr.data.lines ?? [],
      obr.data.totalAmount,
      dv.grossAmount,
    )) {
      if (trust) {
        const programId = String(line.trustProgramId ?? '').trim();
        if (!programId) continue;
        let p = plan.trust.get(programId);
        if (!p) {
          p = { data: await readTrustProgram(tx, programId), delta: 0 };
          plan.trust.set(programId, p);
        }
        p.delta += sign * share;
        continue;
      }

      const key = obligationLineKey(obr.data, line);
      const id = budgetKeyId(key);
      let b = plan.budget.get(id);
      if (!b) {
        b = {
          key,
          balance: await readBudgetBalance(tx, key),
          labels: {
            officeName: line.officeName,
            accountName: line.accountName,
            expenseClass: line.expenseClass,
          },
          delta: 0,
        };
        plan.budget.set(id, b);
      }
      b.delta += sign * share;
    }

    if (!trust) {
      const sid = `${dv.fiscalYear}__${dv.fundCode}`;
      const s = plan.summary.get(sid) ?? {
        fiscalYear: dv.fiscalYear,
        fundCode: dv.fundCode,
        delta: 0,
      };
      s.delta += sign * dv.grossAmount;
      plan.summary.set(sid, s);
    }
  }

  return plan;
}

/**
 * The status an obligation is in once its paid and vouchered figures are
 * known. CLOSED and CANCELLED are left alone - they are decisions, not
 * arithmetic.
 */
export function obligationStatusFor(
  current: string,
  total: number,
  vouchered: number,
  paid: number,
): string {
  if (current === 'CLOSED' || current === 'CANCELLED') return current;
  if (total > 0 && paid >= total) return 'PAID';
  if (total > 0 && vouchered >= total) return 'WITH_DV';
  return 'OBLIGATED';
}

/** Write phase. */
export function applyPaymentPlan(tx: Transaction, plan: PaymentPlan): void {
  for (const { key, balance, labels, delta } of plan.budget.values()) {
    if (delta === 0) continue;
    applyBudgetDelta(tx, key, balance, { disbursed: delta }, labels);
  }
  for (const { fiscalYear, fundCode, delta } of plan.summary.values()) {
    if (delta === 0) continue;
    applySummaryDelta(tx, fiscalYear, fundCode, { disbursed: delta });
  }
  for (const [programId, { data, delta }] of plan.trust) {
    if (delta === 0) continue;
    applyTrustDelta(tx, programId, data, { disbursed: delta });
  }
  for (const { ref, data, delta } of plan.obligations.values()) {
    const paidAmount = Math.max(0, (data.paidAmount ?? 0) + delta);
    tx.update(ref, {
      paidAmount,
      status: obligationStatusFor(
        data.status,
        data.totalAmount,
        data.disbursedAmount ?? 0,
        paidAmount,
      ),
    });
  }
}
