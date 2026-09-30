import {
  FUND_BALANCE_GROUP,
  PERFORMANCE_EXPENSES,
  PERFORMANCE_REVENUE,
  POSITION_SECTIONS,
  TRANSFERS_GROUP,
  captionFor,
  majorGroupOf,
} from '@/lib/fsGroups';
import type { Centavos } from '@/types/common';

/**
 * The two statements, condensed and comparative.
 *
 * GAM Volume I, Section 366 for the Statement of Financial Position and
 * Section 368 for the Statement of Financial Performance: both are presented
 * in condensed format and both "with comparative figure of the preceding
 * year". Annexes 5 and 6 are the faces.
 *
 * This takes two sets of account balances - this year's and last year's, each
 * already sign-adjusted so every figure presents positive - and folds them
 * onto the annex captions.
 *
 * ---------------------------------------------------------------------------
 * AN ACCOUNT THAT FITS NO CAPTION IS REPORTED, NOT DROPPED
 * ---------------------------------------------------------------------------
 * The danger peculiar to a condensed statement is that it goes on balancing
 * when something is missing. Drop an account from a caption and it leaves the
 * subtotal, the section and the grand total together; assets and liabilities
 * still agree, and the only trace is that the statement no longer ties to the
 * trial balance - which nobody prints alongside it.
 *
 * So every balance either lands on a caption or comes back in `unmapped`, and
 * the screen refuses to present the statement as complete while anything is
 * there.
 */

export interface FsAccountBalance {
  accountCode: string;
  accountName: string;
  /** CURRENT_ASSET, NON_CURRENT_LIABILITY, REVENUE and so on. */
  classification: string;
  /** Already sign-adjusted: positive as the statement prints it. */
  amount: Centavos;
}

export interface CondensedAccount {
  accountCode: string;
  accountName: string;
  current: Centavos;
  prior: Centavos;
}

export interface CondensedLine {
  caption: string;
  current: Centavos;
  prior: Centavos;
  /** What is behind the caption, for the note schedule and for checking. */
  accounts: CondensedAccount[];
}

export interface CondensedSection {
  key: string;
  title: string;
  totalLabel: string;
  lines: CondensedLine[];
  totalCurrent: Centavos;
  totalPrior: Centavos;
}

export interface UnmappedBalance {
  accountCode: string;
  accountName: string;
  current: Centavos;
  prior: Centavos;
  reason: string;
}

/** Both years of one account, keyed by code. */
function pair(
  current: FsAccountBalance[],
  prior: FsAccountBalance[],
): Map<string, FsAccountBalance & { current: Centavos; prior: Centavos }> {
  const out = new Map<string, FsAccountBalance & { current: Centavos; prior: Centavos }>();
  const take = (rows: FsAccountBalance[], which: 'current' | 'prior') => {
    for (const r of rows) {
      const got = out.get(r.accountCode) ?? { ...r, current: 0, prior: 0 };
      got[which] += r.amount;
      // A name or a classification recorded this year beats one from last, but
      // an account that existed only last year keeps its own.
      if (which === 'current') {
        got.accountName = r.accountName;
        got.classification = r.classification;
      }
      out.set(r.accountCode, got);
    }
  };
  take(prior, 'prior');
  take(current, 'current');
  return out;
}

export interface CondensedPosition {
  sections: CondensedSection[];
  totalAssets: { current: Centavos; prior: Centavos };
  totalLiabilities: { current: Centavos; prior: Centavos };
  /** Government Equity and the other equity groups, excluding Fund Balance. */
  equity: CondensedLine[];
  equityTotal: { current: Centavos; prior: Centavos };
  /** Surplus for the period, passed in - it is not an account balance. */
  unmapped: UnmappedBalance[];
  /**
   * The 3-05 registry accounts, which carry nothing because CBO does not post
   * to them. Reported so the blank Fund Balance block can say why.
   */
  fundBalanceAccounts: CondensedAccount[];
}

const EQUITY_ORDER = [
  'Government Equity',
  'Intermediate Accounts',
  'Equity in Joint Venture',
  'Unrealized Gain/(Loss)',
  'Remeasurement Gain/(Loss)',
];

export function condensePosition(
  current: FsAccountBalance[],
  prior: FsAccountBalance[],
): CondensedPosition {
  const all = pair(current, prior);
  const unmapped: UnmappedBalance[] = [];
  const fundBalanceAccounts: CondensedAccount[] = [];

  // caption -> section key -> line
  const byCaption = new Map<string, CondensedLine>();
  const keyOf = (section: string, caption: string) => `${section}::${caption}`;

  const equityByCaption = new Map<string, CondensedLine>();

  for (const a of all.values()) {
    if (a.current === 0 && a.prior === 0) continue;

    if (majorGroupOf(a.accountCode) === FUND_BALANCE_GROUP) {
      fundBalanceAccounts.push({
        accountCode: a.accountCode,
        accountName: a.accountName,
        current: a.current,
        prior: a.prior,
      });
      continue;
    }

    const caption = captionFor(a.accountCode);
    if (!caption) {
      unmapped.push({
        accountCode: a.accountCode,
        accountName: a.accountName,
        current: a.current,
        prior: a.prior,
        reason: `No statement caption for account group ${majorGroupOf(a.accountCode)}.`,
      });
      continue;
    }

    if (a.classification === 'NET_ASSETS_EQUITY') {
      const line =
        equityByCaption.get(caption) ?? { caption, current: 0, prior: 0, accounts: [] };
      line.current += a.current;
      line.prior += a.prior;
      line.accounts.push({
        accountCode: a.accountCode,
        accountName: a.accountName,
        current: a.current,
        prior: a.prior,
      });
      equityByCaption.set(caption, line);
      continue;
    }

    const section = POSITION_SECTIONS.find(
      (s) => s.key === a.classification && s.captions.includes(caption),
    );
    if (!section) {
      unmapped.push({
        accountCode: a.accountCode,
        accountName: a.accountName,
        current: a.current,
        prior: a.prior,
        reason:
          a.classification === 'REVENUE' || a.classification === 'EXPENSE'
            ? 'A revenue or expense account, which belongs on the Statement of Financial Performance.'
            : `"${caption}" is not a caption of the ${a.classification.toLowerCase().replace(/_/g, ' ')} section.`,
      });
      continue;
    }

    const k = keyOf(section.key, caption);
    const line = byCaption.get(k) ?? { caption, current: 0, prior: 0, accounts: [] };
    line.current += a.current;
    line.prior += a.prior;
    line.accounts.push({
      accountCode: a.accountCode,
      accountName: a.accountName,
      current: a.current,
      prior: a.prior,
    });
    byCaption.set(k, line);
  }

  const sections: CondensedSection[] = POSITION_SECTIONS.map((def) => {
    // The annex order, and only the captions that carry something. A statement
    // printing a dozen nil lines is harder to read, not more complete.
    const lines = def.captions
      .map((c) => byCaption.get(keyOf(def.key, c)))
      .filter((l): l is CondensedLine => !!l);
    return {
      key: def.key,
      title: def.title,
      totalLabel: def.totalLabel,
      lines,
      totalCurrent: lines.reduce((s, l) => s + l.current, 0),
      totalPrior: lines.reduce((s, l) => s + l.prior, 0),
    };
  });

  const sec = (key: string) => sections.find((s) => s.key === key)!;
  const equity = EQUITY_ORDER.map((c) => equityByCaption.get(c)).filter(
    (l): l is CondensedLine => !!l,
  );

  return {
    sections,
    totalAssets: {
      current: sec('CURRENT_ASSET').totalCurrent + sec('NON_CURRENT_ASSET').totalCurrent,
      prior: sec('CURRENT_ASSET').totalPrior + sec('NON_CURRENT_ASSET').totalPrior,
    },
    totalLiabilities: {
      current: sec('CURRENT_LIABILITY').totalCurrent + sec('NON_CURRENT_LIABILITY').totalCurrent,
      prior: sec('CURRENT_LIABILITY').totalPrior + sec('NON_CURRENT_LIABILITY').totalPrior,
    },
    equity,
    equityTotal: {
      current: equity.reduce((s, l) => s + l.current, 0),
      prior: equity.reduce((s, l) => s + l.prior, 0),
    },
    unmapped,
    fundBalanceAccounts,
  };
}

export interface CondensedPerformance {
  revenue: CondensedLine[];
  totalRevenue: { current: Centavos; prior: Centavos };
  expenses: CondensedLine[];
  totalExpenses: { current: Centavos; prior: Centavos };
  surplusFromOperation: { current: Centavos; prior: Centavos };
  transfersFrom: { current: Centavos; prior: Centavos };
  transfersTo: { current: Centavos; prior: Centavos };
  surplus: { current: Centavos; prior: Centavos };
  unmapped: UnmappedBalance[];
}

export function condensePerformance(
  current: FsAccountBalance[],
  prior: FsAccountBalance[],
): CondensedPerformance {
  const all = pair(current, prior);
  const unmapped: UnmappedBalance[] = [];
  const byGroup = new Map<string, CondensedLine>();
  let transfersFromCurrent = 0;
  let transfersFromPrior = 0;
  let transfersToCurrent = 0;
  let transfersToPrior = 0;

  for (const a of all.values()) {
    if (a.current === 0 && a.prior === 0) continue;
    if (a.classification !== 'REVENUE' && a.classification !== 'EXPENSE') continue;

    const group = majorGroupOf(a.accountCode);

    /*
     * The transfers block sits beneath the surplus from current operation, not
     * in the revenue or expense list. Group 4-03 holds both directions; the
     * sign of the balance says which, because an inward transfer is
     * credit-normal and presents positive while an outward one does not.
     */
    if (group === TRANSFERS_GROUP) {
      if (a.current >= 0) transfersFromCurrent += a.current;
      else transfersToCurrent += -a.current;
      if (a.prior >= 0) transfersFromPrior += a.prior;
      else transfersToPrior += -a.prior;
      continue;
    }

    const def =
      PERFORMANCE_REVENUE.find((l) => l.groups.includes(group)) ??
      PERFORMANCE_EXPENSES.find((l) => l.groups.includes(group));
    if (!def) {
      unmapped.push({
        accountCode: a.accountCode,
        accountName: a.accountName,
        current: a.current,
        prior: a.prior,
        reason: `No line of the Statement of Financial Performance takes account group ${group}.`,
      });
      continue;
    }

    const line = byGroup.get(group) ?? { caption: def.caption, current: 0, prior: 0, accounts: [] };
    line.current += a.current;
    line.prior += a.prior;
    line.accounts.push({
      accountCode: a.accountCode,
      accountName: a.accountName,
      current: a.current,
      prior: a.prior,
    });
    byGroup.set(group, line);
  }

  /*
   * Every caption the annex prints, in its order, whether or not it carries
   * anything. Unlike the position statement, a blank line here is information:
   * "Share from Internal Revenue Collections" at nil says the municipality's
   * chart has no such account, and leaving the line out would hide that.
   */
  const build = (defs: typeof PERFORMANCE_REVENUE): CondensedLine[] =>
    defs.map((d) => {
      const parts = d.groups.map((g) => byGroup.get(g)).filter((l): l is CondensedLine => !!l);
      return {
        caption: d.caption,
        current: parts.reduce((s, l) => s + l.current, 0),
        prior: parts.reduce((s, l) => s + l.prior, 0),
        accounts: parts.flatMap((l) => l.accounts),
      };
    });

  const revenue = build(PERFORMANCE_REVENUE);
  const expenses = build(PERFORMANCE_EXPENSES);

  const totalRevenue = {
    current: revenue.reduce((s, l) => s + l.current, 0),
    prior: revenue.reduce((s, l) => s + l.prior, 0),
  };
  const totalExpenses = {
    current: expenses.reduce((s, l) => s + l.current, 0),
    prior: expenses.reduce((s, l) => s + l.prior, 0),
  };
  const surplusFromOperation = {
    current: totalRevenue.current - totalExpenses.current,
    prior: totalRevenue.prior - totalExpenses.prior,
  };

  return {
    revenue,
    totalRevenue,
    expenses,
    totalExpenses,
    surplusFromOperation,
    transfersFrom: { current: transfersFromCurrent, prior: transfersFromPrior },
    transfersTo: { current: transfersToCurrent, prior: transfersToPrior },
    surplus: {
      current: surplusFromOperation.current + transfersFromCurrent - transfersToCurrent,
      prior: surplusFromOperation.prior + transfersFromPrior - transfersToPrior,
    },
    unmapped,
  };
}
