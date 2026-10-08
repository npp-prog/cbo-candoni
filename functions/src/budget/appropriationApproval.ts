import type { BudgetBalanceData } from '../lib/budget';

/**
 * Approving many appropriation lines at once - an uploaded ordinance. Patch 112.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PLAN AND NOT A LOOP OF SINGLE APPROVALS
 * ---------------------------------------------------------------------------
 * An ordinance often carries two lines on the same budget line - the same
 * office, programme and object, split across two rows of the annex. Approving
 * them one after another inside one transaction would read the same balance
 * twice, add each line to the figure it read, and write twice: the second
 * write wins and the first line's amount simply vanishes from the budget. No
 * error, just a budget short by an amount nobody could trace. The ordinance
 * UPLOAD already guards against this by summing first; approval has to as
 * well.
 *
 * So the lines are grouped by budget line, the deltas summed, the result
 * checked once per budget line, and each balance written once.
 */

export interface ApprovalLine {
  id: string;
  /** The budget balance document id this line falls on. */
  keyId: string;
  kind: string;
  amount: number;
  /** How the line is named in a refusal. */
  label: string;
}

type DeltaField =
  | 'appropriationOriginal'
  | 'appropriationSupplemental'
  | 'appropriationContinuing'
  | 'appropriationAdjustments';

/** Which component of the appropriation a line of this kind adds to. */
export function appropriationField(kind: string): DeltaField {
  switch (kind) {
    case 'ORIGINAL':
      return 'appropriationOriginal';
    case 'SUPPLEMENTAL':
      return 'appropriationSupplemental';
    case 'CONTINUING':
      return 'appropriationContinuing';
    default:
      // REALIGNMENT, TRANSFER, ADJUSTMENT land in adjustments and may be negative.
      return 'appropriationAdjustments';
  }
}

export interface ApprovalPlan {
  ok: boolean;
  problems: string[];
  /** Per budget line: the summed delta, and the lines that make it up. */
  byKey: Map<string, { delta: Partial<BudgetBalanceData>; amount: number; lineIds: string[] }>;
  total: number;
}

const peso = (c: number) => (c / 100).toFixed(2);

export function planAppropriationApproval(
  lines: ApprovalLine[],
  balances: Map<string, Pick<BudgetBalanceData, 'appropriationRevised' | 'allotmentReleased'>>,
): ApprovalPlan {
  const byKey: ApprovalPlan['byKey'] = new Map();
  const labels = new Map<string, string>();
  let total = 0;

  for (const l of lines) {
    const entry = byKey.get(l.keyId) ?? { delta: {}, amount: 0, lineIds: [] };
    const field = appropriationField(l.kind);
    entry.delta[field] = (entry.delta[field] ?? 0) + l.amount;
    entry.amount += l.amount;
    entry.lineIds.push(l.id);
    byKey.set(l.keyId, entry);
    if (!labels.has(l.keyId)) labels.set(l.keyId, l.label);
    total += l.amount;
  }

  const problems: string[] = [];
  for (const [keyId, entry] of byKey) {
    const b = balances.get(keyId) ?? {
      appropriationRevised: 0,
      allotmentReleased: 0,
    };
    const resulting = b.appropriationRevised + entry.amount;
    const label = labels.get(keyId) ?? keyId;
    if (resulting < 0) {
      problems.push(
        `${label} would be driven to ${peso(resulting)}; an appropriation cannot be negative`,
      );
    } else if (resulting < b.allotmentReleased) {
      problems.push(
        `${label} would fall to ${peso(resulting)}, below the ${peso(b.allotmentReleased)} ` +
          'already released as allotment - withdraw the allotment first',
      );
    }
  }

  return { ok: problems.length === 0, problems, byKey, total };
}
