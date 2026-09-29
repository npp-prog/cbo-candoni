import { Link, useLocation } from 'react-router-dom';

/**
 * Tabs within one area of work.
 *
 * The sidebar names the four books the Treasurer's office keeps - checks, ADA,
 * collections and deposits, payroll - and everything drawn from one of them
 * lives inside it rather than beside it. The Report of Checks Issued belongs
 * with the checks; listing it in the sidebar as a peer of "Checks" lengthens
 * the menu and separates a document from the thing it summarises.
 *
 * The same reasoning brought the ADA number control and the primary reports in
 * here: each is the register it sits on, read a different way.
 *
 * Rendered as links rather than local state so that a report can be opened
 * directly, bookmarked, and linked to from a notification.
 */
export function SectionTabs({
  tabs,
}: {
  tabs: Array<{ label: string; to: string }>;
}) {
  const { pathname } = useLocation();

  // Exactly one tab is highlighted: the one whose address is the longest match
  // for where we are. A plain "starts with" test would light up Collections as
  // well as Deposits, because /treasury/collections/deposits begins with
  // /treasury/collections - and two lit tabs tell the reader nothing.
  const current = tabs.reduce<string | null>((best, tab) => {
    const matches = pathname === tab.to || pathname.startsWith(`${tab.to}/`);
    if (!matches) return best;
    return best === null || tab.to.length > best.length ? tab.to : best;
  }, null);

  return (
    <nav className="mb-4 flex flex-wrap gap-1.5 no-print">
      {tabs.map((tab) => {
        const active = tab.to === current;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
              active
                ? 'bg-brand-600 text-white'
                : 'bg-white text-navy-700 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
