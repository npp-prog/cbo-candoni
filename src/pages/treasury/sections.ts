import type { TreasuryReportType } from '@/types/enums';
import type { SectionTab } from '@/layout/sections';

/**
 * The tab strips that sit under each Treasury page heading.
 *
 * They live here, in one file, rather than beside each screen, because a tab
 * strip is only honest if every page in the section shows the same one. When
 * the strip was written out on each page, Collections listed two tabs and the
 * RCD listed the same two - and adding Deposits to the section would have meant
 * remembering three separate places. One definition, imported by all of them.
 *
 * Collections and Deposits are one section deliberately. A collection and its
 * deposit are two halves of the same movement of money: the receipt puts cash
 * in the collecting officer's hands, the deposit slip moves it to the bank, and
 * the RCD reports the pair. Splitting them into two sidebar items invited the
 * reading that they are separate activities that happen to be near each other.
 */
/**
 * Collections and Deposits, in four groups.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STRIP GREW A SECOND LEVEL
 * ---------------------------------------------------------------------------
 * It reached twelve tabs on two wrapped rows, and at that length a strip stops
 * being a map. Twelve things in a row all look equally likely, so finding the
 * Abstract of RPT Collections meant reading the whole strip - which is the
 * same failure the sidebar had before patch 94, moved one level down.
 *
 * The office does not think of them as twelve. It thinks of them as four kinds
 * of work: recording what came in, abstracting it, reporting it, and the
 * summaries drawn off all of that. So the strip says that: the group first,
 * its tabs underneath.
 */
export const COLLECTION_TAB_GROUPS: Array<{ group: string; tabs: SectionTab[] }> = [
  {
    /* What is recorded as the money arrives. */
    group: 'Transactions',
    tabs: [
      { label: 'Collections', to: '/treasury/collections' },
      /*
       * Money that arrived without anybody handing cash over a counter - paid
       * through GCash or Maya, or straight into the bank account.
       *
       * Beside the cash, deliberately. It is a collection: it hits the same
       * revenue accounts, is deposited to the same bank, and must not be
       * counted twice with the cash.
       */
      { label: 'e-Collections', to: '/treasury/collections/electronic' },
      { label: 'Deposits', to: '/treasury/collections/deposits' },
    ],
  },
  {
    /* The same receipts, cut by accountable form and by revenue account. */
    group: 'Abstract',
    tabs: [
      { label: 'Abstract of General Collections', to: '/reports/abstract-of-collections' },
      { label: 'Abstract of General e-Collections', to: '/reports/abstract-of-e-collections' },
      /*
       * The Accountant's abstract, not the Treasurer's: GAM Section 68 puts it
       * in Accounting because its purpose is working out what is owed to the
       * province and the barangays, not reporting what was taken in.
       */
      { label: 'Abstract of RPT Collections', to: '/reports/rpt-abstract' },
    ],
  },
  {
    /* What is certified and sent to Accounting. */
    group: 'RCD',
    tabs: [
      { label: 'Report of Collections and Deposits (RCD)', to: '/treasury/collections/rcd' },
      /*
       * Annexes E and F of COA Circular 2021-014 behind one tab - two reports,
       * one piece of work. The reasoning is in ECollectionReports.
       */
      { label: 'e-Collections and Deposits (eRCD)', to: '/treasury/collections/ercd' },
      /*
       * The two layers above a collector's own report, which were one tab
       * called "Primary Reports" - a name out of the manual that said nothing
       * about which of the two you were about to open.
       *
       *   Collector's Report        one collecting officer's remittances for
       *                             the day, received by the Liquidating
       *                             Officer.
       *   Consolidated Collection   several of those gathered into one.
       *
       * One screen behind both, filtered. A second implementation would be a
       * second set of the rules about closing and re-opening them.
       */
      /* Patch 156: Collector's Report and Consolidated Collection Report removed. */
      { label: 'Summary of RCDs (Transmittal)', to: '/reports/rcd-transmittal' },
    ],
  },
  {
    group: 'Reports',
    tabs: [
      { label: 'Summary of Collections', to: '/reports/summary-of-collections' },
      { label: 'Collection Reports and Cashbook', to: '/reports/treasury' },
    ],
  },
];

/**
 * Every tab in the section, flattened.
 *
 * `registerForPath` and the sidebar work on a flat list - a screen belongs to
 * the register at the head of whichever strip carries it, and that is true
 * whether or not the strip is drawn in groups.
 */
export const COLLECTION_TABS: SectionTab[] = COLLECTION_TAB_GROUPS.flatMap((g) => g.tabs);


/**
 * Checks and ADA are ONE section, with the payment queue at the head of it.
 *
 * They were two menu items, and they should not have been. A check and an
 * advice to debit are two ways of doing the identical thing - paying an
 * approved voucher out of a bank account - and which one is used is decided
 * per payment, on the day, by the Treasurer. Two items asked the clerk to pick
 * the instrument before opening the screen, which is the one question they
 * cannot answer yet.
 *
 * So the section opens on DISBURSEMENTS FOR PAYMENT - the vouchers waiting -
 * and the instrument is chosen there, on the row. The registers and the
 * reports for both instruments are tabs behind it, in the order the work runs:
 * what is owed, what was drawn, what the series looks like, who is being paid,
 * and then the reports that go to Accounting.
 */
export const PAYMENT_TAB_GROUPS: Array<{ group: string; tabs: SectionTab[] }> = [
  {
    /*
     * What the office does. A check and an advice to debit are two ways of
     * doing the identical thing - paying an approved voucher out of a bank
     * account - and which is used is decided per payment, on the day. So the
     * group opens on the vouchers waiting, not on a choice of instrument.
     */
    group: 'Transactions',
    tabs: [
      { label: 'Disbursements for Payment', to: '/treasury/disbursements' },
      { label: 'Checks', to: '/treasury/checks' },
      /*
       * The ADA number series is a tab INSIDE this one. It used to be a tab
       * beside it, which asked the officer to know whether the answer to "what
       * happened to 0221" was in the register or in the series before they
       * could go and look. They are one book.
       */
      { label: 'ADA', to: '/treasury/ada' },
    ],
  },
  {
    /*
     * What is drawn off those registers and sent to Accounting. Patch 144:
     * two tabs, each with the screens that belong to it underneath - the
     * check reports under the RCI, the bank's posting under the RADAI.
     */
    group: 'Reports',
    tabs: [
      {
        label: 'Report of Checks Issued (RCI)',
        to: '/treasury/checks/rci',
        children: [
          { label: 'RCI', to: '/treasury/checks/rci' },
          { label: 'Claim Sheet', to: '/treasury/claim-sheet' },
          { label: 'Unreleased Checks (SUC)', to: '/treasury/checks/unreleased' },
          { label: 'Cancelled Checks (RCC)', to: '/reports/cancelled-checks' },
        ],
      },
      {
        label: 'Report of ADA Issued (RADAI)',
        to: '/treasury/ada/radai',
        children: [
          { label: 'RADAI', to: '/treasury/ada/radai' },
          { label: 'Bank Credits', to: '/treasury/ada/bank-credits' },
        ],
      },
    ],
  },
];

/**
 * Checks and ADA, flattened.
 *
 * The register at the head of the strip is still the first tab of the first
 * group - `registerForPath` and the sidebar depend on that, and it is true
 * whether or not the strip is drawn in groups.
 */
export const PAYMENT_TABS: SectionTab[] = PAYMENT_TAB_GROUPS.flatMap((g) =>
  g.tabs.flatMap((t) => [t, ...(t.children ?? []).filter((c) => c.to !== t.to)]),
);


/**
 * The stock book and the report drawn from it.
 *
 * Same pairing as Payroll and the RCDisb: one register, one report. They were
 * two menu items in two different groups - the register under Registers, the
 * report under Treasury Reports - so the officer who had just recorded a
 * booklet's movement had to go back out to the sidebar, and into a different
 * part of it, to report on what they had recorded.
 */
export const ACCOUNTABLE_FORM_TABS = [
  { label: 'Accountable Forms', to: '/treasury/accountable-forms' },
  { label: 'Accountability for Accountable Forms (RAAF)', to: '/treasury/raaf' },
];

export const PAYROLL_TABS = [
  { label: 'Payroll', to: '/treasury/payroll' },
  { label: 'Report of Cash Disbursement (RCDisb)', to: '/treasury/payroll/rcdisb' },
];

export const SECTION_TABS: Record<TreasuryReportType, Array<{ label: string; to: string }>> = {
  RCI: PAYMENT_TABS,
  RADAI: PAYMENT_TABS,
  RCD: COLLECTION_TABS,
  RCDISB: PAYROLL_TABS,
  // The e-collection reports belong with the collections they report on.
  ERCD_AR: COLLECTION_TABS,
  ERCD_EOR: COLLECTION_TABS,
};

/** The breadcrumb trail shared by every page in the collections section. */
export const COLLECTION_CRUMBS = [
  { label: 'Treasury' },
  { label: 'Collections and Deposits', to: '/treasury/collections' },
];

/** The same, for the checks-and-ADA section. */
export const PAYMENT_CRUMBS = [
  { label: 'Treasury' },
  { label: 'Checks and ADA', to: '/treasury/disbursements' },
];

/**
 * Which register a Treasury screen belongs to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The sidebar folds open the heading holding the screen you are standing on,
 * and it worked that out by matching the address against the menu items. That
 * was enough while every Treasury report was ALSO a menu item.
 *
 * Patch 87 took the Treasury Reports group out, because each of those reports
 * is a tab on the register it is drawn from. Which left the sidebar with
 * nothing to match on `/treasury/checks/rci` - so standing on the RCI, the
 * heading holding it stayed shut.
 *
 * The strips already hold the answer, and they hold it in a form that cannot
 * drift: the FIRST tab of a strip is the register itself, and every other tab
 * is something drawn from it. So a screen's register is the head of whichever
 * strip carries it.
 */
const ALL_STRIPS = [COLLECTION_TABS, PAYMENT_TABS, PAYROLL_TABS, ACCOUNTABLE_FORM_TABS];

export function registerForPath(pathname: string): string | null {
  for (const strip of ALL_STRIPS) {
    const head = strip[0]?.to;
    if (!head) continue;
    for (const tab of strip) {
      if (pathname === tab.to || pathname.startsWith(`${tab.to}/`)) return head;
    }
  }
  return null;
}

/**
 * The groups a treasury report's screen should draw, or null for a flat strip.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION AND NOT A GLANCE AT SECTION_TABS
 * ---------------------------------------------------------------------------
 * One screen serves all seven treasury reports, and they sit in three
 * different sections. Two of those sections are long enough to be drawn in
 * groups - Collections and Deposits, and Checks and ADA - and the third, the
 * payroll, is two tabs and stays flat.
 *
 * The screen rendered the flat strip unconditionally, so patch 97 reached the
 * office with the RCD and the eRCD showing twelve tabs on three wrapped rows
 * while every other screen in that section showed the groups. Nothing failed -
 * it just looked like two different systems.
 *
 * Asked as a question with a name, rather than by comparing SECTION_TABS to
 * COLLECTION_TABS at the call site, because the comparison would be true by
 * accident the day another section happened to share a strip.
 */
export function sectionGroupsFor(
  reportType: TreasuryReportType,
): Array<{ group: string; tabs: SectionTab[] }> | null {
  if (reportType === 'RCD' || reportType === 'ERCD_AR' || reportType === 'ERCD_EOR') {
    return COLLECTION_TAB_GROUPS;
  }
  if (reportType === 'RCI' || reportType === 'RADAI') return PAYMENT_TAB_GROUPS;
  /* The payroll strip is two tabs. A group row over two tabs would be a
     heading with nothing to choose under it. */
  return null;
}
