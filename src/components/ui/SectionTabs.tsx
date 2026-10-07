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
 *
 * ---------------------------------------------------------------------------
 * WHY IT LOOKS LIKE THE TABS AND NOT LIKE BUTTONS
 * ---------------------------------------------------------------------------
 * It used to be a row of rounded chips, with the current one filled in solid
 * brand blue. That reads as a row of BUTTONS - things that do something when
 * pressed - sitting directly under a page heading that also has buttons in it.
 * The officer could not tell from looking which of the two rows acted on the
 * page and which moved between pages, and the filled chip looked like the
 * primary action rather than like where they already were.
 *
 * CFMS already had an answer: the underlined tab bar used on the voucher, the
 * treasury report, the trust accounts and half a dozen others. This is that
 * bar, drawn with links. Two things that do the same job now look the same,
 * and nothing on a Treasury page looks like a button unless it is one.
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
    <div className="mb-4 border-b border-slate-200 no-print">
      {/*
        `flex-wrap` rather than the horizontal scroll the Tabs component uses.
        These strips are long - Collections and Deposits runs to nine - and a
        strip that scrolls hides the tabs at the end of it from anybody who does
        not think to drag. A second row is plainer.
      */}
      <nav className="-mb-px flex flex-wrap gap-x-1" aria-label="Section">
        {tabs.map((tab) => {
          const active = tab.to === current;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? 'page' : undefined}
              /* The same minimum as Tabs - see the note there. */
              className={`inline-flex items-center justify-center whitespace-nowrap border-b-2 min-w-[7rem] px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-navy-800'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * A section strip in two levels: the group, then its tabs.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND LEVEL RATHER THAN A LONGER ROW
 * ---------------------------------------------------------------------------
 * Collections and Deposits reached twelve tabs on two wrapped rows, and at
 * that length a strip stops being a map. Twelve things in a row all look
 * equally likely, so finding one meant reading the whole strip - which is the
 * failure the sidebar had before patch 94, moved one level down.
 *
 * The group holding the current screen is the one whose tabs are shown. There
 * is no state: the address decides, so a tab can be linked to and a reload
 * lands where it left off.
 *
 * Both rows are LINKS. Clicking a group goes to its first tab rather than
 * merely revealing the row - a control that only reveals leaves the reader
 * looking at a list and still one click from anywhere.
 */
export function GroupedSectionTabs({
  groups,
}: {
  groups: Array<{ group: string; tabs: Array<{ label: string; to: string }> }>;
}) {
  const { pathname } = useLocation();

  /*
   * Longest match wins, across every tab of every group - the same rule
   * SectionTabs uses, and for the same reason: /treasury/collections is a
   * prefix of /treasury/collections/deposits, and the more specific one is the
   * true answer. Without it, standing on Deposits would light Transactions by
   * way of Collections, which happens to be right, and standing on the RCD
   * would light it too, which is not.
   */
  let best: { group: string; to: string } | null = null;
  for (const g of groups) {
    for (const tab of g.tabs) {
      if (pathname !== tab.to && !pathname.startsWith(`${tab.to}/`)) continue;
      if (best === null || tab.to.length > best.to.length) best = { group: g.group, to: tab.to };
    }
  }

  /* Nothing matched - a screen reached by an address no tab carries. Show the
     first group rather than an empty strip. */
  const activeGroup = best?.group ?? groups[0]?.group;
  const shown = groups.find((g) => g.group === activeGroup) ?? groups[0];

  return (
    <div className="mb-4 no-print">
      <nav className="flex flex-wrap gap-1 border-b border-slate-200 pb-0" aria-label="Section">
        {groups.map((g) => {
          const active = g.group === activeGroup;
          return (
            <Link
              key={g.group}
              to={g.tabs[0]?.to ?? '#'}
              aria-current={active ? 'true' : undefined}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${
                active
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-navy-800'
              }`}
            >
              {g.group}
            </Link>
          );
        })}
      </nav>

      {/* The chosen group's tabs. Lighter than the groups above them, so the
          two rows cannot be mistaken for one. */}
      <nav className="flex flex-wrap gap-x-1 px-1 pt-1" aria-label={shown?.group}>
        {(shown?.tabs ?? []).map((tab) => {
          const active = tab.to === best?.to;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? 'page' : undefined}
              className={`whitespace-nowrap rounded px-3 py-1.5 text-sm transition-colors ${
                active
                  ? 'bg-brand-50 font-medium text-brand-700'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-navy-800'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
