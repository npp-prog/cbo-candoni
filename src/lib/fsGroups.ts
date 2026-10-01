/**
 * The condensed lines of the financial statements.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATEMENTS ARE NOT A LIST OF ACCOUNTS
 * ---------------------------------------------------------------------------
 * GAM for LGUs, Volume I, Section 366: "The Statement of Financial Position
 * shall be presented in CONDENSED FORMAT and with comparative figure of the
 * preceding year."
 *
 * Annex 5 shows what condensed means. Not six hundred and twenty-five account
 * titles but sixteen captions - Cash and Cash Equivalents, Receivables,
 * Inventories, Property Plant and Equipment and the rest - each of which is an
 * account GROUP of the Revised Chart of Accounts.
 *
 * CFMS used to print every account under seven broad headings. That is a trial
 * balance with subtotals, not a statement of financial position, and it is not
 * what is submitted.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CAPTIONS COME FROM, AND WHY THEY ARE NOT A GUESS
 * ---------------------------------------------------------------------------
 * The eight-digit account code carries the answer. GAM Volume III, Section
 * 2.2: "0 00 00 00 0 - Account Group / Major Account Group / Sub-Major Account
 * Group / General Ledger Accounts". The first digit is the class and the next
 * two are the major group, and Volume III's Chapter 2 names every one of them:
 *
 *   1 01 Cash          1 02 Investments       1 03 Receivables
 *   1 04 Inventories   1 05 Prepayments       1 06 Investment Property
 *   1 07 Property, Plant and Equipment        1 08 Biological Assets
 *   1 09 Intangible Assets                    1 99 Other Assets
 *   2 01 Financial Liabilities                2 02 Inter-Agency Payables
 *   2 03 Intra-Agency Payables                2 04 Trust Liabilities
 *   2 05 Deferred Credits/Unearned Income     2 06 Provisions
 *   2 99 Other Payables
 *   3 01 Government Equity   3 02 Intermediate Accounts
 *   3 03 Equity in Joint Venture              3 04 Unrealized Gain/(Loss)
 *   3 05 Budgetary Accounts
 *   4 01 Tax Revenue         4 02 Service and Business Income
 *   4 03 Transfers and Subsidy                4 04 Shares, Grants and Donations
 *   4 05 Gains               4 06 Miscellaneous Income
 *   5 01 Personnel Services  5 02 Maintenance and Other Operating Expenses
 *   5 03 Financial Expenses  5 04 Direct Costs   5 05 Non-Cash Expenses
 *
 * So the caption an account belongs to is read off its code, not decided here.
 * Where Annex 5 or Annex 6 prints a caption in slightly different words from
 * Volume III's group name - "Cash and Cash Equivalents" for the group called
 * "Cash", "Other Income" for "Miscellaneous Income" - the ANNEX wording is
 * used, because the annex is the statement and Volume III is the chart.
 *
 * ---------------------------------------------------------------------------
 * WHICH SECTION A CAPTION SITS IN IS A SEPARATE QUESTION
 * ---------------------------------------------------------------------------
 * Annex 5 lists Investments and Receivables under BOTH current and
 * non-current. The major group does not say which, and nothing in the account
 * code does. CFMS already answers this per account through
 * `fsClassificationFor`, so the caption comes from the group and the section
 * comes from that existing classification. Neither is invented here.
 *
 * One consequence worth stating: CFMS classifies the whole of Investments as
 * non-current. An LGU holding a time deposit maturing within the year has a
 * current investment, and reporting it would need the account itself to say
 * so - it cannot be read off the code.
 */

/** Class digit plus major group: the first three characters of the code. */
export type MajorGroupKey = string;

/**
 * Every major group, and the caption it prints under on the statements.
 *
 * Keyed by the first three digits. An account whose group is not here is not
 * dropped - see `captionFor`, which says so rather than losing the figure.
 */
export const GROUP_CAPTIONS: Record<MajorGroupKey, string> = {
  // Assets
  '101': 'Cash and Cash Equivalents',
  '102': 'Investments',
  '103': 'Receivables',
  '104': 'Inventories',
  '105': 'Prepayments and Deferred Charges',
  '106': 'Investment Property',
  '107': 'Property, Plant and Equipment',
  '108': 'Biological Assets',
  '109': 'Intangible Assets',
  '199': 'Other Assets',
  // Liabilities
  '201': 'Financial Liabilities',
  '202': 'Inter-Agency Payables',
  '203': 'Intra-Agency Payables',
  '204': 'Trust Liabilities',
  '205': 'Deferred Credits/Unearned Income',
  '206': 'Provisions',
  '299': 'Other Payables',
  // Net assets / equity
  '301': 'Government Equity',
  '302': 'Intermediate Accounts',
  '303': 'Equity in Joint Venture',
  '304': 'Unrealized Gain/(Loss)',
  '305': 'Fund Balance',
  '313': 'Remeasurement Gain/(Loss)',
  // Revenue
  '401': 'Tax Revenue',
  '402': 'Service and Business Income',
  '403': 'Transfers and Subsidy',
  '404': 'Shares, Grants and Donations',
  '405': 'Gains',
  '406': 'Other Income',
  // Expenses
  '501': 'Personnel Services',
  '502': 'Maintenance and Other Operating Expenses',
  '503': 'Financial Expenses',
  '504': 'Direct Costs',
  '505': 'Non-Cash Expenses',
};

/**
 * The caption an account prints under, or null when its group is unknown.
 *
 * Null is deliberate and is NOT the same as zero. A statement that silently
 * dropped an account it did not recognise would still balance - the figure
 * would simply be missing from both a caption and the total - and nobody would
 * ever find it. The screen shows unknown groups on a line of their own.
 */
export function captionFor(code: string): string | null {
  const key = String(code ?? '').trim().slice(0, 3);
  return GROUP_CAPTIONS[key] ?? null;
}

export function majorGroupOf(code: string): MajorGroupKey {
  return String(code ?? '').trim().slice(0, 3);
}

/**
 * The budgetary registry accounts, 3-05.
 *
 * Annex 5 prints a Fund Balance block beneath Government Equity -
 * Unappropriated Surplus, Continuing Allotments, Continuing Appropriations,
 * Commitments. In CFMS those accounts are NOT POSTABLE: the budgetary registry
 * is kept in `budgetBalances`, maintained by the Cloud Functions, and never
 * journalised. So the ledger carries nothing against them and the block cannot
 * be filled from it.
 *
 * It could be derived from the Registry instead, but which registry figure
 * answers to which of those four captions is a judgement, and one wrong
 * mapping there is a wrong figure on a submitted statement. It is left blank
 * with the reason on the screen until the Accountant says which is which.
 */
export const FUND_BALANCE_GROUP = '305';

export const FUND_BALANCE_CAPTIONS = [
  'Unappropriated Surplus',
  'Continuing Allotments',
  'Continuing Appropriations',
  'Commitments',
];

// ---------------------------------------------------------------------------
// Annex 5 - Statement of Financial Position
// ---------------------------------------------------------------------------

export interface StatementSectionDef {
  key: string;
  title: string;
  /** Captions in the order the annex prints them. */
  captions: string[];
  /** The subtotal line beneath them. */
  totalLabel: string;
}

export const POSITION_SECTIONS: StatementSectionDef[] = [
  {
    key: 'CURRENT_ASSET',
    title: 'Current Assets',
    captions: [
      'Cash and Cash Equivalents',
      'Investments',
      'Receivables',
      'Inventories',
      'Prepayments and Deferred Charges',
    ],
    totalLabel: 'Total Current Assets',
  },
  {
    key: 'NON_CURRENT_ASSET',
    title: 'Non-Current Assets',
    captions: [
      'Investments',
      'Receivables',
      'Investment Property',
      'Property, Plant and Equipment',
      'Biological Assets',
      'Intangible Assets',
      // Not on Annex 5. Carried so the total foots: 1-99 Other Assets exists in
      // the chart, and a statement that left it out would not add up to the
      // trial balance.
      'Other Assets',
    ],
    totalLabel: 'Total Non-Current Assets',
  },
  {
    key: 'CURRENT_LIABILITY',
    title: 'Current Liabilities',
    captions: [
      'Financial Liabilities',
      'Inter-Agency Payables',
      'Intra-Agency Payables',
      'Trust Liabilities',
      'Deferred Credits/Unearned Income',
      'Other Payables',
    ],
    totalLabel: 'Total Current Liabilities',
  },
  {
    key: 'NON_CURRENT_LIABILITY',
    title: 'Non-Current Liabilities',
    captions: [
      'Financial Liabilities',
      'Deferred Credits/Unearned Income',
      'Provisions',
      'Other Payables',
    ],
    totalLabel: 'Total Non-Current Liabilities',
  },
];

// ---------------------------------------------------------------------------
// Annex 6 - Statement of Financial Performance
// ---------------------------------------------------------------------------

export interface PerformanceLineDef {
  caption: string;
  /**
   * Account code PREFIXES feeding the line, longest match winning.
   *
   * Prefixes and not major groups, because Annex 6 splits one major group in
   * two. See the note on the national shares below.
   */
  groups: string[];
}

/**
 * Annex 6's revenue captions, in its order.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NATIONAL SHARES NEED A FINER PREFIX THAN THE REST
 * ---------------------------------------------------------------------------
 * Every other line here is a whole major group. These two are not: the
 * municipality's shares of national taxes sit in SUB-MAJOR group 4-01-06,
 * inside major group 4-01 Tax Revenue -
 *
 *   40106010 Share from Internal Revenue Collections (IRA)
 *   40106020 Share from Expanded Value Added Tax
 *   40106030 Share from National Wealth
 *   40106040 Share from Tobacco Excise Tax (RA 7171 and 8240)
 *   40106050 Share from Economic Zones
 *
 * - and Annex 6 prints them on two lines of their own, apart from Tax Revenue.
 * So "Tax Revenue" takes 40101 to 40105 and the two share lines take 40106,
 * with the IRA account alone on the first.
 *
 * ---------------------------------------------------------------------------
 * A CORRECTION, RECORDED BECAUSE IT WAS SHIPPED WRONG
 * ---------------------------------------------------------------------------
 * Patch 48 left both share lines empty and said in terms that Candoni's chart
 * carries no National Tax Allotment account. It does - 40106010, above. The
 * claim came from a search of the chart whose output was cut off at ten lines
 * by unrelated matches on the word "Allotment" in the equity accounts, and the
 * conclusion was drawn from the truncated result without checking.
 *
 * The same false finding was written into the statutory limits screen in patch
 * 46, where it pointed at 40301010 Subsidy from National Government as "the
 * nearest thing" - which would have put the wrong denominator under the 20%
 * Development Fund test.
 */
export const PERFORMANCE_REVENUE: PerformanceLineDef[] = [
  // 40106 is carved out below, so Tax Revenue is named group by group rather
  // than as the whole of 401.
  { caption: 'Tax Revenue', groups: ['40101', '40102', '40103', '40104', '40105'] },
  { caption: 'Share from Internal Revenue Collections', groups: ['4010601'] },
  { caption: 'Other Share from National Taxes', groups: ['40106'] },
  { caption: 'Service and Business Income', groups: ['402'] },
  { caption: 'Shares, Grants and Donations', groups: ['404'] },
  { caption: 'Gains', groups: ['405'] },
  { caption: 'Other Income', groups: ['406'] },
];

/**
 * The line an account falls on, by longest matching prefix.
 *
 * Longest wins so that 4010601 (the IRA account) beats 40106 (the other
 * national shares) which beats nothing. A plain lookup by major group cannot
 * express that, and getting it wrong would report the municipality's largest
 * single income on the wrong line of a submitted statement.
 */
export function lineForCode(
  defs: PerformanceLineDef[],
  code: string,
): PerformanceLineDef | undefined {
  const c = String(code ?? '').trim();
  let best: PerformanceLineDef | undefined;
  let bestLength = -1;
  for (const def of defs) {
    for (const prefix of def.groups) {
      if (c.startsWith(prefix) && prefix.length > bestLength) {
        best = def;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Annex 6's expense captions, in ITS order - which is not the chart's.
 *
 * The annex prints Non-cash Expenses (5-05) before Financial Expenses (5-03).
 * Direct Costs (5-04) is not on the annex at all; it belongs to economic
 * enterprises, and it is carried here so the total foots.
 */
export const PERFORMANCE_EXPENSES: PerformanceLineDef[] = [
  { caption: 'Personnel Services', groups: ['501'] },
  { caption: 'Maintenance and Other Operating Expenses', groups: ['502'] },
  { caption: 'Non-Cash Expenses', groups: ['505'] },
  { caption: 'Financial Expenses', groups: ['503'] },
  { caption: 'Direct Costs', groups: ['504'] },
];

/**
 * Annex 6-A: the Trust Fund's own Statement of Financial Performance.
 *
 * A shorter form, and shorter for a reason rather than for brevity. Trust money
 * arrives as a grant or a donation for a stated purpose, so the only revenue
 * caption is that one; there is no tax revenue in a trust fund and no business
 * income. On the expense side the annex carries no Financial Expenses and no
 * Direct Costs.
 *
 * It matters because the performance statement prints its nil lines on purpose
 * - a nil line says something on the General Fund - and on the Trust Fund a
 * "Tax Revenue" line at nil says nothing at all except that somebody printed
 * the wrong form.
 *
 * The position statement needs no such list: Annex 5-A is Annex 5 with the
 * captions a trust fund never uses left out, and those are left out already
 * because a caption nothing was posted to is not printed.
 */
export const PERFORMANCE_REVENUE_TF: PerformanceLineDef[] = [
  { caption: 'Grants and Donations', groups: ['404'] },
];

export const PERFORMANCE_EXPENSES_TF: PerformanceLineDef[] = [
  { caption: 'Personnel Services', groups: ['501'] },
  { caption: 'Maintenance and Other Operating Expenses', groups: ['502'] },
  { caption: 'Non-Cash Expenses', groups: ['505'] },
];

/**
 * The transfers block beneath the surplus from current operation.
 *
 * Group 4-03 is "Transfers and Subsidy" and holds both directions in the
 * Revised Chart of Accounts. Candoni's chart carries only the inward accounts
 * - eleven of them, every one a "Subsidy from" or a "Transfer from" - so the
 * outward line has nothing behind it here and prints at nil.
 */
export const TRANSFERS_GROUP = '403';
