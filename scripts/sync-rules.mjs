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
  { source: 'src/lib/sectors.ts', target: 'functions/src/lib/sectors.ts' },
  // `estimatedReceipts` joined when the financing side of the budget arrived.
  // Its duplicate-account rule is the reason: a repeated account in an upload
  // REPLACES rather than adds, so a server copy that had lost that check would
  // accept a file the browser refused and store the wrong estimate silently.
  { source: 'src/lib/estimatedReceipts.ts', target: 'functions/src/lib/estimatedReceipts.ts' },
  // `trustPrograms` is the Trust Fund's funding ceiling. It joined for the
  // same reason as the allotment rules: the browser tells an officer whether
  // a utilisation fits, and the engine decides. A server copy that had drifted
  // would wave through a commitment the screen had refused.
  { source: 'src/lib/trustPrograms.ts', target: 'functions/src/lib/trustPrograms.ts' },
  // `chartOfAccounts` derives every classification from the account code. The
  // browser shows the officer what a file will load as, and the engine writes
  // it; a drifted copy would preview one chart and store another.
  { source: 'src/lib/chartOfAccounts.ts', target: 'functions/src/lib/chartOfAccounts.ts' },
  // `jevNumbers` is one sentinel value and one function, and it is here for
  // the same reason as the rest: the browser writes a prepared entry carrying
  // the placeholder and the engine decides, at posting, whether a number still
  // has to be issued. If the two copies ever disagreed about what "no number
  // yet" looks like, entries would post into the General Ledger with the
  // placeholder printed in the JEV No. column of every line, and nothing
  // anywhere would refuse it.
  { source: 'src/lib/jevNumbers.ts', target: 'functions/src/lib/jevNumbers.ts' },
  // `jevSourceKinds` decides whether a posted entry's AMOUNT may be corrected:
  // an entry raised by a signed voucher carries that voucher's figure, and one
  // written in Accounting carries nobody's. The browser offers the field and
  // the engine refuses the write, so the two must agree about which is which.
  { source: 'src/lib/jevSourceKinds.ts', target: 'functions/src/lib/jevSourceKinds.ts' },
  // `treasuryEntry` joined in patch 85, when the Report of Checks Issued began
  // settling Accounts Payable one creditor at a time rather than in a lump.
  // The entry was written twice - once for a report prepared by hand and once
  // for one loaded from a bank file - and the entry a report posts IS the
  // Check Disbursements Journal. Two versions of it is two versions of that
  // journal, and nothing would have said which was right.
  { source: 'src/lib/treasuryEntry.ts', target: 'functions/src/lib/treasuryEntry.ts' },
  // `budgetPrograms` joined in patch 86. The ordinance importer and the Budget
  // Programmes screen both write a programme's record, and they have to land on
  // the SAME document id. If they disagreed, a programme added by hand and the
  // same programme arriving in an upload would become two records under one
  // code, and an appropriation would match whichever the picker happened to
  // show.
  { source: 'src/lib/budgetPrograms.ts', target: 'functions/src/lib/budgetPrograms.ts' },
  // `eCollections` joined in patch 91, with COA Circular 2021-014's three
  // reports. An e-collection is an ordinary collection carrying a kind, so the
  // RCD and the three eRCDs all draw on one pile of documents and this mapping
  // is what divides it. The browser decides what to OFFER and the engine
  // decides what to ACCEPT; a drifted copy would let a GCash receipt be
  // certified onto the Report of Collections and Deposits, and the report that
  // should have carried it would be short with nothing saying why.
  { source: 'src/lib/eCollections.ts', target: 'functions/src/lib/eCollections.ts' },
  // `treasurySources` says which register each treasury report covers. The
  // engine claims and releases those documents when a report is certified or
  // withdrawn; the screen reads one when an officer clicks a line of the
  // report. Two copies would not raise an error if they drifted - the screen
  // would simply read the wrong register and report the document "no longer in
  // CFMS", which is a sentence that means something serious and would be false.
  { source: 'src/lib/treasurySources.ts', target: 'functions/src/lib/treasurySources.ts' },
  // `budgetLines` says what an appropriation must carry to become authority.
  // It is here because the three places that had an opinion disagreed: the
  // upload and the recording form both understood a line appropriated BY
  // PROGRAMME, with no object code, and approval refused one outright - so a
  // by-programme line could be saved and then never approved, and the refusal
  // told the office to record it again, which produced another line it could
  // not approve either.
  { source: 'src/lib/budgetLines.ts', target: 'functions/src/lib/budgetLines.ts' },
  // `budgetActs` joined in patch 123: what finances each act of appropriation
  // and whether it is enough. The ordinance page says whether "Approve all"
  // will go through, and the engine decides; a drifted copy would offer an
  // approval the engine then refused, or refuse one the engine would take.
  { source: 'src/lib/budgetActs.ts', target: 'functions/src/lib/budgetActs.ts' },
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
