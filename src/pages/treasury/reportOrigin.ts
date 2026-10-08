/**
 * What to call the place a treasury report was opened from.
 *
 * The return path says WHERE; this says what to print on the Back button and
 * in the breadcrumbs so the officer recognises it. A button reading "Back"
 * answers nothing - the whole complaint was not knowing where one would land.
 */

export interface ReportOrigin {
  /** The menu section, for the first breadcrumb. */
  section: string;
  /** The screen, for the second breadcrumb and the Back button. */
  label: string;
  /** Where Back goes - the exact address, tab and filter included. */
  to: string;
}

/**
 * The screens that open treasury reports and are not the Treasury register.
 *
 * One entry today. It is a list rather than an `if` because the next screen
 * that opens a report - a dashboard tile, a search result - should be one line
 * here, not another branch in the report page.
 */
const KNOWN: Array<{ prefix: string; section: string; label: string }> = [
  { prefix: '/accounting/treasury-reports', section: 'Accounting', label: 'Treasury reports' },
];

/**
 * The origin to show for a report, given the path it carried back.
 *
 * Without one - a report reached from a check's panel, a notification, a link
 * someone typed - the page falls back to the Treasury register for its kind,
 * which is what it always assumed.
 */
export function reportOrigin(returnPath: string | null, fallback: ReportOrigin): ReportOrigin {
  if (!returnPath) return fallback;

  const pathname = returnPath.split('?')[0];
  const known = KNOWN.find((k) => pathname === k.prefix || pathname.startsWith(`${k.prefix}/`));
  if (known) return { section: known.section, label: known.label, to: returnPath };

  /*
   * Another Treasury screen - the register for this kind, or a different
   * section of its strip. The words are the register's; the destination is
   * exactly where the officer was.
   */
  return { ...fallback, to: returnPath };
}

/**
 * Where closing a printed form goes, and what the button calls it.
 *
 * Opened from the report's own page, back is that page - which still carries
 * its own return path to the list. Opened straight from a list (View report),
 * back is the list. Opened from nowhere in particular, back is the report.
 *
 * A pure function so the three cases can be tested without drawing a screen;
 * FormBackButton only renders what this decides.
 */
export function formBackTarget(
  reportId: string,
  returnPath: string | null,
  fallback: Omit<ReportOrigin, 'to'>,
): { to: string; label: string } {
  const reportPage = `/treasury/reports/${reportId}`;
  if (!returnPath) return { to: reportPage, label: 'the report' };

  const pathname = returnPath.split('?')[0];
  if (pathname === reportPage) return { to: returnPath, label: 'the report' };

  const origin = reportOrigin(returnPath, { ...fallback, to: returnPath });
  return { to: origin.to, label: origin.label };
}
