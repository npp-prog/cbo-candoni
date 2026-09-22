import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { beforeUserSignedIn } from 'firebase-functions/v2/identity';
import { ENFORCE_APP_CHECK, auth, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid } from '../lib/context';
import { audit } from '../lib/audit';

const VALID_ROLES = [
  'SUPER_ADMIN',
  'MUNICIPAL_ACCOUNTANT',
  'ACCOUNTING_REVIEWER',
  'ACCOUNTING_ENCODER',
  'BUDGET_OFFICER',
  'BUDGET_STAFF',
  'MUNICIPAL_TREASURER',
  'TREASURY_STAFF',
  'DEPARTMENT_USER',
  'AUDITOR',
];

/**
 * Role combinations that let one person carry a transaction through two
 * control gates alone. Assigning one is permitted - a small municipal
 * accounting office sometimes has no alternative - but it is recorded as a
 * CRITICAL audit event so that the decision is visible rather than quietly
 * accumulated.
 */
const SEGREGATION_CONFLICTS: Array<[string, string, string]> = [
  ['ACCOUNTING_ENCODER', 'MUNICIPAL_ACCOUNTANT', 'encode and post to the General Ledger'],
  ['BUDGET_STAFF', 'BUDGET_OFFICER', 'prepare and certify obligations'],
  ['TREASURY_STAFF', 'MUNICIPAL_TREASURER', 'record and approve collections'],
  ['ACCOUNTING_REVIEWER', 'ACCOUNTING_ENCODER', 'encode and review the same voucher'],
  ['AUDITOR', 'MUNICIPAL_ACCOUNTANT', 'audit and transact'],
];

/**
 * setUserRoles - the only way roles are granted in CBO.
 *
 * Roles live in Firebase Auth custom claims because that is what Firestore
 * Security Rules can read and what a client cannot forge. The `users` document
 * is a mirror for the administration screen, and rules explicitly forbid a user
 * from writing their own `roles` field - so there is no path by which a user
 * can promote themselves.
 *
 * A claim change takes effect when the user's ID token refreshes, which is
 * within the hour, or immediately on next sign-in. For a revocation that must
 * bite now, this also revokes the user's refresh tokens.
 */
export const setUserRoles = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request, ['SUPER_ADMIN']);
  const { uid, roles, officeScope, fundScope, active } = (request.data ?? {}) as {
    uid?: string;
    roles?: string[];
    officeScope?: string[];
    fundScope?: string[];
    active?: boolean;
  };

  if (!uid) throw invalid('A user id is required.');
  if (!Array.isArray(roles)) throw invalid('Roles must be provided as a list.');

  const invalidRoles = roles.filter((r) => !VALID_ROLES.includes(r));
  if (invalidRoles.length) {
    throw invalid(`Unknown role(s): ${invalidRoles.join(', ')}.`);
  }

  // An administrator removing their own last administrative role would lock
  // the municipality out of its own system.
  if (uid === caller.uid && !roles.includes('SUPER_ADMIN')) {
    const admins = await db
      .collection(COL.users)
      .where('roles', 'array-contains', 'SUPER_ADMIN')
      .where('active', '==', true)
      .get();
    if (admins.size <= 1) {
      throw new HttpsError(
        'failed-precondition',
        'You are the only active Super Administrator. Grant the role to another user before removing it from your own account, or CBO will have no administrator.',
      );
    }
  }

  const userRecord = await auth.getUser(uid).catch(() => null);
  if (!userRecord) {
    throw new HttpsError('not-found', 'That user does not exist in Firebase Authentication.');
  }

  const previousSnap = await db.collection(COL.users).doc(uid).get();
  const previousRoles = (previousSnap.data()?.roles as string[]) ?? [];

  const isActive = active ?? previousSnap.data()?.active ?? true;

  await auth.setCustomUserClaims(uid, {
    roles,
    officeScope: officeScope ?? [],
    fundScope: fundScope ?? [],
    active: isActive,
  });

  // Force the change to take effect on the next request rather than waiting
  // for the existing token to expire. Matters most when revoking access.
  await auth.revokeRefreshTokens(uid);

  const now = new Date().toISOString();
  await db.collection(COL.users).doc(uid).set(
    {
      uid,
      email: userRecord.email ?? '',
      displayName: userRecord.displayName ?? userRecord.email ?? uid,
      roles,
      officeScope: officeScope ?? [],
      fundScope: fundScope ?? [],
      active: isActive,
      claimsSyncedAt: now,
    },
    { merge: true },
  );

  const conflicts = SEGREGATION_CONFLICTS.filter(([a, b]) => roles.includes(a) && roles.includes(b));

  await audit({
    caller,
    event: 'PERMISSION_CHANGE',
    entityType: COL.users,
    entityId: uid,
    entityRef: userRecord.email ?? uid,
    severity: 'CRITICAL',
    changes: [
      { field: 'roles', previous: previousRoles, next: roles },
      { field: 'active', previous: previousSnap.data()?.active ?? null, next: isActive },
      { field: 'officeScope', previous: previousSnap.data()?.officeScope ?? [], next: officeScope ?? [] },
    ],
    remarks:
      conflicts.length > 0
        ? `Segregation of duties warning: this user can now ${conflicts.map((c) => c[2]).join('; ')}.`
        : undefined,
  });

  return { uid, roles, segregationWarnings: conflicts.map((c) => c[2]) };
});

/**
 * Provisions a profile on first sign-in and records the login.
 *
 * A new user arrives with no roles at all and can therefore see nothing until
 * an administrator grants access. Defaulting to any role, however limited,
 * would mean anyone who obtains a Firebase account gets a foothold in the
 * municipality's financial records.
 */
export const onBeforeSignIn = beforeUserSignedIn({ region: REGION }, async (event) => {
  const uid = event.data?.uid;
  const email = event.data?.email ?? '';
  if (!uid) return;

  const ref = db.collection(COL.users).doc(uid);
  const snap = await ref.get();
  const now = new Date().toISOString();

  if (!snap.exists) {
    await ref.set({
      uid,
      email,
      displayName: event.data?.displayName ?? email,
      roles: [],
      officeScope: [],
      fundScope: [],
      active: true,
      mfaEnrolled: false,
      createdAt: now,
      lastLoginAt: now,
    });

    await db.collection(COL.auditLogs).add({
      at: now,
      actorUid: uid,
      actorName: email,
      actorRoles: [],
      event: 'LOGIN',
      entityType: COL.users,
      entityId: uid,
      entityRef: email,
      remarks: 'First sign-in. Profile created with no roles; an administrator must grant access.',
      severity: 'NOTICE',
    });
    return;
  }

  if (snap.data()?.active === false) {
    throw new HttpsError('permission-denied', 'This CBO account has been deactivated.');
  }

  await ref.update({ lastLoginAt: now });
  await db.collection(COL.auditLogs).add({
    at: now,
    actorUid: uid,
    actorName: snap.data()?.displayName ?? email,
    actorRoles: (snap.data()?.roles as string[]) ?? [],
    event: 'LOGIN',
    entityType: COL.users,
    entityId: uid,
    entityRef: email,
    severity: 'INFO',
  });
});

/**
 * recordExport - logs report exports and prints.
 *
 * COA expects to be able to ask who took a copy of the books and when. The
 * client calls this after a successful export; it carries no authority and
 * changes nothing, so a failure here never blocks the export itself.
 */
export const recordExport = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const caller = await requireCaller(request);
  const { report, format, filters } = (request.data ?? {}) as {
    report?: string;
    format?: string;
    filters?: Record<string, unknown>;
  };

  await audit({
    caller,
    event: format === 'PRINT' ? 'PRINT' : 'EXPORT',
    entityType: 'reports',
    entityRef: report ?? 'unnamed report',
    remarks: `${report} exported as ${format}${filters ? ` with filters ${JSON.stringify(filters)}` : ''}.`,
    severity: 'INFO',
  });

  return { logged: true as const };
});
