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
  { label: 'Summary of Collections', to: '/reports/summary-of-collections' },
  { label: 'Collection Reports and Cashbook', to: '/reports/treasury' },
];

export const CHECK_TABS = [
  { label: 'Checks', to: '/treasury/checks' },
  { label: 'Report of Checks Issued (RCI)', to: '/treasury/checks/rci' },
  // The claim sheet is the list of who is being paid out of the checks drawn,
  // so it reads with the check register rather than beside it.
  { label: 'Claim Sheet', to: '/treasury/claim-sheet' },
];

export const ADA_TABS = [
  { label: 'ADA', to: '/treasury/ada' },
  // The number series and every hole in it. It is the same book as the ADA
  // register read a different way, so it is a tab on it and not a menu item.
  { label: 'ADA Numbers', to: '/treasury/ada/numbers' },
  { label: 'Report of ADA Issued (RADAI)', to: '/treasury/ada/radai' },
];

export const PAYROLL_TABS = [
  { label: 'Payroll', to: '/treasury/payroll' },
  { label: 'Report of Cash Disbursement (RCDisb)', to: '/treasury/payroll/rcdisb' },
];

export const SECTION_TABS: Record<TreasuryReportType, Array<{ label: string; to: string }>> = {
  RCI: CHECK_TABS,
  RADAI: ADA_TABS,
  RCD: COLLECTION_TABS,
  RCDISB: PAYROLL_TABS,
};

/** The breadcrumb trail shared by every page in the collections section. */
export const COLLECTION_CRUMBS = [
  { label: 'Treasury' },
  { label: 'Collections and Deposits', to: '/treasury/collections' },
];

/** The same, for the check section. */
export const CHECK_CRUMBS = [{ label: 'Treasury' }, { label: 'Checks', to: '/treasury/checks' }];
