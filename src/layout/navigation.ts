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
  children?: Array<{ label: string; to: string; group?: string }>;
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
    children: [
      { label: 'Appropriation', to: '/budget/appropriations' },
      { label: 'Allotments', to: '/budget/allotments' },
      { label: 'Obligations', to: '/budget/obligations' },
      { label: 'Registry (RAAO)', to: '/budget/registry' },
    ],
  },
  {
    label: 'Accounting',
    to: '/accounting',
    module: 'accounting',
    icon: 'accounting',
    // The order a transaction travels, not the alphabet. The voucher is raised,
    // the treasury reports arrive and are journalized, liquidations settle the
    // advances, and "Others" carries the entries that begin in Accounting
    // itself.
    children: [
      { label: 'Disbursement Voucher', to: '/accounting/disbursements' },
      { label: 'Treasury Reports', to: '/accounting/treasury-reports' },
      { label: 'Liquidation', to: '/accounting/liquidation' },
      // Deliberately not called "Journal Entry Voucher". Every transaction in
      // CBO produces a JEV - the voucher does, each treasury report does - so a
      // menu item by that name reads as though it were the only place JEVs are
      // made. This screen is for the entries that have no source document of
      // their own: manual, adjusting, closing and prior-period adjustments.
      { label: 'Others', to: '/accounting/others' },
      { label: 'Cash Advance Summary', to: '/accounting/cash-advances' },
      { label: 'Index of Payment', to: '/accounting/index-of-payments' },
      // Encoding the balances the books open with is not a report, though it
      // lived under Reports until somebody went looking for it in Accounting
      // and could not find it. It is the one-time act that opens the ledger:
      // the payables, the receivables and the unliquidated cash advances
      // carried in from whatever the municipality kept before.
      { label: 'Opening Balances', to: '/accounting/opening-balances' },
    ],
  },
  {
    label: 'Treasury',
    to: '/treasury',
    module: 'treasury',
    icon: 'treasury',
    // One item for each thing the office does. Each report lives inside the item
    // it reports on - the RCI inside Checks, the RCD inside Collections and
    // Deposits - rather than beside it, so the menu names the work and not the
    // paperwork.
    children: [
      { label: 'Checks', to: '/treasury/checks' },
      { label: 'ADA', to: '/treasury/ada' },
      // Collections and deposits are one item: the receipt and the deposit slip
      // are two halves of the same movement of money, and the RCD reports the
      // pair. The deposits register is a tab inside it.
      { label: 'Collections and Deposits', to: '/treasury/collections' },
      { label: 'Primary Reports', to: '/treasury/collections/primary' },
      { label: 'Accountable Forms', to: '/treasury/accountable-forms' },
      { label: 'RAAF', to: '/treasury/raaf' },
      { label: 'Payroll', to: '/treasury/payroll' },
      { label: 'Claim Sheet', to: '/treasury/claim-sheet' },
      { label: 'Cash Position', to: '/treasury/cash-position' },
    ],
  },
  {
    label: 'Reconciliation',
    to: '/reconciliation',
    module: 'reconciliation',
    icon: 'reconciliation',
    children: [{ label: 'Bank Reconciliation', to: '/reconciliation/bank' }],
  },
  {
    label: 'Reports',
    to: '/reports',
    module: 'reports',
    icon: 'reports',
    // Grouped by the office whose work the report presents, not by format.
    children: [
      { group: 'Budget Reports', label: 'SAOB', to: '/reports/saob' },
      { group: 'Budget Reports', label: 'Registry (RAAO)', to: '/budget/registry' },

      { group: 'Accounting Reports', label: 'Trial Balance', to: '/reports/trial-balance' },
      { group: 'Accounting Reports', label: 'Financial Statements', to: '/reports/financial-statements' },
      { group: 'Accounting Reports', label: 'General Ledger', to: '/reports/general-ledger' },
      { group: 'Accounting Reports', label: 'Subsidiary Ledger', to: '/reports/subsidiary-ledger' },
      { group: 'Accounting Reports', label: 'Journals', to: '/reports/journals' },
      { group: 'Accounting Reports', label: 'Aging Reports', to: '/reports/aging' },
      { group: 'Accounting Reports', label: 'Registers', to: '/reports/registers' },

      { group: 'Treasury Reports', label: 'Cash Position and Collections', to: '/reports/treasury' },
      { group: 'Treasury Reports', label: 'Abstract of General Collection', to: '/reports/abstract-of-collections' },
      { group: 'Treasury Reports', label: 'Summary of Collections', to: '/reports/summary-of-collections' },
      { group: 'Treasury Reports', label: 'Summary of RCDs (Transmittal)', to: '/reports/rcd-transmittal' },
      { group: 'Treasury Reports', label: 'Report of Checks Issued (RCI)', to: '/treasury/checks/rci' },
      { group: 'Treasury Reports', label: 'Report of ADA Issued (RADAI)', to: '/treasury/ada/radai' },
      { group: 'Treasury Reports', label: 'Report of Collections and Deposits (RCD)', to: '/treasury/collections/rcd' },
      { group: 'Treasury Reports', label: 'Report of Cash Disbursement (RCDisb)', to: '/treasury/payroll/rcdisb' },
      { group: 'Treasury Reports', label: 'Report of Cancelled Checks (RCC)', to: '/reports/cancelled-checks' },
      { group: 'Treasury Reports', label: 'Accountability for Accountable Forms (RAAF)', to: '/treasury/raaf' },
    ],
  },
  {
    label: 'Master Data',
    to: '/master-data',
    module: 'masterData',
    icon: 'masterData',
    children: [
      { label: 'Chart of Accounts', to: '/master-data/accounts' },
      { label: 'Payees', to: '/master-data/payees' },
      { label: 'Employees', to: '/master-data/employees' },
      { label: 'Offices', to: '/master-data/offices' },
      { label: 'Budget Structure', to: '/master-data/ppa' },
      { label: 'Banks', to: '/master-data/banks' },
      { label: 'Tax Codes', to: '/master-data/tax-codes' },
      { label: 'Revenue Codes', to: '/master-data/revenue-codes' },
      { label: 'Accountable Forms', to: '/master-data/accountable-forms' },
      { label: 'Funds', to: '/master-data/funds' },
    ],
  },
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
