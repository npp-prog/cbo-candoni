#!/usr/bin/env node
/**
 * Delete the files behind three screens that were retired in patch 61.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * A patch zip can add a file and replace a file. It cannot delete one. So
 * after installing patch 61 the retired screens are still on disk, and they
 * import things that patch 61 took out of the shared modules:
 *
 *   AugmentationFormPage.tsx   imports augmentationForm.ts, which goes with it
 *   AugmentationAuthority.tsx  imports augmentationAuthorityKey and
 *                              checkAugmentationAuthority from accounting-rules
 *   StatutoryLimits.tsx        imports statutoryLimits.ts and statutoryIncome.ts
 *
 * Nothing routes to any of the three pages any more, but TypeScript still
 * compiles every file under src. So leaving them is not dead weight - it is a
 * build that fails with errors about things that no longer exist, which is
 * a confusing way to find out a deletion was missed.
 *
 *   node scripts/remove-retired-screens.mjs
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES IT SAFE TO RUN
 * ---------------------------------------------------------------------------
 * It deletes nothing but the nine paths named below, and it refuses to delete
 * any of them unless patch 61 is actually installed - which it tests by
 * looking for the menu entries those screens had. So running it before the
 * patch does nothing and says so, and running it twice does nothing the
 * second time.
 *
 * Deleting is permanent on Windows - no Recycle Bin - but every file it
 * removes is one the application no longer refers to, and all of them are in
 * the patch 59 zip if they are ever wanted back.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RETIRED = [
  // The Augmentation Form (LBE 2) screen and the module behind it. An
  // augmentation is recorded on the Appropriation screen; this was a second
  // door into the same room.
  'src/pages/budget/AugmentationFormPage.tsx',
  'src/pages/budget/augmentationForm.ts',
  'src/pages/budget/augmentationForm.test.ts',
  // The Augmentation Authority screen and the ordinance gate it fed.
  'src/pages/budget/AugmentationAuthority.tsx',
  // The Statutory Limits screen and the two modules only it used.
  'src/pages/budget/StatutoryLimits.tsx',
  'src/lib/statutoryLimits.ts',
  'src/lib/statutoryLimits.test.ts',
  'src/lib/statutoryIncome.ts',
  'src/lib/statutoryIncome.test.ts',
];

/* Patch 61 is installed when the menu offers none of the three screens. */
const navigation = existsSync(resolve(root, 'src/layout/navigation.ts'))
  ? readFileSync(resolve(root, 'src/layout/navigation.ts'), 'utf8')
  : '';

const patchInstalled =
  navigation.length > 0 &&
  !navigation.includes('/budget/augmentation-form') &&
  !navigation.includes('/budget/augmentation-authority') &&
  !navigation.includes('/budget/statutory-limits');

if (!patchInstalled) {
  console.error('\nNothing was deleted. Patch 61 does not look installed yet.\n');
  console.error('  src/layout/navigation.ts still offers the screens this would remove.');
  console.error('\nCopy the patch 61 files in first, then run this again.\n');
  process.exit(1);
}

const removed = [];
const absent = [];

for (const path of RETIRED) {
  const abs = resolve(root, path);
  if (!existsSync(abs)) {
    absent.push(path);
    continue;
  }
  rmSync(abs);
  removed.push(path);
}

if (removed.length === 0) {
  console.log(`Nothing to remove - all ${RETIRED.length} retired files are already gone.`);
} else {
  console.log(`Removed ${removed.length} retired file${removed.length === 1 ? '' : 's'}:\n`);
  for (const p of removed) console.log(`  ${p}`);
  if (absent.length > 0) {
    console.log(`\n${absent.length} ${absent.length === 1 ? 'was' : 'were'} already gone.`);
  }
}

console.log('\nNow run:  npm run build');
