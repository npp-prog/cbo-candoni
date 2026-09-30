import { describe, it, expect } from 'vitest';
import { parseReceiptsFile } from './parseReceipts';

function csvFile(text: string, name = 'lbp1-receipts.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

const QUARTERLY =
  'Account Code,Account Title,Income Class,1st Quarter,2nd Quarter,3rd Quarter,4th Quarter';
const ANNUAL = 'Account Code,Particulars,Income Class,Budget Year';

const row = (parts: string[]) => parts.join(',') + '\n';

describe('parseReceiptsFile', () => {
  it('reads a quarterly schedule', async () => {
    const rows = await parseReceiptsFile(
      csvFile(
        `${QUARTERLY}\n` +
          row([
            '40101010',
            'Real Property Tax - Basic',
            'Regular',
            '"1,000,000.00"',
            '"500,000.00"',
            '"250,000.00"',
            '"250,000.00"',
          ]),
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountCode: '40101010',
      accountName: 'Real Property Tax - Basic',
      incomeClass: 'REGULAR',
      q1: 100_000_000,
      q2: 50_000_000,
      q3: 25_000_000,
      q4: 25_000_000,
      annualOnly: false,
    });
    expect(rows[0].problem).toBeUndefined();
  });

  /**
   * The decision this parser exists to get right. An office that holds only
   * the budget-year column must not have it quartered for them: four figures
   * nobody estimated would produce a variance on LBAc Form No. 1 that CBO
   * invented and the Treasurer signs.
   */
  it('puts an annual-only figure in one quarter rather than dividing it by four', async () => {
    const rows = await parseReceiptsFile(
      csvFile(`${ANNUAL}\n` + row(['40201010', 'Business Tax', 'Regular', '"4,000,000.00"'])),
    );

    expect(rows[0].annualOnly).toBe(true);
    expect(rows[0].q1).toBe(0);
    expect(rows[0].q2).toBe(0);
    expect(rows[0].q3).toBe(0);
    expect(rows[0].q4).toBe(400_000_000);
  });

  it('reads the three income classes however the office writes them', async () => {
    const rows = await parseReceiptsFile(
      csvFile(
        `${ANNUAL}\n` +
          row(['40101010', 'RPT', 'Regular Income', '100']) +
          row(['40401010', 'Grants', 'Non-Regular Income', '100']) +
          row(['10301010', 'Loan proceeds', 'NON INCOME RECEIPTS', '100']),
      ),
    );

    expect(rows.map((r) => r.incomeClass)).toEqual(['REGULAR', 'NON_REGULAR', 'NON_INCOME']);
  });

  /**
   * "Non-Regular Income" and "Non-Income Receipts" both begin with "non".
   * Confusing them leaves both outside regular income, so the statutory limits
   * come out right and the SRE does not.
   */
  it('does not confuse non-regular income with non-income receipts', async () => {
    const rows = await parseReceiptsFile(
      csvFile(
        `${ANNUAL}\n` +
          row(['40401010', 'Donation', 'Non-Regular', '100']) +
          row(['10301010', 'Bonds issued', 'Non-Income', '100']),
      ),
    );

    expect(rows[0].incomeClass).toBe('NON_REGULAR');
    expect(rows[1].incomeClass).toBe('NON_INCOME');
  });

  it('flags a class it does not recognise instead of guessing', async () => {
    const rows = await parseReceiptsFile(
      csvFile(`${ANNUAL}\n` + row(['40101010', 'RPT', 'Ordinary', '100'])),
    );
    expect(rows[0].problem).toContain('not an income class');
  });

  it('defaults an unclassed row to regular income without flagging it', async () => {
    const rows = await parseReceiptsFile(
      csvFile('Account Code,Particulars,Budget Year\n' + row(['40101010', 'RPT', '100'])),
    );
    expect(rows[0].incomeClass).toBe('REGULAR');
    expect(rows[0].problem).toBeUndefined();
  });

  /**
   * The heading and sub-total rows LBP Form No. 1 prints between sections.
   * They carry an amount and no account code, and adding them would double the
   * municipality's estimated income.
   */
  it('skips a row with no account code and no amount', async () => {
    const rows = await parseReceiptsFile(
      csvFile(
        `${ANNUAL}\n` +
          row(['', 'A. Local Sources', '', '']) +
          row(['40101010', 'RPT', 'Regular', '100']),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].accountCode).toBe('40101010');
  });

  it('flags a sub-total row that carries an amount but no account code', async () => {
    const rows = await parseReceiptsFile(
      csvFile(`${ANNUAL}\n` + row(['', 'Total Tax Revenue', 'Regular', '"9,000.00"'])),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].problem).toContain('no account code');
  });

  /**
   * A file that states both and disagrees with itself. Neither column is
   * obviously right, so nothing is preferred silently - a quietly chosen
   * column here is a wrong total on a form the Treasurer signs.
   */
  it('refuses a row whose quarters disagree with its year column', async () => {
    const rows = await parseReceiptsFile(
      csvFile(
        'Account Code,Particulars,1st Quarter,2nd Quarter,3rd Quarter,4th Quarter,Budget Year\n' +
          row(['40101010', 'RPT', '100', '100', '100', '100', '"500.00"']),
      ),
    );
    expect(rows[0].problem).toContain('the quarters come to');
  });

  it('accepts a row whose quarters agree with its year column', async () => {
    const rows = await parseReceiptsFile(
      csvFile(
        'Account Code,Particulars,1st Quarter,2nd Quarter,3rd Quarter,4th Quarter,Budget Year\n' +
          row(['40101010', 'RPT', '"1.00"', '"1.00"', '"1.00"', '"1.00"', '"4.00"']),
      ),
    );
    expect(rows[0].problem).toBeUndefined();
    expect(rows[0].annualOnly).toBe(false);
    expect(rows[0].q4).toBe(100);
  });

  it('flags a negative estimate', async () => {
    const rows = await parseReceiptsFile(
      csvFile(`${ANNUAL}\n` + row(['40101010', 'RPT', 'Regular', '-100'])),
    );
    expect(rows[0].problem).toContain('negative');
  });

  /**
   * LBP Form No. 1 carries a past-year actual and a current-year estimate
   * beside the budget year. Reading one of those as the budget would post the
   * wrong year's figure with no error at all.
   */
  it('reads the budget-year column and not the current-year one', async () => {
    const rows = await parseReceiptsFile(
      csvFile(
        'Account Code,Particulars,Past Year (Actual),Current Year Estimate,Budget Year\n' +
          row(['40101010', 'RPT', '"1,000.00"', '"2,000.00"', '"3,000.00"']),
      ),
    );
    expect(rows[0].q4).toBe(300_000);
  });
});
