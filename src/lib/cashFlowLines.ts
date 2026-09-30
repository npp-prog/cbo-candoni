import { cashFlowClassFor } from '@/lib/chartOfAccounts';

/**
 * The lines of Annex 9, the Statement of Cash Flows.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS FORM POSES, AND WHY IT TURNED OUT NOT TO NEED A GUESS
 * ---------------------------------------------------------------------------
 * Annex 9 is a DIRECT-METHOD statement. It does not ask for "net cash from
 * operating activities"; it asks for "Collection from taxpayers", "Payments to
 * employees", "Payments to suppliers and creditors" - captions about what the
 * money was FOR.
 *
 * CBO records a cash-flow class against each journal entry line, and the
 * statement it shipped with read that class off the CASH line. That tells you
 * nothing, for two reasons. The class of a cash account is always OPERATING,
 * because that is what the classifier returns for anything that is not an
 * investment or a loan; and every posting routine on the server writes the
 * literal 'OPERATING' anyway. So the investing and financing sections of the
 * statement CBO has been printing are empty - not because Candoni bought no
 * equipment, but because there is no path by which they could ever fill.
 *
 * The captions are all about the counterpart in any case. "Payments to
 * employees" is a credit to Cash whose debit is Personnel Services.
 *
 * The obvious way out is to spread each journal entry's cash movement across
 * its other lines somehow, and every "somehow" is an assumption - which is why
 * this statement was held back rather than guessed at.
 *
 * It does not need one. A journal entry balances, so the signed amounts of the
 * non-cash lines sum to exactly the negative of the cash lines':
 *
 *     cash + (everything else) = 0     therefore    cash = -(everything else)
 *
 * So each non-cash line's contribution to that entry's cash movement is
 * PRECISELY the negative of its own signed amount. Not a share, not an
 * apportionment - double entry, and it adds up to the centavo by construction.
 *
 * A voucher of 100 with 5 withheld makes this concrete: Dr Expense 100, Cr Cash
 * 95, Cr Due to BIR 5. The expense line contributes -100 (an outflow of 100)
 * and the withholding line +5 (an inflow of 5, money the LGU kept and has not
 * yet remitted), and they net to the 95 that actually left the bank. That is
 * the gross presentation the direct method wants, and it is what happened.
 *
 * Two consequences fall out of this for free, and both are correct:
 *
 *   - A journal entry with no cash line contributes nothing. An accrual, a
 *     depreciation run, a liquidation that clears an advance against an
 *     expense: none of them moved cash and none of them appear.
 *   - A journal entry whose ONLY lines are cash accounts contributes nothing
 *     either, because it has no counterpart lines to attribute. The deposit of
 *     collections - Dr Cash in Bank, Cr Cash Collecting Officers - is exactly
 *     this, and it must contribute nothing or every peso collected would be
 *     counted twice, once on collection and once on deposit.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STILL A JUDGEMENT
 * ---------------------------------------------------------------------------
 * Which caption a counterpart account belongs to. That is read off the account
 * code and the direction of the money, the same way every other statement's
 * lines are, and an account that reaches no caption is reported rather than
 * dropped.
 */

export type CashFlowSection = 'OPERATING' | 'INVESTING' | 'FINANCING';

export interface CashFlowCaptionDef {
  section: CashFlowSection;
  /** Inflow captions print under "Cash Inflows", outflows under "Cash Outflows". */
  direction: 'IN' | 'OUT';
  caption: string;
  /** Account code prefixes. Longest match wins, across every section. */
  prefixes: string[];
  /** The catch-all for its section and direction, when no prefix matches. */
  fallback?: boolean;
}

/**
 * Annex 9's captions, in the annex's own order.
 *
 * Two kinds of prefix appear against each caption, because there are two ways
 * the same receipt reaches the books. Where an income account is credited as
 * the money arrives, the counterpart is that income account (4-01-01 and so
 * on). Where the income was accrued first, the collection credits the
 * RECEIVABLE instead and the income account is nowhere in the cash entry - so
 * Real Property Tax Receivable has to reach "Collection from taxpayers" too,
 * or the tax lines would print nil and the money would sit in Other Receipts.
 *
 * Cash itself (1-01) never appears here: it is the thing being explained, not
 * one of the explanations.
 */
export const CASH_FLOW_CAPTIONS: CashFlowCaptionDef[] = [
  // --- Operating, inflows -------------------------------------------------
  {
    section: 'OPERATING',
    direction: 'IN',
    caption: 'Collection from taxpayers',
    // Tax revenue, and the two tax receivables collections are credited to.
    prefixes: ['40101', '40102', '40103', '40104', '40105', '1030102', '1030103'],
  },
  {
    section: 'OPERATING',
    direction: 'IN',
    caption: 'Share from Internal Revenue Allotment',
    prefixes: ['40106'],
  },
  {
    section: 'OPERATING',
    direction: 'IN',
    caption: 'Receipts from business/service income',
    prefixes: ['402', '1030101', '10302'],
  },
  {
    section: 'OPERATING',
    direction: 'IN',
    caption: 'Interest Income',
    prefixes: ['40202220', '1030107'],
  },
  {
    section: 'OPERATING',
    direction: 'IN',
    caption: 'Dividend Income',
    prefixes: ['40202210', '1030108'],
  },
  { section: 'OPERATING', direction: 'IN', caption: 'Other Receipts', prefixes: [], fallback: true },

  // --- Operating, outflows ------------------------------------------------
  /*
   * "Payment of expenses" is the annex's general line and CBO never reaches
   * it: every operating payment it can see is already a payment to employees,
   * to suppliers and creditors, or of interest. It is printed because the
   * annex prints it, and it prints at nil.
   */
  { section: 'OPERATING', direction: 'OUT', caption: 'Payment of expenses', prefixes: [] },
  {
    section: 'OPERATING',
    direction: 'OUT',
    caption: 'Payments to suppliers and creditors',
    prefixes: ['502'],
  },
  { section: 'OPERATING', direction: 'OUT', caption: 'Payments to employees', prefixes: ['501'] },
  { section: 'OPERATING', direction: 'OUT', caption: 'Interest Expense', prefixes: ['503'] },
  { section: 'OPERATING', direction: 'OUT', caption: 'Other Expenses', prefixes: [], fallback: true },

  // --- Investing ----------------------------------------------------------
  {
    section: 'INVESTING',
    direction: 'IN',
    caption: 'Proceeds from Sale of Investment Property',
    prefixes: ['106'],
  },
  {
    section: 'INVESTING',
    direction: 'IN',
    caption: 'Proceeds from Sale/Disposal of Property, Plant and Equipment',
    prefixes: ['107'],
  },
  {
    section: 'INVESTING',
    direction: 'IN',
    caption: 'Proceeds from Sale of Non-Current Investments',
    prefixes: ['102'],
  },
  {
    section: 'INVESTING',
    direction: 'IN',
    caption: 'Collection of Principal on loans to other entities',
    // Loans Receivable - GOCC, LGUs and Others. Not the trade receivables.
    prefixes: ['1030105', '1030106', '1030199'],
  },

  {
    section: 'INVESTING',
    direction: 'OUT',
    caption: 'Purchase/Construction of Investment Property',
    prefixes: ['106'],
  },
  {
    section: 'INVESTING',
    direction: 'OUT',
    caption: 'Purchase/Construction of Property, Plant and Equipment',
    prefixes: ['107'],
  },
  { section: 'INVESTING', direction: 'OUT', caption: 'Investment', prefixes: ['102'] },
  {
    section: 'INVESTING',
    direction: 'OUT',
    caption: 'Purchase of Bearer Biological Assets',
    prefixes: ['108'],
  },
  {
    section: 'INVESTING',
    direction: 'OUT',
    caption: 'Purchase of Intangible Assets',
    prefixes: ['109'],
  },
  {
    section: 'INVESTING',
    direction: 'OUT',
    caption: 'Grant of Loans',
    prefixes: ['1030105', '1030106', '1030199'],
  },

  // --- Financing ----------------------------------------------------------
  {
    section: 'FINANCING',
    direction: 'IN',
    caption: 'Proceeds from Issuance of Bonds',
    prefixes: ['2010202'],
  },
  { section: 'FINANCING', direction: 'IN', caption: 'Proceeds from Loans', prefixes: ['20102'] },

  {
    section: 'FINANCING',
    direction: 'OUT',
    caption: 'Payment of Long-Term Liabilities',
    prefixes: [],
    fallback: true,
  },
  {
    section: 'FINANCING',
    direction: 'OUT',
    caption: 'Retirement/Redemption of debt securities',
    prefixes: ['2010202'],
  },
  {
    section: 'FINANCING',
    direction: 'OUT',
    caption: 'Payment of loan amortization',
    prefixes: ['2010204', '2010205'],
  },
];

/**
 * Annex 9-A, the Trust Fund's own face.
 *
 * The annex gives the Trust Fund a much shorter statement: one operating
 * inflow, "Other Receipts"; two operating outflows, "Payments to suppliers and
 * creditors" and "Other Expenses"; and investing and financing sections
 * printed as headings with no caption lines beneath them at all.
 *
 * That last part is a presentation, not a rule that the Trust Fund cannot
 * invest or borrow, so the statement keeps the full investing and financing
 * captions available and prints only the ones carrying a figure. A trust fund
 * with nothing in those sections therefore looks exactly like the annex, and
 * one with something in them shows it rather than losing it.
 */
export const TRUST_FUND_CODE = 'TF';

export const TRUST_FUND_OPERATING: CashFlowCaptionDef[] = [
  { section: 'OPERATING', direction: 'IN', caption: 'Other Receipts', prefixes: [], fallback: true },
  {
    section: 'OPERATING',
    direction: 'OUT',
    caption: 'Payments to suppliers and creditors',
    prefixes: ['502'],
  },
  { section: 'OPERATING', direction: 'OUT', caption: 'Other Expenses', prefixes: [], fallback: true },
];

/** The captions in force for a fund: Annex 9, or Annex 9-A for the Trust Fund. */
export function captionsForFund(fundCode?: string): CashFlowCaptionDef[] {
  if (fundCode !== TRUST_FUND_CODE) return CASH_FLOW_CAPTIONS;
  return [
    ...TRUST_FUND_OPERATING,
    ...CASH_FLOW_CAPTIONS.filter((d) => d.section !== 'OPERATING'),
  ];
}

/**
 * Cash and cash equivalents: major group 1-01, the accounts the statement
 * explains. In Candoni's chart that is Cash Local Treasury, Petty Cash and the
 * four Cash in Bank accounts. Group 1-02 is Investments - it opens with two
 * time-deposit accounts whose titles also begin "Cash in Bank", and they are
 * deliberately NOT treated as cash here, because the chart classifies them as
 * investments and the statement follows the chart.
 */
export const CASH_GROUP = '101';

export function isCashAccount(code: string): boolean {
  return String(code ?? '').trim().slice(0, 3) === CASH_GROUP;
}

/**
 * The caption a counterpart account falls on, given which way the money went.
 *
 * Direction matters as much as the code: 1-07 Property, Plant and Equipment is
 * "Proceeds from Sale/Disposal" when cash came in against it and
 * "Purchase/Construction" when it went out. The same account, opposite
 * captions, and nothing but the sign to tell them apart.
 *
 * The section comes from the matched caption rather than from the account's
 * own cash-flow class, because the two do not always agree and the annex is
 * the authority on where a line prints. Loans Receivable is the case that
 * forces it: the classifier calls major group 1-03 operating, which is right
 * for trade receivables, while the annex puts lending and its repayment under
 * investing. Only where no prefix matches at all does the account's own class
 * choose which section's catch-all takes it.
 */
export function captionFor(
  code: string,
  direction: 'IN' | 'OUT',
  accountName = '',
  captions: CashFlowCaptionDef[] = CASH_FLOW_CAPTIONS,
): CashFlowCaptionDef {
  const c = String(code ?? '').trim();
  let best: CashFlowCaptionDef | undefined;
  let bestLength = -1;

  for (const def of captions) {
    if (def.direction !== direction) continue;
    for (const prefix of def.prefixes) {
      if (c.startsWith(prefix) && prefix.length > bestLength) {
        best = def;
        bestLength = prefix.length;
      }
    }
  }
  if (best) return best;

  // Nothing matched: the account's own class picks the section, and that
  // section's catch-all takes the figure. NON_CASH lands in operating - an
  // account classed as never moving cash has just been found in an entry that
  // did, and operating is where the annex puts what it cannot place.
  const cls = cashFlowClassFor(c, accountName);
  const section: CashFlowSection = cls === 'INVESTING' || cls === 'FINANCING' ? cls : 'OPERATING';

  return (
    captions.find((d) => d.fallback && d.direction === direction && d.section === section) ??
    captions.find((d) => d.fallback && d.direction === direction && d.section === 'OPERATING')!
  );
}
