import type { Action, Module, Permission, Role } from '@/types/system';

/**
 * Role-based access control.
 *
 * Two layers, deliberately:
 *
 *  1. This table, used by the UI to decide what to render. It is a *usability*
 *     control. Hiding a button stops mistakes, not attackers.
 *  2. Firestore Security Rules and Cloud Functions, which read the same roles
 *     from the user's Firebase Auth custom claims. That is the *security*
 *     control, and it is the only one that matters if someone opens a console.
 *
 * Both layers are derived from the same role definitions so they cannot drift
 * in intent; but the rules are written out longhand in `firestore.rules`
 * because security rules cannot import TypeScript.
 */

const all = (module: Module, actions: Action[]): Permission[] =>
  actions.map((a) => `${module}:${a}` as Permission);

const READ_ONLY: Action[] = ['view', 'print', 'export'];
const ENCODE: Action[] = ['view', 'create', 'edit', 'print', 'export'];

/**
 * Default permission sets for the built-in roles. An administrator may clone
 * and adjust these in the Administration module; the stored `roleDefinitions`
 * documents win over this table at runtime, which only supplies the seed and
 * the fallback for a role with no stored definition.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    ...all('dashboard', ['view', 'export', 'print']),
    ...all('budget', ['view', 'create', 'edit', 'review', 'approve', 'post', 'cancel', 'print', 'export']),
    ...all('accounting', ['view', 'create', 'edit', 'review', 'approve', 'post', 'cancel', 'print', 'export']),
    ...all('treasury', ['view', 'create', 'edit', 'review', 'approve', 'post', 'cancel', 'print', 'export']),
    ...all('reconciliation', ['view', 'create', 'edit', 'review', 'approve', 'post', 'cancel', 'print', 'export']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view', 'create', 'edit', 'cancel', 'print', 'export', 'delete']),
    ...all('documents', ['view', 'create', 'edit', 'cancel', 'print', 'export']),
    ...all('administration', ['view', 'create', 'edit', 'approve', 'cancel', 'export']),
    ...all('auditTrail', READ_ONLY),
  ],

  MUNICIPAL_ACCOUNTANT: [
    ...all('dashboard', ['view', 'export', 'print']),
    ...all('budget', READ_ONLY),
    ...all('accounting', ['view', 'create', 'edit', 'review', 'approve', 'post', 'cancel', 'print', 'export']),
    ...all('treasury', READ_ONLY),
    ...all('reconciliation', ['view', 'create', 'edit', 'review', 'approve', 'print', 'export']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view', 'create', 'edit', 'print', 'export']),
    ...all('documents', ['view', 'create', 'print', 'export']),
    ...all('administration', ['view']),
    ...all('auditTrail', READ_ONLY),
  ],

  ACCOUNTING_REVIEWER: [
    ...all('dashboard', ['view', 'export']),
    ...all('budget', READ_ONLY),
    ...all('accounting', ['view', 'edit', 'review', 'print', 'export']),
    ...all('treasury', READ_ONLY),
    ...all('reconciliation', ['view', 'edit', 'review', 'print', 'export']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view']),
    ...all('documents', ['view', 'create', 'print', 'export']),
    ...all('auditTrail', ['view']),
  ],

  ACCOUNTING_ENCODER: [
    ...all('dashboard', ['view']),
    ...all('budget', ['view']),
    ...all('accounting', ENCODE),
    ...all('treasury', ['view']),
    ...all('reconciliation', ['view', 'create', 'edit']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view']),
    ...all('documents', ['view', 'create', 'print']),
  ],

  BUDGET_OFFICER: [
    ...all('dashboard', ['view', 'export', 'print']),
    ...all('budget', ['view', 'create', 'edit', 'review', 'approve', 'post', 'cancel', 'print', 'export']),
    ...all('accounting', READ_ONLY),
    ...all('treasury', ['view']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view', 'create', 'edit']),
    ...all('documents', ['view', 'create', 'print', 'export']),
    ...all('auditTrail', ['view']),
  ],

  BUDGET_STAFF: [
    ...all('dashboard', ['view']),
    ...all('budget', ENCODE),
    ...all('accounting', ['view']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view']),
    ...all('documents', ['view', 'create', 'print']),
  ],

  MUNICIPAL_TREASURER: [
    ...all('dashboard', ['view', 'export', 'print']),
    ...all('budget', ['view']),
    ...all('accounting', READ_ONLY),
    ...all('treasury', ['view', 'create', 'edit', 'review', 'approve', 'post', 'cancel', 'print', 'export']),
    ...all('reconciliation', ['view', 'create', 'edit', 'review', 'print', 'export']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view', 'create', 'edit']),
    ...all('documents', ['view', 'create', 'print', 'export']),
    ...all('auditTrail', ['view']),
  ],

  TREASURY_STAFF: [
    ...all('dashboard', ['view']),
    ...all('treasury', ENCODE),
    ...all('accounting', ['view']),
    ...all('reconciliation', ['view', 'create', 'edit']),
    ...all('reports', READ_ONLY),
    ...all('masterData', ['view']),
    ...all('documents', ['view', 'create', 'print']),
  ],

  /** Scoped further to the user's own office by `officeScope` on the profile. */
  DEPARTMENT_USER: [
    ...all('dashboard', ['view']),
    ...all('budget', ['view', 'create', 'edit', 'print']),
    ...all('accounting', ['view', 'create', 'edit', 'print']),
    ...all('reports', ['view', 'print']),
    ...all('masterData', ['view']),
    ...all('documents', ['view', 'create', 'print']),
  ],

  /**
   * COA. Read-only across the whole system, including supporting documents and
   * the audit trail. Deliberately given export and print: an auditor who cannot
   * take a working copy will ask for a database dump instead, which is worse.
   */
  AUDITOR: [
    ...all('dashboard', READ_ONLY),
    ...all('budget', READ_ONLY),
    ...all('accounting', READ_ONLY),
    ...all('treasury', READ_ONLY),
    ...all('reconciliation', READ_ONLY),
    ...all('reports', READ_ONLY),
    ...all('masterData', READ_ONLY),
    ...all('documents', READ_ONLY),
    ...all('auditTrail', READ_ONLY),
  ],
};

/** Union of permissions across all of a user's roles. */
export function permissionsFor(
  roles: Role[],
  overrides?: Partial<Record<Role, Permission[]>>,
): Set<Permission> {
  const set = new Set<Permission>();
  for (const role of roles) {
    const perms = overrides?.[role] ?? DEFAULT_ROLE_PERMISSIONS[role] ?? [];
    for (const p of perms) set.add(p);
  }
  return set;
}

export function can(
  permissions: Set<Permission>,
  module: Module,
  action: Action,
): boolean {
  return permissions.has(`${module}:${action}` as Permission);
}

/**
 * Roles that may post to the General Ledger. Kept separate from the permission
 * table because posting is the single most consequential act in the system and
 * should be greppable.
 */
export const POSTING_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

/** Roles that may certify an obligation as to availability of allotment. */
export const CERTIFYING_ROLES: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER'];

/** Roles that may close or reopen an accounting period. */
export const PERIOD_CONTROL_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

/**
 * Segregation of duties. A single user holding both roles in a pair can push a
 * transaction through two control gates alone. The administration screen warns
 * when such a combination is assigned; it does not block it, because in a
 * municipality with a small accounting staff it is sometimes unavoidable - but
 * it should be a deliberate, visible decision rather than an accident.
 */
export const SEGREGATION_CONFLICTS: Array<[Role, Role, string]> = [
  [
    'ACCOUNTING_ENCODER',
    'MUNICIPAL_ACCOUNTANT',
    'The same user could both encode and post a journal entry to the General Ledger.',
  ],
  [
    'BUDGET_STAFF',
    'BUDGET_OFFICER',
    'The same user could both prepare and certify an obligation against allotment.',
  ],
  [
    'TREASURY_STAFF',
    'MUNICIPAL_TREASURER',
    'The same user could both record and approve collections and deposits.',
  ],
  [
    'ACCOUNTING_REVIEWER',
    'ACCOUNTING_ENCODER',
    'The same user could review a disbursement voucher they themselves encoded.',
  ],
  [
    'AUDITOR',
    'MUNICIPAL_ACCOUNTANT',
    'An audit role must not also hold transaction authority.',
  ],
];

export function segregationWarnings(roles: Role[]): string[] {
  const held = new Set(roles);
  return SEGREGATION_CONFLICTS.filter(([a, b]) => held.has(a) && held.has(b)).map(
    ([a, b, why]) => why,
  );
}
