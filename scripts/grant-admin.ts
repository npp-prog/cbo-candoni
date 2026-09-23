/**
 * Grants the first Super Administrator on a fresh CBO project.
 *
 *   npx tsx scripts/grant-admin.ts --project cbo-candoni-dev --email you@example.org
 *
 * Requires Application Default Credentials:
 *   gcloud auth application-default login
 *
 * WHY THIS SCRIPT EXISTS
 *
 * Roles in CBO are granted by `setUserRoles`, and that function requires the
 * caller to already be a SUPER_ADMIN - which is what makes it impossible for a
 * user to promote themselves. On a brand-new project nobody holds that role
 * yet, so there is nothing to call it with. Something outside the application
 * has to grant the first one.
 *
 * The Firebase Console cannot: it can reset a password, disable an account and
 * delete one, but it has no way to set custom claims. So this runs with the
 * project's own administrative credentials - the same authority that created
 * the project - and does exactly what setUserRoles would have done.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not create the account. The person signs up through the application
 * first, with their own password, and only then is the role attached to the
 * account that already exists. A script that both creates an account and makes
 * it an administrator is a script that leaves a known identity with full rights
 * in a municipality's financial system - the sort of thing that is set up once,
 * forgotten, and found later by somebody else.
 *
 * Run it once, for the first administrator. After that the role is granted in
 * the application, under Administration - Users, where every change is written
 * to the audit trail with the name of the officer who made it. This script
 * writes an audit entry too, attributed to the console, so the first grant is
 * not invisible.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const projectId = valueOf('--project') ?? process.env.GCLOUD_PROJECT;
const email = valueOf('--email');

function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (!projectId || !email) {
  console.error(
    'Usage: tsx scripts/grant-admin.ts --project <firebase-project-id> --email <user-email>',
  );
  process.exit(1);
}

initializeApp({ projectId, credential: applicationDefault() });

const auth = getAuth();
const db = getFirestore();

async function main() {
  // Distinguish "that user does not exist" from every other failure.
  //
  // An earlier version of this script caught all errors and reported them as a
  // missing account. A permissions problem, credentials pointing at the wrong
  // project and a disabled API all came out as "no account exists", which sent
  // the reader looking for the wrong thing. Only user-not-found means what it
  // says; anything else is printed as itself.
  let user;
  try {
    user = await auth.getUserByEmail(email!);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? '';
    const message = (err as { message?: string }).message ?? String(err);

    if (code === 'auth/user-not-found') {
      console.error(
        `\nNo account exists for ${email} in project ${projectId}.\n\n` +
          'Create it in the Firebase Console under Authentication - Users, or\n' +
          'sign in to the application once with that address. Then run this again.\n',
      );
      process.exit(1);
    }

    console.error(`\nCould not look up ${email} in project ${projectId}.\n`);
    console.error(`  ${code ? code + ': ' : ''}${message}\n`);
    console.error('  What this usually means:\n');
    console.error(
      '  - The credentials on this machine are for a different project.\n' +
        '    Check with:  gcloud config list\n' +
        '    and re-run:  gcloud auth application-default login\n',
    );
    console.error(
      '  - The Identity Toolkit API is not enabled on the project. Enable it at\n' +
        `    https://console.cloud.google.com/apis/library/identitytoolkit.googleapis.com?project=${projectId}\n`,
    );
    console.error(
      '  - The signed-in account lacks the Firebase Authentication Admin role\n' +
        '    on this project.\n',
    );
    process.exit(1);
  }

  const now = new Date().toISOString();

  await auth.setCustomUserClaims(user.uid, {
    roles: ['SUPER_ADMIN'],
    officeScope: [],
    fundScope: [],
    active: true,
  });

  // The existing ID token still carries the old, empty claims. Revoking forces
  // a fresh one on the next request rather than waiting up to an hour.
  await auth.revokeRefreshTokens(user.uid);

  await db.collection('users').doc(user.uid).set(
    {
      uid: user.uid,
      email: user.email ?? email,
      displayName: user.displayName ?? user.email ?? user.uid,
      roles: ['SUPER_ADMIN'],
      officeScope: [],
      fundScope: [],
      active: true,
      claimsSyncedAt: now,
    },
    { merge: true },
  );

  await db.collection('auditLogs').add({
    event: 'PERMISSION_CHANGE',
    entityType: 'users',
    entityId: user.uid,
    entityRef: user.email ?? email,
    severity: 'CRITICAL',
    at: now,
    actor: {
      uid: 'console',
      name: 'Project administrator (grant-admin script)',
      position: null,
    },
    changes: [{ field: 'roles', previous: [], next: ['SUPER_ADMIN'] }],
    remarks:
      'First Super Administrator granted outside the application, using project credentials. Subsequent role changes are made under Administration - Users.',
  });

  console.log(`\n  ${email} is now a Super Administrator of ${projectId}.`);
  console.log('  UID: ' + user.uid);
  console.log('\n  Sign out of the application and sign in again for it to take effect.\n');
}

main().catch((err) => {
  console.error('\nCould not grant the role:', err.message ?? err, '\n');
  process.exit(1);
});
