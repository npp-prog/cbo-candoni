import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { form2307FromVoucher, quarterOf, tinBoxes } from './bir2307';
import { fill2307 } from './bir2307Xlsx';

const taxCodes = [
  {
    id: 't1',
    code: 'EWT1',
    description: 'Income payment to suppliers of goods',
    kind: 'EWT',
    atc: 'WI640',
  },
  {
    id: 't2',
    code: 'EWT2',
    description: 'Income payment to suppliers of services',
    kind: 'EWT',
    atc: 'WI157',
  },
  {
    id: 't3',
    code: 'VAT5',
    description: 'VAT withheld on goods',
    kind: 'VAT_WITHHOLDING',
    atc: 'WV010',
  },
  { id: 't4', code: 'GSIS', description: 'GSIS', kind: 'OTHER' },
];

describe('BIR 2307 (patch 162)', () => {
  it('knows the quarter and the month in it', () => {
    expect(quarterOf('2026-08-14')).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
      monthIndex: 1,
    });
    expect(quarterOf('2026-02-01')).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
      monthIndex: 1,
    });
    expect(quarterOf('2026-12-31').to).toBe('2026-12-31');
  });

  it('splits a TIN into the four boxes', () => {
    expect(tinBoxes('123-456-789-000')).toEqual(['123', '456', '789', '00000']);
    expect(tinBoxes('123456789')).toEqual(['123', '456', '789', '00000']);
    expect(tinBoxes('')).toEqual(['', '', '', '']);
  });

  it('builds the certificate from the deductions, one row per ATC', () => {
    const f = form2307FromVoucher({
      date: '2026-08-14',
      deductions: [
        { taxCodeId: 't1', code: 'EWT1', base: 100_000_00, amount: 1_000_00 },
        { taxCodeId: 't3', code: 'VAT5', base: 100_000_00, amount: 5_000_00 },
        { taxCodeId: 't1', code: 'EWT1', base: 20_000_00, amount: 200_00 },
        { taxCodeId: 't4', code: 'GSIS', base: 1, amount: 9 },
      ],
      taxCodes,
      payee: { tin: '123456789', name: 'Negros Hardware', address: 'Candoni', zip: '6110' },
      payor: {
        tin: '000111222',
        name: 'Municipal Government of Candoni',
        address: 'Rizal St.',
        zip: '6110',
      },
      signatory: { name: 'Juan Cruz', position: 'Municipal Treasurer' },
    })!;
    expect(f.periodFrom).toBe('2026-07-01');
    expect(f.ewt).toEqual([
      {
        description: 'Income payment to suppliers of goods',
        atc: 'WI640',
        months: [0, 120_000_00, 0],
        total: 120_000_00,
        tax: 1_200_00,
      },
    ]);
    expect(f.business[0]).toMatchObject({ atc: 'WV010', tax: 5_000_00 });
    expect(f.signatory).toBe('Juan Cruz - Municipal Treasurer');
  });

  it('is nothing when no tax was withheld', () => {
    expect(
      form2307FromVoucher({
        date: '2026-08-14',
        deductions: [{ taxCodeId: 't4', base: 1, amount: 9 }],
        taxCodes,
        payee: { name: 'X' },
        payor: { name: 'Y' },
      }),
    ).toBeNull();
  });

  it("fills the BIR's own Excel form", () => {
    const template = readFileSync(resolve(__dirname, '../../public/forms/bir-2307.xlsx'));
    const form = form2307FromVoucher({
      date: '2026-08-14',
      deductions: [
        { taxCodeId: 't1', base: 100_000_00, amount: 1_000_00 },
        { taxCodeId: 't3', base: 100_000_00, amount: 5_000_00 },
      ],
      taxCodes,
      payee: {
        tin: '123-456-789-000',
        name: 'Negros Hardware & Co.',
        address: 'Poblacion, Candoni, Negros Occidental',
        zip: '6110',
      },
      payor: {
        tin: '000-111-222',
        name: 'Municipal Government of Candoni',
        address: 'Municipal Building, Rizal St., Candoni',
        zip: '6110',
      },
      signatory: { name: 'Juan Cruz', position: 'Municipal Treasurer' },
    })!;
    const out = fill2307(new Uint8Array(template), form);
    if (process.env.BIR2307_OUT) writeFileSync(process.env.BIR2307_OUT, out);
    const zip = XLSX.CFB.read(out, { type: 'array' });
    const sheet = new TextDecoder().decode(
      XLSX.CFB.find(zip, '/xl/worksheets/sheet1.xml')!.content as Uint8Array,
    );
    const drawing = new TextDecoder().decode(
      XLSX.CFB.find(zip, '/xl/drawings/drawing1.xml')!.content as Uint8Array,
    );
    expect(sheet).toContain(
      '<c r="L38" s="171" t="inlineStr"><is><t xml:space="preserve">WI640</t>',
    );
    expect(sheet).toContain('100,000.00');
    expect(drawing).toContain('NEGROS HARDWARE &amp; CO.');
    expect(drawing).toContain('<a:t>0701</a:t>');
    expect(drawing).toContain('<a:t>00000</a:t>');
    // The workbook still reads.
    expect(XLSX.read(out, { type: 'array' }).SheetNames).toEqual(['Page1']);
  });
});
