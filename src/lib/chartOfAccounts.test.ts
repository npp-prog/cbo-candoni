import { describe, it, expect } from 'vitest';
import {
  accountClassFor,
  cashFlowClassFor,
  checkChart,
  checkNamedAccounts,
  deriveAccount,
  expenseClassFor,
  fsClassificationFor,
  isBudgetChargeable,
  isBudgetaryAccount,
  isCapitalOutlayAccount,
  isContraAccount,
  normalBalanceFor,
  requiresSubsidiaryFor,
} from './chartOfAccounts';

/**
 * Every code and title below is taken from the municipality's own chart, not
 * invented. A derivation that is right about a made-up code and wrong about
 * 10203011 has tested nothing.
 */

describe('accountClassFor', () => {
  it('reads the class out of the first digit', () => {
    expect(accountClassFor('10101010')).toBe('ASSET');
    expect(accountClassFor('20101010')).toBe('LIABILITY');
    expect(accountClassFor('30101010')).toBe('EQUITY');
    expect(accountClassFor('40101010')).toBe('REVENUE');
    expect(accountClassFor('50201010')).toBe('EXPENSE');
  });

  it('returns nothing for a code outside the five groups', () => {
    expect(accountClassFor('90000000')).toBeNull();
    expect(accountClassFor('')).toBeNull();
  });
});

describe('isContraAccount', () => {
  it('recognises the contra titles the chart actually uses', () => {
    expect(isContraAccount('Allowance for Impairment - Accounts Receivable')).toBe(true);
    expect(isContraAccount('Accumulated Depreciation - Investment Property, Buildings')).toBe(true);
    expect(isContraAccount('Accumulated Amortization - Patents/Copyrights')).toBe(true);
    expect(isContraAccount('Accumulated Impairment Losses - Computer Software')).toBe(true);
    expect(isContraAccount('Discount on Real Property Tax- Basic')).toBe(true);
    expect(isContraAccount('Sales Discounts')).toBe(true);
    expect(isContraAccount('Remeasurement Loss')).toBe(true);
  });

  /**
   * The code convention is contra = parent + 1, and 20102022 "Premium on Bonds
   * Payable" is parent + 2 and not contra. That is exactly why this is matched
   * on the title and not on the digits.
   */
  it('does not treat a premium as a contra account', () => {
    expect(isContraAccount('Premium on Bonds Payable - Domestic')).toBe(false);
  });

  it('does not match a title that merely mentions one of the words', () => {
    expect(isContraAccount('Discounts Granted to Senior Citizens')).toBe(false);
    expect(isContraAccount('Remeasurement Gain')).toBe(false);
  });
});

describe('normalBalanceFor', () => {
  it('gives assets and expenses a debit balance', () => {
    expect(normalBalanceFor('10101010', 'Cash Local Treasury')).toBe('DEBIT');
    expect(normalBalanceFor('50201010', 'Traveling Expenses - Local')).toBe('DEBIT');
  });

  it('gives liabilities, equity and revenue a credit balance', () => {
    expect(normalBalanceFor('20101010', 'Accounts Payable')).toBe('CREDIT');
    expect(normalBalanceFor('30101010', 'Government Equity')).toBe('CREDIT');
    expect(normalBalanceFor('40101010', 'Real Property Tax')).toBe('CREDIT');
  });

  /**
   * A hundred and thirty-five accounts in this chart are contra assets. One
   * recorded with a debit balance would be shown as an asset and would ADD to
   * net assets instead of reducing them.
   */
  it('flips a contra asset to credit', () => {
    expect(
      normalBalanceFor('10203011', 'Allowance for Impairment - Investments in Treasury Bills - Local'),
    ).toBe('CREDIT');
    expect(
      normalBalanceFor('10701011', 'Accumulated Depreciation - Construction and Heavy Equipment'),
    ).toBe('CREDIT');
  });

  it('flips a contra revenue and a contra liability to debit', () => {
    expect(normalBalanceFor('40102041', 'Discount on Real Property Tax- Basic')).toBe('DEBIT');
    expect(normalBalanceFor('20102021', 'Discount on Bonds Payable - Domestic')).toBe('DEBIT');
  });
});

describe('Capital Outlay', () => {
  /**
   * The finding that made this patch necessary. The 5-series has no Capital
   * Outlay account, so CBO - which offered only expense accounts as the object
   * of an obligation - could not encode a Capital Outlay obligation at all.
   */
  it('treats the capitalisable asset groups as Capital Outlay', () => {
    expect(isCapitalOutlayAccount('10601010')).toBe(true); // Investment Property, Land
    expect(isCapitalOutlayAccount('10701010')).toBe(true); // Land
    expect(isCapitalOutlayAccount('10801010')).toBe(true); // Breeding Stocks
    expect(isCapitalOutlayAccount('10901010')).toBe(true); // Patents/Copyrights
  });

  it('does not treat cash, receivables or inventories as Capital Outlay', () => {
    expect(isCapitalOutlayAccount('10101010')).toBe(false);
    expect(isCapitalOutlayAccount('10301010')).toBe(false);
    expect(isCapitalOutlayAccount('10401010')).toBe(false);
  });

  it('classes a capitalisable asset as CO', () => {
    expect(expenseClassFor('10705020', 'Office Buildings')).toBe('CO');
  });

  /** Accumulated depreciation is never bought. */
  it('gives a contra asset no expense class and refuses it as a budget charge', () => {
    expect(
      expenseClassFor('10705021', 'Accumulated Depreciation - Office Buildings'),
    ).toBeNull();
    expect(
      isBudgetChargeable('10705021', 'Accumulated Depreciation - Office Buildings'),
    ).toBe(false);
  });

  it('allows an expense account and a capitalisable asset as a budget charge', () => {
    expect(isBudgetChargeable('50203010', 'Office Supplies Expenses')).toBe(true);
    expect(isBudgetChargeable('10705020', 'Office Buildings')).toBe(true);
  });

  it('refuses cash and payables as a budget charge', () => {
    expect(isBudgetChargeable('10101010', 'Cash Local Treasury')).toBe(false);
    expect(isBudgetChargeable('20101010', 'Accounts Payable')).toBe(false);
  });
});

describe('expenseClassFor', () => {
  it('reads the expense class out of the major group', () => {
    expect(expenseClassFor('50101010', 'Salaries and Wages - Regular')).toBe('PS');
    expect(expenseClassFor('50201010', 'Traveling Expenses - Local')).toBe('MOOE');
    expect(expenseClassFor('50301010', 'Management Supervision/Trusteeship Fees')).toBe('FE');
  });

  /** Cost of sales of an economic enterprise: obligated as MOOE. */
  it('classes direct costs as MOOE', () => {
    expect(expenseClassFor('50401010', 'Direct Materials')).toBe('MOOE');
  });

  /**
   * Depreciation is never obligated and never appears in an appropriation.
   * Giving it an expense class would put it in the obligation picker beside
   * the things the municipality actually buys.
   */
  it('gives the non-cash expenses no expense class at all', () => {
    expect(expenseClassFor('50501010', 'Depreciation - Investment Property')).toBeNull();
  });

  it('gives a revenue or a liability no expense class', () => {
    expect(expenseClassFor('40101010', 'Real Property Tax')).toBeNull();
    expect(expenseClassFor('20101010', 'Accounts Payable')).toBeNull();
  });
});

describe('isBudgetaryAccount', () => {
  /**
   * The 3-05 series belongs to the budget registries. CBO keeps the registry
   * itself, so posting an appropriation to an equity account would give the
   * municipality two records of the same budget with nothing reconciling them.
   */
  it('recognises the registry accounts', () => {
    expect(isBudgetaryAccount('30502050')).toBe(true); // Appropriations – Annual Budget
    expect(isBudgetaryAccount('30503020')).toBe(true); // Obligations-Current Allotment
    expect(isBudgetaryAccount('30504010')).toBe(true); // Reversion of Unallotted CY Appropriations
    expect(isBudgetaryAccount('30501010')).toBe(true); // Fund Balance
  });

  it('leaves the real equity accounts alone', () => {
    expect(isBudgetaryAccount('30101010')).toBe(false); // Government Equity
    expect(isBudgetaryAccount('30201010')).toBe(false); // Income and Expense Summary
    expect(isBudgetaryAccount('31301010')).toBe(false); // Remeasurement Gain
  });
});

describe('fsClassificationFor', () => {
  it('splits current from non-current assets', () => {
    expect(fsClassificationFor('10101010')).toBe('CURRENT_ASSET'); // Cash
    expect(fsClassificationFor('10301010')).toBe('CURRENT_ASSET'); // Receivables
    expect(fsClassificationFor('10401010')).toBe('CURRENT_ASSET'); // Inventories
    expect(fsClassificationFor('10501010')).toBe('CURRENT_ASSET'); // Prepayments
    expect(fsClassificationFor('10201010')).toBe('NON_CURRENT_ASSET'); // Investments
    expect(fsClassificationFor('10701010')).toBe('NON_CURRENT_ASSET'); // PPE
  });

  it('splits current from non-current liabilities', () => {
    expect(fsClassificationFor('20101010')).toBe('CURRENT_LIABILITY');
    expect(fsClassificationFor('29999990')).toBe('CURRENT_LIABILITY'); // Other Payables
    expect(fsClassificationFor('20601010')).toBe('NON_CURRENT_LIABILITY'); // Provisions
  });

  it('classes equity, revenue and expense', () => {
    expect(fsClassificationFor('30101010')).toBe('NET_ASSETS_EQUITY');
    expect(fsClassificationFor('40101010')).toBe('REVENUE');
    expect(fsClassificationFor('50201010')).toBe('EXPENSE');
  });
});

describe('cashFlowClassFor', () => {
  it('puts the capitalisable assets and investments under investing', () => {
    expect(cashFlowClassFor('10701010', 'Land')).toBe('INVESTING');
    expect(cashFlowClassFor('10203010', 'Investments in Treasury Bills - Local')).toBe('INVESTING');
  });

  it('puts bonds and loans payable under financing', () => {
    expect(cashFlowClassFor('20102020', 'Bonds Payable - Domestic')).toBe('FINANCING');
    expect(cashFlowClassFor('20102040', 'Loans Payable - Domestic')).toBe('FINANCING');
  });

  it('puts the non-cash expenses and every contra account under non-cash', () => {
    expect(cashFlowClassFor('50501010', 'Depreciation - Investment Property')).toBe('NON_CASH');
    expect(
      cashFlowClassFor('10301011', 'Allowance for Impairment - Accounts Receivable'),
    ).toBe('NON_CASH');
  });

  it('puts the registry accounts under non-cash, since no cash moves in them', () => {
    expect(cashFlowClassFor('30502050', 'Appropriations – Annual Budget')).toBe('NON_CASH');
  });

  it('leaves everything else operating', () => {
    expect(cashFlowClassFor('10101010', 'Cash Local Treasury')).toBe('OPERATING');
    expect(cashFlowClassFor('50201010', 'Traveling Expenses - Local')).toBe('OPERATING');
  });
});

describe('requiresSubsidiaryFor', () => {
  it('sets the three CBO itself relies on', () => {
    expect(requiresSubsidiaryFor('20101010')).toBe(true); // Accounts Payable
    expect(requiresSubsidiaryFor('10301010')).toBe(true); // Accounts Receivable
    expect(requiresSubsidiaryFor('10305040')).toBe(true); // Advances to Officers and Employees
  });

  /**
   * "Due to BIR" does not need a subsidiary saying BIR. A rule that guessed
   * would turn every remittance line into a search for a party the account
   * already names.
   */
  it('leaves the remittance liabilities alone', () => {
    expect(requiresSubsidiaryFor('20201010')).toBe(false); // Due to BIR
    expect(requiresSubsidiaryFor('20101020')).toBe(false); // Due to Officers and Employees
  });
});

describe('deriveAccount', () => {
  it('derives a whole ordinary expense account', () => {
    expect(deriveAccount({ code: '50203010', name: 'Office Supplies Expenses' })).toEqual({
      code: '50203010',
      name: 'Office Supplies Expenses',
      accountClass: 'EXPENSE',
      normalBalance: 'DEBIT',
      fsClassification: 'EXPENSE',
      cashFlowClass: 'OPERATING',
      expenseClass: 'MOOE',
      postable: true,
      isControl: false,
      requiresSubsidiary: false,
      majorGroup: '502',
    });
  });

  it('derives a contra asset the opposite way round', () => {
    const a = deriveAccount({
      code: '10701011',
      name: 'Accumulated Depreciation - Construction and Heavy Equipment',
    });
    expect(a).toMatchObject({
      accountClass: 'ASSET',
      normalBalance: 'CREDIT',
      cashFlowClass: 'NON_CASH',
      expenseClass: null,
      postable: true,
    });
  });

  it('derives a registry account as not postable', () => {
    expect(
      deriveAccount({ code: '30502050', name: 'Appropriations – Annual Budget' })?.postable,
    ).toBe(false);
  });

  it('collapses the line breaks COA prints inside a title', () => {
    const a = deriveAccount({
      code: '10202020',
      name: 'Financial Assets Designated at Fair Value Through Surplus or\nDeficit',
    });
    expect(a?.name).toBe('Financial Assets Designated at Fair Value Through Surplus or Deficit');
  });

  it('returns nothing rather than a half-classified account', () => {
    expect(deriveAccount({ code: '90000000', name: 'Something' })).toBeNull();
  });
});

describe('checkChart', () => {
  const row = (lineNo: number, code: string, name = 'An account') => ({ lineNo, code, name });

  it('passes a clean file', () => {
    expect(checkChart([row(1, '10101010'), row(2, '20101010')]).ok).toBe(true);
  });

  it('refuses an empty file', () => {
    expect(checkChart([]).violations[0].code).toBe('CHART_EMPTY');
  });

  it('refuses a code that is not eight digits', () => {
    const result = checkChart([row(1, '1010101')]);
    expect(result.violations[0].code).toBe('CHART_BAD_CODE');
  });

  it('refuses a row with no title', () => {
    expect(checkChart([row(1, '10101010', '')]).violations[0].code).toBe('CHART_NO_NAME');
  });

  /**
   * The code is the account's identity, so a duplicate replaces rather than
   * adds: the chart would load with one of the two titles and report nothing.
   */
  it('refuses the same code twice and names both rows', () => {
    const result = checkChart([row(4, '10101010', 'Cash'), row(9, '10101010', 'Cash on Hand')]);
    const dup = result.violations.find((v) => v.code === 'CHART_DUPLICATE');
    expect(dup?.details).toMatchObject({ first: 4, second: 9 });
  });

  it('reports every bad row, not just the first', () => {
    const result = checkChart([row(1, 'abc'), row(2, '123')]);
    expect(result.violations.filter((v) => v.code === 'CHART_BAD_CODE')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('checkNamedAccounts', () => {
  /**
   * The accounts CBO hardcodes, held against the chart Candoni actually loads.
   *
   * This is the test that would have caught four shipped defects: collections
   * posted to Petty Cash under the title of an account the LGU chart does not
   * contain, deposits crediting the same, the current-account constant
   * carrying the savings-account code, and a payroll entry proposing an
   * account in no chart at all. Every one of those postings balanced, so
   * nothing else could have found them.
   */
  const chart = readShippedChart();

  it('reads the shipped chart', () => {
    expect(chart.length).toBeGreaterThan(600);
  });

  it('finds every hardcoded account in the chart under its own title', () => {
    expect(checkNamedAccounts(chart)).toEqual([]);
  });

  it('reports an account that is not in the chart', () => {
    const violations = checkNamedAccounts(chart.filter((r) => r.code !== '10305020'));
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('NAMED_ACCOUNT_MISSING');
  });

  it('reports an account whose title is not what the code posts it as', () => {
    const violations = checkNamedAccounts(
      chart.map((r) => (r.code === '10101020' ? { ...r, name: 'Cash - Collecting Officers' } : r)),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('NAMED_ACCOUNT_RENAMED');
    expect(violations[0].message).toContain('10101020');
  });
});

/** The chart as shipped, quoted titles and all. */
function readShippedChart(): Array<{ code: string; name: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '../../data/chart-of-accounts.csv'),
    'utf8',
  );

  const rows: Array<{ code: string; name: string }> = [];
  for (const raw of text.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const code = line.slice(0, comma).trim();
    let name = line.slice(comma + 1).trim();
    // A title containing a comma is quoted, in the ordinary CSV way.
    if (name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/""/g, '"');
    }
    rows.push({ code, name });
  }
  return rows;
}
