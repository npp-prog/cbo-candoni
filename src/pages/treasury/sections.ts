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
  { label: 'Deposits', to: '/treasury/collections/deposits' },
  // The primary reports a collecting officer closes before the RCD is drawn.
  { label: 'Primary Reports', to: '/treasury/collections/primary' },
  { label: 'Report of Collections and Deposits (RCD)', to: '/treasury/collections/rcd' },
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
  // Drawn out of the same register and submitted to Accounting at year end,
  // so it belongs on this strip as well as in Treasury Reports.
  { label: 'Unreleased Checks (SUC)', to: '/treasury/checks/unreleased' },
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
