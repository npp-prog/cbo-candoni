#!/usr/bin/env node
/**
 * Keeps the accounting invariants identical on both sides of the wire.
 *
 * `src/lib/accounting-rules.ts` is the canonical copy, used by the React app to
 * give a user immediate feedback. `functions/src/lib/rules.ts` is the copy the
 * Cloud Functions actually decide with. They must not drift: if the browser and
 * the server disagree about whether an obligation fits inside its allotment,
 * users learn to distrust the system, and worse, a real violation could be
 * waved through by a permissive server copy.
 *
 * Firebase deploys only the `functions` directory, so a shared import is not
 * available. This script copies the file and CI runs it with `--check` to fail
 * the build if the two have diverged.
 *
 *   node scripts/sync-rules.mjs          copy canonical -> functions
 *   node scripts/sync-rules.mjs --check  verify they match, exit 1 if not
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src/lib/accounting-rules.ts');
const target = resolve(root, 'functions/src/lib/rules.ts');

const BANNER = `// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/accounting-rules.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run \`npm run functions:build\` (or \`npm --prefix
// functions run sync:rules\`) to regenerate. CI fails if the two diverge.
// =============================================================================
`;

const checkOnly = process.argv.includes('--check');

if (!existsSync(source)) {
  console.error(`sync-rules: canonical file not found at ${source}`);
  process.exit(1);
}

const body = readFileSync(source, 'utf8');
const expected = BANNER + body;

if (checkOnly) {
  if (!existsSync(target)) {
    console.error('sync-rules: functions/src/lib/rules.ts is missing. Run `npm run functions:build`.');
    process.exit(1);
  }
  const actual = readFileSync(target, 'utf8');
  if (actual !== expected) {
    console.error(
      'sync-rules: functions/src/lib/rules.ts has drifted from src/lib/accounting-rules.ts.\n' +
        'The browser and the accounting engine would disagree about the invariants.\n' +
        'Run `npm --prefix functions run sync:rules` and commit the result.',
    );
    process.exit(1);
  }
  console.log('sync-rules: accounting invariants are in sync.');
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, expected, 'utf8');
console.log(`sync-rules: wrote ${target}`);
