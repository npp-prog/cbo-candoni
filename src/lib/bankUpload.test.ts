import { describe, it, expect } from 'vitest';
import { buildBankPayrollFile } from './bankUpload';

const ROWS = [
  { accountNumber: '1234567890', name: 'Dela Cruz, Juan', amount: 1_234_567 },
  { accountNumber: '9876543210', name: 'Santos, Maria', amount: 50_000 },
];

describe('buildBankPayrollFile', () => {
  it('is three columns and the rows, with nothing above them', () => {
    const { content } = buildBankPayrollFile(ROWS);
    const lines = content!.split('\r\n');

    expect(lines[0]).toBe('ATM Number,Name,Amount');
    expect(lines).toHaveLength(3);
  });

  /*
   * The whole reason this is not exportCsv. A letterhead, a "Generated" line
   * and a blank line are three lines the bank's parser does not expect.
   */
  it('carries no letterhead and no byte-order mark', () => {
    const { content } = buildBankPayrollFile(ROWS);
    expect(content!.startsWith('ATM Number')).toBe(true);
    expect(content).not.toContain('Republic of the Philippines');
    expect(content).not.toContain('Municipality of Candoni');
  });

  /*
   * 1,234.56 in a comma-separated file is a number followed by a comma, which
   * is how forty payments become eighty broken ones.
   */
  it('writes the amount ungrouped, with no symbol', () => {
    const { content } = buildBankPayrollFile(ROWS);
    expect(content).toContain('1234567890,"Dela Cruz, Juan",12345.67');
    expect(content).not.toContain('12,345.67');
    expect(content).not.toContain('₱');
  });

  it('quotes a name that contains a comma, and nothing else', () => {
    const { content } = buildBankPayrollFile([
      { accountNumber: '111', name: 'Dela Cruz, Juan', amount: 100 },
      { accountNumber: '222', name: 'Santos Maria', amount: 100 },
    ]);
    expect(content).toContain('111,"Dela Cruz, Juan",1.00');
    expect(content).toContain('222,Santos Maria,1.00');
  });

  /*
   * These files get opened in Excel on the way to the bank, and a name that
   * begins with one of these characters is executed there.
   */
  it('stops a name being read as a formula', () => {
    const { content } = buildBankPayrollFile([
      { accountNumber: '111', name: '=SUM(A1:A9)', amount: 100 },
    ]);
    expect(content).toContain("'=SUM(A1:A9)");
  });

  /*
   * The case the whole module exists for. A blank account number is either
   * rejected by the bank after the upload, or - on a less careful bank
   * application - paid into the account on the line above.
   */
  it('refuses to build a file with an account number missing, and names who', () => {
    const result = buildBankPayrollFile([
      ROWS[0],
      { accountNumber: '', name: 'Reyes, Pedro', amount: 30_000 },
      { accountNumber: null, name: 'Lim, Ana', amount: 20_000 },
    ]);

    expect(result.content).toBeNull();
    expect(result.missing).toEqual(['Reyes, Pedro', 'Lim, Ana']);
  });

  it('counts and totals even when it refuses, so the screen can say how far off it is', () => {
    const result = buildBankPayrollFile([
      ROWS[0],
      { accountNumber: '', name: 'Reyes, Pedro', amount: 30_000 },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.total).toBe(1_264_567);
  });

  it('treats whitespace as missing', () => {
    expect(buildBankPayrollFile([{ accountNumber: '   ', name: 'Lim, Ana', amount: 1 }]).content)
      .toBeNull();
  });
});
