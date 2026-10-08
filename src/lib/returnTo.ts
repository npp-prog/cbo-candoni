/**
 * Where a screen was opened from, carried in its address.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * A treasury report has one page, and it is reached from two offices.
 *
 * The Accountant opens it from Accounting > Treasury Reports, on the RCI tab,
 * to journalize it. The Treasurer opens it from the RCI register under
 * Treasury, to certify it. Both land on /treasury/reports/<id> - the same
 * address - and that page could only assume one of them. It assumed Treasury:
 * the breadcrumbs said Treasury > RCI, the menu lit Treasury, and there was no
 * button back. So the Accountant, having journalized a report, found
 * themselves in the Treasurer's part of the system with no way to the list
 * they came from except the browser's Back button - and on the "All reports"
 * tab rather than the RCI tab they had been working through.
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER, AND WHY IT IS IN THE ADDRESS
 * ---------------------------------------------------------------------------
 * The list that opens a report says where it is, in the report's address:
 *
 *     /treasury/reports/<id>?from=%2Faccounting%2Ftreasury-reports%3Ftab%3DRCI
 *
 * The page reads it back for its Back button, its breadcrumbs and the menu.
 *
 * In the ADDRESS rather than held in memory, because an address survives what
 * memory does not: a page refresh, a bookmark, the link pasted into a message
 * to a colleague, the printed form opened from the report and closed again.
 * Each of those would have quietly dropped the officer back into Treasury.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS CHECKED BEFORE IT IS USED
 * ---------------------------------------------------------------------------
 * Anything in an address can be typed by anyone. A Back button that went
 * wherever `from` said would go to "//somewhere-else.example" if somebody
 * built a link that said so. Only a path inside CFMS is accepted - a single
 * leading slash, no scheme, no host - and anything else is ignored, which
 * leaves the page on its ordinary default.
 */

/** The query parameter that carries the return path. */
export const RETURN_PARAM = 'from';

/** A return path longer than this is not one a CFMS screen produces. */
const MAX_LENGTH = 500;

/**
 * Whether a string is a path inside this application.
 *
 * One leading slash and not two (two is a host: "//evil.example"), no
 * backslash (which some browsers read as a slash), and no scheme anywhere in
 * the path segment ("/x/javascript:..."). Queries are allowed - that is how a
 * list's tab and filter come back - but only after the path.
 */
export function isInternalPath(value: string | null | undefined): value is string {
  if (!value || typeof value !== 'string') return false;
  if (value.length > MAX_LENGTH) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('\\')) return false;
  const path = value.split('?')[0].split('#')[0];
  if (/[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return true;
}

/**
 * The return path in a query string, or null when there is none or it is not
 * one CFMS would have written.
 */
export function returnPathFrom(search: string): string | null {
  const value = new URLSearchParams(search).get(RETURN_PARAM);
  return isInternalPath(value) ? value : null;
}

/** Just the path of a return path, without its query - what the menu matches on. */
export function returnPathname(search: string): string | null {
  const path = returnPathFrom(search);
  return path ? path.split('?')[0].split('#')[0] : null;
}

/**
 * An address that remembers where it was opened from.
 *
 * `from` is the full location of the screen doing the opening - its path AND
 * its query - so a list's tab and filter come back with it.
 */
export function withReturn(to: string, from: string | null | undefined): string {
  if (!isInternalPath(from)) return to;
  const separator = to.includes('?') ? '&' : '?';
  return `${to}${separator}${RETURN_PARAM}=${encodeURIComponent(from)}`;
}

/** The location of the current screen, as a return path. */
export function hereAsReturn(location: { pathname: string; search: string }): string {
  return `${location.pathname}${location.search}`;
}

/**
 * The screen the officer actually started from, following the chain.
 *
 * Returns nest: the Accounting list opens a report and says so; the report
 * opens its printed form and says where IT is - which is the report, still
 * carrying its own return path to the list. So the form's `from` is the
 * report, and the report's `from` is the list.
 *
 * The menu should light the place the officer started, not the stop in the
 * middle, so this follows the chain to its first link. Bounded, because an
 * address is typed by people and a loop in one must not hang the menu.
 */
export function originPathname(search: string, depth = 4): string | null {
  let path = returnPathFrom(search);
  if (!path) return null;
  for (let i = 0; i < depth; i += 1) {
    const q = path.indexOf('?');
    if (q < 0) break;
    const inner = returnPathFrom(path.slice(q));
    if (!inner) break;
    path = inner;
  }
  return path.split('?')[0].split('#')[0];
}

/*
 * ---------------------------------------------------------------------------
 * BACK TO THE TABLE, FROM EVERY DOCUMENT (patch 114)
 * ---------------------------------------------------------------------------
 * Patch 109 gave the treasury report a way back. The Obligation, the
 * Disbursement Voucher, the journal entry and the liquidation report had none:
 * opened from their list, from the Index of Payment, from a voucher's link to
 * its OBR, the officer could leave only by the menu or the browser's Back
 * button. So every one of them now has a button that says where it goes.
 *
 * The button goes to `from` when the address carries one - the very table the
 * officer clicked, with its tab - and otherwise to the document's own list.
 * It says which, by name, because "Back" on its own does not answer the
 * question that made it necessary.
 */

/** The lists and documents a document can be opened from, by the name the button uses. */
const PLACES: Array<[RegExp, string]> = [
  [/^\/$/, 'Dashboard'],
  [/^\/budget\/obligations$/, 'Obligations'],
  [/^\/budget\/obligations\/[^/]+$/, 'the obligation'],
  [/^\/accounting\/disbursements$/, 'Disbursement Vouchers'],
  [/^\/accounting\/disbursements\/[^/]+$/, 'the voucher'],
  [/^\/accounting\/index-of-payments$/, 'Index of Payment'],
  [/^\/accounting\/general-transactions$/, 'General Transactions'],
  [/^\/accounting\/journal-entries$/, 'Journal Entries Register'],
  [/^\/accounting\/(general-transactions|journal-entries|jev)\/[^/]+$/, 'the journal entry'],
  [/^\/accounting\/liquidation$/, 'Liquidation Reports'],
  [/^\/accounting\/liquidation\/[^/]+$/, 'the liquidation report'],
  [/^\/treasury\/disbursements$/, 'Disbursements'],
  [/^\/treasury\/checks(\/[^/]+)?$/, 'Checks'],
  [/^\/treasury\/ada(\/[^/]+)?$/, 'ADA'],
  [/^\/reports\/registers$/, 'Registers'],
  [/^\/reports\/general-ledger$/, 'General Ledger'],
  [/^\/reports\/subsidiary-ledger$/, 'Subsidiary Ledger'],
  [/^\/reports\/journals$/, 'Journals'],
  [/^\/documents$/, 'Documents'],
  [/^\/audit-trail$/, 'Audit Trail'],
];

/** What a back button names a path by. */
export function placeName(path: string): string {
  const bare = path.split('?')[0].split('#')[0];
  return PLACES.find(([pattern]) => pattern.test(bare))?.[1] ?? 'where you were';
}

/**
 * Where a document's back button goes, and what it says.
 *
 * `fallback` is the document's own list, used when the address does not say
 * where it was opened from - a bookmark, a link typed or pasted.
 */
export function backTarget(
  search: string,
  fallback: { to: string; label: string },
): { to: string; label: string } {
  const from = returnPathFrom(search);
  if (!from) return fallback;
  const bare = from.split('?')[0].split('#')[0];
  // Back to the document's own list by its proper name, even when that list
  // is not in the table above (it always should be).
  if (bare === fallback.to.split('?')[0]) return { to: from, label: fallback.label };
  return { to: from, label: placeName(from) };
}
