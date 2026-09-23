import { describe, it, expect } from 'vitest';
import { parsePaymentFile } from './parsePayments';

/**
 * The reader is tested against the headings the Treasurer's office actually
 * prints, not against headings invented to suit it.
 *
 * The RCI heading block reads:
 *
 *   CHECK (Date | Serial No.) | DV/PAYROLL NO. | CAFOA NO. |
 *   RESPONSIBILITY CENTER CODE | PAYEE | NATURE OF PAYMENT | AMOUNT
 *
 * The obligation column is the one worth a test of its own. It is headed "OBR
 * NO." now and "CAFOA NO." on every file printed before the change, and a
 * reader that silently dropped the older heading would lose the obligation
 * reference from the historical files without failing.
 */

function csvFile(text: string, name = 'rci.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

const RCI_HEADER =
  'Date,Serial No.,DV/PAYROLL NO.,CAFOA NO.,RESPONSIBILITY CENTER CODE,PAYEE,NATURE OF PAYMENT,AMOUNT';

describe('parsePaymentFile', () => {
  it('reads the office RCI columns, including CAFOA as the obligation number', async () => {
    const rows = await parsePaymentFile(
      csvFile(
        `${RCI_HEADER}\n` +
          '2026-09-15,1835959,2026-09-0142,2026-09-0231,1011,Negros Hardware,Supplies,"41,200.00"\n' +
          '2026-09-15,1835960,2026-09-0143,T/L,1011,BIR,Remittance of taxes withheld,"12,004.57"\n',
      ),
      'RCI',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: '2026-09-15',
      serialNo: '1835959',
      dvNo: '2026-09-0142',
      obrNo: '2026-09-0231',
      responsibilityCenter: '1011',
      payeeName: 'Negros Hardware',
      particulars: 'Supplies',
      amount: 4_120_000,
    });
    expect(rows[0].problem).toBeUndefined();
    expect(rows[0].willHold).toBeUndefined();

    // A trust-liability payment carries no obligation. It is still a payment.
    expect(rows[1].obrNo).toBe('T/L');
    expect(rows[1].amount).toBe(1_200_457);
  });

  it('reads the same columns under the new OBR heading', async () => {
    const rows = await parsePaymentFile(
      csvFile(
        'Check Date,Check No.,DV No.,OBR No.,Payee,Nature of Payment,Amount\n' +
          '2026-09-16,1835961,2026-09-0144,2026-09-0233,Candoni Water District,Water bills,"8,300.00"\n',
      ),
      'RCI',
    );
    expect(rows[0].obrNo).toBe('2026-09-0233');
    expect(rows[0].dvNo).toBe('2026-09-0144');
    expect(rows[0].serialNo).toBe('1835961');
  });

  it('holds a row with no DV number rather than calling the file unreadable', async () => {
    const rows = await parsePaymentFile(
      csvFile(`${RCI_HEADER}\n2026-09-15,1835962,,2026-09-0234,1011,Someone,Something,"500.00"\n`),
      'RCI',
    );
    expect(rows[0].problem).toBeUndefined();
    expect(rows[0].willHold).toContain('no DV number');
  });

  it('refuses to send a row with no amount or no readable date', async () => {
    const rows = await parsePaymentFile(
      csvFile(`${RCI_HEADER}\nnot a date,1835963,2026-09-0145,,1011,Someone,Something,\n`),
      'RCI',
    );
    expect(rows[0].problem).toContain('no amount');
    expect(rows[0].problem).toContain('no readable date');
  });

  it('skips blank lines and the footing the report prints under the columns', async () => {
    const rows = await parsePaymentFile(
      csvFile(
        `${RCI_HEADER}\n` +
          '2026-09-15,1835964,2026-09-0146,2026-09-0235,1011,Someone,Something,"1,000.00"\n' +
          ',,,,,,TOTAL,"1,000.00"\n' +
          ',,,,,,,\n',
      ),
      'RCI',
    );
    expect(rows).toHaveLength(1);
  });

  it('does not require a check number on a RADAI, where one number covers the batch', async () => {
    const rows = await parsePaymentFile(
      csvFile(
        'Date,DV No.,OBR No.,Payee,Nature of Payment,Amount\n' +
          '2026-09-18,2026-09-0150,2026-09-0240,Juan Dela Cruz,Travelling expenses,"3,500.00"\n',
        'radai.csv',
      ),
      'RADAI',
    );
    expect(rows[0].willHold).toBeUndefined();
    expect(rows[0].serialNo).toBe('');
    expect(rows[0].amount).toBe(350_000);
  });
});
