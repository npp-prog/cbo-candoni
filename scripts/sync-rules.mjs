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

/**
 * Every file the browser and the engine must agree about, letter for letter.
 *
 * `accounting-rules` came first and is the reason this script exists.
 * `serials` joined it when accountable forms arrived: the browser shows an
 * officer what their ending balance will be, the engine decides whether the
 * report may be filed, and a difference of one serial between the two copies
 * would be a custody finding nobody could explain.
 */
const PAIRS = [
  { source: 'src/lib/accounting-rules.ts', target: 'functions/src/lib/rules.ts' },
  { source: 'src/lib/serials.ts', target: 'functions/src/lib/serials.ts' },
  { source: 'src/lib/clearing.ts', target: 'functions/src/lib/clearing.ts' },
];

const bannerFor = (sourcePath) => `// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from ${sourcePath} by scripts/sync-rules.mjs.
// Edit the canonical file and run \`npm run functions:build\` (or \`npm --prefix
// functions run sync:rules\`) to regenerate. CI fails if the two diverge.
// =============================================================================
`;

const checkOnly = process.argv.includes('--check');

for (const pair of PAIRS) {
  const source = resolve(root, pair.source);
  const target = resolve(root, pair.target);

  if (!existsSync(source)) {
    console.error(`sync-rules: canonical file not found at ${source}`);
    process.exit(1);
  }

  const expected = bannerFor(pair.source) + readFileSync(source, 'utf8');

  if (checkOnly) {
    if (!existsSync(target)) {
      console.error(`sync-rules: ${pair.target} is missing. Run \`npm run functions:build\`.`);
      process.exit(1);
    }
    if (readFileSync(target, 'utf8') !== expected) {
      console.error(
        `sync-rules: ${pair.target} has drifted from ${pair.source}.\n` +
          'The browser and the accounting engine would disagree about the invariants.\n' +
          'Run `npm --prefix functions run sync:rules` and commit the result.',
      );
      process.exit(1);
    }
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected, 'utf8');
  console.log(`sync-rules: wrote ${target}`);
}

if (checkOnly) {
  console.log('sync-rules: shared invariants are in sync.');
}
