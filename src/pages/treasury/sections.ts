import type { TreasuryReportType } from '@/types/enums';

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
export const COLLECTION_TABS = [
  { label: 'Collections', to: '/treasury/collections' },
  /*
   * Money that arrived without anybody handing cash over a counter - paid
   * through GCash or Maya, or straight into the bank account.
   *
   * On this strip and not a section of its own, deliberately. It is a
   * collection: it hits the same revenue accounts, it is deposited to the same
   * bank, and it must not be counted twice with the cash. Putting it elsewhere
   * in the menu would have invited exactly that - two places money comes in,
   * and a Cashbook that reads one of them.
   */
  { label: 'e-Collections', to: '/treasury/collections/electronic' },
  { label: 'Deposits', to: '/treasury/collections/deposits' },
  // The primary reports a collecting officer closes before the RCD is drawn.
  { label: 'Primary Reports', to: '/treasury/collections/primary' },
  { label: 'Report of Collections and Deposits (RCD)', to: '/treasury/collections/rcd' },
  /*
   * Annexes E, F and G of COA Circular 2021-014, behind one tab. Three
   * reports, one piece of work - the reasoning is in ECollectionReports.
   */
  { label: 'e-Collections and Deposits (eRCD)', to: '/treasury/collections/ercd' },
  // Everything else drawn off the same collections. Each of these was a menu
  // item of its own, which put four documents about collections beside the
  // collections rather than in them - so the clerk who had just recorded the
  // day's receipts had to go back out to the sidebar to report on them.
  { label: 'Summary of RCDs (Transmittal)', to: '/reports/rcd-transmittal' },
  { label: 'Abstract of General Collection', to: '/reports/abstract-of-collections' },
  // The Accountant's abstract, not the Treasurer's: GAM Section 68 puts it in
  // Accounting because its purpose is working out what is owed to the province
  // and the barangays, not reporting what was taken in.
  { label: 'Abstract of RPT Collections', to: '/reports/rpt-abstract' },
  { label: 'Summary of Collections', to: '/reports/summary-of-collections' },
  { label: 'Collection Reports and Cashbook', to: '/reports/treasury' },
];

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
export const PAYMENT_TABS = [
  { label: 'Disbursements for Payment', to: '/treasury/disbursements' },
  { label: 'Checks', to: '/treasury/checks' },
  // The ADA number series is INSIDE this one, as a tab on the page. It used
  // to be a tab of its own here, which asked the officer to know whether the
  // answer to "what happened to 0221" was in the register or in the series
  // before they could go and look for it. They are one book.
  { label: 'ADA', to: '/treasury/ada' },
  // Then the two reports that go to Accounting, in the order the work runs:
  // what was drawn, then what is reported.
  { label: 'Report of Checks Issued (RCI)', to: '/treasury/checks/rci' },
  { label: 'Report of ADA Issued (RADAI)', to: '/treasury/ada/radai' },
  // The claim sheet is the list of who is being paid out of the checks drawn.
  { label: 'Claim Sheet', to: '/treasury/claim-sheet' },
  // Both drawn out of the same check register and submitted to Accounting, so
  // they belong on the check book's own strip.
  //
  // The Report of Cancelled Checks joined in patch 87, when the Treasury
  // Reports group came out of the sidebar. It was the one report in that group
  // that was on no strip at all, so removing the group would have left it
  // reachable only by typing its address - and a screen nothing links to is a
  // screen the office stops knowing about.
  { label: 'Unreleased Checks (SUC)', to: '/treasury/checks/unreleased' },
  { label: 'Cancelled Checks (RCC)', to: '/reports/cancelled-checks' },
];

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
