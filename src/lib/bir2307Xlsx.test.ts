import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { addBottomAlignedStyle, fill2307 } from './bir2307Xlsx';

const TEMPLATE = resolve(__dirname, '../../public/forms/bir-2307.xlsx');

describe('BIR 2307 on the BIR form (patch 166)', () => {
  const bytes = fill2307(new Uint8Array(readFileSync(TEMPLATE)), {
    periodFrom: '2026-01-01',
    periodTo: '2026-03-31',
    payee: { tin: '200200200', name: 'Rujen General Merchandise', address: 'Candoni', zip: '6110' },
    payor: {
      tin: '005560000',
      name: 'Municipal Government of Candoni',
      address: 'Rizal St.',
      zip: '6110',
    },
    ewt: [
      {
        description: 'EWT goods 1%',
        atc: 'WC158',
        months: [20_000_00, 0, 0],
        total: 20_000_00,
        tax: 178_57,
      },
    ],
    business: [],
    signatory: 'NEIL P. PRIOLO, CPA - Municipal Accountant',
  });
  if (process.env.BIR2307_OUT) writeFileSync(process.env.BIR2307_OUT, bytes);
  const zip = XLSX.CFB.read(bytes, { type: 'array' });
  const text = (p: string) =>
    new TextDecoder().decode(XLSX.CFB.find(zip, p)!.content as Uint8Array);

  it('writes the digit boxes on one line, centred, without wrapping', () => {
    const d = text('/xl/drawings/drawing1.xml');
    const box = (id: number) =>
      d.slice(
        d.indexOf(`<xdr:cNvPr id="${id}" `),
        d.indexOf('</xdr:sp>', d.indexOf(`<xdr:cNvPr id="${id}" `)),
      );
    for (const id of [223, 218, 135, 373, 406]) {
      const b = box(id);
      expect(b).toMatch(/<a:bodyPr\b[^>]*wrap="none"/);
      expect(b).toMatch(/<a:bodyPr\b[^>]*tIns="0"/);
      expect(b).toMatch(/<a:bodyPr\b[^>]*anchor="ctr"/);
    }
    expect(box(223)).toContain('<a:t>0101</a:t>');
    expect(box(373)).toContain('<a:t>6110</a:t>');
  });

  it('prints the signatory at the bottom of A63', () => {
    const s = text('/xl/worksheets/sheet1.xml');
    const idx = Number(/<c r="A63" s="(\d+)"/.exec(s)![1]);
    const styles = text('/xl/styles.xml');
    const xfs = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(styles)!;
    expect(Number(xfs[1])).toBe(idx + 1);
    expect(xfs[2]).toMatch(/vertical="bottom"\/><\/xf>$/);
    expect(s).toContain('NEIL P. PRIOLO, CPA - MUNICIPAL ACCOUNTANT');
  });

  it('adds a bottom-aligned copy of a style', () => {
    const r = addBottomAlignedStyle('<cellXfs count="1"><xf numFmtId="0"/></cellXfs>', 0)!;
    expect(r.index).toBe(1);
    expect(r.xml).toContain('<cellXfs count="2">');
    expect(r.xml).toContain('<alignment vertical="bottom"/></xf>');
  });
});
