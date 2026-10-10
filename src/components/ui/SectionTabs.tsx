import { Link, useLocation } from 'react-router-dom';

/*
 * ---------------------------------------------------------------------------
 * ONE TAB STYLE, AND ONE SUB-TAB STYLE
 * ---------------------------------------------------------------------------
 * There were three, close enough to look like mistakes rather than choices: a
 * section strip, the top row of a grouped strip, and the in-page tabs on a
 * voucher all drew a tab slightly differently - a different weight here, four
 * more pixels of padding there. Moving between two screens, an officer saw the
 * same control change shape for no reason.
 *
 * TOP_TAB is what a tab looks like, everywhere. SUB_TAB is what a tab looks
 * like when it sits UNDER one - lighter, and a filled pill rather than an
 * underline, so the two rows of a grouped strip cannot be read as one row.
 *
 * The minimum width stays. A tab sized only by its own label leaves "Schedule"
 * half the width of "Sources of Financing" beside it, and the two stop reading
 * as one choice with two answers.
 */
export const TOP_TAB =
  'inline-flex items-center justify-center whitespace-nowrap border-b-2 -mb-px ' +
  'min-w-[7rem] px-4 py-2.5 text-sm font-semibold transition-colors';

export const TOP_TAB_ON = 'border-brand-600 text-brand-700';
export const TOP_TAB_OFF =
  'border-transparent text-slate-500 hover:border-slate-300 hover:text-navy-800';

export const SUB_TAB =
  'inline-flex items-center justify-center whitespace-nowrap rounded ' +
  'min-w-[7rem] px-3 py-1.5 text-sm transition-colors';

export const SUB_TAB_ON = 'bg-brand-50 font-medium text-brand-700';
export const SUB_TAB_OFF = 'text-slate-500 hover:bg-slate-50 hover:text-navy-800';


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
/**
 * A tab, and any further screens that belong to it.
 *
 * `includes` is for a tab whose own screens live at addresses that do not
 * start with its address. Trust Accounts is at /accounting/trust-programs, and
 * its Registry of Special Trust Fund at /accounting/trust-registry - one
 * subject, three screens, three addresses that predate the strip. Without this
 * the strip could not tell that the officer on the registry is still inside
 * Trust Accounts, and lit nothing.
 */
export interface StripTab {
  label: string;
  to: string;
  includes?: readonly string[];
}

/** Whether an address is this one or a screen beneath it. */
const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/**
 * The tab holding the current screen: its `to`, or null.
 *
 * Exactly one tab is highlighted: the one whose address is the LONGEST match
 * for where we are. A plain "starts with" test would light up Collections as
 * well as Deposits, because /treasury/collections/deposits begins with
 * /treasury/collections - and two lit tabs tell the reader nothing.
 *
 * Shared with the sidebar (layout/sections.ts), which asks the same question
 * one level up. Two copies of this were how the sidebar and the strip came to
 * disagree about where the officer was standing.
 */
export function currentTab(tabs: readonly StripTab[], pathname: string): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const tab of tabs) {
    for (const address of [tab.to, ...(tab.includes ?? [])]) {
      if (!under(pathname, address)) continue;
      if (address.length > bestLength) {
        best = tab.to;
        bestLength = address.length;
      }
    }
  }
  return best;
}

export function SectionTabs({ tabs }: { tabs: readonly StripTab[] }) {
  const { pathname } = useLocation();
  const current = currentTab(tabs, pathname);

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
              className={`${TOP_TAB} ${active ? TOP_TAB_ON : TOP_TAB_OFF}`}
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
  groups: Array<{
    group: string;
    tabs: Array<{ label: string; to: string; children?: ReadonlyArray<{ label: string; to: string }> }>;
  }>;
}) {
  const { pathname } = useLocation();

  /*
   * Longest match wins, across every tab of every group - the same rule
   * SectionTabs uses, and for the same reason: /treasury/collections is a
   * prefix of /treasury/collections/deposits, and the more specific one is the
   * true answer. Without it, standing on Deposits would light Transactions by
   * way of Collections, which happens to be right, and standing on the RCD
   * would light it too, which is not.
   *
   * Patch 144: a tab may carry children (a third row). A child's address
   * lights its parent tab as well as itself.
   */
  let best: { group: string; to: string; parent: string } | null = null;
  const consider = (group: string, to: string, parent: string) => {
    if (pathname !== to && !pathname.startsWith(`${to}/`)) return;
    if (best === null || to.length > best.to.length) best = { group, to, parent };
  };
  for (const g of groups) {
    for (const tab of g.tabs) {
      consider(g.group, tab.to, tab.to);
      for (const c of tab.children ?? []) consider(g.group, c.to, tab.to);
    }
  }
  const found = best as { group: string; to: string; parent: string } | null;

  /* Nothing matched - a screen reached by an address no tab carries. Show the
     first group rather than an empty strip. */
  const activeGroup = found?.group ?? groups[0]?.group;
  const shown = groups.find((g) => g.group === activeGroup) ?? groups[0];
  const activeTab = shown?.tabs.find((t) => t.to === found?.parent);

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
              className={`${TOP_TAB} ${active ? TOP_TAB_ON : TOP_TAB_OFF}`}
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
          const active = tab.to === found?.parent;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? 'page' : undefined}
              className={`${SUB_TAB} ${active ? SUB_TAB_ON : SUB_TAB_OFF}`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {/* Patch 144: the active tab's own screens, a third and lightest row. */}
      {activeTab?.children && activeTab.children.length > 0 && (
        <nav
          className="mt-2 flex flex-wrap border-b border-slate-200 px-2"
          style={{ columnGap: '0.5rem' }}
          aria-label={activeTab.label}
        >
          {activeTab.children.map((c) => {
            const on = c.to === found?.to;
            return (
              <Link
                key={c.to}
                to={c.to}
                aria-current={on ? 'page' : undefined}
                /* Patch 156: a minimum width, so "RCI" is not a sliver beside "Claim Sheet". */
                className={`-mb-px inline-flex min-w-[6rem] justify-center whitespace-nowrap border-b-2 px-3 py-1.5 text-sm ${
                  on
                    ? 'border-brand-600 font-medium text-brand-700'
                    : 'border-transparent text-slate-500 hover:text-navy-800'
                }`}
              >
                {c.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
