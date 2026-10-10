import type { Action, Module } from '@/types/system';

/**
 * Patch 169 - ACCESS PER USER, on top of the role.
 *
 * A role says what a kind of officer may do. The office also needs to say
 * what THIS officer may do: a treasury staff who keeps only the payroll, a
 * clerk who may look at the Budget but not touch it, a module someone should
 * not see at all. So each user carries an access map, set on Administration >
 * Users:
 *
 *   FULL    what the role allows (the default for anything not listed)
 *   VIEW    the role's view, print and export only - nothing that changes data
 *   HIDDEN  nothing: the menu item is gone and the screens refuse
 *
 * Keyed by module ('budget', 'treasury', ...) and, inside Treasury, by the
 * four books the office divides its staff by ('treasury.checks', ...).
 *
 * It only ever NARROWS the role. A user given FULL on a module their role does
 * not grant gets nothing more.
 *
 * It travels in the user's sign-in token (custom claims), set by the
 * setUserRoles callable, and firestore.rules reads it for the Treasury
 * collections a browser writes to.
 */

export type AccessLevel = 'FULL' | 'VIEW' | 'HIDDEN';
export type AccessMap = Partial<Record<string, AccessLevel>>;

export const ACCESS_LEVELS: AccessLevel[] = ['FULL', 'VIEW', 'HIDDEN'];

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  FULL: 'Full (as the role allows)',
  VIEW: 'View only',
  HIDDEN: 'Hidden',
};

/** The parts of Treasury a staff member can be given, one or more. */
export const TREASURY_AREAS = [
  {
    key: 'treasury.checks',
    label: 'Checks and ADA',
    prefixes: [
      '/treasury/disbursements',
      '/treasury/checks',
      '/treasury/ada',
      '/treasury/print/checks',
      '/treasury/claim-sheet',
      '/treasury/cash-advance-book',
    ],
  },
  {
    key: 'treasury.collections',
    label: 'Collections and Deposits',
    prefixes: [
      '/treasury/collections',
      '/treasury/deposits',
      '/treasury/rcd',
      '/treasury/print/receipts',
      '/reports/abstract-of-collections',
      '/reports/abstract-of-e-collections',
      '/reports/summary-of-collections',
      '/reports/rcd-transmittal',
      '/reports/rpt-abstract',
    ],
  },
  { key: 'treasury.payroll', label: 'Payroll', prefixes: ['/treasury/payroll'] },
  {
    key: 'treasury.forms',
    label: 'Accountable Forms',
    prefixes: ['/treasury/accountable-forms', '/treasury/raaf'],
  },
] as const;

export type TreasuryArea = (typeof TREASURY_AREAS)[number]['key'];

/** Which Treasury book a screen belongs to, or null. Longest prefix wins. */
export function treasuryAreaFor(pathname: string): TreasuryArea | null {
  let best: { key: TreasuryArea; len: number } | null = null;
  for (const a of TREASURY_AREAS) {
    for (const p of a.prefixes) {
      if ((pathname === p || pathname.startsWith(`${p}/`)) && (!best || p.length > best.len)) {
        best = { key: a.key, len: p.length };
      }
    }
  }
  return best?.key ?? null;
}

const READ: Action[] = ['view', 'print', 'export'];

/** Whether an access level lets an action through. */
export function levelAllows(level: AccessLevel | undefined, action: Action): boolean {
  if (!level || level === 'FULL') return true;
  if (level === 'HIDDEN') return false;
  return READ.includes(action);
}

/**
 * The role's answer, narrowed by the user's access: by the module, and - on a
 * screen that belongs to one of Treasury's books (`pathname`) - by Treasury and
 * that book as well, whatever menu the screen sits under (the Abstract and the
 * Summary of Collections are Collections screens kept under /reports/).
 */
export function narrowed(
  roleAllows: boolean,
  access: AccessMap,
  module: Module,
  action: Action,
  pathname?: string | null,
  /**
   * Apply the screen's Treasury book whatever the module. The route guard
   * does; a button asking about 'budget' while the page is a Collections
   * screen must not be answered by the Collections access.
   */
  anyModule = false,
): boolean {
  if (!roleAllows) return false;
  if (!levelAllows(access[module], action)) return false;
  if (pathname && (module === 'treasury' || anyModule)) {
    const area = treasuryAreaFor(pathname);
    if (area && (!levelAllows(access.treasury, action) || !levelAllows(access[area], action))) {
      return false;
    }
  }
  return true;
}

/** Keeps only known keys and levels, and drops FULL (the default). */
export function cleanAccess(input: unknown, modules: readonly string[]): AccessMap {
  const keys = new Set<string>([...modules, ...TREASURY_AREAS.map((a) => a.key)]);
  const out: AccessMap = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (keys.has(k) && (v === 'VIEW' || v === 'HIDDEN')) out[k] = v;
    }
  }
  return out;
}
