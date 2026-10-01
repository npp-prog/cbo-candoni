#!/usr/bin/env node
/**
 * Delete the eight renamed modules left behind by patch 54.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND NOT AN INSTRUCTION
 * ---------------------------------------------------------------------------
 * Patch 54 renamed eight arithmetic modules so their names would stop clashing
 * with the screens beside them - `scbaa.ts` next to `Scbaa.tsx` is one file
 * name on Windows, and the build there resolved the import to the wrong one.
 *
 * A patch zip can add a file and it can replace a file. It cannot delete one.
 * So after installing patch 54 BOTH names are on disk, the old pair still
 * clashes, and the old test file still runs - which is exactly what happened:
 * 43 test files instead of 35, 1,033 tests instead of 818, and the same eight
 * collisions reported by check-rules.
 *
 * The instruction for that was a single 600-character line to paste into
 * PowerShell, which is a poor thing to ask of anybody. This is the same work,
 * as one short command that says what it did.
 *
 *   node scripts/remove-legacy-modules.mjs
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES IT SAFE TO RUN
 * ---------------------------------------------------------------------------
 * It deletes nothing but the sixteen paths named below, and it deletes none of
 * them unless the file that REPLACED it is present and non-empty. So it cannot
 * run before patch 54 is installed and leave the repository short of a module,
 * and running it twice does nothing the second time.
 *
 * Deleting is permanent on Windows - Remove-Item and fs.rm do not use the
 * Recycle Bin - but every file it removes is in the patch 54 zip under its new
 * name, so nothing here is unrecoverable.
 */

import { existsSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** [the file to delete, the file that replaced it]. */
const RENAMED = [
  ['src/pages/budget/raao.ts', 'src/pages/budget/raaoReport.ts'],
  ['src/pages/budget/reairr.ts', 'src/pages/budget/reairrReport.ts'],
  ['src/pages/reports/scbaa.ts', 'src/pages/reports/scbaaReport.ts'],
  ['src/pages/reports/rptAbstract.ts', 'src/pages/reports/rptAbstractReport.ts'],
  ['src/pages/reports/quarterlyReceipts.ts', 'src/pages/reports/quarterlyReceiptsReport.ts'],
  ['src/pages/reports/budgetVsActual.ts', 'src/pages/reports/budgetVsActualReport.ts'],
  ['src/pages/treasury/unreleasedChecks.ts', 'src/pages/treasury/unreleasedChecksReport.ts'],
  ['src/pages/treasury/cashAdvanceBook.ts', 'src/pages/treasury/cashAdvanceBookReport.ts'],
];

/** The test files move with them, under the same rule. */
const PAIRS = RENAMED.flatMap(([oldPath, newPath]) => [
  [oldPath, newPath],
  [oldPath.replace(/\.ts$/, '.test.ts'), newPath.replace(/\.ts$/, '.test.ts')],
]);

const removed = [];
const absent = [];
const refused = [];

for (const [oldPath, newPath] of PAIRS) {
  const oldAbs = resolve(root, oldPath);
  const newAbs = resolve(root, newPath);

  if (!existsSync(oldAbs)) {
    absent.push(oldPath);
    continue;
  }

  // The replacement has to be there, and has to have something in it, before
  // the original is given up.
  if (!existsSync(newAbs) || statSync(newAbs).size === 0) {
    refused.push([oldPath, newPath]);
    continue;
  }

  rmSync(oldAbs);
  removed.push(oldPath);
}

if (refused.length > 0) {
  console.error('\nNothing was deleted. Patch 54 does not look installed yet:\n');
  for (const [oldPath, newPath] of refused) {
    console.error(`  - ${oldPath} is here, but ${newPath} that replaces it is not.`);
  }
  console.error('\nCopy the patch 54 files in first, then run this again.\n');
  process.exit(1);
}

if (removed.length === 0) {
  console.log(`Nothing to remove - all ${PAIRS.length} old files are already gone.`);
} else {
  console.log(`Removed ${removed.length} file${removed.length === 1 ? '' : 's'} left over from the rename:\n`);
  for (const p of removed) console.log(`  ${p}`);
  if (absent.length > 0) {
    console.log(`\n${absent.length} ${absent.length === 1 ? 'was' : 'were'} already gone.`);
  }
}

console.log('\nNow run:  node scripts/check-rules.mjs');
