import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import {
  beforeUserSignedIn,
  // A blocking function has its own error type. Throwing the callable
  // HttpsError here does not deny the sign-in with a reason - it escapes as
  // an internal error, which reads to the user as a wrong password.
  HttpsError as AuthBlockingError,
} from 'firebase-functions/v2/identity';
import { ENFORCE_APP_CHECK, auth, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, reporting } from '../lib/context';
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
 * Apply roles and scope to an account that already exists in Firebase
 * Authentication, and record it.
 *
 * Shared by setUserRoles and createUserAccount so that an account created in
 * CFMS is granted access by exactly the same code, and the same checks, as one
 * created in the Firebase console. Two code paths to the same permissions is
 * how one of them quietly stops applying the last-administrator rule.
 */
async function grantAccess(
  caller: Awaited<ReturnType<typeof requireCaller>>,
  uid: string,
  input: {
    roles?: string[];
    officeScope?: string[];
    fundScope?: string[];
    active?: boolean;
    access?: unknown;
  },
): Promise<{ uid: string; roles: string[]; segregationWarnings: string[] }> {
  const { roles, officeScope, fundScope, active } = input;

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
        'You are the only active Super Administrator. Grant the role to another user before removing it from your own account, or CFMS will have no administrator.',
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
  /*
   * Patch 169: the user's own access - per module, and per Treasury book -
   * which narrows the roles. Kept when not sent, so an older screen granting
   * roles does not wipe it.
   */
  const access =
    input.access === undefined
      ? ((previousSnap.data()?.access as Record<string, string>) ?? {})
      : cleanAccess(input.access);

  await auth.setCustomUserClaims(uid, {
    roles,
    officeScope: officeScope ?? [],
    fundScope: fundScope ?? [],
    active: isActive,
    access,
  });

  // Force the change to take effect on the next request rather than waiting
  // for the existing token to expire. Matters most when revoking access.
  await auth.revokeRefreshTokens(uid);

  const now = new Date().toISOString();
  // `set` with merge, not `update`: this both maintains an existing profile and
  // provisions one that the sign-in hook never got to create.
  await db
    .collection(COL.users)
    .doc(uid)
    .set(
      {
        uid,
        email: userRecord.email ?? '',
        displayName: userRecord.displayName ?? userRecord.email ?? uid,
        roles,
        officeScope: officeScope ?? [],
        fundScope: fundScope ?? [],
        active: isActive,
        access,
        claimsSyncedAt: now,
      },
      { merge: true },
    );

  const conflicts = SEGREGATION_CONFLICTS.filter(
    ([a, b]) => roles.includes(a) && roles.includes(b),
  );

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
      {
        field: 'officeScope',
        previous: previousSnap.data()?.officeScope ?? [],
        next: officeScope ?? [],
      },
      { field: 'access', previous: previousSnap.data()?.access ?? {}, next: access },
    ],
    remarks:
      conflicts.length > 0
        ? `Segregation of duties warning: this user can now ${conflicts.map((c) => c[2]).join('; ')}.`
        : undefined,
  });

  return { uid, roles, segregationWarnings: conflicts.map((c) => c[2]) };
}

/**
 * Patch 169 - a user's access map, cleaned: known keys (the modules and the
 * four Treasury books) and the narrowing levels only. FULL is the default and
 * is not stored. Mirrors src/auth/access.ts.
 */
const ACCESS_KEYS = new Set([
  'dashboard',
  'budget',
  'accounting',
  'treasury',
  'reconciliation',
  'reports',
  'masterData',
  'documents',
  'administration',
  'auditTrail',
  'treasury.checks',
  'treasury.collections',
  'treasury.payroll',
  'treasury.forms',
]);
export function cleanAccess(input: unknown): Record<string, 'VIEW' | 'HIDDEN'> {
  const out: Record<string, 'VIEW' | 'HIDDEN'> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (ACCESS_KEYS.has(k) && (v === 'VIEW' || v === 'HIDDEN')) out[k] = v;
    }
  }
  return out;
}

/**
 * setUserRoles - the only way roles are granted in CFMS.
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
export const setUserRoles = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ['SUPER_ADMIN']);
    return reporting('Granting access', async () => {
      const {
        uid: uidIn,
        email,
        roles,
        officeScope,
        fundScope,
        active,
        access,
      } = (request.data ?? {}) as {
        uid?: string;
        email?: string;
        roles?: string[];
        officeScope?: string[];
        fundScope?: string[];
        active?: boolean;
        access?: unknown;
      };

      /*
       * A user may be named by id or by email address, and the email is what an
       * administrator actually has.
       *
       * Roles used to be grantable only to somebody already in the `users`
       * collection, which meant only to somebody who had signed in at least once,
       * because the profile was created by the sign-in hook. That put the
       * municipality one broken hook away from nobody being able to grant access to
       * anybody - including to a new administrator, with the old one gone. The
       * administration screen would simply be empty, with no way to act.
       *
       * Looking the account up here removes that. The account must still exist in
       * Firebase Authentication; this does not create one, because creating
       * credentials is not a thing a role-granting function should be able to do.
       */
      let uid = uidIn;
      if (!uid) {
        const address = String(email ?? '')
          .trim()
          .toLowerCase();
        if (!address) throw invalid('A user id or an email address is required.');
        const found = await auth.getUserByEmail(address).catch((err: { code?: string }) => {
          if (err?.code === 'auth/user-not-found') return null;
          throw err;
        });
        if (!found) {
          throw new HttpsError(
            'not-found',
            `No Firebase Authentication account exists for ${address}. Create the account first - Firebase console, Authentication, Add user - then grant the role here.`,
          );
        }
        uid = found.uid;
      }
      return grantAccess(caller, uid, { roles, officeScope, fundScope, active, access });
    });
  },
);

/** Firebase accepts six. A system holding the municipality's books asks more. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * createUserAccount - make the Firebase Authentication account AND grant the
 * role, in one act, from inside CFMS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NOW EXISTS, HAVING DELIBERATELY NOT EXISTED
 * ---------------------------------------------------------------------------
 * setUserRoles refuses to create credentials, and the comment on it says why:
 * creating credentials is not a thing a role-granting function should be able
 * to do. That reasoning stands, which is why this is a SEPARATE function with
 * its own name, rather than setUserRoles quietly growing the power.
 *
 * What it buys: the Municipal Accountant can add a clerk without a Firebase
 * console, a Google account with project access, and a walk through a developer
 * interface that offers - two clicks from the Add user button - the ability to
 * delete the entire authentication database.
 *
 * ---------------------------------------------------------------------------
 * THE PASSWORD
 * ---------------------------------------------------------------------------
 * It is passed straight to Firebase Authentication and never stored, logged or
 * audited by CFMS. The audit entry records that an account was created, by
 * whom, for which email address - never the password, and there is no field
 * here that could carry it by accident.
 *
 * It is a TEMPORARY password, handed to the person face to face. CFMS has no
 * password-change screen yet, so that is the next thing worth building; until
 * then a password is changed by the administrator setting a new one.
 *
 * ---------------------------------------------------------------------------
 * AN EXISTING ACCOUNT IS GRANTED, NOT REFUSED
 * ---------------------------------------------------------------------------
 * If the email already has an account - because somebody made it in the
 * console, or because the clerk already signed in once - this grants the role
 * and leaves the password alone. An administrator should not have to know
 * which of the two cases they are in, and this function must never be a way to
 * overwrite somebody's password by typing their address.
 */
export const createUserAccount = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ['SUPER_ADMIN']);
    return reporting('Creating the account', async () => {
      const { email, displayName, password, roles, officeScope, fundScope } = (request.data ??
        {}) as {
        email?: string;
        displayName?: string;
        password?: string;
        roles?: string[];
        officeScope?: string[];
        fundScope?: string[];
      };

      const address = String(email ?? '')
        .trim()
        .toLowerCase();
      if (!address) throw invalid('An email address is required.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
        throw invalid(`"${address}" is not an email address.`);
      }

      const existing = await auth.getUserByEmail(address).catch((err: { code?: string }) => {
        if (err?.code === 'auth/user-not-found') return null;
        throw err;
      });

      if (existing) {
        const granted = await grantAccess(caller, existing.uid, {
          roles,
          officeScope,
          fundScope,
          active: true,
        });
        return { ...granted, created: false, email: address };
      }

      const name = String(displayName ?? '').trim();
      if (!name) {
        throw invalid(
          'A full name is required. It is what appears on every document this user certifies, approves or posts.',
        );
      }

      const secret = String(password ?? '');
      if (secret.length < MIN_PASSWORD_LENGTH) {
        throw invalid(
          `The temporary password must be at least ${MIN_PASSWORD_LENGTH} characters. This account can reach the municipality's financial records.`,
        );
      }

      const record = await auth
        .createUser({ email: address, password: secret, displayName: name, emailVerified: false })
        .catch((err: { code?: string; message?: string }) => {
          if (err?.code === 'auth/email-already-exists') {
            throw new HttpsError(
              'already-exists',
              `An account for ${address} was created a moment ago by somebody else. Close this and grant the role from the list.`,
            );
          }
          if (err?.code === 'auth/invalid-password') {
            throw invalid('Firebase Authentication refused that password. Use a longer one.');
          }
          throw new HttpsError(
            'internal',
            `Firebase Authentication refused to create the account: ${err?.message ?? 'no reason given'}.`,
          );
        });

      await audit({
        caller,
        event: 'PERMISSION_CHANGE',
        entityType: COL.users,
        entityId: record.uid,
        entityRef: address,
        severity: 'CRITICAL',
        remarks: `Firebase Authentication account created from CFMS for ${name}.`,
      });

      const granted = await grantAccess(caller, record.uid, {
        roles,
        officeScope,
        fundScope,
        active: true,
      });

      return { ...granted, created: true, email: address };
    });
  },
);

/**
 * Provisions a profile on first sign-in and records the login.
 *
 * A new user arrives with no roles at all and can therefore see nothing until
 * an administrator grants access. Defaulting to any role, however limited,
 * would mean anyone who obtains a Firebase account gets a foothold in the
 * municipality's financial records.
 *
 * ---------------------------------------------------------------------------
 * The rule this function is built around
 * ---------------------------------------------------------------------------
 *
 * This code runs BEFORE the sign-in completes, and anything that escapes it
 * denies that sign-in. There is no retry and no way round it from the browser:
 * a fault here locks every user out of the municipality's accounting system at
 * once, including the administrator who would have to fix it.
 *
 * So exactly one thing may refuse a sign-in - a deactivated account - and it
 * says so in as many words. Everything else this function does is bookkeeping:
 * creating the profile, stamping the login time, writing the audit entry. None
 * of that is a reason to keep somebody out of the books, so all of it is
 * wrapped, and a failure is logged for an administrator to find rather than
 * thrown at the person trying to sign in.
 *
 * That is not a safety net over careless code. It is the correct trade. A
 * missing audit entry is a gap in a record; a denied sign-in is an office that
 * cannot work, and the deactivation check - the only thing here that protects
 * anything - still runs first and still refuses.
 */
export const onBeforeSignIn = beforeUserSignedIn({ region: REGION }, async (event) => {
  const uid = event.data?.uid;
  const email = event.data?.email ?? '';
  if (!uid) return;

  const ref = db.collection(COL.users).doc(uid);
  const now = new Date().toISOString();

  // ---- the one check that may refuse -------------------------------------
  //
  // Read on its own, so a deactivated account is refused even if every write
  // below fails. If the read itself fails we cannot know whether the account
  // is active; the sign-in is allowed, because the security rules and the
  // engine both check the `active` claim again on every request, and a
  // Firestore outage must not become a lockout.

  let profile: FirebaseFirestore.DocumentSnapshot | null = null;
  try {
    profile = await ref.get();
  } catch (err) {
    console.error('onBeforeSignIn: could not read the user profile', { uid, err });
  }

  if (profile?.exists && profile.data()?.active === false) {
    throw new AuthBlockingError('permission-denied', 'This CFMS account has been deactivated.');
  }

  // ---- bookkeeping, which may never deny -----------------------------------

  try {
    if (profile && !profile.exists) {
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
        remarks:
          'First sign-in. Profile created with no roles; an administrator must grant access.',
        severity: 'NOTICE',
      });
      return;
    }

    if (profile?.exists) {
      await ref.update({ lastLoginAt: now });
      await db.collection(COL.auditLogs).add({
        at: now,
        actorUid: uid,
        actorName: profile.data()?.displayName ?? email,
        actorRoles: (profile.data()?.roles as string[]) ?? [],
        event: 'LOGIN',
        entityType: COL.users,
        entityId: uid,
        entityRef: email,
        severity: 'INFO',
      });
    }
  } catch (err) {
    // Logged, not thrown. See the note at the top of this function.
    console.error('onBeforeSignIn: could not record the sign-in', { uid, email, err });
  }
});

/**
 * recordExport - logs report exports and prints.
 *
 * COA expects to be able to ask who took a copy of the books and when. The
 * client calls this after a successful export; it carries no authority and
 * changes nothing, so a failure here never blocks the export itself.
 */
export const recordExport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
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
  },
);
