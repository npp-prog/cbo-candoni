import { registerForPath } from '@/pages/treasury/sections';
import {
  ACCOUNTING_MONITORING_TABS,
  ACCOUNTING_SETUP_TABS,
  TRUST_ACCOUNT_TABS,
  TRUST_FUND_CODE,
  BUDGET_MONITORING_TABS,
  BUDGET_REPORT_TABS,
  CASH_BOOK_TABS,
  PRINTING_TABS,
  REPORT_TABS,
} from './sections';
import type { Module } from '@/types/system';

/**
 * The navigation tree.
 *
 * Order follows the flow of a transaction through the municipality rather than
 * the alphabet: budget authorises, accounting records, treasury moves the
 * money, reconciliation proves it, reports present it, and audit trail shows
 * who did what. A user learning the system can read the sidebar as the process.
 */

export interface NavItem {
  label: string;
  to: string;
  module: Module;
  /**
   * Sub-items shown when the section is open.
   *
   * `group` starts a labelled block within the list. Reports are the reason it
   * exists: a Trial Balance and a SAOB are both "reports", but one belongs to
   * Accounting and the other to Budget, and an officer looking for their own
   * office's output should not have to read the whole list to find it.
   */
  children?: Array<{
    label: string;
    to: string;
    group?: string;
    /** Shown only while this fund is selected at the top of the screen. Patch 136. */
    fund?: string;
  }>;
  icon: string;
}

/** Icon paths (Heroicons outline, 24x24). Inlined to avoid an icon dependency. */
export const ICONS: Record<string, string> = {
  dashboard:
    'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75',
  budget:
    'M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v4.5m3-6.75v6.75',
  accounting:
    'M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z',
  treasury:
    'M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  reconciliation:
    'M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  reports:
    'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  masterData:
    'M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75',
  documents:
    'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
  administration:
    'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z',
  auditTrail:
    'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
};

export const NAVIGATION: NavItem[] = [
  { label: 'Dashboard', to: '/', module: 'dashboard', icon: 'dashboard' },
  {
    label: 'Budget',
    to: '/budget',
    module: 'budget',
    icon: 'budget',
    /*
     * Three headings, because the Budget menu had to be grouped once the
     * accountability reports arrived - the sidebar groups a section all or
     * nothing, and a loose item under the last heading reads as though it
     * belonged to it.
     *
     * The split is the manual's own: the documents the office writes, the
     * books and tests it keeps, and the forms it submits.
     */
    children: [
      /*
       * The order is LBP Form No. 1's: what will pay for the year, then what
       * the year will spend. The ordinance enacts only the second, which is
       * why the first needed a record of its own - and why it belongs in
       * front of it rather than beside it as an afterthought.
       */
      {
        group: 'Budget transactions',
        // Named for the whole of what the screen holds since patch 119: the
        // estimated receipts of LBP Form No. 1 and the funding sources of a
        // supplemental budget, LBP Form No. 8. The address is unchanged.
        label: 'Sources of Financing',
        to: '/budget/estimated-receipts',
      },
      { group: 'Budget transactions', label: 'Appropriation', to: '/budget/appropriations' },
      /*
       * ONE item, not two.
       *
       * There were two - "Allotment Release Orders" and "Allotment Register" -
       * and they sat next to each other reading almost identically. Renaming
       * them helped and did not fix it: the officer still had to decide which
       * of two menu entries to open before knowing what was in either.
       *
       * They are one subject with two faces. The register is what you open;
       * the orders are how you add to it, a tab away. Nothing is lost - the
       * tab strip is on both screens - and there is no longer a choice to get
       * wrong on the way in.
       */
      { group: 'Budget transactions', label: 'Allotments', to: '/budget/allotments' },
      { group: 'Budget transactions', label: 'Obligations', to: '/budget/obligations' },
      /*
       * There is no Augmentation item in this menu, and that is deliberate.
       *
       * An augmentation is recorded on the Appropriation screen - it is one
       * of the types in the Type list there, beside Original, Supplemental
       * and Realignment. A second menu entry for it would be a second door
       * into the same room, and the question "which one do I use?" has no
       * good answer.
       */

      /*
       * MONITORING AND REPORTS ARE ONE ITEM EACH NOW.
       *
       * Each was a folded heading over two or three screens that are read one
       * after the other. The heading named the kind of thing; the tab strip on
       * the page says the same and puts the next screen one click away instead
       * of three. Every address is unchanged.
       *
       * Ungrouped, because a heading over a single item is a fold that hides
       * one line - which is what these two already were.
       */
      { label: 'Monitoring', to: BUDGET_MONITORING_TABS[0].to },
      { label: 'Reports', to: BUDGET_REPORT_TABS[0].to },
    ],
  },
  {
    label: 'Accounting',
    to: '/accounting',
    module: 'accounting',
    icon: 'accounting',
    // Four of these seven are the same act: each one ends in a Journal Entry
    // Voucher that posts to the General Ledger. Grouping them says so on the
    // menu, so an accountant looking for "where do I journalize this" sees the
    // four doors into the ledger together instead of finding them scattered
    // among registers and setup.
    //
    // The order inside the group is the order the paper reaches Accounting,
    // not the alphabet: the voucher is raised first, the liquidation settles
    // an advance already given, the treasury reports arrive from the
    // Treasurer, and General Transactions carries what begins in Accounting
    // itself and has no source document at all.
    children: [
      { group: 'Accounting transactions', label: 'Disbursement Voucher', to: '/accounting/disbursements' },
      { group: 'Accounting transactions', label: 'Liquidation Report', to: '/accounting/liquidation' },
      { group: 'Accounting transactions', label: 'Treasury Reports', to: '/accounting/treasury-reports' },
      // Deliberately not called "Journal Entry Voucher". Every item in this
      // group produces a JEV - the voucher does, each treasury report does -
      // so a menu item by that name would read as though it were the only
      // place JEVs are made. This screen is for the entries that have no
      // source document of their own: manual, adjusting, closing and
      // prior-period adjustments.
      { group: 'Accounting transactions', label: 'General Transactions', to: '/accounting/general-transactions' },

      /*
       * The book of every entry, after the four screens that make them.
       *
       * It is last in the group because it is the only one that is read rather
       * than worked in: the four above are where an entry is raised, and this
       * is where they are all found afterwards. An accountant asked "what
       * entries were made in March" used to have to open each of the four and
       * add them up.
       */
      /*
       * ---------------------------------------------------------------------
       * OUT OF THE GROUP, AND THE REASON IS WHAT THE HEADING PROMISES
       * ---------------------------------------------------------------------
       * It was the fifth item under Accounting transactions, on the argument
       * that an accountant looking for an entry looks where entries are made.
       * That argument held while the heading was called "Journal Entry
       * Transactions": the register is a journal entry thing, so it belonged
       * among them.
       *
       * Under a heading that says TRANSACTIONS it no longer does. The four
       * above are acts - a voucher raised, an advance liquidated, a report
       * received, an entry made. The register is none of them. It is the book
       * they all land in, read after the fact and never worked in, and a
       * heading that promises transactions and delivers a read-only book on
       * its last line is a heading that has stopped being true.
       *
       * So it stands on its own, between the transactions and what the office
       * monitors - after the four screens that write entries, before the four
       * screens that watch them. Its address is unchanged.
       */
      { label: 'Journal Entries Register', to: '/accounting/journal-entries' },

      /*
       * TRUST ACCOUNTS, after the register and only for the Trust Fund.
       * Patch 136 - FURS, Trust Fund Programmes, Registry of Special Trust
       * Fund, Fund Utilization Report. See TRUST_ACCOUNT_TABS.
       */
      { label: 'Trust Accounts', to: TRUST_ACCOUNT_TABS[0].to, fund: TRUST_FUND_CODE },

      // Everything below is looked at or set up, never posted. The heading is
      // not decoration: without it these would sit directly under the group
      // above and read as though they too journalized something.

      /*
       * The Trust Fund's own funding control, and it is here rather than in
       * the Budget menu on purpose.
       *
       * There is no ordinance behind a trust programme and nothing for the
       * Budget Officer to release: the money arrived under a memorandum of
       * agreement, and the Accountant books it, reports on it and answers to
       * the source for it. Putting it beside the appropriation would say the
       * Budget Office owns it, which it does not.
       */
      /*
       * ONE item, not three.
       *
       * The programmes, the registry kept against them and the report drawn
       * from that registry were three entries in a row. They are one subject
       * seen three ways, and three entries made the officer pick one before
       * knowing what was in any of them - while pushing the rest of Monitoring
       * and Setup down the menu, so the Trust Fund took the most room in the
       * list and is the smallest of the three funds.
       *
       * The three are tabs on the screen now. See trustTabs.tsx.
       */
      /*
       * MONITORING AND SETUP WERE TWO JOBS IN ONE HEADING.
       *
       * Three of the five were standing questions the Accountant asks of the
       * books - what is held in trust, what advances are outstanding, what a
       * payee has been paid - plus the ageing of what is overdue. The fourth
       * thing under that heading, Opening Balances, is done ONCE when a fund
       * is set up and then never again.
       *
       * They are two items now, each with its own tab strip, so nothing is
       * monitored on the setup screen and nothing is set up on the monitoring
       * ones. Addresses are unchanged.
       *
       *   Monitoring   Cash Advance Summary, Index of Payment,
       *                Aging Reports (Trust Accounts has its own item
       *                since patch 136)
       *   Setup        Opening Balances
       *
       * Aging Reports keeps its /reports/ address, which is where it was
       * built. sectionHeadForPath is what tells the sidebar it belongs here.
       */
      { label: 'Monitoring', to: ACCOUNTING_MONITORING_TABS[0].to },
      { label: 'Setup', to: ACCOUNTING_SETUP_TABS[0].to },
    ],
  },
  {
    label: 'Treasury',
    to: '/treasury',
    module: 'treasury',
    icon: 'treasury',
    // Four groups, in the order the office works: the books where the day's
    // transactions are recorded, the cash books those foot into, the reports
    // drawn off them, and the printing that is always last.
    //
    // The treasury reports used to live under Reports, beside the Budget and
    // Accounting ones. That grouped them by FORMAT - "things that are reports" -
    // when the only question the Treasurer's clerk actually asks is "where is my
    // RCD". A report belongs with the register it is drawn from, in the menu of
    // the office that prepares it.
    children: [
      // ----------------------------------------------------------------
      // Treasury transactions: the four books the office keeps, and nothing
      // else.
      //
      // Called "Registers" until patch 101. The four under it are where the
      // Treasurer's day is RECORDED - money received, money paid, a payroll
      // settled, a form issued - which is the same kind of thing "Budget
      // transactions" and "Accounting transactions" name in the two menus
      // above. "Registers" named the shape of the screen instead of the work,
      // and it was the one heading of the three that did.
      //
      // The books are still registers and the rule below is unchanged: these
      // four, and nothing else.
      //
      // Four, not eight. ADA Numbers, Primary Reports and the Claim Sheet were
      // listed here beside them, which made the menu answer a question nobody
      // asks - "how many treasury screens are there" - instead of the one
      // everybody asks: "which book am I working in today". Each of them now
      // sits as a tab inside the register it belongs to, where it is found by
      // somebody already doing that work rather than by somebody reading a
      // list.
      //
      //   ADA Numbers                    -> a tab on ADA
      //   Primary Reports                -> a tab on Collections and Deposits
      //   Claim Sheet                    -> a tab on Checks
      //   Collection Reports and Cashbook \
      //   Abstract of General Collection   > tabs on Collections and Deposits
      //   Summary of Collections           |
      //   Summary of RCDs (Transmittal)  /
      // ----------------------------------------------------------------
      // Checks and ADA are ONE item, and it opens on the payment queue.
      //
      // They were two. A check and an advice to debit are two ways of doing
      // the identical thing - paying an approved voucher out of a bank account
      // - and which one is used is decided per payment, on the day. Two menu
      // items asked the clerk to choose the instrument before opening the
      // screen, which is the one question they cannot answer yet.
      //
      // So the item opens on Disbursements for Payment: the vouchers waiting.
      // The instrument is chosen there, on the row, and both registers and
      // both reports are tabs behind it.
      { group: 'Treasury transactions', label: 'Checks and ADA', to: '/treasury/disbursements' },
      // Collections and deposits are one item: the receipt and the deposit slip
      // are two halves of the same movement of money, and the RCD reports the
      // pair. The deposits register is a tab inside it.
      { group: 'Treasury transactions', label: 'Collections and Deposits', to: '/treasury/collections' },
      { group: 'Treasury transactions', label: 'Payroll', to: '/treasury/payroll' },
      // The stock book: which booklets of which form each accountable officer
      // holds. It is a register the office writes in, not a report it draws -
      // the report drawn from it is the RAAF, below.
      { group: 'Treasury transactions', label: 'Accountable Forms', to: '/treasury/accountable-forms' },

      // ----------------------------------------------------------------
      // Cash books: the running balances the registers foot into. Cash in
      // Local Treasury sits here rather than among the reports because it is
      // the same kind of thing as the other two - a running book, read down a
      // column - and an officer who wants to know what is in their hands looks
      // in one place for all three.
      // ----------------------------------------------------------------
      /*
       * THE CASH BOOKS ARE ONE ITEM.
       *
       * Four views of one question - what have we got, and where - read one
       * after the other when the Treasurer closes the day. The heading said
       * that; the tab strip says it and puts the next view one click away.
       *
       * Cash in Local Treasury keeps its /reports/ address, which is where it
       * was built. sectionHeadForPath is what tells the sidebar it belongs
       * here and not under Reports.
       */
      { label: 'Cash Books', to: CASH_BOOK_TABS[0].to },

      // ----------------------------------------------------------------
      // A "TREASURY REPORTS" GROUP WAS HERE, AND IS NOT ANY MORE
      // ----------------------------------------------------------------
      // Seven entries: the RCD, RCI, RADAI, RCDisb, RCC, SUC and RAAF.
      //
      // Every one of them is a report drawn from a register that is already in
      // this menu, and every one of them is now a tab ON that register:
      //
      //   RCD                 Collections and Deposits
      //   RCI, RADAI,
      //   SUC, RCC            Checks and ADA
      //   RCDisb              Payroll
      //   RAAF                Accountable Forms
      //
      // So the group listed seven screens the officer could already reach from
      // the register they were standing in - and listed them in a different
      // part of the menu, which is the part that did the damage. It taught the
      // office that reporting on the day's work is something you leave the
      // screen to do.
      //
      // Two of them, the RCC and the RAAF, were on no strip at all before
      // patch 87; removing the group without putting them on one would have
      // left them reachable only by typing the address. They are on the check
      // book's strip and the stock book's strip now - see
      // src/pages/treasury/sections.ts. A navigation test holds that: nothing
      // may leave this menu unless a section strip carries it.
      // ----------------------------------------------------------------


      // ----------------------------------------------------------------
      // The two screens that put ink on paper somebody else printed. Last,
      // because they are the last thing done - after the check is signed and
      // the collection is recorded, never before.
      // ----------------------------------------------------------------
      { label: 'Printing', to: PRINTING_TABS[0].to },
    ],
  },
  {
    label: 'Reconciliation',
    to: '/reconciliation',
    module: 'reconciliation',
    icon: 'reconciliation',
    /*
     * No children. The section had exactly one, so the fold hid a single line
     * behind an arrow - the officer had to open a heading to discover that
     * the heading WAS the screen. /reconciliation already redirects to it.
     */
  },
  /*
   * REPORTS IS ONE ITEM AND EIGHT TABS.
   *
   * It listed eight statements with no heading over them, which made it the
   * longest flat run in the menu. They are eight cuts of ONE thing - the
   * General Ledger - read from the summary a mayor sees down to the detail an
   * auditor traces, and an officer who has just read the Trial Balance is
   * usually about to open the General Ledger behind it.
   *
   * The order is unchanged. Every address is unchanged. See REPORT_TABS.
   */
  { label: 'Reports', to: REPORT_TABS[0].to, module: 'reports', icon: 'reports' },
  { label: 'Master Data', to: '/master-data', module: 'masterData', icon: 'masterData' },
  { label: 'Documents', to: '/documents', module: 'documents', icon: 'documents' },
  {
    label: 'Administration',
    to: '/administration',
    module: 'administration',
    icon: 'administration',
    children: [
      { label: 'Users and Roles', to: '/administration/users' },
      { label: 'Accounting Periods', to: '/administration/periods' },
      { label: 'Numbering', to: '/administration/numbering' },
      { label: 'Settings', to: '/administration/settings' },
    ],
  },
  { label: 'Audit Trail', to: '/audit-trail', module: 'auditTrail', icon: 'auditTrail' },
];

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

export type NavChild = NonNullable<NavItem['children']>[number];

/** A run of consecutive children sharing one heading. */
export interface ChildBlock {
  group?: string;
  items: NavChild[];
}

/**
 * Cuts a section's children into runs of the same heading, so the sidebar can
 * fold each run away.
 *
 * Consecutive, deliberately. A heading is where it is in this file, and two
 * separated runs carrying the same name would be two headings on screen -
 * which is a mistake in this file worth seeing rather than one the renderer
 * quietly tidies away by merging items that were written apart.
 *
 * Children with no `group` form their own run with no heading. Such a run is
 * never folded: there would be nothing to label the fold with.
 */
export function toBlocks(children: readonly NavChild[]): ChildBlock[] {
  const blocks: ChildBlock[] = [];
  for (const child of children) {
    const last = blocks[blocks.length - 1];
    if (last && last.group === child.group) last.items.push(child);
    else blocks.push({ group: child.group, items: [child] });
  }
  return blocks;
}

/**
 * The heading holding a path, as `section.to` and the group name.
 *
 * The LONGEST matching target wins: /treasury/checks and /treasury/checks/rci
 * are both real menu items and both match the second path, and opening the
 * wrong heading would leave the highlighted item hidden inside a folded one.
 */
export function groupForPath(pathname: string): { sectionTo: string; group: string } | null {
  const direct = matchMenuItem(pathname);
  if (direct) return direct;

  /*
   * No menu item matches, so ask the Treasury section strips.
   *
   * A report that is a tab on a register is no longer a menu item of its own -
   * patch 87 took the whole Treasury Reports group out, because every entry in
   * it was already a tab on the register it is drawn from. Without this, the
   * sidebar had nothing to match on `/treasury/checks/rci` and the heading
   * holding it stayed shut: standing on the RCI, the menu showed nothing about
   * where you were.
   *
   * `registerForPath` answers with the register the screen belongs to, which
   * IS a menu item, so the ordinary match above finishes the job.
   */
  const register = registerForPath(pathname);
  return register ? matchMenuItem(register) : null;
}

/** The plain longest-match over the menu items themselves. */
function matchMenuItem(pathname: string): { sectionTo: string; group: string } | null {
  let best: { sectionTo: string; group: string; length: number } | null = null;
  for (const item of NAVIGATION) {
    for (const child of item.children ?? []) {
      if (!child.group) continue;
      if (pathname !== child.to && !pathname.startsWith(`${child.to}/`)) continue;
      if (!best || child.to.length > best.length) {
        best = { sectionTo: item.to, group: child.group, length: child.to.length };
      }
    }
  }
  return best ? { sectionTo: best.sectionTo, group: best.group } : null;
}

/**
 * The menu items to show for the fund selected at the top of the screen.
 * Patch 136: Trust Accounts belongs to the Trust Fund and is hidden for the
 * General Fund and the Special Education Fund.
 */
export function childrenForFund(
  children: readonly NavChild[] | undefined,
  fundCode: string,
): NavChild[] {
  return (children ?? []).filter(
    (c) => !c.fund || c.fund.toUpperCase() === String(fundCode ?? '').toUpperCase(),
  );
}
