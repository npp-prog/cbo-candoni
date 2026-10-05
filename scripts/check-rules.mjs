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

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('\nSecurity rule checks failed:\n');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nAll security rule checks passed.');
