import { describe, it, expect } from 'vitest';
import { parseAbstractFile, revenueCodesUsed } from './parseAbstract';

function csvFile(text: string, name = 'abstract.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

const HEADER =
  '"Date","Primary Report No.","Accountable Form","Serial/O.R. No.","Payor","Collector","Fund","Account Code","Account Name","Amount (PHP)","Remarks"';

describe('parseAbstractFile', () => {
  /**
   * The one the whole reader exists for. Two rows, one receipt: the abstract
   * writes a line per revenue account, and a receipt that collected two things
   * appears twice under the same O.R. number.
   */
  it('gathers the rows of one receipt into one receipt with two lines', async () => {
    const receipts = await parseAbstractFile(
      csvFile(
        `${HEADER}\n` +
          '"2026-09-22","26-09153","AF 51","7707727","ELSIE TOPES","RHEA C. PAURILLO","GF Proper","4020220001","Health Certificate","50",""\n' +
          '"2026-09-22","26-09153","AF 51","7707727","ELSIE TOPES","RHEA C. PAURILLO","GF Proper","40601010D/S","Miscellaneous Income - D/S","30",""\n',
      ),
    );

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      orNumber: '7707727',
      reportRef: '26-09153',
      payor: 'ELSIE TOPES',
      collector: 'RHEA C. PAURILLO',
      fund: 'GF Proper',
      totalAmount: 8000,
    });
    expect(receipts[0].lines).toHaveLength(2);
    expect(receipts[0].lines[1].revenueCode).toBe('40601010D/S');
  });

  it('keeps receipts with the same O.R. number under different reports apart', async () => {
    const receipts = await parseAbstractFile(
      csvFile(
        `${HEADER}\n` +
          '"2026-09-22","26-09153","AF 51","001","A","C","GF Proper","40201010","Permit Fees","100",""\n' +
          '"2026-09-23","26-09154","AF 51","001","B","C","GF Proper","40201010","Permit Fees","200",""\n',
      ),
    );
    expect(receipts).toHaveLength(2);
  });

  it('records a cancelled receipt at nil, with no revenue line', async () => {
    const receipts = await parseAbstractFile(
      csvFile(
        `${HEADER}\n` +
          '"2026-09-22","26-09153","AF 51","7707728","VOID","RHEA C. PAURILLO","GF Proper","40201010","Permit Fees","500","CANCELLED"\n',
      ),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].cancelled).toBe(true);
    expect(receipts[0].totalAmount).toBe(0);
    expect(receipts[0].lines).toHaveLength(0);
    expect(receipts[0].problem).toBeUndefined();
  });

  it('keeps the two funds an abstract may carry', async () => {
    const receipts = await parseAbstractFile(
      csvFile(
        `${HEADER}\n` +
          '"2026-09-22","26-09153","AF 51","001","A","C","GF Proper","40201010","Permit Fees","100",""\n' +
          '"2026-09-22","26-09153","AF 51","002","B","C","TF","40601010TF","Miscellaneous Income-TF","300",""\n',
      ),
    );
    expect(receipts.map((r) => r.fund).sort()).toEqual(['GF Proper', 'TF']);
  });

  it('lists the distinct revenue codes, for checking them against the mapping', async () => {
    const receipts = await parseAbstractFile(
      csvFile(
        `${HEADER}\n` +
          '"2026-09-22","26-09153","AF 51","001","A","C","GF Proper","4020214001","Market Fee","100",""\n' +
          '"2026-09-22","26-09153","AF 51","002","B","C","GF Proper","4020214001","Market Fee","150",""\n' +
          '"2026-09-22","26-09153","AF 51","003","D","C","GF Proper","40202120","Parking Fees","20",""\n',
      ),
    );
    const codes = revenueCodesUsed(receipts);
    expect([...codes.keys()].sort()).toEqual(['40202120', '4020214001']);
    expect(codes.get('4020214001')).toBe('Market Fee');
  });

  it('flags a receipt that has no readable date rather than dropping it', async () => {
    const receipts = await parseAbstractFile(
      csvFile(
        `${HEADER}\n` +
          '"not a date","26-09153","AF 51","001","A","C","GF Proper","40201010","Permit Fees","100",""\n',
      ),
    );
    expect(receipts[0].problem).toContain('no readable date');
  });
});
