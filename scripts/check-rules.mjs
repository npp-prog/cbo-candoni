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

/*
 * The invariant is not "edits are restricted to DRAFT and FOR_REVIEW" - that
 * was the shape of the rule, and the shape changed when APPROVED entries
 * became editable. The invariant is that a POSTED entry is never writable from
 * a client, and neither is one that has been REVERSED or CANCELLED: those are
 * finished, and an entry that can be edited after the ledger has taken it
 * means the General Ledger is no longer evidence of anything.
 *
 * So every status list in the update rule is read, and any of the three
 * finished states appearing in one fails the build - however the rule is
 * written around them.
 */
const FINISHED_JEV_STATES = ['POSTED', 'REVERSED', 'CANCELLED'];

const jevBlock = firestore.match(/match \/jevs\/\{[^}]*\}\s*\{([\s\S]*?)\n    \}/);
if (!jevBlock) {
  failures.push("firestore.rules: no rule block for 'jevs'");
} else {
  const update = jevBlock[1].match(/allow update:([\s\S]*?);/);
  if (!update) {
    failures.push("firestore.rules: the 'jevs' block has no update rule to check.");
  } else {
    const lists = update[1].match(/status in \[[^\]]*\]/g) ?? [];
    if (lists.length === 0) {
      failures.push(
        "firestore.rules: the 'jevs' update rule names no statuses at all, so nothing stops a " +
          'posted entry being edited. A posted journal entry must be immutable.',
      );
    }
    const leaked = FINISHED_JEV_STATES.filter((state) =>
      lists.some((list) => list.includes(`'${state}'`)),
    );
    if (leaked.length > 0) {
      failures.push(
        `firestore.rules: the 'jevs' update rule allows ${leaked.join(' and ')}. An entry in ` +
          'any of those states is finished - the ledger has taken it, or it has been undone - ' +
          'and editing it would mean the General Ledger is no longer evidence of what was ' +
          'posted. A posted entry is corrected through correctJev, which reverses it and opens ' +
          'a fresh draft.',
      );
    } else {
      console.log(`jevs: ${FINISHED_JEV_STATES.join(', ')} entries stay immutable`);
    }
  }
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
  'functions/src/admin/budgetRebuild.ts',
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
// Patch 120: the rebuild, and the list with it, moved to budgetRebuild.ts,
// shared by the nightly verifier and the repair callable.
const scheduledTs = resolve(root, 'functions/src/admin/budgetRebuild.ts');

if (existsSync(periodsTs) && existsSync(scheduledTs)) {
  const notCommitted = readFileSync(periodsTs, 'utf8').match(
    /const NOT_COMMITTED = new Set<string>\(\[([\s\S]*?)\]\)/,
  );
  const serverList = readFileSync(scheduledTs, 'utf8').match(
    /const COMMITTED_OBLIGATION_STATUSES = \[([^\]]*)\]/,
  );
  const enums = readFileSync(resolve(root, 'src/types/enums.ts'), 'utf8');
  const statuses = enums.match(/export const OBLIGATION_STATUSES = \[([\s\S]*?)\] as const;/);

  if (!notCommitted || !serverList || !statuses) {
    // This used to pass quietly when a list could not be found - a guard
    // that cannot fail out loud. It fails now.
    failures.push(
      'The committed-status lists could not be read (budgetPeriods.ts NOT_COMMITTED, ' +
        'budgetRebuild.ts COMMITTED_OBLIGATION_STATUSES, enums.ts OBLIGATION_STATUSES). ' +
        'If one moved, point check-rules at it.',
    );
  } else {
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
        `functions/src/admin/budgetRebuild.ts does not count ${missing.join(', ')} as a committed ` +
          'obligation, but the registries do. The nightly verification would stop counting ' +
          'those obligations and report budget balance discrepancies that are not there.',
      );
    }
    if (extra.length > 0) {
      failures.push(
        `functions/src/admin/budgetRebuild.ts counts ${extra.join(', ')}, which the registries do not.`,
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

// --- 14. Only Treasury marks a voucher paid ---------------------------------
/*
 * A disbursement voucher is PAID when the Treasurer draws a check or an advice
 * against it, and at no other moment.
 *
 * This is not a point of style. The Treasury payment queue lists the vouchers
 * that are owed, and it finds them by status. Posting the journal entry used
 * to set a voucher to PAID, so an entry posted by the Accountant - which patch
 * 75 moved on to the voucher screen, where it happens seconds after approval -
 * took the voucher out of the Treasurer's queue before anybody had paid it.
 * The supplier was owed money and the voucher was invisible.
 *
 * The word means "the money has gone out". Any other act that writes it is the
 * same defect again under a different name, so the build refuses it.
 */
if (existsSync(functionsSrc)) {
  const allowed = 'functions/src/accounting/payments.ts';
  let offenders = 0;

  for (const file of walkTs(functionsSrc)) {
    const name = file.slice(root.length + 1).split('\\').join('/');
    if (name === allowed) continue;

    const source = readFileSync(file, 'utf8');

    // Each tx.update(...) call, taken whole, so that the collection and the
    // status it writes are read together rather than anywhere in the file.
    const updates = source.match(/tx\.update\(([\s\S]*?)\n\s*\}\s*\)/g) ?? [];
    for (const call of updates) {
      if (!call.includes('disbursementVouchers')) continue;
      if (!/status:\s*'PAID'/.test(call)) continue;
      offenders += 1;
      failures.push(
        `${name}: sets a disbursement voucher to PAID. Only ${allowed} may do that, when the ` +
          'check or the advice is drawn. The Treasury payment queue finds what is owed by ' +
          'status, so a voucher marked paid by any other act disappears from it with nothing ' +
          'having been paid.',
      );
    }
  }

  if (offenders === 0) {
    console.log('payments: only the drawing of a check or an advice marks a voucher paid');
  }
}

// --- 15. The voucher's own number is never drawn from a series --------------
/*
 * ---------------------------------------------------------------------------
 * THIS GUARD USED TO SAY THE OPPOSITE, AND WHY IT CHANGED
 * ---------------------------------------------------------------------------
 * Until patch 85 it refused dv.ts the numbering helpers altogether: approving
 * a voucher only PREPARED its entry, so a JEV number drawn at approval was
 * spent whether or not the entry was ever posted, and an approval that was
 * undone left a gap in the series the office could not account for.
 *
 * Approval now posts. The gap that argument guarded against is covered by what
 * replaced it - taking an approval back REVERSES the posted entry rather than
 * cancelling an unposted one, so the number is spent on an entry that exists,
 * with its reversal beside it. Guard 27 is what holds that pair together, and
 * it is the reason this one could be relaxed rather than merely deleted.
 *
 * What has NOT changed is the rule underneath: the DISBURSEMENT VOUCHER's own
 * number is typed in by accounting staff from the office's book. CFMS reserves
 * it so it cannot be used twice; CFMS does not issue it. So dv.ts may ask the
 * numbering series for a JEV number and for nothing else.
 */
{
  const dvFile = resolve(root, 'functions/src/accounting/dv.ts');
  if (existsSync(dvFile)) {
    const source = readFileSync(dvFile, 'utf8');
    const naked = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // Every document type this file asks the numbering series for.
    const asked = [...naked.matchAll(/loadNumberingConfig\(\s*['"]([A-Z_]+)['"]\s*\)/g)].map(
      (m) => m[1],
    );
    const wrong = asked.filter((kind) => kind !== 'JEV');

    if (wrong.length > 0) {
      failures.push(
        `functions/src/accounting/dv.ts draws a ${wrong.join(', ')} number from the numbering ` +
          "series. Only the JEV's is CFMS's to issue. The voucher's own number comes out of " +
          'the office book and is typed in - CFMS reserves it so it cannot be used twice, ' +
          'which is a different thing from handing it out.',
      );
    } else {
      console.log('numbering: the voucher draws only its journal number');
    }
  }
}

// --- 16. The office's own series are never issued by CFMS -------------------
/*
 * The RCI, the RADAI, the RCD, the RCDisb and the liquidation report are
 * numbered from the books the Treasurer's office and Accounting already keep,
 * under the series COA expects of them. Those numbers reach CFMS by being
 * typed in.
 *
 * If CFMS ever issued one of them again it would run a second series beside
 * the office's, and the two would disagree. Nothing would break; nobody would
 * notice until an audit, when somebody holding the paper found that the
 * system's RCI 0042 was a different report from the one in the book.
 *
 * So no numbering configuration for those five is loaded anywhere in the
 * engine. A number for them comes from reserveDocumentNumber, which takes the
 * one it is given and refuses a duplicate.
 */
if (existsSync(functionsSrc)) {
  const OFFICE_SERIES = ['RCI', 'RADAI', 'RCD', 'RCDISB', 'LIQ'];
  let offenders = 0;

  for (const file of walkTs(functionsSrc)) {
    const source = readFileSync(file, 'utf8');
    const name = file.slice(root.length + 1).split('\\').join('/');

    for (const series of OFFICE_SERIES) {
      // Only a real call counts; the word inside a comment does not.
      const call = new RegExp(`loadNumberingConfig\\(\\s*['"]${series}['"]\\s*\\)`);
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (!call.test(stripped)) continue;
      offenders += 1;
      failures.push(
        `${name}: loads the ${series} numbering series. That number is assigned by the office ` +
          'from its own book and typed in; CFMS issuing one would run a second series beside ' +
          "the office's, and the two disagree silently until an audit. Use " +
          'reserveDocumentNumber, which takes the number given and refuses a duplicate.',
      );
    }
  }

  if (offenders === 0) {
    console.log(`numbering: CFMS issues none of the ${5} series the offices number themselves`);
  }
}

// --- 17. A closed attachment stays closed -----------------------------------
/*
 * Two halves of one rule, in two files, and the build compares them.
 *
 * WHO MAY CLOSE. The screen offers the button from ATTACHMENT_LOCK_ROLES and
 * the engine refuses on its own list. A button offered to somebody the engine
 * refuses is a button that fails when pressed, which teaches people the system
 * is unreliable about a thing that cannot be undone.
 *
 * WHAT CLOSING MEANS. The lock lives on the parent document and the create
 * rule on /documents consults it. If a client could write that field it could
 * also write it back off - and the rule would be enforcing a value controlled
 * by the person it exists to constrain. So every collection that can be
 * locked must name both lock fields among the ones a client may not change.
 */
{
  const clientRoles = resolve(root, 'src/lib/attachmentTypes.ts');
  const serverRoles = resolve(root, 'functions/src/lib/context.ts');

  const listOf = (source, name) => {
    const block = source.match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
    if (!block) return null;
    return (block[1].match(/'([A-Z_]+)'/g) ?? []).map((r) => r.slice(1, -1)).sort();
  };

  if (existsSync(clientRoles) && existsSync(serverRoles)) {
    const screen = listOf(readFileSync(clientRoles, 'utf8'), 'ATTACHMENT_LOCK_ROLES');
    const engine = listOf(readFileSync(serverRoles, 'utf8'), 'ATTACHMENT_LOCK_ROLES');

    if (!screen || !engine) {
      failures.push(
        'ATTACHMENT_LOCK_ROLES could not be read from both src/lib/attachmentTypes.ts and ' +
          'functions/src/lib/context.ts. The screen and the engine must agree about who may ' +
          'close a supporting document.',
      );
    } else if (screen.join(',') !== engine.join(',')) {
      failures.push(
        `The roles offered the lock button (${screen.join(', ')}) are not the roles the engine ` +
          `accepts (${engine.join(', ')}). Closing cannot be undone, so a button that fails when ` +
          'pressed is worse here than anywhere else.',
      );
    } else {
      console.log(`attachments: the ${screen.length} roles offered the lock are the ${engine.length} the engine accepts`);
    }
  }

  const LOCKABLE = ['obligations', 'disbursementVouchers', 'treasuryReports', 'liquidations'];
  let unprotected = 0;

  /*
   * Comments out first, for two reasons.
   *
   * A clause is read up to its semicolon, and a comment inside one that
   * happens to contain a semicolon would cut the clause short - which is
   * exactly what happened while this check was being written, and it reported
   * three rules as unguarded that were guarded.
   *
   * And a field name mentioned in a comment must not satisfy the check. A
   * rule that only TALKS about protecting the lock protects nothing.
   */
  const ruleCode = firestore.replace(/\/\/[^\n]*/g, '');

  for (const collection of LOCKABLE) {
    const block = ruleCode.match(
      new RegExp(`match /${collection}/\\{[^}]*\\}\\s*\\{([\\s\\S]*?)\\n    \\}`),
    );
    if (!block) {
      failures.push(`firestore.rules: no rule block for '${collection}', which can be locked.`);
      unprotected += 1;
      continue;
    }
    const update = block[1].match(/allow update:([\s\S]*?);/);
    const text = update ? update[1] : '';
    const guarded =
      text.includes("'attachmentsLockedAt'") && text.includes("'attachmentsLockedBy'");
    if (!guarded) {
      unprotected += 1;
      failures.push(
        `firestore.rules: the '${collection}' update rule does not stop a client changing ` +
          "'attachmentsLockedAt' and 'attachmentsLockedBy'. A client that can write the lock " +
          'can write it back off, and the create rule on /documents would then be consulting a ' +
          'value held by the person it constrains. Add both to its didNotChange list.',
      );
    }
  }

  if (unprotected === 0) {
    console.log(`attachments: all ${LOCKABLE.length} lockable collections keep the lock out of client hands`);
  }

  if (!/attachmentsOpen\(/.test(firestore)) {
    failures.push(
      "firestore.rules: the '/documents' create rule no longer checks whether the parent's " +
        'attachments are closed. The lock would then be a message on a screen, and the next ' +
        'upload would be accepted.',
    );
  }
}

// --- 18. A typed document number is not refused by the rules ----------------
/*
 * The numbers below are assigned by the office, from its own books, and typed
 * on the draft. Patch 77 made that true of five documents; the rules still
 * said what had been true before it, which is that a number arriving from a
 * browser could only be a browser inventing one.
 *
 * The result was the worst kind of failure. Saving an RCI draft was refused
 * with "Missing or insufficient permissions" - a message that names neither
 * the field nor the reason - and nothing in the build, the tests or the
 * engine had anything to say about it. The Treasurer could not have worked it
 * out, and neither could I without being shown the screen.
 *
 * So: no create rule may refuse the very field its screen now requires.
 */
{
  const TYPED_NUMBERS = [
    ['treasuryReports', 'reportNo'],
    ['rcds', 'rcdNo'],
    ['liquidations', 'liquidationNo'],
    ['obligations', 'obrNo'],
    ['disbursementVouchers', 'dvNo'],
  ];

  const code = firestore.replace(/\/\/[^\n]*/g, '');
  let refused = 0;

  for (const [collection, field] of TYPED_NUMBERS) {
    const block = code.match(
      new RegExp(`match /${collection}/\\{[^}]*\\}\\s*\\{([\\s\\S]*?)\\n    \\}`),
    );
    if (!block) {
      failures.push(`firestore.rules: no rule block for '${collection}'.`);
      refused += 1;
      continue;
    }
    const create = block[1].match(/allow create:([\s\S]*?);/);
    if (!create) continue;

    // The shape that caused it: a flat refusal of the field on create.
    const bans = new RegExp(`!\\s*\\(\\s*'${field}'\\s+in\\s+request\\.resource\\.data\\s*\\)`);
    if (bans.test(create[1])) {
      refused += 1;
      failures.push(
        `firestore.rules: the '${collection}' create rule refuses '${field}', but that number is ` +
          'typed in by the office on the draft. Every save from that screen will be rejected with ' +
          '"Missing or insufficient permissions", which names neither the field nor the reason.',
      );
    }
  }

  if (refused === 0) {
    console.log(`numbering: all ${TYPED_NUMBERS.length} typed document numbers are accepted on a draft`);
  }
}

// --- 19. A bank account's own name is not an account title ------------------
/*
 * A bank account record carries two names and they are easy to confuse.
 * `glAccountCode` is the General Ledger account it posts to; `accountName` is
 * what the OFFICE calls that bank account - "General Fund".
 *
 * Writing the second into a journal line's `accountName` beside the first
 * produced a proposed entry reading
 *
 *     10102020     General Fund     10,000.00
 *
 * which is not an account in anybody's chart. Nothing refuses it. The entry
 * balances, the code is real, and the name is only a label travelling beside
 * it - all the way into every ledger line, where the General Ledger, the
 * journals and the trial balance print it. It was in two places and might
 * have reached a third.
 *
 * The title comes from the code, through cashInBankLine.
 */
{
  const SOURCE_DIRS = [resolve(root, 'src'), resolve(root, 'functions/src')];
  const BAD = /accountName:\s*(\w*[Bb]ank\w*)\.accountName/;
  let offenders = 0;

  for (const dir of SOURCE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of walkTs(dir)) {
      const name = file.slice(root.length + 1).split('\\').join('/');
      if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;

      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        /*
         * Passing the bank's own name INTO cashInBankLine is the sanctioned
         * use - that is how it reaches the subsidiary ledger, which is where
         * it belongs. Only a journal line named from it directly is the fault.
         */
        .replace(/cashInBankLine\(\s*\{[^{}]*\}\s*(,[^)]*)?\)/g, '');

      const hit = source.match(BAD);
      if (!hit) continue;
      offenders += 1;
      failures.push(
        `${name}: puts a bank account's own name (${hit[1]}.accountName) into a journal line's ` +
          "accountName. That field is what the OFFICE calls the account - \"General Fund\" - not " +
          'the title of the General Ledger account it posts to. Use cashInBankLine, which names ' +
          "the line from the code and puts the office's name in the subsidiary ledger.",
      );
    }
  }

  if (offenders === 0) {
    console.log("accounts: no journal line is named from a bank account's own name");
  }
}

// --- 20. The ledger is written in one file, and nowhere else ----------------
/*
 * Patch 80 gave the Municipal Accountant the ability to correct a posted entry
 * while its month is open, which means CFMS now DELETES ledger entries - the
 * first time anything has. That is defensible only because it happens in one
 * place, hedged by a period check, a role, a reason and a recorded history.
 *
 * A second place that wrote or deleted a ledger entry would have none of that,
 * and nothing about the books would look wrong afterwards: the trial balance
 * would still foot, to a figure nobody could account for.
 */
if (existsSync(functionsSrc)) {
  const OWNER = 'functions/src/lib/ledger.ts';
  const MUTATIONS = /(?:tx|batch)\.(?:create|set|update|delete)\(([\s\S]{0,400}?)\)/g;
  let offenders = 0;

  for (const file of walkTs(functionsSrc)) {
    const name = file.slice(root.length + 1).split('\\').join('/');
    if (name === OWNER) continue;

    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    for (const call of source.matchAll(MUTATIONS)) {
      if (!call[1].includes('ledgerEntries')) continue;
      offenders += 1;
      failures.push(
        `${name}: writes or deletes a ledgerEntries document. Only ${OWNER} may - it is the one ` +
          'place where posting and correcting are hedged by the period check, the role, the ' +
          'reason and the history kept on the entry. A ledger written from anywhere else still ' +
          'foots, to a figure nobody can account for.',
      );
      break;
    }
  }

  if (offenders === 0) {
    console.log('ledger: only lib/ledger.ts writes or removes a ledger entry');
  }
}

// --- 21. Correcting a posted entry checks the month is open -----------------
/*
 * The whole case for rewriting a posted entry in place is that the month is
 * still open: nothing outside this office has relied on it yet. Take that
 * check away and CFMS silently becomes a system in which a closed, reported,
 * audited month can be edited - with no error, no reversal and no sign.
 */
{
  const file = resolve(root, 'functions/src/accounting/jev.ts');
  if (existsSync(file)) {
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf('export const amendPostedJev');
    if (start < 0) {
      console.log('ledger: amendPostedJev is not present (nothing to check)');
    } else {
      const end = source.indexOf('\nexport const ', start + 10);
      const body = source.slice(start, end > 0 ? end : undefined);
      const missing = ['assertFiscalYearOpen(', 'assertPeriodOpen('].filter(
        (call) => !body.includes(call),
      );
      if (missing.length > 0) {
        failures.push(
          `functions/src/accounting/jev.ts: amendPostedJev no longer calls ${missing.join(' or ')}. ` +
            'Rewriting a posted entry is allowed only while its month and fiscal year are open. ' +
            'Without that check a closed month could be edited, with no error and no reversal.',
        );
      } else {
        console.log('ledger: a posted entry is only corrected while its month is open');
      }
    }
  }
}

// --- 22. A code from a record takes its title from the chart -----------------
/*
 * The third appearance of one mistake, so it gets a check.
 *
 * A journal line carries a code and a title. When the CODE is read from a
 * record - a bank account's glAccountCode, a cash advance's - and the TITLE is
 * written out beside it as a string, the two drift the moment an office sets a
 * different code. CFMS has posted:
 *
 *     10102020  General Fund                   (the bank account's own name)
 *     10101010  Cash in Vault                  (the chart says Cash Local Treasury)
 *     <advance> Advances to Officers and Employees   (whatever code it had)
 *
 * Every one of them balances, carries a real code, and prints a title that is
 * in no chart. Nothing refuses them, and the General Ledger shows the title.
 *
 * A code written out as a constant is fine - its title comes from the same
 * constant. This is only about a code read from a record.
 */
{
  const SOURCE_DIRS = [resolve(root, 'src'), resolve(root, 'functions/src')];
  const FROM_RECORD = /accountCode:\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*\.(?:glAccountCode|accountCode))/;
  const LITERAL_NAME = /accountName:\s*['"`]/;
  let offenders = 0;

  for (const dir of SOURCE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of walkTs(dir)) {
      const name = file.slice(root.length + 1).split('\\').join('/');
      if (name.includes('.test.')) continue;

      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');

      let flagged = false;
      for (const hit of source.matchAll(new RegExp(FROM_RECORD, 'g'))) {
        // The title, if it is given, is within the same object literal - a
        // few lines either side of the code.
        const from = Math.max(0, (hit.index ?? 0) - 300);
        const window = source.slice(from, (hit.index ?? 0) + 300);
        if (!LITERAL_NAME.test(window)) continue;
        flagged = true;
        failures.push(
          `${name}: a journal line takes its accountCode from ${hit[1]} and its accountName from ` +
            'a written-out string. The two drift the moment an office sets a different code, and ' +
            'the ledger then prints a title that is in no chart - which balances, and which ' +
            'nothing refuses. Look the title up (titleForAccountCode, or the loaded chart).',
        );
        break;
      }
      if (flagged) offenders += 1;
    }
  }

  if (offenders === 0) {
    console.log('accounts: a code read from a record never carries a written-out title');
  }
}

// --- 23. Nothing is certified without its signed form -----------------------
/*
 * Certifying is the act that forwards a document to another office and makes
 * the municipality answerable for it. For an obligation request it consumes a
 * number from a gapless series; for a treasury report it locks every document
 * the report covers and sets Accounting to work.
 *
 * What CFMS holds in both cases is an ENCODING of a form somebody signed, and
 * the certificate is a statement about that form. Issued before anybody has
 * put the form on the record, it is a statement about nothing - and in
 * practice the file is then attached late or never, because the thing that
 * needed it has already happened.
 *
 * Each function checks this its own way: the obligation reads a count kept on
 * itself, the report queries the attachments. What this refuses is either of
 * them losing the check altogether.
 */
{
  const CERTIFIERS = [
    {
      file: 'functions/src/budget/obligations.ts',
      fn: 'export const certifyObligation',
      proof: /attachmentCount/,
      how: 'the attachment count on the obligation',
    },
    {
      file: 'functions/src/treasury/reports.ts',
      fn: 'export const certifyTreasuryReport',
      proof: /COL\.documents/,
      how: 'a query for the attachments on the report',
    },
  ];

  let missing = 0;

  for (const check of CERTIFIERS) {
    const full = resolve(root, check.file);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, 'utf8');
    const start = source.indexOf(check.fn);
    if (start < 0) {
      failures.push(`${check.file}: ${check.fn} is gone; the certification checks cannot be read.`);
      missing += 1;
      continue;
    }
    const next = source.indexOf('\nexport const ', start + 10);
    const body = source.slice(start, next > 0 ? next : undefined);

    if (!check.proof.test(body)) {
      missing += 1;
      failures.push(
        `${check.file}: ${check.fn} no longer checks that a form is attached (it did so with ` +
          `${check.how}). Certifying forwards the document to another office and is hard to undo; ` +
          'a certificate issued before the signed form is on the record is a statement about ' +
          'nothing, and the file then gets attached late or never.',
      );
    }
  }

  if (missing === 0) {
    console.log(`attachments: both certifications require the signed form`);
  }
}

// --- 24. The evidence of a correction cannot be written from a browser -------

/*
 * Two fields on a journal entry exist only to say that something happened to
 * it after the ledger took it:
 *
 *   `corrections`  - what the entry said before, who changed it and why.
 *   `signedTotal`  - the figure the source document was signed for, set while
 *                    the entry no longer agrees with it.
 *
 * Both are written by the engine, inside the same transaction that makes the
 * change true. Patch 84 opened the amount on a document-sourced entry at the
 * Municipal Accountant's request, and the ONLY thing that makes that
 * defensible is that the disagreement is recorded and visible. A browser able
 * to write either field could erase the record of the edit it had just made,
 * which would be worse than never having allowed the edit at all.
 *
 * `sourceType` and `sourceId` are here for the same reason: they are the
 * document the entry came from, and that is not the entry's to change.
 */
{
  const EVIDENCE_FIELDS = ['corrections', 'signedTotal', 'sourceType', 'sourceId'];

  const block = firestore.match(/match \/jevs\/\{[^}]*\}\s*\{([\s\S]*?)\n    \}/);
  if (!block) {
    failures.push("firestore.rules: no rule block for 'jevs' to check the evidence fields in.");
  } else {
    // Comments are stripped first: a field named only in prose is not a field
    // the rule protects, and a semicolon inside a comment would cut the clause
    // short. Both have caught this file out before.
    const naked = block[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const update = naked.match(/allow update:([\s\S]*?);/);

    if (!update) {
      failures.push("firestore.rules: the 'jevs' block has no update rule to check.");
    } else {
      /*
       * Every branch, not just one. The rule protects a different list
       * depending on how the entry was raised, and a field protected in one
       * branch and forgotten in the other is protected on exactly half the
       * entries - which is the half nobody tests.
       */
      const lists = update[1].match(/\[[^\]]*\]/g) ?? [];
      const guarding = lists.filter((l) => l.includes("'jevNo'"));

      if (guarding.length === 0) {
        failures.push(
          "firestore.rules: the 'jevs' update rule no longer protects any field list that " +
            'includes jevNo, so the protected-field check cannot be read at all.',
        );
      } else {
        const unprotected = EVIDENCE_FIELDS.filter((f) =>
          guarding.some((l) => !l.includes(`'${f}'`)),
        );
        if (unprotected.length > 0) {
          failures.push(
            `firestore.rules: the 'jevs' update rule leaves ${unprotected.join(', ')} writable ` +
              'from a browser in at least one branch. Those fields are the entry’s own record ' +
              'of having been corrected after posting and of no longer agreeing with the ' +
              'document behind it. They are written by the engine in the transaction that ' +
              'makes the change true; a client that could write them could erase the evidence ' +
              'of its own edit.',
          );
        } else {
          console.log(`jevs: ${EVIDENCE_FIELDS.join(', ')} are the engine's to write`);
        }
      }
    }
  }
}

// --- 25. A correction never repoints an entry at another document -----------

/*
 * `amendPostedJev` rewrites a posted entry in place. The Municipal Accountant
 * asked for the date, the particulars, the accounts and the amount to be
 * correctable; he asked for ONE thing to stay locked - which document the
 * entry came from.
 *
 * The lock is structural rather than a check: the callable simply does not
 * read those fields from the request, so there is nothing to validate and
 * nothing to get wrong. This refuses the day somebody adds them to the
 * destructuring "for completeness". An entry repointed at another document
 * describes paper that does not describe it, and nothing downstream - not the
 * voucher, not the treasury report, not the audit trail - would show it.
 */
{
  const file = 'functions/src/accounting/jev.ts';
  const full = resolve(root, file);
  const source = existsSync(full) ? readFileSync(full, 'utf8') : '';
  const start = source.indexOf('export const amendPostedJev');

  if (start < 0) {
    failures.push(`${file}: amendPostedJev is gone; the correction rules cannot be checked.`);
  } else {
    const next = source.indexOf('\nexport const ', start + 10);
    const body = source.slice(start, next > 0 ? next : undefined);
    // Only the destructuring of the request, not the whole function: the
    // ORIGINAL entry's sourceType is read all over the body, and rightly so.
    const destructure = body.match(/\}\s*=\s*\(request\.data\s*\?\?\s*\{\}\)\s*as/);
    const head = destructure ? body.slice(0, destructure.index) : body;

    const accepted = ['sourceType', 'sourceId', 'referenceNo'].filter((f) =>
      new RegExp(`\\b${f}\\b`).test(head),
    );

    if (!destructure) {
      failures.push(
        `${file}: amendPostedJev no longer reads its request in the usual shape, so what it ` +
          'accepts from the caller cannot be read. The source document reference must stay ' +
          'out of it.',
      );
    } else if (accepted.length > 0) {
      failures.push(
        `${file}: amendPostedJev now accepts ${accepted.join(', ')} from the caller. The ` +
          'document an entry came from is not the entry’s to change: repointing it leaves an ' +
          'entry describing paper that does not describe it, and no screen or report would ' +
          'show the difference.',
      );
    } else {
      console.log('jevs: a correction cannot repoint an entry at another document');
    }
  }
}

// --- 26. What makes a voucher payable is the engine's to write --------------

/*
 * Patch 85 split approving a voucher from sending it to be paid. Two fields
 * carry that split:
 *
 *   `awaitingTransferToTreasury`  - approved, and Accounting is still holding it
 *   `forwardedToTreasury`         - who sent it over, and when
 *
 * They are written by `approveDv` and `forwardDvToTreasury` and by nothing
 * else. A browser able to write either could put a voucher in front of the
 * Treasurer with nobody in Accounting having decided to send it - which is the
 * single decision the split exists to make somebody take, and the reason the
 * Treasurer's queue can be trusted to mean what it says.
 *
 * `jevPostedAt` is here for the neighbouring reason: approval now posts, and
 * that field is the voucher's own statement that its entry reached the ledger.
 */
{
  const PAYABILITY_FIELDS = [
    'awaitingTransferToTreasury',
    'forwardedToTreasury',
    'jevId',
    'jevNo',
    'jevPostedAt',
    'checkId',
    'adaId',
  ];

  const block = firestore.match(
    /match \/disbursementVouchers\/\{[^}]*\}\s*\{([\s\S]*?)\n    \}/,
  );

  if (!block) {
    failures.push("firestore.rules: no rule block for 'disbursementVouchers'.");
  } else {
    // Comments stripped first - a field named only in prose is not protected,
    // and a semicolon inside a comment would cut the clause short.
    const naked = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const update = naked.match(/allow update:([\s\S]*?);/);

    if (!update) {
      failures.push("firestore.rules: the 'disbursementVouchers' block has no update rule.");
    } else {
      const unprotected = PAYABILITY_FIELDS.filter((f) => !update[1].includes(`'${f}'`));
      if (unprotected.length > 0) {
        failures.push(
          `firestore.rules: the 'disbursementVouchers' update rule leaves ${unprotected.join(', ')} ` +
            'writable from a browser. Those fields decide whether the voucher is in the books ' +
            'and whether the Treasurer may pay it. Both are decisions an officer takes through ' +
            'the engine, where they are checked and recorded; a client that could write them ' +
            'takes the decision without taking it.',
        );
      } else {
        console.log('vouchers: being in the books and being payable are the engine’s to say');
      }
    }
  }
}

// --- 27. Approval posts, and taking it back reverses ------------------------

/*
 * Two halves of one rule, and the pair is the point.
 *
 * `approveDv` posts the entry it creates. If it ever stops, the General Ledger
 * goes back to lagging the vouchers by however long it takes somebody to press
 * Post on a second screen - which is the fault patch 85 was asked to fix.
 *
 * `unapproveDv` reverses that posted entry. If THAT ever stops, an approval
 * either cannot be taken back at all, or - far worse - is taken back while its
 * entry stays in the ledger with no voucher behind it.
 *
 * Checked together because each is only safe while the other holds. Posting at
 * approval without the reversal leaves entries stranded; the reversal without
 * the posting is dead code nobody notices has stopped being exercised.
 */
{
  const file = 'functions/src/accounting/dv.ts';
  const full = resolve(root, file);
  const source = existsSync(full) ? readFileSync(full, 'utf8') : '';

  const PAIR = [
    {
      fn: 'export const approveDv',
      proof: /postJevInTransaction\s*\(/,
      why:
        'approveDv no longer posts the entry it creates. Approving a voucher is the decision ' +
        'that the claim is proper, and the books say so at that moment - leaving it to a ' +
        'second button means the ledger lags the vouchers by however long it takes somebody ' +
        'to remember.',
    },
    {
      fn: 'export const unapproveDv',
      proof: /buildReversalLines\s*\(/,
      why:
        'unapproveDv no longer reverses the posted entry. Since approval posts, taking an ' +
        'approval back must put a reversing entry in the books - otherwise the approval ' +
        'cannot be taken back at all, or is taken back leaving ledger lines behind that no ' +
        'voucher accounts for.',
    },
  ];

  let broken = 0;

  for (const half of PAIR) {
    const start = source.indexOf(half.fn);
    if (start < 0) {
      broken += 1;
      failures.push(`${file}: ${half.fn} is gone; the approval chain cannot be checked.`);
      continue;
    }
    const next = source.indexOf('\nexport const ', start + 10);
    const body = source.slice(start, next > 0 ? next : undefined);
    if (!half.proof.test(body)) {
      broken += 1;
      failures.push(`${file}: ${half.why}`);
    }
  }

  if (broken === 0) {
    console.log('vouchers: approval posts the entry, and taking it back reverses it');
  }
}

// --- 28. A budget programme's record is named one way -----------------------

/*
 * Two things write a programme record: the ordinance importer, as it meets a
 * programme in the annex, and the Budget Programmes screen, when somebody adds
 * one by hand. Both write at a KNOWN document id rather than an auto-generated
 * one, so that loading the same ordinance twice updates the programme instead
 * of making a second copy of it.
 *
 * Which means the two have to land on the SAME id. If they ever disagreed, a
 * programme added by hand and the same programme arriving in an upload would
 * become two records under one code, and an appropriation would be matched to
 * whichever the picker happened to show.
 *
 * The id also has to carry the FISCAL YEAR. While it was the code alone,
 * uploading the FY2027 ordinance overwrote the FY2026 programme of the same
 * code - the name changed underneath last year's appropriations and nothing
 * anywhere said so.
 *
 * `programDocId` is the one answer to both, vendored into the engine. This
 * refuses any other way of naming the record.
 */
{
  const WRITERS = [
    'functions/src/budget/import.ts',
    'src/pages/budget/BudgetPrograms.tsx',
  ];

  let offenders = 0;

  for (const file of WRITERS) {
    const full = resolve(root, file);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    /*
     * Every place this file names a document in the programmes collection.
     * Both shapes are matched: the engine's `collection(COL.programs).doc(x)`
     * and the screen's `upsertMaster(COL.programs, x, ...)`.
     */
    const named = [
      ...source.matchAll(/COL\.programs\s*\)\s*\.doc\(\s*([^),]+)/g),
      ...source.matchAll(/upsertMaster\(\s*COL\.programs\s*,\s*([^,]+)/g),
    ].map((m) => m[1].trim());

    if (named.length === 0) {
      offenders += 1;
      failures.push(
        `${file}: nothing in this file names a programme record any more, so the rule that both ` +
          'writers use the same id cannot be checked. If programme writing moved, move this ' +
          'check with it.',
      );
      continue;
    }

    const handRolled = named.filter((expr) => !expr.includes('programDocId'));
    if (handRolled.length > 0) {
      offenders += 1;
      failures.push(
        `${file}: a budget programme record is named without programDocId (${handRolled.join(', ')}). ` +
          'The ordinance importer and the Budget Programmes screen both write these records and ' +
          'must land on the same id, and the id must carry the fiscal year - a programme is what ' +
          'the Sanggunian appropriated to in ONE annual budget, and an id without the year lets ' +
          "next year's ordinance overwrite this year's programme.",
      );
    }
  }

  if (offenders === 0) {
    console.log('budget: a programme record is named by programDocId and nothing else');
  }
}

// --- 29. A withholding line is named by its account, not by its tax ---------

/*
 * ---------------------------------------------------------------------------
 * THE FIFTH APPEARANCE OF ONE MISTAKE
 * ---------------------------------------------------------------------------
 * Every tax the municipality withholds posts to ONE account - Due to BIR,
 * 20201010. Which tax it was belongs in the subsidiary ledger.
 *
 * `computeDeduction` takes the account's title as its second argument, and
 * every caller was handing it the TAX CODE's description. So the General
 * Ledger carried:
 *
 *     20201010  Expanded withholding tax on goods (1%)
 *     20201010  Final VAT withholding on goods (5%)
 *
 * Two titles against one code, neither of them the account's name. The Trial
 * Balance showed one figure for the account and the ledger showed two names
 * for it.
 *
 * This is the same fault as patches 79, 81 and 86 - a code read from a record
 * carrying a written-out title beside it - and guard 22 did not reach it,
 * because here the title is not written out as a literal. It is read from a
 * DIFFERENT record. So the guard is written for the call rather than for the
 * literal: the account title handed to `computeDeduction` may not come off
 * the tax code.
 */
{
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(resolve(root, 'src'));
  walk(resolve(root, 'functions/src'));

  let offenders = 0;

  for (const full of files) {
    const name = full.slice(root.length + 1);
    const source = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    /*
     * The call's arguments, flattened. Only the first two matter: the tax code
     * and the account title. A call that names `.description` in that second
     * position is handing the tax's own name to the account.
     */
    for (const m of source.matchAll(/computeDeduction\s*\(([\s\S]{0,300}?)\)\s*;/g)) {
      const args = m[1].replace(/\s+/g, ' ');
      const second = args.split(',')[1] ?? '';
      if (/\.description\b/.test(second)) {
        offenders += 1;
        failures.push(
          `${name}: computeDeduction is given a tax code's own description as the ACCOUNT title ` +
            `(${second.trim()}). Every tax withheld posts to Due to BIR; writing the tax's name ` +
            'there puts two different titles against one account code in the General Ledger. ' +
            'Read the title from the Chart of Accounts and let the tax travel as the subsidiary.',
        );
      }
    }
  }

  if (offenders === 0) {
    console.log('accounts: a withholding line is named by its account, not by its tax');
  }
}

// --- 30. A printed form takes its heading from the municipality -------------

/*
 * ---------------------------------------------------------------------------
 * EVERY FORM CFMS PRINTED HAD THE WRONG HEADING ON IT
 * ---------------------------------------------------------------------------
 * Two components wrote the entity heading out in code, and they wrote two
 * DIFFERENT headings:
 *
 *   formParts.tsx   Republic / Province of Negros Occidental /
 *                   Municipality of Candoni / an office
 *   ReportShell.tsx Republic / Province / Municipality
 *
 * The municipality's own COA forms say neither. They say Republic / MUNICIPAL
 * GOVERNMENT OF CANDONI / the street address, with no province line and no
 * office line - so every prescribed appendix CFMS printed was headed wrongly,
 * in two different wrong ways, and neither could be corrected without a patch.
 *
 * It comes from Settings now, through `useEntity`. This refuses the day
 * somebody writes it out again, which is the easiest possible thing to do:
 * the lines are short, they look like boilerplate, and a form that prints
 * them looks right until somebody lays it beside the real one.
 */
{
  /*
   * The one file allowed to carry the words is the one that supplies them.
   * ReportShell is allowed them as a FALLBACK for an export whose meta does
   * not name a municipality, which is a different thing from a prescribed
   * form's letterhead.
   */
  const ALLOWED = new Set([
    // Supplies the lines.
    'src/lib/entity.ts',
    'src/data/useEntity.ts',
    // The EXPORTS' own heading, and its fallback. An exported spreadsheet is
    // not a prescribed appendix: it heads its pages with the municipality and
    // the province, which is a different heading and a correct one.
    'src/components/ReportShell.tsx',
    'src/lib/export.ts',
    // Where the office TYPES the heading. A default value in the box it is
    // typed into is the one place the words belong in code.
    'src/pages/admin/Settings.tsx',
  ]);

  const MARKERS = [/Republic of the Philippines/, /MUNICIPAL GOVERNMENT OF/];

  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(resolve(root, 'src'));

  let offenders = 0;

  for (const full of files) {
    const name = full.slice(root.length + 1).split('\\').join('/');
    if (ALLOWED.has(name)) continue;

    const source = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    if (MARKERS.some((m) => m.test(source))) {
      offenders += 1;
      failures.push(
        `${name}: the entity's heading is written out here. It belongs to the municipality, not ` +
          'to a component - a COA appendix is headed with the entity name and street address the ' +
          'office has set, and two files writing it out is how CFMS came to print two different ' +
          'wrong headings. Read it from useEntity().',
      );
    }
  }

  if (offenders === 0) {
    console.log("forms: the heading comes from the municipality's own settings");
  }
}


// --- 31. One pile of collections, divided by kind ---------------------------

/*
 * ---------------------------------------------------------------------------
 * FOUR REPORTS READING ONE REGISTER
 * ---------------------------------------------------------------------------
 * An e-collection is an ordinary `collections` document carrying a kind - the
 * reasoning is on `Collection.eCollectionKind`, and it is the decision the
 * whole of patch 91 rests on. It buys one register, one Cashbook, one Abstract
 * of Collections and one SRE, which is what the office asked for when it said
 * all online collections should be presented together.
 *
 * What it costs is this: the Report of Collections and Deposits and COA
 * Circular 2021-014's three reports all draw on that one pile, and the ONLY
 * thing dividing it is the kind recorded on each document.
 *
 * If the division were lost, a GCash receipt would be offered to the RCD as
 * well as to its own report, and whichever was certified first would claim it
 * - because a document is claimed by one report and one only, which is the
 * control that stops a receipt reaching the ledger twice. The other report
 * would then foot to less than the money it covers, the officer would certify
 * a statement that is untrue, and the only visible symptom would be a bank
 * reconciliation that will not close.
 *
 * The screen filters the list it offers. The screen is not the authority. So
 * this asserts that the ENGINE still refuses the mismatch, inside the
 * transaction that certifies.
 */
{
  const file = resolve(root, 'functions/src/treasury/reports.ts');
  const source = existsSync(file)
    ? readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
    : '';

  if (!source) {
    failures.push(
      'functions/src/treasury/reports.ts: not found. The treasury report engine is where the ' +
        'RCD and the three e-collection reports are kept apart.',
    );
  } else if (!/collectionBelongsOnReport\s*\(/.test(source)) {
    failures.push(
      'functions/src/treasury/reports.ts: certifyTreasuryReport no longer checks that a ' +
        'collection belongs on the report claiming it. The RCD and the three COA Circular ' +
        '2021-014 reports draw on one `collections` register and are divided only by ' +
        '`eCollectionKind`; without this check a receipt can be certified onto the wrong ' +
        'report, which claims it for good and leaves the right report short. ' +
        'Call collectionBelongsOnReport from src/lib/eCollections.ts.',
    );
  } else {
    /*
     * And that the mapping is the SHARED one. A copy written out here would
     * be a second answer to "which report is this collection for", and the
     * browser decides what to offer from the first.
     */
    const importsShared = /from\s+'\.\.\/lib\/eCollections'/.test(source);
    if (!importsShared) {
      failures.push(
        'functions/src/treasury/reports.ts: the report-to-kind mapping is not the shared one ' +
          "from '../lib/eCollections'. The browser decides what to OFFER from that mapping and " +
          'the engine decides what to ACCEPT; two copies of it is two answers, and the day they ' +
          'differ a receipt is offered to a report the engine then refuses - or worse, accepted ' +
          'onto one the screen never meant.',
      );
    } else {
      console.log('collections: the RCD and the eRCDs are divided by the same mapping');
    }
  }
}


// --- 32. A master-data list has the index it needs --------------------------

/*
 * ---------------------------------------------------------------------------
 * A SCREEN THAT LOADS NOTHING AND SAYS SO IN RED
 * ---------------------------------------------------------------------------
 * Almost every master-data list asks Firestore the same question: the active
 * records, in order. Two constraints, and Firestore needs a composite index
 * for the pair. Without it the query does not return an empty list - it FAILS,
 * and the screen shows "This view needs a Firestore index that has not been
 * created yet".
 *
 * It has now happened twice. Budget Programmes shipped in patch 86 with no
 * index for `programs`, and the office found it by opening the screen. Patch
 * 91 added Collection Intermediaries with the same omission, which would have
 * been found the same way a week later.
 *
 * Both are one line in firestore.indexes.json that nobody thought of, and
 * nothing anywhere connected the query to the file. Which is the shape this
 * project has a standing answer to: when a rule lives in two places, a build
 * check compares them.
 *
 * WHAT THIS DOES NOT COVER, said plainly. It reads the queries declared in
 * src/data/queries.ts of the exact form [ACTIVE, orderBy('field')] - the shape
 * that has failed twice. Queries built elsewhere, or with further `where`
 * clauses, are not checked, so a green run here is not a promise that every
 * index exists. It is a promise about this one family.
 */
{
  const queriesFile = resolve(root, 'src/data/queries.ts');
  const indexFile = resolve(root, 'firestore.indexes.json');

  if (!existsSync(queriesFile) || !existsSync(indexFile)) {
    failures.push(
      'src/data/queries.ts or firestore.indexes.json is missing; the master-data index check ' +
        'cannot run.',
    );
  } else {
    const source = readFileSync(queriesFile, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    /* COL.<key> -> the Firestore collection name it stands for. */
    const collections = {};
    const colSource = readFileSync(resolve(root, 'src/lib/collections.ts'), 'utf8');
    for (const m of colSource.matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
      collections[m[1]] = m[2];
    }

    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    const have = new Set(
      (index.indexes ?? []).map(
        (i) => `${i.collectionGroup}|${(i.fields ?? []).map((f) => f.fieldPath).join(',')}`,
      ),
    );

    let offenders = 0;
    let checked = 0;

    for (const m of source.matchAll(/useCollection<[^>]+>\(\s*COL\.(\w+)\s*,\s*\[([^\]]*)\]/g)) {
      const key = m[1];
      const constraints = m[2].replace(/\s+/g, ' ');
      if (!/\bACTIVE\b/.test(constraints)) continue;

      const ordered = /orderBy\('([^']+)'/.exec(constraints);
      if (!ordered) continue;

      /* Only the plain two-constraint shape; anything richer is out of scope. */
      const parts = constraints.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length !== 2) continue;

      const collection = collections[key] ?? key;
      const field = ordered[1];
      checked += 1;

      if (!have.has(`${collection}|active,${field}`)) {
        offenders += 1;
        failures.push(
          `firestore.indexes.json: the ${collection} list asks for the active records ordered by ` +
            `'${field}', and there is no index for it. Firestore does not answer that query with ` +
            'an empty list - it refuses it, and the screen shows a red "this view needs a ' +
            'Firestore index" where the records should be. Add { collectionGroup: ' +
            `"${collection}", fields: [active, ${field}] } and deploy the indexes.`,
        );
      }
    }

    /*
     * ---- AND THE SECOND FAMILY: a year, a fund, and an order ---------------
     *
     * The other shape this application asks over and over - the appropriations
     * of a fund for a year, its allotments, its obligations - needs a
     * three-field composite index, and fails exactly as loudly without one.
     *
     * It was not checked while every such query predated the index file. Patch
     * 103 added `useAugmentationDrafts`, which is the first new one in a long
     * while, and an unindexed query here would have shown the Budget Officer a
     * red box where their prepared augmentations should be.
     */
    let yearFundOffenders = 0;
    let yearFundChecked = 0;

    for (const m of source.matchAll(/useCollection<[^>]+>\(\s*COL\.(\w+)\s*,\s*\[([^\]]*)\]/g)) {
      const key = m[1];
      const constraints = m[2].replace(/\s+/g, ' ');

      if (!/where\('fiscalYear',\s*'=='/.test(constraints)) continue;
      if (!/where\('fundCode',\s*'=='/.test(constraints)) continue;

      const ordered = /orderBy\('([^']+)'/.exec(constraints);
      if (!ordered) continue;

      /* Exactly the three; anything richer is out of scope, as above. */
      const parts = constraints.split('),').map((p) => p.trim()).filter(Boolean);
      if (parts.length !== 3) continue;

      const collection = collections[key] ?? key;
      const field = ordered[1];
      yearFundChecked += 1;

      if (!have.has(`${collection}|fiscalYear,fundCode,${field}`)) {
        yearFundOffenders += 1;
        failures.push(
          `firestore.indexes.json: the ${collection} list asks for one fund's records for one ` +
            `year ordered by '${field}', and there is no index for it. Firestore refuses that ` +
            'query rather than answering it empty, and the screen shows a red "this view needs ' +
            'a Firestore index" where the records should be. Add { collectionGroup: ' +
            `"${collection}", fields: [fiscalYear, fundCode, ${field}] } and deploy the indexes.`,
        );
      }
    }

    if (offenders === 0 && yearFundOffenders === 0) {
      console.log(
        `indexes: ${checked} master-data lists and ${yearFundChecked} fund-and-year lists each ` +
          'have the index they need',
      );
    }
  }
}


// --- 33. A data hook is never called conditionally --------------------------

/*
 * ---------------------------------------------------------------------------
 * THE SCREEN THAT WENT WHITE
 * ---------------------------------------------------------------------------
 * `useBankTransactions` read, for a long time:
 *
 *     if (!bankAccountId) return { data: [], loading: false, error: null };
 *     ...
 *     return useCollection(...)
 *
 * which looks like an ordinary guard clause and is not. It is a HOOK called
 * conditionally. With no account chosen the function returns having called
 * nothing; with one chosen it calls useCollection, which calls several hooks
 * of its own. React matches hooks between renders BY POSITION, so the render
 * where the account arrives has more hooks than the one before it, and React
 * responds by throwing and unmounting the tree.
 *
 * Bank Reconciliation auto-selects the bank account when the fund has exactly
 * one, which Candoni's General Fund does. So the page rendered, chose the only
 * account, and went WHITE on the next render. No error on screen, nothing in
 * the interface to report, and no test caught it because the components are
 * not rendered in the test suite at all.
 *
 * The honest form is the one useWorkflowHistory has always used: pass a null
 * PATH to useCollection, which returns an empty settled result, and call the
 * hook every time.
 *
 * This refuses the shape. It is deliberately narrow - an early return that
 * sits before the first use* call inside an exported hook - because that is
 * the shape that reached the office.
 */
{
  const file = resolve(root, 'src/data/queries.ts');
  const source = existsSync(file)
    ? readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
    : '';

  if (!source) {
    failures.push('src/data/queries.ts: not found. Every screen reads its data through it.');
  } else {
    let offenders = 0;
    let checked = 0;

    /* Exported arrow hooks with a BLOCK body - the only ones that can return early. */
    for (const m of source.matchAll(
      /export const (use\w+)\s*=\s*\([^)]*\)\s*(?::[^=]*?)?=>\s*\{([\s\S]*?)\n\};/g,
    )) {
      const [, name, body] = m;
      checked += 1;

      const early = /\n\s*if\s*\([^)]*\)\s*(?:\{\s*)?return\b/.exec(body);
      const firstHook = /\buse[A-Z]\w*\s*[<(]/.exec(body);
      if (!early || !firstHook) continue;
      if (early.index > firstHook.index) continue;

      offenders += 1;
      failures.push(
        `src/data/queries.ts: ${name} returns before it calls a hook. React matches hooks ` +
          'between renders by position, so the render where the argument arrives calls more ' +
          'hooks than the one before it and React unmounts the whole tree - the screen goes ' +
          'white with nothing to report. Pass a null PATH to useCollection instead, as ' +
          'useWorkflowHistory does, and call the hook every time.',
      );
    }

    if (offenders === 0) {
      console.log(`hooks: ${checked} data hooks call their hooks unconditionally`);
    }
  }
}


// --- 34. A grouped strip is never drawn flat --------------------------------

/*
 * ---------------------------------------------------------------------------
 * ONE SECTION, TWO DIFFERENT STRIPS
 * ---------------------------------------------------------------------------
 * Collections and Deposits is the one section long enough to be drawn in
 * groups - twelve tabs flat is three wrapped rows, and at that length a strip
 * stops being a map.
 *
 * Patch 97 converted the screens in that section one at a time, and missed
 * two: the Report of Collections and Deposits and the eRCD are not pages of
 * their own, they are the shared treasury-report screen, which rendered the
 * FLAT strip unconditionally. So the office opened the RCD and saw twelve tabs
 * on three rows, with every other screen in the same section showing four
 * groups. Nothing failed. It just looked like two different systems, and the
 * only way to find it was to open each screen.
 *
 * This refuses the flat strip for that section's tabs. `usesCollectionGroups`
 * is how the shared screen asks which section it is in.
 */
{
  /* Every strip that has a grouped form, and the name of that form. */
  const GROUPED_STRIPS = [
    ['COLLECTION_TABS', 'COLLECTION_TAB_GROUPS'],
    ['PAYMENT_TABS', 'PAYMENT_TAB_GROUPS'],
    ['REPORT_TABS', 'REPORT_TAB_GROUPS'],
    ['MASTER_DATA_TABS', 'MASTER_DATA_TAB_GROUPS'],
  ];

  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name)) files.push(full);
    }
  };
  walk(resolve(root, 'src'));

  let offenders = 0;

  for (const full of files) {
    const name = full.slice(root.length + 1).split('\\').join('/');
    const source = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\/[^\n]*/g, '');

    for (const [flat, grouped] of GROUPED_STRIPS) {
      if (!new RegExp(`<SectionTabs\\s+tabs=\\{${flat}\\}`).test(source)) continue;
      offenders += 1;
      failures.push(
        `${name}: renders ${flat} FLAT. That section is drawn in GROUPS - a strip long enough ` +
          'to wrap onto two or three rows stops being a map, because every tab in it looks ' +
          `equally likely. Use <GroupedSectionTabs groups={${grouped}} />.`,
      );
    }
  }

  if (offenders === 0) {
    console.log('tabs: every grouped section is drawn in groups everywhere');
  }
}

// --- 35. No HTML entity inside a JavaScript string --------------------------

/*
 * ---------------------------------------------------------------------------
 * "A collecting officer&rsquo;s receipts"
 * ---------------------------------------------------------------------------
 * That is what the Report of Collections and Deposits printed under its own
 * heading, because the apostrophe was written as an HTML entity inside a
 * STRING rather than in JSX text. In JSX text `&rsquo;` is an apostrophe; in a
 * string handed to a prop it is six literal characters, and React renders them
 * faithfully.
 *
 * Nothing breaks, which is why it survived - it is just the municipality's
 * financial system showing gibberish on a page an auditor may read.
 *
 * Only STRING LITERALS are checked. An entity in JSX text is correct and
 * common, and this must not chase people away from writing it there.
 */
{
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(resolve(root, 'src'));

  /* The entities that read as words when they fail. */
  const ENTITY = /&(rsquo|lsquo|ldquo|rdquo|mdash|ndash|nbsp|amp|hellip|times|middot);/;

  let offenders = 0;

  for (const full of files) {
    const name = full.slice(root.length + 1).split('\\').join('/');
    const source = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    /* Single- and double-quoted strings only; template literals too. */
    for (const m of source.matchAll(/'([^'\n\\]*)'|"([^"\n\\]*)"|`([^`\\]*)`/g)) {
      const text = m[1] ?? m[2] ?? m[3] ?? '';
      const hit = ENTITY.exec(text);
      if (!hit) continue;
      offenders += 1;
      failures.push(
        `${name}: the string "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" contains ` +
          `${hit[0]}. Inside a string that is not an entity - it is the literal characters, and ` +
          'the screen prints them. Write the character itself, or move the text into JSX where ' +
          'an entity is read as one.',
      );
    }
  }

  if (offenders === 0) {
    console.log('text: no HTML entity is hiding inside a string literal');
  }
}

// --- 36. A heading is never smaller than what it holds ----------------------

/*
 * ---------------------------------------------------------------------------
 * THE SMALLEST TYPE ON THE MENU WAS THE HEADING
 * ---------------------------------------------------------------------------
 * The sidebar has three depths - a module, a heading inside it, a screen under
 * that heading - and nothing but type size tells them apart. The heading was
 * set at 11px against 12px items, so it was smaller than the five screens it
 * held: a label that looked subordinate to its own contents.
 *
 * It got that way quietly. The item size was raised once and the heading was
 * not, because the two sizes were written into class strings a hundred lines
 * apart with nothing connecting them. Sidebar.tsx names all three now, and
 * this reads those names and insists the ladder still descends.
 *
 * It checks ORDER, not particular numbers. Making the whole menu bigger or
 * smaller is a free decision; making a heading smaller than its items is the
 * mistake, and it is the only thing refused here.
 */
{
  const file = resolve(root, 'src/layout/Sidebar.tsx');

  if (!existsSync(file)) {
    failures.push('src/layout/Sidebar.tsx is missing. The menu is the whole navigation.');
  } else {
    const source = readFileSync(file, 'utf8');

    /* Tailwind's named sizes, in pixels, plus the arbitrary text-[Npx] form. */
    const NAMED = { 'text-2xs': 10, 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18 };

    const sizeOf = (cls) => {
      const arbitrary = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(cls);
      if (arbitrary) return Number(arbitrary[1]);
      return Object.prototype.hasOwnProperty.call(NAMED, cls) ? NAMED[cls] : null;
    };

    const read = (name) => {
      const m = new RegExp(`const ${name} = '([^']+)'`).exec(source);
      return m ? m[1] : null;
    };

    const LADDER = ['SECTION_TEXT', 'GROUP_TEXT', 'ITEM_TEXT'];
    const found = {};
    let usable = true;

    for (const name of LADDER) {
      const cls = read(name);
      if (cls === null) {
        failures.push(
          `src/layout/Sidebar.tsx no longer declares ${name}. The menu's three type sizes are ` +
            'named in one place so the ladder between them can be checked. Writing a size back ' +
            'into a class string hides it again, which is how a heading ended up smaller than ' +
            'its own items.',
        );
        usable = false;
        continue;
      }
      const px = sizeOf(cls);
      if (px === null) {
        failures.push(
          `src/layout/Sidebar.tsx: ${name} is "${cls}", which this check cannot measure. Use a ` +
            'Tailwind named size or the text-[Npx] form, so the ladder stays checkable.',
        );
        usable = false;
        continue;
      }
      found[name] = { cls, px };
    }

    /* Every named size must actually be used, or naming it proves nothing. */
    if (usable) {
      for (const name of LADDER) {
        const uses = source.split(name).length - 1;
        if (uses < 2) {
          failures.push(
            `src/layout/Sidebar.tsx declares ${name} but never uses it. A size that is declared ` +
              'and not applied is a check passing over a menu it is not describing.',
          );
          usable = false;
        }
      }
    }

    if (usable) {
      const section = found.SECTION_TEXT;
      const group = found.GROUP_TEXT;
      const item = found.ITEM_TEXT;

      if (!(group.px > item.px)) {
        failures.push(
          `src/layout/Sidebar.tsx: a group heading is ${group.cls} (${group.px}px) and the items ` +
            `under it are ${item.cls} (${item.px}px). A heading must be LARGER than what it ` +
            'holds - set smaller, it reads as the least important thing in its own group, which ' +
            'is what "Budget transactions" did until patch 100.',
        );
      }

      if (!(section.px > group.px)) {
        failures.push(
          `src/layout/Sidebar.tsx: a module is ${section.cls} (${section.px}px) and a heading ` +
            `inside it is ${group.cls} (${group.px}px). The module must be the larger of the ` +
            'two, or the menu stops saying which contains which.',
        );
      }
    }

    if (!failures.some((f) => f.includes('Sidebar.tsx'))) {
      console.log('menu: a heading is larger than the items under it');
    }
  }
}

// --- 37. The Edit button and the rule agree about "not yet approved" --------

/*
 * ---------------------------------------------------------------------------
 * A BUTTON THAT FAILS ON SAVE IS WORSE THAN NO BUTTON
 * ---------------------------------------------------------------------------
 * Patch 102 put an Edit button on a draft appropriation. The screen decides
 * whether to OFFER it; `firestore.rules` decides whether to ACCEPT the write.
 * When the two disagree the officer fills in sixteen fields, presses save, and
 * is told "Missing or insufficient permissions" - and concludes the system is
 * unreliable about editing, which is a worse place to be than never having
 * offered it.
 *
 * So three things are checked, and none of them is "the rule says DRAFT",
 * because the rule may reasonably be written several ways:
 *
 *   The screen's test comes from one file, not from an `=== 'DRAFT'` written
 *   inline on whichever screen needed it.
 *
 *   The rule still turns on the STORED status rather than the submitted one.
 *   `isDraft()` reads resource.data; a rule that checked only
 *   request.resource.data would let a client submit status DRAFT over an
 *   APPROVED line and edit approved authority.
 *
 *   The rule freezes the fields a correction must not touch, and checks the
 *   fund. Both were absent while nobody edited.
 */
{
  const helper = resolve(root, 'src/lib/budgetEditable.ts');

  if (!existsSync(helper)) {
    failures.push(
      'src/lib/budgetEditable.ts is missing. The test for whether an appropriation may still be ' +
        'corrected lives there so the screen and firestore.rules cannot drift apart.',
    );
  } else {
    const source = readFileSync(helper, 'utf8');
    if (!/export function appropriationEditable/.test(source)) {
      failures.push(
        'src/lib/budgetEditable.ts no longer exports appropriationEditable. The screens call it ' +
          'to decide whether to offer the Edit button.',
      );
    }
    if (!/EDITABLE_APPROPRIATION_STATUS\s*=\s*'DRAFT'/.test(source)) {
      failures.push(
        "src/lib/budgetEditable.ts no longer names DRAFT as the editable status, but " +
          "firestore.rules still permits an update only while isDraft(). An appropriation the " +
          'screen thinks is editable and the database refuses is a form that fails on save.',
      );
    }
  }

  /* No screen decides this for itself. */
  const screens = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name)) screens.push(full);
    }
  };
  walk(resolve(root, 'src/pages/budget'));

  for (const full of screens) {
    const name = full.slice(root.length + 1).split('\\').join('/');
    const source = readFileSync(full, 'utf8');
    /* An Edit affordance decided by a raw status comparison. */
    if (/>\s*Edit\s*</.test(source) && !/appropriationEditable/.test(source)) {
      if (/status\s*===?\s*'DRAFT'/.test(source)) {
        failures.push(
          `${name} offers an Edit control and decides it with a raw status comparison. Use ` +
            'appropriationEditable from src/lib/budgetEditable.ts, so the button and the ' +
            'Firestore rule cannot drift apart.',
        );
      }
    }
  }

  /* And the rule itself. */
  const block = firestore.match(/match \/appropriations\/\{[^}]*\}\s*\{([\s\S]*?)\n    \}/);

  if (!block) {
    failures.push("firestore.rules: no rule block for 'appropriations'.");
  } else {
    const body = block[1].replace(/\/\/[^\n]*/g, '');
    const update = body.match(/allow update:([\s\S]*?);/);

    if (!update) {
      failures.push("firestore.rules: the 'appropriations' block has no update rule to check.");
    } else {
      const clause = update[1];

      if (!/isDraft\(\)/.test(clause)) {
        failures.push(
          "firestore.rules: the 'appropriations' update rule no longer checks isDraft(). It is " +
            'the STORED status that decides - without it a client may submit status DRAFT over ' +
            'an approved line and edit authority that allotments have already been released ' +
            'against.',
        );
      }

      if (!/fundAllowed\(resource\.data\.fundCode\)/.test(clause)) {
        failures.push(
          "firestore.rules: the 'appropriations' update rule does not check fundAllowed on the " +
            'STORED fund, so an officer scoped to one fund could edit another fund\'s draft.',
        );
      }

      for (const field of ['fiscalYear', 'fundCode', 'kind', 'createdBy', 'approvedBy']) {
        if (!new RegExp(`'${field}'`).test(clause)) {
          failures.push(
            `firestore.rules: the 'appropriations' update rule leaves '${field}' writable. A ` +
              'correction corrects THIS line - changing the year, the fund or the kind records ' +
              'a different appropriation over one that may already have been read.',
          );
        }
      }
    }
  }

  if (!failures.some((f) => f.includes('appropriation') || f.includes('budgetEditable'))) {
    console.log('budget: the Edit button and the appropriations rule agree');
  }
}

// --- 38. Every treasury report has a form it can be printed on --------------

/*
 * ---------------------------------------------------------------------------
 * THE REPORT THAT COULD NOT BE PRINTED, AND SAID NOTHING
 * ---------------------------------------------------------------------------
 * Appendix 34 - the Report of Collections and Deposits - was written when an
 * RCD was its own document in the `rcds` collection, and it read that
 * collection. The RCD then became a TREASURY REPORT, like the RCI and the
 * RADAI, and `rcds` stopped being written to.
 *
 * Nothing failed. The screen went on working perfectly against a collection
 * that no longer receives anything, reachable only from a register that is now
 * empty, while the report the Treasurer certifies most often had no printable
 * form at all - its own page hid the Print button and pointed at the screen
 * that had nothing to show. No test covered it because every test passed.
 *
 * The rule is simple and it lives in two files: the list of report types in
 * src/types/enums.ts, and the dispatch in TreasuryReportForm.tsx that decides
 * which form each one renders. A type in the first and not the second is a
 * report the office cannot print, and the office finds out at the counter.
 *
 * A type is covered when the dispatch names it: as a key of the FORMS map, as
 * an e-collection report in the shared mapping, or in a branch of its own.
 */
{
  const enums = resolve(root, 'src/types/enums.ts');
  const screen = resolve(root, 'src/pages/treasury/TreasuryReportForm.tsx');
  const shared = resolve(root, 'src/lib/eCollections.ts');

  if (!existsSync(enums) || !existsSync(screen)) {
    failures.push(
      'src/types/enums.ts or src/pages/treasury/TreasuryReportForm.tsx is missing; the ' +
        'treasury-form check cannot run.',
    );
  } else {
    const enumSource = readFileSync(enums, 'utf8');
    const listed = /TREASURY_REPORT_TYPES\s*=\s*\[([\s\S]*?)\]/.exec(enumSource);

    if (!listed) {
      failures.push('src/types/enums.ts no longer declares TREASURY_REPORT_TYPES.');
    } else {
      const types = (listed[1].match(/'([A-Z_]+)'/g) ?? []).map((t) => t.slice(1, -1));

      const screenSource = readFileSync(screen, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');

      /* The e-collection types, from the one file that divides them. */
      const eTypes = existsSync(shared)
        ? (
            /KIND_BY_REPORT[^=]*=\s*\{([\s\S]*?)\}/.exec(readFileSync(shared, 'utf8'))?.[1] ?? ''
          ).match(/\b([A-Z_]+)\s*:/g) ?? []
        : [];
      const eCovered = new Set(eTypes.map((t) => t.replace(/\s*:$/, '')));

      /* The FORMS map, and any branch that names a type outright. */
      const formsBlock = /const FORMS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(screenSource)?.[1] ?? '';
      const formKeys = new Set(
        (formsBlock.match(/^\s{2}([A-Z_]+)\s*:/gm) ?? []).map((k) => k.trim().replace(/:$/, '')),
      );
      const branchKeys = new Set(
        (screenSource.match(/reportType === '([A-Z_]+)'/g) ?? []).map((m) =>
          m.replace(/.*'([A-Z_]+)'.*/, '$1'),
        ),
      );

      const uncovered = types.filter(
        (t) => !formKeys.has(t) && !branchKeys.has(t) && !eCovered.has(t),
      );

      if (uncovered.length) {
        failures.push(
          `src/pages/treasury/TreasuryReportForm.tsx has no prescribed form for ` +
            `${uncovered.join(', ')}. Every treasury report is certified on a COA form and ` +
            'every one of them is printed. A type the dispatch does not name falls through to ' +
            '"No prescribed form for this report" - or, as the RCD did until patch 104, to a ' +
            'screen reading a collection nothing writes to any more. Add it to FORMS, or give ' +
            'it a branch of its own.',
        );
      } else {
        console.log(
          `treasury: all ${types.length} report types have a form to print on`,
        );
      }

      /*
       * And the way in. The detail screen is the only place that offers the
       * form, so a type excluded there cannot be printed however well the
       * dispatch handles it - which is the exact shape the RCD was in.
       */
      const detail = resolve(root, 'src/pages/treasury/TreasuryReportDetail.tsx');
      if (existsSync(detail)) {
        const detailSource = readFileSync(detail, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '');

        if (!/\/form`/.test(detailSource)) {
          failures.push(
            'src/pages/treasury/TreasuryReportDetail.tsx no longer offers the printed form. It ' +
              'is the only way in to it.',
          );
        }

        const excluded = (detailSource.match(/reportType !== '([A-Z_]+)'/g) ?? []).map((m) =>
          m.replace(/.*'([A-Z_]+)'.*/, '$1'),
        );
        if (excluded.length) {
          failures.push(
            `src/pages/treasury/TreasuryReportDetail.tsx excludes ${excluded.join(', ')} by ` +
              'report type. That is how the RCD lost its printed form: the exclusion outlived ' +
              'the reason for it by three patches and nothing failed. If the exclusion is ' +
              'right, say why here and teach this check about it.',
          );
        }
      }
    }
  }
}

// --- 39. An appropriation may be made to a programme, not only an object ----

/*
 * ---------------------------------------------------------------------------
 * THE DRAFT THAT COULD BE SAVED AND NEVER APPROVED
 * ---------------------------------------------------------------------------
 * The ordinance appropriates in two shapes. BY OBJECT - "Office Supplies
 * Expenses, 150,000" - and BY PROGRAMME - "Construction of Barangay Health
 * Station, Payauan, 2,000,000", where the ordinance named a PROJECT and no
 * object at all, and the object code is empty on purpose because budget
 * control operates at the level the appropriation was made at.
 *
 * Patch 86 taught the recording form and the ordinance upload both shapes.
 * `approveAppropriation` was not touched, and went on demanding an account
 * code outright. So a by-programme line could be recorded, saved, and then
 * refused at approval with "This appropriation is missing its account code" -
 * and the refusal advised recording it again, which produced another line that
 * could not be approved either. The office found it by trying.
 *
 * Nothing failed in the build, because the two halves were in different files
 * and neither mentioned the other. So the rule is in one shared file now and
 * this checks that it stayed there: an approval path that tests `accountCode`
 * by itself is the defect coming back.
 */
{
  const shared = resolve(root, 'src/lib/budgetLines.ts');
  const engine = resolve(root, 'functions/src/budget/appropriations.ts');

  if (!existsSync(shared)) {
    failures.push(
      'src/lib/budgetLines.ts is missing. What an appropriation must carry to become authority ' +
        'lives there, shared with the engine, because the screen and the engine disagreed about ' +
        'it for three patches.',
    );
  } else {
    const source = readFileSync(shared, 'utf8');
    for (const name of ['appropriationApprovalProblems', 'appropriationLineLabel']) {
      if (!new RegExp(`export function ${name}`).test(source)) {
        failures.push(`src/lib/budgetLines.ts no longer exports ${name}.`);
      }
    }
    if (!/account code or budget programme/.test(source)) {
      failures.push(
        'src/lib/budgetLines.ts no longer accepts a line appropriated to a programme instead of ' +
          'an object. An ordinance that names a project and no object is the ordinary case for ' +
          'capital outlay, and refusing it leaves a draft that can be saved and never approved.',
      );
    }
  }

  if (!existsSync(engine)) {
    failures.push('functions/src/budget/appropriations.ts is missing.');
  } else {
    const source = readFileSync(engine, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    if (!/appropriationApprovalProblems\(/.test(source)) {
      failures.push(
        'functions/src/budget/appropriations.ts no longer asks budgetLines what is missing from ' +
          'an appropriation. It decided that for itself until patch 107, and what it decided ' +
          'refused every line the ordinance appropriated to a project.',
      );
    }

    /*
     * The shape of the original defect: a required-field list naming the
     * account code on its own. The programme is the alternative, so a test of
     * one without the other is the refusal coming back.
     */
    for (const m of source.matchAll(/\['account code'[^\]]*\]/g)) {
      failures.push(
        `functions/src/budget/appropriations.ts requires an account code on its own ` +
          `(${m[0]}). A line appropriated by programme has none, on purpose. Use ` +
          'appropriationApprovalProblems, which accepts either.',
      );
    }
  }

  if (!failures.some((f) => f.includes('budgetLines') || f.includes('budget/appropriations'))) {
    console.log('budget: an appropriation may name a programme instead of an object');
  }
}

// --- 40. A button inside a clickable row does not also click the row ------

/*
 * ---------------------------------------------------------------------------
 * ONE CLICK, ONE THING
 * ---------------------------------------------------------------------------
 * A table whose rows open something is the common case in CFMS now - fourteen
 * screens - and a row like that usually carries buttons of its own as well:
 * Cancel, Release, Certify, View report.
 *
 * A click on a button inside a row is ALSO a click on the row. Unless the
 * button says otherwise, both fire. What that looks like on the screen:
 *
 *   CHECKS - pressing Cancel opened the cancel dialog AND the check's detail
 *   panel, one on top of the other.
 *
 *   ADA - the "ADA Form" link went to the form and then immediately to the
 *   advice's detail page, because the row navigated second and the last
 *   navigation wins. The link simply did not work, and nobody had said so.
 *
 *   DEPOSITS, RAAF - the same two-dialogs-at-once on Record Bank Credit and
 *   Certify.
 *
 * And when patch 108 made the treasury-report rows clickable, the same thing
 * would have broken VIEW REPORT from patch 105 - it would have landed on the
 * report instead of the form. That was caught before it shipped by driving the
 * clicks in a browser, which is how all of the above were found as well.
 *
 * So: on a screen whose DataTable has onRowClick, every click handler and every
 * link inside the columns must stop its click at itself.
 *
 * WHAT THIS DOES NOT SEE, said plainly. It reads the columns as written on the
 * screen. A cell that renders a component of its own - CoveringCell, say - is
 * opaque to it, and the buttons inside that component are that component's
 * responsibility. CoveringCell stops its own clicks and was checked by driving
 * them in a browser; a new one would need the same.
 */
{
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name)) files.push(full);
    }
  };
  walk(resolve(root, 'src/pages'));

  let screens = 0;
  let offenders = 0;

  for (const full of files) {
    const raw = readFileSync(full, 'utf8');
    if (!/onRowClick=/.test(raw)) continue;
    screens += 1;

    const name = full.slice(root.length + 1).split('\\').join('/');
    const source = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    /* The columns array: from its declaration to the bracket that closes it. */
    const start = /const columns[^=]*=\s*\[/.exec(source);
    if (!start) continue;
    let i = start.index + start[0].length;
    let depth = 1;
    while (depth > 0 && i < source.length) {
      if (source[i] === '[') depth += 1;
      else if (source[i] === ']') depth -= 1;
      i += 1;
    }
    const region = source.slice(start.index, i);

    /* Every onClick={...} handler, read to its matching brace. */
    for (const m of region.matchAll(/onClick=\{/g)) {
      let j = m.index + m[0].length;
      let d = 1;
      while (d > 0 && j < region.length) {
        if (region[j] === '{') d += 1;
        else if (region[j] === '}') d -= 1;
        j += 1;
      }
      const body = region.slice(m.index + m[0].length, j - 1);
      if (!/stopPropagation/.test(body)) {
        offenders += 1;
        failures.push(
          `${name}: a button in a clickable row does not stop its click - ` +
            `onClick={${body.trim().slice(0, 60)}}. The row opens as well, so the press does ` +
            'two things. Write (e) => { e.stopPropagation(); ... }.',
        );
      }
    }

    /*
     * And every link, which navigates on its own and then the row navigates
     * over it. The opening tag is read to the first `>` OUTSIDE braces: an
     * arrow function's `=>` inside a prop is not the end of the tag, and a
     * plain [^>]* stopped there and reported the fixed link as broken.
     */
    for (const m of region.matchAll(/<Link\b/g)) {
      let k = m.index + m[0].length;
      let braces = 0;
      while (k < region.length) {
        const c = region[k];
        if (c === '{') braces += 1;
        else if (c === '}') braces -= 1;
        else if (c === '>' && braces === 0) break;
        k += 1;
      }
      const tag = region.slice(m.index, k + 1);
      if (!/stopPropagation/.test(tag)) {
        offenders += 1;
        failures.push(
          `${name}: a link in a clickable row does not stop its click. The link navigates and ` +
            'then the row navigates over it, and the last one wins - the link appears not to ' +
            'work. Add onClick={(e) => e.stopPropagation()}.',
        );
      }
    }
  }

  if (offenders === 0) {
    console.log(`rows: ${screens} clickable tables, and no button in one also clicks its row`);
  }
}

// --- 41. Allotment is released only by the Budget Officer's approval -------

/*
 * ---------------------------------------------------------------------------
 * RECORDING IS NOT RELEASING
 * ---------------------------------------------------------------------------
 * Until patch 110, entering an Allotment Release Order released it, and so did
 * uploading a file of allotments. The Budget Office asked for the two to be
 * separate: an order is PREPARED - by Budget Staff or the Budget Officer - and
 * authority moves only when the Budget Officer approves it.
 *
 * Three things hold that, and each is a place it could quietly come undone:
 *
 *   The prepared order is written by the browser, so the RULE must refuse a
 *   browser writing it as APPROVED or giving it an ARO number. A client that
 *   could would make an order look released without releasing anything.
 *
 *   `issueAro` - the old one-press release - is still deployed, because
 *   deleting a function is an easily-missed step. It must refuse, not
 *   release. Left working it is the door beside the one being guarded.
 *
 *   `approveAro` reads the order it releases inside its own transaction. An
 *   approval that took the lines from the browser would release whatever the
 *   browser said at that moment, not what was prepared.
 */
{
  const block = firestore.match(/match \/aroDrafts\/\{[^}]*\}\s*\{([\s\S]*?)\n    \}/);
  if (!block) {
    failures.push("firestore.rules: no rule block for 'aroDrafts', the prepared release orders.");
  } else {
    const body = block[1].replace(/\/\/[^\n]*/g, '');
    for (const verb of ['create', 'update']) {
      const rule = body.match(new RegExp(`allow ${verb}:([\\s\\S]*?);`));
      if (!rule) {
        failures.push(`firestore.rules: 'aroDrafts' has no ${verb} rule to check.`);
        continue;
      }
      if (!/request\.resource\.data\.status == 'DRAFT'/.test(rule[1])) {
        failures.push(
          `firestore.rules: the 'aroDrafts' ${verb} rule does not hold a browser to status DRAFT. ` +
            'Only the engine may mark an order APPROVED - a client that could would make an order ' +
            'look released without releasing anything.',
        );
      }
      if (!/aroNo/.test(rule[1])) {
        failures.push(
          `firestore.rules: the 'aroDrafts' ${verb} rule lets a browser write an ARO number. ` +
            'The number is issued by the engine when the order is released, and by nothing else.',
        );
      }
    }
    const del = body.match(/allow delete:([\s\S]*?);/);
    if (del && !/resource\.data\.status == 'DRAFT'/.test(del[1])) {
      failures.push(
        "firestore.rules: the 'aroDrafts' delete rule lets an APPROVED order be deleted. It is the " +
          'record of who prepared a release, and its id is what stops an uploaded release being ' +
          'prepared twice.',
      );
    }
  }

  const aroFile = resolve(root, 'functions/src/budget/aro.ts');
  if (existsSync(aroFile)) {
    const src = readFileSync(aroFile, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    const issue = src.match(/export const issueAro = onCall\(([\s\S]*?)\n\);/);
    if (!issue) {
      failures.push('functions/src/budget/aro.ts no longer declares issueAro, so it cannot be checked.');
    } else if (/postAroInTransaction|runTransaction|applyBudgetDelta/.test(issue[1])) {
      failures.push(
        'functions/src/budget/aro.ts: issueAro releases allotment again. It must refuse - an order ' +
          'is prepared and then approved, and a one-press release beside that is a way round the ' +
          "Budget Officer's approval.",
      );
    }

    const approve = src.match(/export const approveAro = onCall\(([\s\S]*?)\n\);/);
    if (!approve) {
      failures.push('functions/src/budget/aro.ts no longer declares approveAro.');
    } else {
      if (!/tx\.get\(ref\)/.test(approve[1])) {
        failures.push(
          'functions/src/budget/aro.ts: approveAro does not read the prepared order inside its ' +
            'transaction. What is released must be what was prepared, read where it is released.',
        );
      }
      if (/request\.data[^;]*lines/.test(approve[1])) {
        failures.push(
          'functions/src/budget/aro.ts: approveAro takes its lines from the request. They must come ' +
            'from the stored order, or an order can be approved as something other than what was ' +
            'prepared.',
        );
      }
    }
  }

  if (!failures.some((f) => f.includes('aroDrafts') || f.includes('budget/aro.ts'))) {
    console.log("budget: allotment is released only by the Budget Officer's approval");
  }
}

// --- 43. Appropriation becomes authority only by approval ------------------

/*
 * ---------------------------------------------------------------------------
 * PREPARED FIRST, POSTED ON APPROVAL - FOR EVERY APPROPRIATION (patch 112)
 * ---------------------------------------------------------------------------
 * Three doors used to post appropriation the moment they were used: the
 * ordinance upload, the realignment form, and the realignment upload. And the
 * one that did wait - the prepared augmentation - posted whatever LINES the
 * browser sent at approval, not necessarily what had been prepared.
 *
 * Now importBudgetLines posts only a prepared set named by its id, with the
 * lines read from the stored set; everything else it receives lands as drafts.
 * This refuses a build in which any of that comes undone.
 */
{
  const importFile = resolve(root, 'functions/src/budget/import.ts');
  const before = failures.length;
  if (!existsSync(importFile)) {
    failures.push('functions/src/budget/import.ts is missing, so appropriation posting cannot be checked.');
  } else {
    const src = readFileSync(importFile, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (!/const preparing = kind === 'APPROPRIATION' && !fromDraft;/.test(src) || !/const asDrafts = preparing;/.test(src)) {
      failures.push(
        "functions/src/budget/import.ts: an appropriation call that is not the approval of a prepared set " +
          'no longer lands as drafts. Uploading an ordinance or a realignment must PREPARE it; only the ' +
          "Budget Officer's approval posts.",
      );
    }
    if (!/asDrafts\s*\?\s*\{\s*status:\s*'DRAFT'/.test(src)) {
      failures.push(
        'functions/src/budget/import.ts: the lines of an uploaded ordinance are no longer written as ' +
          'DRAFT. They would be authority the moment the file was read.',
      );
    }
    if (!/postingFromPreparedSet\(/.test(src) || !/data\.rows = posting\.rows/.test(src)) {
      failures.push(
        'functions/src/budget/import.ts: approving a prepared augmentation or realignment no longer ' +
          'takes its lines from the stored set. What is posted must be what was prepared, not what ' +
          'the browser sends.',
      );
    }
    if (!/tx\.get\(fromDraft\.ref\)/.test(src)) {
      failures.push(
        'functions/src/budget/import.ts: a prepared set is not read again inside the transaction that ' +
          'posts it, so one edited during approval would post as edited.',
      );
    }
  }

  const screen = resolve(root, 'src/pages/budget/Appropriations.tsx');
  if (existsSync(screen)) {
    const src = readFileSync(screen, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (/engine\.importBudgetLines\(/.test(src)) {
      failures.push(
        'src/pages/budget/Appropriations.tsx calls importBudgetLines with lines of its own. A ' +
          'realignment or augmentation is prepared and then approved by its id ' +
          '(engine.approvePreparedSet); the screen does not send what is to be posted.',
      );
    }
  }

  if (failures.length === before) {
    console.log('budget: appropriation becomes authority only by approval');
  }
}

// --- 44. Every document has a way back to the table it came from ---------

/*
 * ---------------------------------------------------------------------------
 * THE OBR, THE DV, THE JOURNAL ENTRY AND THE LIQUIDATION REPORT (patch 114)
 * ---------------------------------------------------------------------------
 * Opened from a table, each of these had no way back except the menu or the
 * browser's own Back button - patch 109 had fixed it for the treasury report
 * alone. Now each has a Back button that reads where it was opened from, and
 * the tables that open them write that into the address.
 *
 * This refuses a build in which one of the four loses its Back button, or in
 * which a screen opens one of them with a bare navigate() - which is how the
 * next list would quietly lose the way back again.
 */
{
  const before = failures.length;
  const DOCUMENTS = [
    'src/pages/budget/ObligationDetail.tsx',
    'src/pages/accounting/DisbursementDetail.tsx',
    'src/pages/accounting/JevDetail.tsx',
    'src/pages/accounting/LiquidationDetail.tsx',
  ];
  for (const rel of DOCUMENTS) {
    const full = resolve(root, rel);
    if (!existsSync(full)) continue;
    const src = readFileSync(full, 'utf8');
    if (!/<BackButton\b/.test(src)) {
      failures.push(
        `${rel} has no BackButton. Opened from a table, the officer must be able to return to ` +
          'that table - not only through the menu.',
      );
    }
  }

  const bare =
    /navigate\(\s*`\/(budget\/obligations|accounting\/(disbursements|general-transactions|journal-entries|liquidation))\/\$\{/;
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name)) files.push(full);
    }
  };
  walk(resolve(root, 'src/pages'));
  for (const full of files) {
    const name = full.slice(root.length + 1).split('\\').join('/');
    const src = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const line of src.split('\n')) {
      if (bare.test(line)) {
        failures.push(
          `${name} opens a document with a bare navigate(): ${line.trim().slice(0, 90)}. Use ` +
            'useOpenWithReturn (from a list) or keepReturn (from the document itself), so its Back ' +
            'button returns here.',
        );
      }
    }
  }

  if (failures.length === before) {
    console.log('navigation: every document has a way back to the table it came from');
  }
}

// --- 45. Budget reports print on A4, fitted, with the seal ----------------

/*
 * Patch 117: every Budget > Monitoring and Budget > Reports screen prints on
 * A4 fitted to the width of the sheet, with the municipal seal at the left of
 * its heading - and the two budget forms, the Allotment Release Order and the
 * Augmentation Form, on A4 with the seal centred above the letterhead. This
 * refuses a build in which one of them goes back to the ordinary page, which
 * cuts a wide table off at the paper's edge without a word.
 */
{
  const before = failures.length;
  const REPORTS = [
    'src/pages/budget/Registry.tsx',
    'src/pages/budget/Raao.tsx',
    'src/pages/budget/Reairr.tsx',
    'src/pages/reports/QuarterlyReceipts.tsx',
    'src/pages/reports/QuarterlyFinancialReport.tsx',
    'src/pages/reports/Sre.tsx',
  ];
  for (const rel of REPORTS) {
    const full = resolve(root, rel);
    if (existsSync(full) && !/printLayout="(portrait|landscape)"/.test(readFileSync(full, 'utf8'))) {
      failures.push(`${rel} no longer prints on A4 fitted to width with the seal (printLayout).`);
    }
  }
  const FORMS = ['src/pages/budget/AroPrint.tsx', 'src/pages/budget/AugmentationFormSheet.tsx'];
  for (const rel of FORMS) {
    const full = resolve(root, rel);
    if (!existsSync(full)) continue;
    const src = readFileSync(full, 'utf8');
    if (!/<FormPrintStyle orientation="portrait"/.test(src) || !/<Seal\b|\bseal\b/.test(src)) {
      failures.push(`${rel} no longer prints on A4 fitted to width with the seal above the letterhead.`);
    }
  }
  if (failures.length === before) {
    console.log('print: budget reports and forms print on A4, fitted, with the seal');
  }
}

// --- 46. The ordinance is a document: attached, printed, approved whole -----

/*
 * Patch 119: an ordinance is recorded first and its lines inside it. Three
 * things must stay true of it. The `ordinances` collection must be in the
 * rules and never deletable except by an admin - its lines are found by the
 * number it carries, so losing the record orphans them. The ordinance page
 * must print LBP Form No. 2 and offer the Supporting documents panel. And a
 * line typed inside an ordinance must carry `importReference`, or
 * approveOrdinanceUpload cannot find it and "Approve all" leaves it behind.
 */
{
  const before = failures.length;
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');
  const block = rules.match(/match \/ordinances\/\{[^}]+\}\s*\{([\s\S]*?)\n\s{4}\}/);
  if (!block) {
    failures.push('firestore.rules has no /ordinances block (patch 119).');
  } else {
    if (!/allow delete:\s*if signedIn\(\) && isAdmin\(\)/.test(block[1])) {
      failures.push('firestore.rules: an ordinance may be deleted by someone other than an admin.');
    }
    if (!/didNotChange\(\[[^\]]*'reference'[^\]]*\]\)/.test(block[1])) {
      failures.push('firestore.rules: an ordinance number may be changed after its lines were recorded under it.');
    }
  }
  const detail = resolve(root, 'src/pages/budget/OrdinanceDetail.tsx');
  if (existsSync(detail)) {
    const src = readFileSync(detail, 'utf8');
    if (!/buildLbpForm2\(/.test(src) || !/<LbpForm2Sheet\b/.test(src)) {
      failures.push('OrdinanceDetail.tsx no longer prints LBP Form No. 2.');
    }
    if (!/<AttachmentsPanel\b/.test(src)) {
      failures.push('OrdinanceDetail.tsx no longer offers the supporting documents panel.');
    }
    if (!/approveOrdinanceUpload\(/.test(src)) {
      failures.push('OrdinanceDetail.tsx no longer approves the ordinance whole.');
    }
  } else {
    failures.push('src/pages/budget/OrdinanceDetail.tsx is missing (patch 119).');
  }
  const form = resolve(root, 'src/pages/budget/Appropriations.tsx');
  if (existsSync(form)) {
    const src = readFileSync(form, 'utf8');
    if (!/importReference:\s*authorityReference\.trim\(\)\s*\|\|\s*null/.test(src)) {
      failures.push(
        'Appropriations.tsx: a line typed under an ordinance no longer carries importReference, so Approve all would leave it behind.',
      );
    }
  }
  if (failures.length === before) {
    console.log('ordinance: recorded, attached, printed on LBP Form No. 2, approved whole');
  }
}

// --- 47. What a voucher takes from a budget line, its cancellation gives back

/*
 * Patch 120: approving a voucher adds its share to each budget line's
 * `disbursed`. Cancelling or un-approving it gave the money back to the
 * obligation and to the fund summary - and not to the budget line, so the
 * registry showed more disbursed than obligated and an unpaid figure below
 * zero. The nightly verifier rebuilt `disbursed` and never compared it.
 *
 * Three things this refuses: a dv.ts whose reversal (applyDvConsumption) does
 * not write the budget line; a share allocation hand-rolled anywhere outside
 * lib/dvShares.ts, which is how approval and reversal come to differ by a
 * centavo; and a verifier that leaves `disbursed` off its comparison.
 */
{
  const before = failures.length;
  const dvTs = resolve(root, 'functions/src/accounting/dv.ts');
  if (existsSync(dvTs)) {
    const src = readFileSync(dvTs, 'utf8');
    const reversal = src.match(/function applyDvConsumption\([\s\S]*?\n\}/);
    if (!reversal || !/applyBudgetDelta\(/.test(reversal[0])) {
      failures.push(
        'functions/src/accounting/dv.ts: applyDvConsumption no longer gives the budget line back what the voucher took (patch 120).',
      );
    }
  }
  const HAND_ROLLED_SHARE = /Math\.round\(\s*\(\s*line\.amount\s*\/\s*\w+\s*\)\s*\*/;
  for (const rel of [
    'functions/src/accounting/dv.ts',
    'functions/src/admin/scheduled.ts',
    'functions/src/admin/budgetRebuild.ts',
  ]) {
    const full = resolve(root, rel);
    if (existsSync(full) && HAND_ROLLED_SHARE.test(readFileSync(full, 'utf8'))) {
      failures.push(`${rel} allocates a voucher over obligation lines by hand. Use allocateDvShares from lib/dvShares.ts.`);
    }
  }
  const sched = resolve(root, 'functions/src/admin/scheduled.ts');
  if (existsSync(sched)) {
    const src = readFileSync(sched, 'utf8');
    const checks = src.match(/const checks: Array<\[string, number, number\]> = \[([\s\S]*?)\];/);
    if (!checks || !/\['disbursed'/.test(checks[1])) {
      failures.push('functions/src/admin/scheduled.ts: the nightly verifier no longer compares `disbursed`.');
    }
  }
  if (failures.length === before) {
    console.log('vouchers: a cancelled voucher gives its budget line back, one allocation, verifier compares disbursed');
  }
}

// --- 42. A sub-tab strip never hides the strip above it --------------------

/*
 * ---------------------------------------------------------------------------
 * THE MAIN TABS COME WITH THE SUB-TABS
 * ---------------------------------------------------------------------------
 * Budget > Monitoring has two main tabs - the RAAO and the REAIRR - and the
 * RAAO has five sub-tabs of its own: Summary, PS, MOOE, CO, FE. Until patch
 * 111 the main strip was drawn by the Summary PAGE, so it was there on
 * Summary and gone on the other four. Accounting > Monitoring did the same
 * with Trust Accounts: there on the programmes, gone on the registry and the
 * utilization report. An officer one click in had lost the way back out.
 *
 * The fix is that the sub-tab component draws the main strip itself, so every
 * page that shows the sub-tabs shows both. This refuses a sub-tab component
 * (a *Tabs.tsx under src/pages) whose addresses sit inside a main strip in
 * layout/sections.ts and which does not draw a strip.
 */
{
  const sectionsFile = resolve(root, 'src/layout/sections.ts');
  if (existsSync(sectionsFile)) {
    const sectionsSrc = readFileSync(sectionsFile, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const owned = [...new Set([...sectionsSrc.matchAll(/'(\/[a-z0-9/-]+)'/g)].map((m) => m[1]))];
    const under = (path, to) => path === to || path.startsWith(`${to}/`);

    const files = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/Tabs\.tsx$/i.test(entry.name)) files.push(full);
      }
    };
    walk(resolve(root, 'src/pages'));

    let offenders = 0;
    for (const full of files) {
      const name = full.slice(root.length + 1).split('\\').join('/');
      const source = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (!/<Tabs\b/.test(source)) continue;
      const addresses = [...source.matchAll(/\bto:\s*'(\/[^']*)'/g)].map((m) => m[1]);
      const inside = addresses.filter((a) => owned.some((o) => under(a, o)));
      if (inside.length === 0) continue;
      if (/<(Grouped)?SectionTabs\b/.test(source)) continue;
      offenders += 1;
      failures.push(
        `${name}: draws sub-tabs for ${inside[0]}, which sits inside a main strip in ` +
          'layout/sections.ts, but does not draw that strip. On every sub-tab but the first the ' +
          'main tabs disappear. Render <SectionTabs tabs={...} /> above the <Tabs> here.',
      );
    }

    if (offenders === 0) {
      console.log('tabs: every sub-tab strip keeps the main strip above it');
    }
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('\nSecurity rule checks failed:\n');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nAll security rule checks passed.');
