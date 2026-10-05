// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/budgetPrograms.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
/**
 * How a budget programme's record is named.
 *
 * ---------------------------------------------------------------------------
 * WHY THE YEAR IS IN THE DOCUMENT ID
 * ---------------------------------------------------------------------------
 * A programme belongs to one annual budget. The same code appears again next
 * year as a different record - possibly renamed, possibly to a different
 * office - because next year's ordinance is a different authority.
 *
 * The ordinance importer writes these records as it encounters them, and it
 * writes them at a KNOWN id rather than an auto-generated one so that loading
 * the same ordinance twice updates the programme instead of creating a second
 * copy of it. While that id was the code alone, uploading the FY2027 ordinance
 * silently overwrote the FY2026 programme of the same code - the name changed
 * underneath last year's appropriations and nothing anywhere said so.
 *
 * Putting the year in the id is what makes the two separate records, and it is
 * what makes "load the ordinance twice" still safe within a year.
 *
 * Vendored into the engine, because the importer and the Budget Programmes
 * screen both write these records and they must land on the same id. If they
 * disagreed, a programme added by hand and the same programme arriving in an
 * upload would become two records with one code, and the appropriations would
 * match whichever the picker happened to show.
 *
 * It imports nothing, which is the condition of being vendored.
 */

/**
 * A code reduced to what is safe in a Firestore document id.
 *
 * Firestore forbids `/` outright and dislikes the rest; a programme code from
 * an annex can carry dots, dashes and spaces. Lowercased so that "8711a" and
 * "8711A" cannot become two programmes - a difference in case is a typing
 * accident, never a different programme.
 */
export function programCodeSlug(code: string): string {
  return String(code ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `2026__8711`. The year first, so a listing of the collection reads by year. */
export function programDocId(fiscalYear: number, code: string): string {
  return `${fiscalYear}__${programCodeSlug(code)}`;
}
