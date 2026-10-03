import type { Role } from '@/types/system';

/**
 * Payee rules that are needed in more than one place, kept out of the screens.
 *
 * ---------------------------------------------------------------------------
 * WHY A PAYEE MAY BE ADDED IN THE MIDDLE OF A DOCUMENT
 * ---------------------------------------------------------------------------
 * The security rules have allowed it from the start, and say why:
 *
 *     "Encoders need to add a supplier mid-voucher; blocking that guarantees
 *      duplicate payee records created under vague names."
 *
 * Sending a clerk away to Master Data in the middle of an Obligation Request
 * means losing the document they were encoding. What they do instead is finish
 * the OBR under whatever name will pass - "ABC", "abc trading", "ABC Trdg" -
 * and the duplicates arrive anyway, only now attached to posted transactions
 * where they cannot be merged.
 *
 * So the interruption is the thing to remove, and the duplicate is the thing
 * to catch. That is what this module is for.
 */

/**
 * Typed as `Role[]` on purpose: a role misspelt here is a button that appears
 * and then fails when it is pressed, and TypeScript catches that at build time
 * rather than in front of a clerk. check-rules compares the list against
 * firestore.rules, which is the other half of the same guard.
 */
export const PAYEE_CREATOR_ROLES: readonly Role[] = [
  // Master data writers.
  'SUPER_ADMIN',
  'MUNICIPAL_ACCOUNTANT',
  'BUDGET_OFFICER',
  'MUNICIPAL_TREASURER',
  // The encoders, who meet a new supplier before anybody else does.
  'ACCOUNTING_ENCODER',
  'TREASURY_STAFF',
  'BUDGET_STAFF',
];

export interface PayeeLike {
  id: string;
  name: string;
  tin?: string;
  payeeType?: string;
}

/**
 * Case, punctuation and spacing removed - nothing else.
 *
 * The temptation is to strip "Inc.", "Corp." and "Trading" as well, and it is
 * the wrong instinct: "Candoni Agri" and "Candoni Agri Corporation" can be two
 * different entities with two different TINs, and a match that merges them is
 * worse than a duplicate, because one supplier would be paid under another's
 * record. This catches what is actually mistyped - capitals, a full stop, a
 * stray double space - and leaves judgement to the person.
 */
export function normalisePayeeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"()\-/&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Digits only, so "123-456-789-000" and "123456789000" are one TIN. */
export function normaliseTin(tin: string): string {
  return tin.replace(/\D/g, '');
}

/**
 * Payees already on file that this one may be a second copy of.
 *
 * A TIN match comes first and is close to conclusive: two records with one TIN
 * are one taxpayer whatever they are called. A name match is a strong hint and
 * nothing more.
 *
 * This NEVER blocks. It is shown to the person entering the payee, who knows
 * whether the two are the same supplier, and who is the only one who can know.
 */
export function findPayeeDuplicates(
  input: { name: string; tin?: string },
  payees: PayeeLike[],
): Array<{ payee: PayeeLike; matchedOn: 'TIN' | 'NAME' }> {
  const name = normalisePayeeName(input.name);
  const tin = normaliseTin(input.tin ?? '');

  const matches: Array<{ payee: PayeeLike; matchedOn: 'TIN' | 'NAME' }> = [];
  const seen = new Set<string>();

  if (tin.length > 0) {
    for (const p of payees) {
      if (normaliseTin(p.tin ?? '') === tin) {
        matches.push({ payee: p, matchedOn: 'TIN' });
        seen.add(p.id);
      }
    }
  }

  if (name.length > 0) {
    for (const p of payees) {
      if (seen.has(p.id)) continue;
      if (normalisePayeeName(p.name) === name) {
        matches.push({ payee: p, matchedOn: 'NAME' });
        seen.add(p.id);
      }
    }
  }

  return matches;
}

/** What is missing before a payee can be saved, in the words of the labels. */
export function missingPayeeFields(input: { name: string; payeeType: string }): string[] {
  const missing: string[] = [];
  if (!input.name.trim()) missing.push('Name');
  if (!input.payeeType) missing.push('Type');
  return missing;
}
