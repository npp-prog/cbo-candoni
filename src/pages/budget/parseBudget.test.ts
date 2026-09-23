import { describe, it, expect } from 'vitest';
import { parseBudgetFile } from './parseBudget';

function csvFile(text: string, name = 'ordinance.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

const HEADER = 'Office,Account Code,Account Title,Expense Class,Amount,Purpose';

describe('parseBudgetFile', () => {
  it('reads an annex row and normalises the expense class', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          'Office of the Mayor,50101010,Salaries and Wages - Regular,Personnel Services,"4,820,000.00",\n' +
          'Municipal Accounting Office,50203010,Office Supplies Expenses,MOOE,"185,000.00",Annual requirement\n',
      ),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      office: 'Office of the Mayor',
      accountCode: '50101010',
      expenseClass: 'PS',
      amount: 482_000_000,
    });
    expect(rows[1].expenseClass).toBe('MOOE');
    expect(rows[1].particulars).toBe('Annual requirement');
    expect(rows.every((r) => !r.problem)).toBe(true);
  });

  /**
   * The one that would do damage quietly. An annex prints a sub-total under
   * each office: an amount with no account against it. Taken as a budget line
   * it would post the office's whole budget a second time, and the ordinance
   * total would still look right because the annex's own grand total includes
   * those sub-totals too.
   */
  it('ignores the sub-total rows an annex prints under each office', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          'Office of the Mayor,50101010,Salaries and Wages,PS,"4,820,000.00",\n' +
          'Office of the Mayor,50203010,Office Supplies,MOOE,"185,000.00",\n' +
          ',,,,"5,005,000.00",TOTAL - Office of the Mayor\n' +
          ',,,,,\n',
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(500_500_000);
  });

  it('flags a row that is missing something rather than dropping it', async () => {
    const rows = await parseBudgetFile(
      csvFile(`${HEADER}\nOffice of the Mayor,,,,"1,000.00",\n`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].problem).toContain('no account code');
  });

  it('keeps a negative amount, which a realignment needs', async () => {
    const rows = await parseBudgetFile(
      csvFile(`${HEADER}\nOffice of the Mayor,50203010,Office Supplies,MOOE,"-50,000.00",Realigned\n`),
    );
    expect(rows[0].amount).toBe(-5_000_000);
  });

  it('reads an office column headed Department', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        'Department,UACS Code,Allotment Class,Appropriation\n' +
          'MAYOR,50101010,PS,"4,820,000.00"\n',
      ),
    );
    expect(rows[0].office).toBe('MAYOR');
    expect(rows[0].accountCode).toBe('50101010');
    expect(rows[0].expenseClass).toBe('PS');
    expect(rows[0].amount).toBe(482_000_000);
  });
});
