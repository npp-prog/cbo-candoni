import {
  SCBAA_EXPENSE_CLASSES,
  SCBAA_REVENUE,
  SCBAA_REVENUE_TOTAL_OF,
  SCBAA_SECTORS,
  autoMatchSector,
  revenueLineFor,
  type ActualBasis,
  type ScbaaRevenueLine,
} from '@/lib/scbaaLines';
import type { Centavos } from '@/types/common';

/**
 * The Statement of Comparison of Budget and Actual Amounts, Annex 8.
 *
 * Five columns and no comparative year - Section 370 says this statement
 * "shall not be presented in comparison with the previous year figures", which
 * makes it the only one of the six that is not comparative.
 *
 * The line definitions and the two decisions this statement cannot make for
 * itself live in lib/scbaaLines.ts; this is the arithmetic.
 */

export interface ScbaaFigures {
  original: Centavos;
  final: Centavos;
  /** Original less final. Negative where the budget grew during the year. */
  differenceOriginalFinal: Centavos;
  actual: Centavos;
  /** Final less actual. Positive is budget not used. */
  differenceFinalActual: Centavos;
}

const figures = (original: Centavos, final: Centavos, actual: Centavos): ScbaaFigures => ({
  original,
  final,
  differenceOriginalFinal: original - final,
  actual,
  differenceFinalActual: final - actual,
});

const ZERO = figures(0, 0, 0);

const add = (a: ScbaaFigures, b: ScbaaFigures): ScbaaFigures =>
  figures(a.original + b.original, a.final + b.final, a.actual + b.actual);

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

export interface ScbaaRevenueEstimate {
  accountCode: string;
  accountName: string;
  /** The whole year's estimate. */
  annual: Centavos;
}

export interface ScbaaRevenueActual {
  accountCode: string;
  amount: Centavos;
}

export interface ScbaaRevenueRow {
  line: ScbaaRevenueLine;
  figures: ScbaaFigures;
  /** Accounts behind the line, for checking. */
  accounts: Array<{ accountCode: string; accountName: string; budget: Centavos; actual: Centavos }>;
}

export interface ScbaaRevenue {
  rows: ScbaaRevenueRow[];
  total: ScbaaFigures;
  /**
   * Collections or estimates on an account no annex line takes. Reported, not
   * dropped: on a statement this shape a missing figure leaves no trace.
   */
  unmapped: Array<{ accountCode: string; accountName: string; budget: Centavos; actual: Centavos }>;
  /**
   * True while CFMS holds one estimate per account and no record of which
   * ordinance set it, so the original and final revenue budgets are the same
   * figure.
   */
  originalEqualsFinal: boolean;
}

export function buildScbaaRevenue(input: {
  estimates: ScbaaRevenueEstimate[];
  actuals: ScbaaRevenueActual[];
}): ScbaaRevenue {
  const budgetByAccount = new Map<string, { name: string; budget: Centavos; actual: Centavos }>();

  for (const e of input.estimates) {
    const got = budgetByAccount.get(e.accountCode) ?? { name: e.accountName, budget: 0, actual: 0 };
    got.budget += e.annual;
    got.name = e.accountName || got.name;
    budgetByAccount.set(e.accountCode, got);
  }
  for (const a of input.actuals) {
    const got = budgetByAccount.get(a.accountCode) ?? { name: '', budget: 0, actual: 0 };
    got.actual += a.amount;
    budgetByAccount.set(a.accountCode, got);
  }

  const byLabel = new Map<string, ScbaaRevenueRow>();
  for (const line of SCBAA_REVENUE) {
    byLabel.set(line.label, { line, figures: ZERO, accounts: [] });
  }

  const unmapped: ScbaaRevenue['unmapped'] = [];

  for (const [code, v] of budgetByAccount) {
    if (v.budget === 0 && v.actual === 0) continue;
    const line = revenueLineFor(code);
    if (!line) {
      unmapped.push({ accountCode: code, accountName: v.name, budget: v.budget, actual: v.actual });
      continue;
    }
    const row = byLabel.get(line.label)!;
    /*
     * The original and the final revenue budget are the same figure, and that
     * is a limitation rather than a claim that no supplemental budget was
     * enacted. CFMS holds ONE estimate per income account with no record of
     * which ordinance set it, so it cannot separate the annual budget from a
     * supplemental. The screen says so beside the columns.
     */
    row.figures = add(row.figures, figures(v.budget, v.budget, v.actual));
    row.accounts.push({
      accountCode: code,
      accountName: v.name,
      budget: v.budget,
      actual: v.actual,
    });
  }

  // Subtotals, after the detail lines are filled.
  for (const line of SCBAA_REVENUE) {
    if (!line.totalOf) continue;
    const row = byLabel.get(line.label)!;
    row.figures = line.totalOf.reduce(
      (acc, label) => add(acc, byLabel.get(label)?.figures ?? ZERO),
      ZERO,
    );
  }

  /*
   * The grand total is built from the detail lines of the two halves, not by
   * adding the subtotals - the external sources have no subtotal line of their
   * own on the annex, so there is nothing to add there.
   */
  const externalLabels = SCBAA_REVENUE.slice(
    SCBAA_REVENUE.findIndex((l) => l.label === 'B. External Sources'),
  )
    .filter((l) => !l.heading && !l.totalOf)
    .map((l) => l.label);

  const total = [
    ...SCBAA_REVENUE_TOTAL_OF.filter((l) => l !== 'B. External Sources'),
    ...externalLabels,
  ].reduce((acc, label) => add(acc, byLabel.get(label)?.figures ?? ZERO), ZERO);

  return {
    rows: SCBAA_REVENUE.map((l) => byLabel.get(l.label)!),
    total,
    unmapped,
    originalEqualsFinal: true,
  };
}

// ---------------------------------------------------------------------------
// Expenditure
// ---------------------------------------------------------------------------

export interface ScbaaBudgetLine {
  sector?: string;
  expenseClass: string;
  appropriationOriginal: Centavos;
  appropriationContinuing: Centavos;
  appropriationRevised: Centavos;
  obligated: Centavos;
  disbursed: Centavos;
}

export interface ScbaaExpenditureRow {
  sector: string;
  classKey: string;
  classLabel: string;
  onAnnex: boolean;
  figures: ScbaaFigures;
}

export interface ScbaaSectorBlock {
  sector: string;
  rows: ScbaaExpenditureRow[];
  total: ScbaaFigures;
}

export interface ScbaaExpenditure {
  blocks: ScbaaSectorBlock[];
  total: ScbaaFigures;
  /**
   * Sector names in the ordinance that no annex line has been matched to.
   * The office nominates these; nothing is guessed, and nothing is quietly
   * swept into "Others".
   */
  unmatchedSectors: Array<{ sector: string; amount: Centavos }>;
}

export function buildScbaaExpenditure(input: {
  lines: ScbaaBudgetLine[];
  basis: ActualBasis;
  /** Municipal sector name to annex line, for the ones that do not match by name. */
  sectorMapping?: Record<string, string>;
}): ScbaaExpenditure {
  const key = (sector: string, cls: string) => `${sector}::${cls}`;
  const cells = new Map<string, ScbaaFigures>();
  const unmatched = new Map<string, Centavos>();

  for (const l of input.lines) {
    const own = (l.sector ?? '').trim();
    const mapped = own ? (input.sectorMapping?.[own] ?? autoMatchSector(own)) : null;

    const amount = l.appropriationRevised;
    if (!mapped) {
      // Not dropped and not swept into Others: named, so somebody can map it.
      unmatched.set(own || '(no sector recorded)', (unmatched.get(own || '(no sector recorded)') ?? 0) + amount);
      continue;
    }

    // Section 371 puts the carry-on continuing appropriations in the ORIGINAL
    // budget, so they are added here rather than shown apart.
    const original = l.appropriationOriginal + l.appropriationContinuing;
    const actual = input.basis === 'OBLIGATIONS' ? l.obligated : l.disbursed;

    const k = key(mapped, l.expenseClass);
    cells.set(k, add(cells.get(k) ?? ZERO, figures(original, l.appropriationRevised, actual)));
  }

  const blocks: ScbaaSectorBlock[] = [];
  for (const sector of SCBAA_SECTORS) {
    const rows: ScbaaExpenditureRow[] = [];
    for (const cls of SCBAA_EXPENSE_CLASSES) {
      const f = cells.get(key(sector, cls.key));
      if (!f) continue;
      rows.push({
        sector,
        classKey: cls.key,
        classLabel: cls.label,
        onAnnex: cls.onAnnex,
        figures: f,
      });
    }
    // A sector with nothing appropriated to it is not printed. The annex lists
    // eleven because a province might use all eleven; a municipality that funds
    // six should not submit five empty blocks.
    if (rows.length === 0) continue;
    blocks.push({
      sector,
      rows,
      total: rows.reduce((acc, r) => add(acc, r.figures), ZERO),
    });
  }

  return {
    blocks,
    total: blocks.reduce((acc, b) => add(acc, b.total), ZERO),
    unmatchedSectors: [...unmatched.entries()]
      .map(([sector, amount]) => ({ sector, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}
