#!/usr/bin/env node
/**
 * Static checks on the security rules.
 *
 * Firestore rules cannot be unit-tested without the emulator, and an emulator
 * run in CI is slow enough that people start skipping it. These checks are
 * cheap, run on every push, and catch the mistakes that would actually matter:
 * a syntax error that breaks the deploy, and — more importantly — a
 * server-only collection quietly losing its blanket write denial.
 *
 * The second check is the one worth having. The whole trustworthiness of the
 * General Ledger rests on `allow write: if false` for `ledgerEntries`. If a
 * future change removes that line, every guarantee in the README becomes
 * false, and nothing else in the build would notice.
 *
 *   node scripts/check-rules.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Must match SERVER_ONLY_COLLECTIONS in src/lib/collections.ts. */
const SERVER_ONLY = [
  'ledgerEntries',
  'auditLogs',
  'counters',
  'budgetBalances',
  'budgetSummaries',
  'estimatedReceipts',
  'trustPrograms',
  'cashPositions',
  'accountingPeriods',
  'workflowHistory',
  'treasuryImports',
  'bankLedgers',
  'bankLedgerEntries',
  'adaNumbers',
  'primaryReports',
  'accountableFormMovements',
  'raafReports',
];

const failures = [];

// --- 1. Both rules files parse and declare version 2 ------------------------

for (const file of ['firestore.rules', 'storage.rules']) {
  const src = readFileSync(resolve(root, file), 'utf8');
  const open = (src.match(/{/g) ?? []).length;
  const close = (src.match(/}/g) ?? []).length;

  if (open !== close) failures.push(`${file}: unbalanced braces (${open} open, ${close} close)`);
  if (!/rules_version\s*=\s*'2'/.test(src)) failures.push(`${file}: must declare rules_version = '2'`);
  if (!/match \/\{[a-zA-Z]+=\*\*\}/.test(src)) {
    failures.push(`${file}: no default-deny catch-all rule found`);
  }
  if (open === close && /rules_version/.test(src)) console.log(`${file}: ok`);
}

// --- 2. Server-only collections deny every client write ---------------------

const firestore = readFileSync(resolve(root, 'firestore.rules'), 'utf8');

for (const collection of SERVER_ONLY) {
  const block = firestore.match(
    new RegExp(`match /${collection}/\\{[^}]*\\}\\s*\\{([\\s\\S]*?)\\n    \\}`),
  );

  if (!block) {
    failures.push(`firestore.rules: no rule block for server-only collection '${collection}'`);
    continue;
  }

  const body = block[1];
  const denied = /allow (create, update, delete|write):\s*if false;/.test(body);

  if (!denied) {
    failures.push(
      `firestore.rules: '${collection}' is server-only but has no blanket write denial. ` +
        `It needs 'allow write: if false;' or 'allow create, update, delete: if false;'. ` +
        `Without it, a client could write this collection directly and the guarantees in ` +
        `README.md no longer hold.`,
    );
  }
}

if (!failures.some((f) => f.includes('server-only'))) {
  console.log(`server-only collections: all ${SERVER_ONLY.length} deny client writes`);
}

// --- 3. Posted journal entries are immutable --------------------------------

const jevBlock = firestore.match(/match \/jevs\/\{[^}]*\}\s*\{([\s\S]*?)\n    \}/);
if (!jevBlock) {
  failures.push("firestore.rules: no rule block for 'jevs'");
} else if (!/resource\.data\.status in \['DRAFT', 'FOR_REVIEW'\]/.test(jevBlock[1])) {
  failures.push(
    "firestore.rules: the 'jevs' update rule no longer restricts edits to DRAFT and FOR_REVIEW. " +
      'A posted journal entry must be immutable.',
  );
} else {
  console.log('jevs: posted entries are immutable');
}

// --- 4. Indexes are valid JSON ----------------------------------------------

try {
  JSON.parse(readFileSync(resolve(root, 'firestore.indexes.json'), 'utf8'));
  console.log('firestore.indexes.json: valid');
} catch (err) {
  failures.push(`firestore.indexes.json: ${err instanceof Error ? err.message : err}`);
}

// --- 5. The budget key is computed identically on both sides -----------------
//
// `budgetKeyId` exists twice - in src/types/budget.ts for the browser and in
// functions/src/lib/budget.ts for the server - because each carries its own
// types and neither can import the other's. They are not vendored.
//
// If they ever disagree, nothing fails. The browser reads one balance document
// and the server writes another, both succeed, and the budget control silently
// stops controlling anything: every obligation sees a fresh line with no
// allotment drawn against it. That is the worst shape a bug can take in this
// system, so the two are compared here on every build.

const KEY_BODY = /export function budgetKeyId\([^)]*\)[^{]*\{([\s\S]*?)\n\}/;

function keyBody(file) {
  const match = KEY_BODY.exec(readFileSync(resolve(root, file), 'utf8'));
  if (!match) return null;
  // Compare the segments the id is built from, not the whitespace or the
  // comments around them.
  return match[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '');
}

const clientKey = keyBody('src/types/budget.ts');
const serverKey = keyBody('functions/src/lib/budget.ts');

if (!clientKey || !serverKey) {
  failures.push(
    'budgetKeyId: could not find it in src/types/budget.ts and functions/src/lib/budget.ts. ' +
      'Both must define it, and they must define it identically.',
  );
} else if (clientKey !== serverKey) {
  failures.push(
    'budgetKeyId differs between src/types/budget.ts and functions/src/lib/budget.ts. ' +
      'The browser and the server would read and write different balance documents for the ' +
      'same budget line, and every obligation would see an untouched allotment.',
  );
} else {
  console.log('budgetKeyId: client and server agree');
}

// --- 6. Nobody else builds a budget key by hand ------------------------------
//
// Two copies are already one more than anybody wants. A THIRD copy is what the
// nightly integrity check had: a hand-written `[...].join('__')` that fell a
// segment behind when the key gained the FPP code. Nothing failed. The rebuilt
// ids simply stopped matching any stored id, every balance was skipped, and
// the job reported a clean night every night while verifying nothing at all.
//
// A control that cannot fail out loud is worse than no control, because it is
// believed. So any file that derives a balance document id derives it with
// `budgetKeyId`, and this refuses the pattern that went wrong.

const HAND_ROLLED = /\.join\(\s*['"`]__['"`]\s*\)/;
const KEY_CONSUMERS = [
  'functions/src/admin/scheduled.ts',
  'functions/src/budget/aro.ts',
  'functions/src/budget/obligations.ts',
  'functions/src/budget/import.ts',
];

for (const file of KEY_CONSUMERS) {
  const source = readFileSync(resolve(root, file), 'utf8');
  if (HAND_ROLLED.test(source)) {
    failures.push(
      `${file} builds a budget key by joining fields with '__' instead of calling budgetKeyId. ` +
        'A hand-written key drifts silently: it will keep producing ids, they will simply stop ' +
        'matching the stored balances, and whatever reads them will report nothing wrong.',
    );
  }
}

if (!failures.some((f) => f.includes("joining fields with '__'"))) {
  console.log(`budget keys: ${KEY_CONSUMERS.length} consumers all use budgetKeyId`);
}

// ---------------------------------------------------------------------------
// 7. Two files in one folder whose names differ only in case
// ---------------------------------------------------------------------------
//
// This one does not look like a security check and is here because it broke
// the build on the only machine that matters - the Municipal Accountant's.
//
// The convention in src/pages is a lowercase module holding the arithmetic
// beside an Uppercase component holding the screen: `scbaa.ts` next to
// `Scbaa.tsx`. On Linux, where this repository is developed, those are two
// files and `import './Scbaa'` finds the component. On Windows they are one
// name in two spellings, and because TypeScript tries `.ts` before `.tsx`,
// `import './pages/reports/Scbaa'` resolves to `scbaa.ts` - the arithmetic
// module, which has no default export and is not a React component.
//
// Eight such pairs had accumulated. The build failed with 23 errors on the
// accountant's machine while passing here, which is the worst shape a defect
// can take: invisible to the person who wrote it.
//
// Turning off forceConsistentCasingInFileNames would silence the errors and
// leave the real fault in place - the lazy route would import the wrong module
// and fail at run time instead. So the names have to stay distinct, and this
// is what keeps them so.

const CASE_SCAN_DIRS = ['src', 'functions/src', 'scripts'];
const CODE_EXT = /\.(ts|tsx|mjs|js)$/;

function scanForCaseCollisions(dir, out) {
  let entries;
  try {
    entries = readdirSync(resolve(root, dir), { withFileTypes: true });
  } catch {
    return;
  }

  const stems = new Map();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue;
      scanForCaseCollisions(`${dir}/${entry.name}`, out);
      continue;
    }
    if (!CODE_EXT.test(entry.name)) continue;
    const stem = entry.name.replace(CODE_EXT, '');
    const key = stem.toLowerCase();
    const seen = stems.get(key);
    if (seen && seen !== stem) out.push({ dir, a: seen, b: stem });
    else if (!seen) stems.set(key, stem);
  }
}

const collisions = [];
for (const dir of CASE_SCAN_DIRS) scanForCaseCollisions(dir, collisions);

/*
 * The eight that patch 54 renamed. A patch zip can add and replace a file but
 * cannot delete one, so installing it leaves the old name on disk beside the
 * new - which is a collision again, and the old test file runs as well. When
 * the pair we have found is one of those, say what to run rather than leaving
 * the reader to work out that the fix is a deletion.
 */
const RENAMED_BY_PATCH_54 = new Set([
  'raao',
  'reairr',
  'scbaa',
  'rptAbstract',
  'quarterlyReceipts',
  'budgetVsActual',
  'unreleasedChecks',
  'cashAdvanceBook',
]);

const leftovers = collisions.filter((c) => RENAMED_BY_PATCH_54.has(c.a) || RENAMED_BY_PATCH_54.has(c.b));

for (const c of collisions) {
  const stale = RENAMED_BY_PATCH_54.has(c.a) ? c.a : RENAMED_BY_PATCH_54.has(c.b) ? c.b : null;
  failures.push(
    `${c.dir} holds both ${c.a} and ${c.b}, which differ only in case. On Windows and macOS ` +
      'those are one file name, so an extensionless import of either resolves to whichever ' +
      'extension TypeScript tries first - and the build fails there while passing on Linux. ' +
      (stale
        ? `${stale} was renamed to ${stale}Report and the old file is still here.`
        : 'Give one of them a distinct name.'),
  );
}

if (leftovers.length > 0) {
  failures.push(
    `Run  node scripts/remove-legacy-modules.mjs  to delete the ${leftovers.length} leftover ` +
      'file(s) above and their tests. It removes nothing else, and it refuses to run unless the ' +
      'files that replaced them are already in place.',
  );
}

if (collisions.length === 0) {
  console.log('file names: no two differ only in case');
}

// --- 8. Colour is reserved for things that need attention -------------------
//
// The `info` tone was a blue panel, and it was carrying explanations of how
// the accounting works. Explanation does not need colour, and spending colour
// on it is what made the real warnings easy to scroll past. The tone is grey
// now, and this check keeps it grey: a guard is cheaper than noticing a year
// later that the blue crept back one screen at a time.

const layoutPath = resolve(root, 'src/components/ui/Layout.tsx');

if (existsSync(layoutPath)) {
  const layout = readFileSync(layoutPath, 'utf8');
  const infoStyle = layout.match(/^\s*info:\s*'([^']*)'/m);

  if (!infoStyle) {
    failures.push(
      'src/components/ui/Layout.tsx no longer declares a style for the `info` alert tone. ' +
        'If the tone was removed deliberately, remove this check with it.',
    );
  } else if (/brand-|blue-|sky-|indigo-/.test(infoStyle[1])) {
    failures.push(
      `The \`info\` alert tone is blue again (${infoStyle[1]}). It is meant to be grey: that ` +
        'tone states a fact about the data - "nothing on this registry yet", "3 accounts in ' +
        'the chart" - and a fact is not a warning. Amber, rose and green are the tones that ' +
        'carry colour, and they only work while colour is rare.',
    );
  } else {
    console.log('alert tones: `info` is still grey, colour is still for attention');
  }
}

// --- 9. The "Add a payee" button matches who may actually add one -----------
//
// The payee picker offers to create a payee mid-document, and it only offers
// it to roles the security rules will accept. Those are two separate lists in
// two separate files, so they are compared here: if they drift, the button
// appears and the save is refused, which is a failure the clerk cannot act on.

const payeesRule = firestore.match(
  /match \/payees\/\{id\}[\s\S]*?allow create: if signedIn\(\) && hasAny\(masterDataWriters\(\)\.concat\(\[([^\]]*)\]\)\)/,
);
const writersRule = firestore.match(/function masterDataWriters\(\)\s*\{\s*return \[([^\]]*)\]/);
const payeesLibPath = resolve(root, 'src/lib/payees.ts');

if (payeesRule && writersRule && existsSync(payeesLibPath)) {
  const fromRules = new Set(
    [writersRule[1], payeesRule[1]]
      .join(',')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  );

  const lib = readFileSync(payeesLibPath, 'utf8');
  const libList = lib.match(/PAYEE_CREATOR_ROLES[^=]*=\s*\[([\s\S]*?)\]/);
  // Comments inside the list contain commas of their own, so they go before
  // the split rather than after it.
  const fromLib = new Set(
    (libList?.[1] ?? '')
      .replace(/\/\/[^\n]*/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  );

  const onlyInRules = [...fromRules].filter((r) => !fromLib.has(r));
  const onlyInLib = [...fromLib].filter((r) => !fromRules.has(r));

  if (onlyInLib.length > 0) {
    failures.push(
      `PAYEE_CREATOR_ROLES offers the "Add a payee" button to ${onlyInLib.join(', ')}, which ` +
        'firestore.rules will refuse. Those users would press the button and be told they are ' +
        'not permitted. Add the role to the payees create rule, or take it out of the list.',
    );
  }

  if (onlyInRules.length > 0) {
    failures.push(
      `firestore.rules lets ${onlyInRules.join(', ')} create a payee, but PAYEE_CREATOR_ROLES ` +
        'does not offer them the button, so they are sent to Master Data for no reason.',
    );
  }

  if (onlyInLib.length === 0 && onlyInRules.length === 0) {
    console.log(`payees: the ${fromRules.size} roles offered the button are the ${fromRules.size} the rules allow`);
  }
}

// --- 13. The nightly verifier counts the same obligations the registry does --
//
// The scheduled budget-balance verification queries obligations by status with
// a Firestore `in`, which needs literal values - so it keeps its own copy of
// "which statuses have committed allotment". The registries derive theirs from
// the status list.
//
// An obligation state missing from the server's copy is one the verification
// silently stops counting, and it then reports discrepancies that are not
// there - sending somebody to look for a fault in the budget balances when the
// fault is in the query. Adding WITH_DV would have done exactly that.

const periodsTs = resolve(root, 'src/lib/budgetPeriods.ts');
const scheduledTs = resolve(root, 'functions/src/admin/scheduled.ts');

if (existsSync(periodsTs) && existsSync(scheduledTs)) {
  const notCommitted = readFileSync(periodsTs, 'utf8').match(
    /const NOT_COMMITTED = new Set<string>\(\[([\s\S]*?)\]\)/,
  );
  const serverList = readFileSync(scheduledTs, 'utf8').match(
    /const COMMITTED_OBLIGATION_STATUSES = \[([^\]]*)\]/,
  );
  const enums = readFileSync(resolve(root, 'src/types/enums.ts'), 'utf8');
  const statuses = enums.match(/export const OBLIGATION_STATUSES = \[([\s\S]*?)\] as const;/);

  if (notCommitted && serverList && statuses) {
    const names = (block) =>
      block
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .split(',')
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);

    const all = names(statuses[1]);
    const excluded = new Set(names(notCommitted[1]));
    const onServer = new Set(names(serverList[1]));

    // The verifier never sees a pre-certification obligation, so CERTIFIED is
    // allowed to be absent from its list; everything else must be there.
    const expected = all.filter((s) => !excluded.has(s) && s !== 'CERTIFIED');
    const missing = expected.filter((s) => !onServer.has(s));
    const extra = [...onServer].filter((s) => !expected.includes(s));

    if (missing.length > 0) {
      failures.push(
        `functions/src/admin/scheduled.ts does not count ${missing.join(', ')} as a committed ` +
          'obligation, but the registries do. The nightly verification would stop counting ' +
          'those obligations and report budget balance discrepancies that are not there.',
      );
    }
    if (extra.length > 0) {
      failures.push(
        `functions/src/admin/scheduled.ts counts ${extra.join(', ')}, which the registries do not.`,
      );
    }
    if (missing.length === 0 && extra.length === 0) {
      console.log(
        `obligations: the verifier and the registries agree on all ${expected.length} committed statuses`,
      );
    }
  }
}

// --- 12. Paying a voucher is a Treasury act ---------------------------------
//
// The Accountant approves a voucher; the Treasurer pays it. Two officers, two
// acts, and the second is the one that moves money out of the municipality.
//
// CFMS used to offer Issue check and Prepare ADA on the Accounting voucher
// screen, which made drawing a check something done by whoever had the voucher
// open. That is the point in the chain where the separation stops being
// visible, and it is the kind of thing that creeps back one convenient button
// at a time. So no screen under src/pages/accounting may call either engine
// operation.

const accountingPages = resolve(root, 'src/pages/accounting');

if (existsSync(accountingPages)) {
  const offenders = [];

  for (const entry of readdirSync(accountingPages, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
    const source = readFileSync(resolve(accountingPages, entry.name), 'utf8');
    for (const op of ['issueCheck', 'issueAda']) {
      if (new RegExp(`engine\\.${op}\\s*\\(`).test(source)) {
        offenders.push(`src/pages/accounting/${entry.name} calls engine.${op}`);
      }
    }
  }

  if (offenders.length > 0) {
    failures.push(
      `Paying a voucher has moved back into Accounting: ${offenders.join('; ')}. The Accountant ` +
        'approves a payment and the Treasurer makes one. Drawing a check belongs on ' +
        'TREASURY > DISBURSEMENTS FOR PAYMENT, which is the screen that keeps those two acts ' +
        'in two different hands.',
    );
  } else {
    console.log('payments: no Accounting screen draws a check or an advice');
  }
}

// --- 11. The password rule on the screen is the one the server enforces -----
//
// The Add a user dialog lights its button once the temporary password is long
// enough; the server refuses anything shorter. Two numbers, two files. If the
// screen's is the smaller one, the administrator types a password, presses the
// button and is refused - with no way to tell that the length was the problem.

const systemTs = resolve(root, 'src/types/system.ts');
const usersTs = resolve(root, 'functions/src/admin/users.ts');

if (existsSync(systemTs) && existsSync(usersTs)) {
  const client = readFileSync(systemTs, 'utf8').match(
    /export const MIN_PASSWORD_LENGTH\s*=\s*(\d+)/,
  );
  const server = readFileSync(usersTs, 'utf8').match(/const MIN_PASSWORD_LENGTH\s*=\s*(\d+)/);

  if (client && server && client[1] !== server[1]) {
    failures.push(
      `MIN_PASSWORD_LENGTH is ${client[1]} in src/types/system.ts and ${server[1]} in ` +
        'functions/src/admin/users.ts. The screen and the server must ask for the same ' +
        'password length, or one of them refuses what the other accepted.',
    );
  } else if (client && server) {
    console.log(`passwords: the screen and the server both ask for ${client[1]} characters`);
  }
}

// --- 10. One issueNumber per transaction ------------------------------------
//
// `issueNumber` reads a counter and then writes it. One call is a read then a
// write, which is fine. TWO calls are read, write, READ, write - and Firestore
// refuses a read after a write inside a transaction, so the whole operation
// fails with a message no accounting clerk can act on.
//
// Four operations needed two numbers and every one of them was broken by this
// from the day it was written: approveDv, postLiquidation, issueAda and
// reserveAdaNumbers. There was a comment on issueNumber warning about the
// ordering, and it did not help, because it warned about the caller writing
// too early and said nothing about calling twice.
//
// `issueNumbers` takes them all at once and does every read before every
// write. This makes the rule a build failure rather than a comment.

function transactionChunks(source) {
  // Everything before the first runTransaction cannot hold a `tx`, so it is
  // dropped. Each remaining chunk runs to the next transaction or the end of
  // the file, which can only over-include code that has no `tx` in scope.
  const parts = source.split('db.runTransaction(');
  return parts.slice(1);
}

const functionsSrc = resolve(root, 'functions/src');

function walkTs(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

if (existsSync(functionsSrc)) {
  let offenders = 0;

  for (const file of walkTs(functionsSrc)) {
    if (file.endsWith('lib/numbering.ts')) continue;
    const source = readFileSync(file, 'utf8');
    const name = file.slice(root.length + 1);

    transactionChunks(source).forEach((chunk, i) => {
      const calls = (chunk.match(/\bissueNumber\s*\(\s*tx\b/g) ?? []).length;
      if (calls > 1) {
        offenders += 1;
        failures.push(
          `${name}: transaction ${i + 1} calls issueNumber ${calls} times. The second call ` +
            'reads a counter after the first has written one, and Firestore refuses a read ' +
            'after a write inside a transaction - the operation fails outright. Use ' +
            'issueNumbers(tx, [...]) instead, which reads every counter before writing any.',
        );
      }
    });
  }

  if (offenders === 0) {
    console.log('numbering: no transaction issues more than one number at a time');
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('\nSecurity rule checks failed:\n');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nAll security rule checks passed.');
