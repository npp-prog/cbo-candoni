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
  { label: 'Report of Collections and Deposits (RCD)', to: '/treasury/collections/rcd' },
];

export const CHECK_TABS = [
  { label: 'Checks', to: '/treasury/checks' },
  { label: 'Report of Checks Issued (RCI)', to: '/treasury/checks/rci' },
  // Where the RCI usually comes from. The Treasurer's own system produces the
  // file; CBO reads it rather than asking for the same rows to be typed again.
  { label: 'Upload RCI', to: '/treasury/checks/uploads' },
];

export const ADA_TABS = [
  { label: 'ADA', to: '/treasury/ada' },
  { label: 'Report of ADA Issued (RADAI)', to: '/treasury/ada/radai' },
  { label: 'Upload RADAI', to: '/treasury/ada/uploads' },
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
export const COLLECTION_CRUMBS = [{ label: 'Treasury' }, { label: 'Collections and Deposits' }];
