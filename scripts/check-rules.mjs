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

import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('\nSecurity rule checks failed:\n');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nAll security rule checks passed.');
