import { describe, it, expect } from 'vitest';
import { parseBudgetFile } from './parseBudget';

function csvFile(text: string, name = 'ordinance.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

/** The ten columns of the FY2025 appropriation annex, in its own words. */
const HEADER =
  'Fund,Office/Function Code,Office/Function Name,Allotment Class,' +
  'Annual Appropriation Amount,Continuing Appropriations Amount,Sector,' +
  'General Appropriation Ordinance No.,FPP,FPP Name';

const row = (parts: string[]) => parts.join(',') + '\n';

describe('parseBudgetFile', () => {
  it('reads a line of the annex as the office writes it', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          row([
            'General Fund',
            '1011',
            'Executive Services (Mayor)',
            'PS',
            '"5,692,848.00"',
            '0',
            'General Public Services',
            '2025-003',
            '5-01-01-010',
            'Salaries and Wages - Regular',
          ]),
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fpp: '5-01-01-010',
      fppName: 'Salaries and Wages - Regular',
      sector: 'General Public Services',
      expenseClass: 'PS',
      amount: 569_284_800,
    });
    expect(rows[0].problem).toBeUndefined();
  });

  /**
   * The rule that makes the whole model work. An FPP that looks like an object
   * code IS the object code; an FPP that is a project name leaves the account
   * column empty, and that is how the ordinance was enacted rather than
   * something missing.
   */
  it('takes the FPP as the account code when it is one', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          row(['General Fund', '1011', 'Mayor', 'MOOE', '"300,000"', '0', 'Economic Services', '2025-003', '5-02-01-010', 'Traveling']),
      ),
    );
    expect(rows[0].accountCode).toBe('5-02-01-010');
  });

  it('leaves the account code empty when the FPP is a project', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          row(['General Fund', '1011', 'Mayor', 'CO', '"2,000,000"', '0', '20% Development Fund', '2025-003', 'Acquisition of Service Vehicle', 'Acquisition of Service Vehicle']),
      ),
    );
    expect(rows[0].accountCode).toBe('');
    expect(rows[0].fpp).toBe('Acquisition of Service Vehicle');
    expect(rows[0].problem).toBeUndefined();
  });

  /**
   * The file carries an annual column and a continuing column. Reading the
   * wrong one would post last year's carry-over as this year's budget, and the
   * ordinance total would be wrong by exactly the continuing appropriations -
   * a figure nobody checks because it is usually zero.
   */
  it('reads the annual column, not the continuing one', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          row(['General Fund', '1011', 'Mayor', 'MOOE', '"300,000"', '"999,999"', 'Economic Services', '2025-003', '5-02-01-010', 'Traveling']),
      ),
    );
    expect(rows[0].amount).toBe(30_000_000);
  });

  /**
   * The one that would do damage quietly. An annex prints a sub-total under
   * each office: an amount with no line against it. Taken as a budget line it
   * would post the office's budget a second time, and the grand total would
   * still look right because the annex's own total includes the sub-totals.
   */
  it('ignores the sub-total rows an annex prints under each office', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          row(['General Fund', '1011', 'Mayor', 'PS', '"4,820,000"', '0', 'General Public Services', '2025-003', '5-01-01-010', 'Salaries']) +
          row(['General Fund', '1011', 'Mayor', 'MOOE', '"185,000"', '0', 'General Public Services', '2025-003', '5-02-03-010', 'Supplies']) +
          ',,,,"5005000",,,,,TOTAL - Office of the Mayor\n' +
          ',,,,,,,,,\n',
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(500_500_000);
  });

  it('flags a row with no FPP rather than dropping it', async () => {
    const rows = await parseBudgetFile(
      csvFile(`${HEADER}\n` + row(['General Fund', '1011', 'Mayor', 'PS', '"1,000"', '0', 'General Public Services', '2025-003', '', ''])),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].problem).toContain('no FPP');
  });

  it('keeps a negative amount, which a realignment needs', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER}\n` +
          row(['General Fund', '1011', 'Mayor', 'MOOE', '"-50,000"', '0', 'General Public Services', '2025-003', '5-02-03-010', 'Supplies']),
      ),
    );
    expect(rows[0].amount).toBe(-5_000_000);
  });

  it('reads a service sector column when the file carries one', async () => {
    const rows = await parseBudgetFile(
      csvFile(
        `${HEADER},Service Sector\n` +
          row([
            'General Fund', 'MDF', '20% Development', 'CO', '"1,000,000"', '0',
            '20% Development Fund', '2025-003', 'Concreting of Barangay Road',
            'Concreting of Barangay Road', 'Economic Services',
          ]),
      ),
    );
    expect(rows[0].sector).toBe('20% Development Fund');
    expect(rows[0].serviceSector).toBe('Economic Services');
  });

  it('still reads an older file whose office column is headed Department', async () => {
    const rows = await parseBudgetFile(
      csvFile('Department,FPP,Allotment Class,Appropriation\n' + 'MAYOR,5-01-01-010,PS,"4,820,000.00"\n'),
    );
    expect(rows[0].office).toBe('MAYOR');
    expect(rows[0].accountCode).toBe('5-01-01-010');
    expect(rows[0].expenseClass).toBe('PS');
    expect(rows[0].amount).toBe(482_000_000);
  });
});
