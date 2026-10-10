import type { LayoutRow } from './detailedFsLayout';

/**
 * Patch 168 - the DETAILED Statements of Financial Position and Financial
 * Performance, in the office's own format (src/lib/detailedFsLayout.ts):
 * every account under its heading, with the subtotals the office prints,
 * this year beside last year.
 *
 * The condensed statements (Annexes 5 and 6) stay; this is the schedule
 * behind them.
 *
 * A figure is the account's NATURAL balance: debit less credit for an asset
 * or an expense (1-, 5-), credit less debit for a liability, equity or
 * revenue (2-, 3-, 4-). So a contra account - accumulated depreciation, a
 * discount on real property tax - prints negative, as on the office's sheet.
 */

export interface Balances {
  current: Map<string, number>;
  prior: Map<string, number>;
}

export interface DetailedRow {
  kind: 'heading' | 'account' | 'total' | 'computed' | 'equity';
  level: number;
  label: string;
  code?: string;
  current: number;
  prior: number;
  /** Shown when nil accounts are hidden: there is something in it. */
  hasFigures: boolean;
  /** An account the layout has no line for, printed beside the nearest one. */
  extra?: boolean;
}

export interface DetailedStatement {
  rows: DetailedRow[];
  /** Accounts with a balance that the layout has no line for. */
  unplaced: Array<{ code: string; current: number; prior: number }>;
}

/** Debit-positive for assets and expenses, credit-positive for the rest. */
export function naturalSign(code: string): 1 | -1 {
  const c = String(code ?? '').trim()[0];
  return c === '1' || c === '5' ? 1 : -1;
}

/** Natural balances by account code, from ledger lines (debit positive). */
export function naturalBalances(
  entries: Array<{ accountCode: string; period: number; signedAmount?: number }>,
  throughPeriod: number,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    if (e.period > throughPeriod) continue;
    const code = String(e.accountCode ?? '').trim();
    m.set(code, (m.get(code) ?? 0) + (e.signedAmount ?? 0));
  }
  for (const [code, v] of m) m.set(code, v * naturalSign(code));
  return m;
}

export function buildDetailed(
  layout: LayoutRow[],
  balances: Balances,
  /** The Net Assets/Equity line's figures, where the layout has one. */
  equity?: { current: number; prior: number },
  /** Account titles from the chart, for an account the layout lacks. */
  names?: Map<string, string>,
): DetailedStatement {
  const rows: DetailedRow[] = layout.map((r) => {
    switch (r[0]) {
      case 'h':
        return {
          kind: 'heading',
          level: r[1],
          label: r[2],
          current: 0,
          prior: 0,
          hasFigures: false,
        };
      case 'a': {
        const dup = r[3] === 1;
        const cur = dup ? 0 : (balances.current.get(r[1]) ?? 0);
        const pri = dup ? 0 : (balances.prior.get(r[1]) ?? 0);
        return {
          kind: 'account',
          level: 5,
          label: r[2],
          code: r[1],
          current: cur,
          prior: pri,
          hasFigures: cur !== 0 || pri !== 0,
        };
      }
      case 't':
        return { kind: 'total', level: r[1], label: r[2], current: 0, prior: 0, hasFigures: false };
      case 'f':
        return {
          kind: 'computed',
          level: r[1],
          label: r[2],
          current: 0,
          prior: 0,
          hasFigures: true,
        };
      case 'e':
        return {
          kind: 'equity',
          level: r[1],
          label: r[2],
          current: equity?.current ?? 0,
          prior: equity?.prior ?? 0,
          hasFigures: true,
        };
    }
  });

  /*
   * An account with a balance the layout has no line for (a code from an
   * older chart, 19901030, say) is not dropped: it is printed beside the
   * nearest account of the layout - the last one with a lower code in the
   * same class - and counted in that account's totals, so the statement
   * still foots. It is also listed, so the chart can be put right.
   */
  const placed = new Set(
    layout.filter((r): r is ['a', string, string] => r[0] === 'a').map((r) => r[1]),
  );
  const codes = new Set([...balances.current.keys(), ...balances.prior.keys()]);
  const hasEquityLine = layout.some((r) => r[0] === 'e');
  const unplaced = [...codes]
    .filter((c) => !placed.has(c))
    // On the position statement the other equity accounts are in Net Assets/Equity.
    .filter((c) => !(hasEquityLine && c.startsWith('3')))
    .map((code) => ({
      code,
      current: balances.current.get(code) ?? 0,
      prior: balances.prior.get(code) ?? 0,
    }))
    .filter((u) => u.current !== 0 || u.prior !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const extras = new Map<number, DetailedRow[]>();
  for (const u of unplaced) {
    let anchor = -1;
    layout.forEach((r, i) => {
      if (r[0] === 'a' && r[3] !== 1 && r[1][0] === u.code[0] && r[1] < u.code) anchor = i;
    });
    if (anchor < 0) {
      layout.forEach((r, i) => {
        if (anchor < 0 && r[0] === 'a' && r[3] !== 1 && r[1][0] === u.code[0]) anchor = i;
      });
    }
    if (anchor < 0) continue;
    extras.set(anchor, [
      ...(extras.get(anchor) ?? []),
      {
        kind: 'account',
        level: 5,
        label: names?.get(u.code) ?? 'Account not in the detailed format',
        code: u.code,
        current: u.current,
        prior: u.prior,
        hasFigures: true,
        extra: true,
      },
    ]);
  }

  // Subtotals: the accounts (and the equity line) in their range.
  layout.forEach((r, i) => {
    if (r[0] !== 't') return;
    let cur = 0;
    let pri = 0;
    let any = false;
    for (let j = r[3]; j <= r[4]; j++) {
      for (const x of [rows[j], ...(extras.get(j) ?? [])]) {
        if (x.kind === 'account' || x.kind === 'equity') {
          cur += x.current;
          pri += x.prior;
          any = any || x.hasFigures;
        }
      }
    }
    rows[i] = { ...rows[i], current: cur, prior: pri, hasFigures: any };
  });

  // Computed lines, in order (a later one may use an earlier one).
  layout.forEach((r, i) => {
    if (r[0] !== 'f') return;
    let cur = 0;
    let pri = 0;
    for (const [sign, j] of r[3]) {
      cur += sign * rows[j].current;
      pri += sign * rows[j].prior;
    }
    rows[i] = { ...rows[i], current: cur, prior: pri };
  });

  const out: DetailedRow[] = [];
  rows.forEach((x, i) => {
    out.push(x);
    for (const e of extras.get(i) ?? []) out.push(e);
  });

  // A heading has figures when an account beneath it (before the next
  // heading, subtotal or line of its own level or higher) has.
  out.forEach((x, i) => {
    if (x.kind !== 'heading') return;
    for (let j = i + 1; j < out.length; j++) {
      const y = out[j];
      if (y.kind !== 'account' && y.level <= x.level) break;
      if (y.kind === 'account' && y.hasFigures) {
        x.hasFigures = true;
        break;
      }
    }
  });

  return { rows: out, unplaced };
}

/** Only the balances of one statement: 1-3 for position, 4-5 for performance. */
export function balancesFor(
  m: Map<string, number>,
  statement: 'position' | 'performance',
): Map<string, number> {
  const keep = statement === 'position' ? /^[123]/ : /^[45]/;
  return new Map([...m].filter(([code]) => keep.test(code)));
}

/** The figure on a computed line, found by its label (e.g. the surplus). */
export function lineValue(s: DetailedStatement, label: RegExp): { current: number; prior: number } {
  const r = s.rows.find((x) => label.test(x.label));
  return { current: r?.current ?? 0, prior: r?.prior ?? 0 };
}

/**
 * Net Assets/Equity on the detailed position statement: the equity accounts
 * (3-) the layout has no line of their own for, plus the surplus or deficit
 * of the period - as the condensed statement works it.
 */
export function equityFigures(
  layout: LayoutRow[],
  balances: Balances,
  surplus: { current: number; prior: number },
): { current: number; prior: number } {
  const placed = new Set(
    layout.filter((r): r is ['a', string, string] => r[0] === 'a').map((r) => r[1]),
  );
  const sum = (m: Map<string, number>) =>
    [...m].filter(([c]) => c.startsWith('3') && !placed.has(c)).reduce((t, [, v]) => t + v, 0);
  return {
    current: sum(balances.current) + surplus.current,
    prior: sum(balances.prior) + surplus.prior,
  };
}
