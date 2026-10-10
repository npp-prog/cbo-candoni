// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/fiscalYears.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
/**
 * Patch 171 - THE FISCAL YEARS CFMS OFFERS.
 *
 * CFMS is implemented from FY 2027. The year before it, 2026, stays in the
 * list because the 2027 statements print it as their comparative column (set
 * up on Accounting > Setup). Nothing earlier is offered.
 *
 * Later years are not invented from the calendar any more: the administrator
 * adds the next year on Administration > Accounting Periods when the office is
 * ready to work in it (the addFiscalYear callable writes fiscalYears/{year}).
 * One year at a time, so the list never has a gap.
 *
 * Shared by the browser and the engine (scripts/sync-rules).
 */

/** The first year of CFMS. */
export const CFMS_START_YEAR = 2027;

/** The earliest year in the list: the comparative year of the first one. */
export const FIRST_FISCAL_YEAR = CFMS_START_YEAR - 1;

/** The years always offered, before any is added. */
export const BASE_FISCAL_YEARS = [FIRST_FISCAL_YEAR, CFMS_START_YEAR];

/** Every year offered, newest first: the base years and those added. */
export function fiscalYearList(added: number[]): number[] {
  const all = new Set<number>(BASE_FISCAL_YEARS);
  for (const y of added) {
    if (Number.isInteger(y) && y >= FIRST_FISCAL_YEAR) all.add(y);
  }
  return [...all].sort((a, b) => b - a);
}

/** The one year that may be added next: the year after the latest. */
export function nextFiscalYear(added: number[]): number {
  return fiscalYearList(added)[0] + 1;
}

/**
 * The year to fall back to when the one selected is not offered (a year from
 * before CFMS, kept in the browser from an earlier visit): the latest offered
 * year not after the calendar year, else the earliest.
 */
export function nearestFiscalYear(list: number[], calendarYear: number): number {
  const notAfter = list.filter((y) => y <= calendarYear);
  return notAfter.length ? Math.max(...notAfter) : Math.min(...list);
}
