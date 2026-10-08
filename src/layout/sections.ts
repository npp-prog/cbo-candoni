/**
 * The tab strips that replaced the folded sidebar headings.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE LIVE IN ONE FILE
 * ---------------------------------------------------------------------------
 * A strip is only honest if every page in it shows the same one. Written out
 * on each screen, a strip of four is four places to remember when a fifth
 * arrives - and the one that gets forgotten is a screen nothing links to any
 * more, which is a screen the office stops knowing about.
 *
 * Treasury learned this in patch 87 and keeps its own strips in
 * src/pages/treasury/sections.ts. These are the rest of them.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE SIDEBAR READS THEM TOO
 * ---------------------------------------------------------------------------
 * The sidebar used to find the item holding the current screen by matching the
 * address against the menu. That worked while every screen WAS a menu item.
 *
 * It is not true any more, and in two places it never quite was: Aging Reports
 * lives at /reports/aging but belongs to Accounting, and Cash in Local
 * Treasury lives at /reports/cash-in-local-treasury but belongs to the
 * Treasurer's cash books. Matching on the address alone lights up Reports for
 * both of them, and leaves the heading the officer is actually standing in
 * shut.
 *
 * The strips already hold the answer, and in a form that cannot drift: the
 * FIRST tab of a strip is the screen the menu names, and every other tab is
 * something beside it. So a screen's menu item is the head of whichever strip
 * carries it. See `sectionHeadForPath`.
 */

export interface SectionTab {
  label: string;
  to: string;
  /**
   * Further screens inside this tab whose addresses do not begin with its
   * own. See StripTab in components/ui/SectionTabs.tsx.
   */
  includes?: readonly string[];
}

/*
 * The Trust Fund's three screens, by address. Written here rather than
 * imported from trustTabs.tsx so that this file - which the sidebar reads on
 * every screen - does not pull a page's components into the menu. A test
 * holds the two lists to each other.
 */
export const TRUST_SCREENS = [
  '/accounting/trust-programs',
  '/accounting/trust-registry',
  '/accounting/fund-utilization',
] as const;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * The two registries the Budget Office keeps against the appropriation.
 *
 * One records what was obligated against each allotment; the other records
 * what was actually realised against the income estimated. They answer the two
 * halves of the same question - is the budget holding - so they are read one
 * after the other rather than found separately.
 */
export const BUDGET_MONITORING_TABS: SectionTab[] = [
  { label: 'Registry (RAAO)', to: '/budget/registry' },
  { label: 'Registry of Income (REAIRR)', to: '/budget/registry-income' },
];

/**
 * Budget accountability, as against statements drawn off the books.
 *
 * Named as the office names them, not by their form numbers. The forms still
 * print "LBAc Form No. 1" in the corner, which is what COA reads; the tab is
 * what the clerk reads, and a tab that quizzes somebody on a form number to
 * find a report they know by name is a tab doing the wrong job.
 *
 * These three are prepared BY the Budget Officer, the Treasurer and the
 * Accountant AGAINST the budget, which is why they are here and not under
 * Reports. The note in navigation.ts has said so since they were built; this
 * keeps them together now that the heading they sat under is gone.
 */
export const BUDGET_REPORT_TABS: SectionTab[] = [
  { label: 'Report of Receipts', to: '/budget/reports/receipts' },
  { label: 'Financial Report of Operations', to: '/budget/reports/quarterly-financial' },
  { label: 'Receipts and Expenditures (SRE)', to: '/budget/reports/sre' },
];

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

/**
 * What Accounting WATCHES, as against what it records.
 *
 * The four were under a heading called "Monitoring and Setup", which was two
 * jobs in one word. Three of these are standing questions the Accountant asks
 * of the books - what is held in trust, what cash advances are outstanding,
 * what each payee has been paid, what is overdue - and the fourth, Opening
 * Balances, is something done once when a fund is set up and then never again.
 *
 * They are separated now. Nothing is monitored on the Opening Balances screen
 * and nothing is set up on these.
 */
export const ACCOUNTING_MONITORING_TABS: SectionTab[] = [
  /*
    Trust Accounts is three screens - the programmes, the registry, the
    utilization report - at three addresses that do not share a beginning.
    `includes` is what keeps this tab lit, and this strip on the screen, on
    all three. Without it the strip vanished the moment the officer opened
    the registry, which is the fault patch 111 fixed.
  */
  { label: 'Trust Accounts', to: '/accounting/trust-programs', includes: TRUST_SCREENS },
  { label: 'Cash Advance Summary', to: '/accounting/cash-advances' },
  { label: 'Index of Payment', to: '/accounting/index-of-payments' },
  // Lives under /reports/ because it was built there. The address is kept so
  // older links still work; `sectionHeadForPath` is what tells the sidebar it
  // belongs to Accounting.
  { label: 'Aging Reports', to: '/reports/aging' },
];

/**
 * A strip of one, deliberately.
 *
 * Opening Balances is the whole of Setup today. It is here as a strip rather
 * than a bare page because what goes beside it is already in view - the
 * opening of a fiscal year, the closing entries, the first chart load - and a
 * strip that exists is one that can be added to without moving the screen the
 * office has bookmarked.
 */
export const ACCOUNTING_SETUP_TABS: SectionTab[] = [
  { label: 'Opening Balances', to: '/accounting/opening-balances' },
];

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

/**
 * The books of cash, as opposed to the registers of documents.
 *
 * A register answers "what did we issue"; a cash book answers "what have we
 * got, and where". Four views of the second question: one account's running
 * book, the Treasurer's own undeposited cash, what is out with officers as
 * advances, and the snapshot across all of them.
 */
export const CASH_BOOK_TABS: SectionTab[] = [
  { label: 'Cash in Bank', to: '/treasury/cash-in-bank' },
  // Under /reports/ for the same historical reason as Aging.
  { label: 'Cash in Local Treasury', to: '/reports/cash-in-local-treasury' },
  { label: 'Cash Advances', to: '/treasury/cash-advance-book' },
  { label: 'Cash Position', to: '/treasury/cash-position' },
];

/** The two pre-printed forms that go through the office's own printer. */
export const PRINTING_TABS: SectionTab[] = [
  { label: 'Print Checks', to: '/treasury/print/checks' },
  { label: 'Print Receipts', to: '/treasury/print/receipts' },
];

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * The statements drawn off the General Ledger.
 *
 * Order unchanged from the menu: the two that read the budget against the
 * actual first, then the trial balance and the statements built on it, then
 * the ledgers and books they are built from. It runs from the summary a mayor
 * reads to the detail an auditor traces.
 */
export const REPORT_TAB_GROUPS: Array<{ group: string; tabs: SectionTab[] }> = [
  {
    /* The budget beside what actually happened. */
    group: 'Budget and actual',
    tabs: [
      { label: 'SAOB', to: '/reports/saob' },
      { label: 'Budget and Actual (SCBAA)', to: '/reports/budget-vs-actual' },
    ],
  },
  {
    /* What the books add up to. */
    group: 'Statements',
    tabs: [
      { label: 'Trial Balance', to: '/reports/trial-balance' },
      { label: 'Financial Statements', to: '/reports/financial-statements' },
    ],
  },
  {
    /* And the books themselves, which the statements are built from. */
    group: 'Books',
    tabs: [
      { label: 'General Ledger', to: '/reports/general-ledger' },
      { label: 'Subsidiary Ledger', to: '/reports/subsidiary-ledger' },
      { label: 'Journals', to: '/reports/journals' },
      { label: 'Registers', to: '/reports/registers' },
    ],
  },
];

/**
 * The statements drawn off the General Ledger, flattened.
 *
 * Order unchanged from the menu: the two that read the budget against the
 * actual first, then the trial balance and the statements built on it, then
 * the ledgers and books they are built from. It runs from the summary a mayor
 * reads to the detail an auditor traces.
 */
export const REPORT_TABS: SectionTab[] = REPORT_TAB_GROUPS.flatMap((g) => g.tabs);


/**
 * Every strip above, for the sidebar's benefit.
 *
 * Treasury's own strips are NOT here. They have their own resolver,
 * `registerForPath`, which the sidebar already consults; adding them twice
 * would make two answers to one question.
 */
const ALL_STRIPS: SectionTab[][] = [
  BUDGET_MONITORING_TABS,
  BUDGET_REPORT_TABS,
  ACCOUNTING_MONITORING_TABS,
  ACCOUNTING_SETUP_TABS,
  CASH_BOOK_TABS,
  PRINTING_TABS,
  REPORT_TABS,
];

/**
 * The menu item holding this screen: the head of whichever strip carries it.
 *
 * Longest match wins, for the reason SectionTabs does the same - /reports and
 * /reports/aging are both prefixes of /reports/aging, and the more specific
 * one is the true answer.
 */
export function sectionHeadForPath(pathname: string): string | null {
  /*
   * Two things are tracked, and they are not the same string: `matched` is the
   * ADDRESS that fitted, and `head` is the menu item its tab belongs to.
   * Comparing lengths on the head would compare the wrong thing - two strips
   * can match, and the winner is decided by how specifically the address
   * matched. A tab's `includes` count as its addresses, so the Trust Fund's
   * registry lights Monitoring exactly as its programmes do.
   */
  let matched: string | null = null;
  let head: string | null = null;

  for (const strip of ALL_STRIPS) {
    const stripHead = strip[0]?.to;
    if (!stripHead) continue;
    for (const tab of strip) {
      for (const address of [tab.to, ...(tab.includes ?? [])]) {
        if (pathname !== address && !pathname.startsWith(`${address}/`)) continue;
        if (matched === null || address.length > matched.length) {
          matched = address;
          head = stripHead;
        }
      }
    }
  }

  return head;
}
