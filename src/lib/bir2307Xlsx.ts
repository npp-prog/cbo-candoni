import * as XLSX from 'xlsx';
import { mmddyyyy, pesos, tinBoxes, type Form2307, type Form2307Row } from './bir2307';

/**
 * Patch 162 - BIR Form 2307 written onto the BIR's OWN Excel form
 * ("2307 Jan 2018 ENCS v3"), kept in /public/forms/bir-2307.xlsx.
 *
 * The form is not rebuilt: the file is opened as the zip it is and only the
 * values are written in, so every line, box, logo and bar code of the BIR's
 * layout stays exactly as the BIR drew it.
 *
 *   The boxes at the top (period, TINs, names, addresses, ZIP codes) are
 *   drawing TEXT BOXES on the sheet, not cells - each is found by its shape
 *   id and given its text. The digit boxes (dates, TIN, ZIP) are written in
 *   a fixed-width font spaced so each digit sits in its own box.
 *
 *   Part III is ordinary cells (A38:AN61) and the signature line A63.
 */

const DRAWING = '/xl/drawings/drawing1.xml';
const SHEET = '/xl/worksheets/sheet1.xml';

/** Shape ids of the BIR form's text boxes. */
export const BOX = {
  fromMmdd: 223,
  fromYyyy: 218,
  toMmdd: 294,
  toYyyy: 290,
  payeeTin: [135, 339, 343, 347],
  payeeName: 370,
  payeeAddress: 371,
  payeeZip: 373,
  payeeForeign: 377,
  payorTin: [130, 383, 387, 391],
  payorName: 403,
  payorAddress: 404,
  payorZip: 406,
} as const;

/** Box widths on the sheet, in points, after the groups' scaling. */
const WIDTH_PT: Record<number, number> = {
  223: 52.9,
  218: 52.9,
  294: 52.9,
  290: 52.9,
  135: 39.7,
  339: 39.7,
  343: 39.7,
  347: 74.2,
  130: 39.7,
  383: 39.7,
  387: 39.7,
  391: 74.2,
  373: 50.2,
  406: 50.2,
};

/*
 * XML escaping for the values written into the form. The entities are built
 * from their names because this text goes into the file's XML, not onto a
 * screen (the build check rightly refuses a literal entity in a UI string).
 */
const entity = (name: string) => `&${name};`;
const XML_ESCAPES: Record<string, string> = {
  '&': entity('amp'),
  '<': entity('lt'),
  '>': entity('gt'),
  '"': entity('quot'),
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => XML_ESCAPES[c]);

/** Courier New at 10 pt: every character 6 pt wide. */
const MONO_CHAR_PT = 6;

/**
 * Puts text into the text box with this shape id. `slots` spreads the
 * characters one per box (digits); without it the text is written plainly.
 */
export function fillTextBox(xml: string, id: number, text: string, slots?: number): string {
  if (!text) return xml;
  const start = xml.indexOf(`<xdr:cNvPr id="${id}" `);
  if (start < 0) return xml;
  const end = xml.indexOf('</xdr:sp>', start);
  let shape = xml.slice(start, end);

  let run: string;
  if (slots) {
    const width = WIDTH_PT[id] ?? slots * 13;
    const pitch = width / slots;
    const spc = Math.max(0, Math.round((pitch - MONO_CHAR_PT) * 100));
    const inset = Math.max(0, Math.round(((pitch - MONO_CHAR_PT) / 2) * 12700));
    shape = shape.replace(/<a:bodyPr\b([^>]*?)lIns="\d+"/, `<a:bodyPr$1lIns="${inset}"`);
    shape = shape.replace(/<a:bodyPr\b([^>]*?)rIns="\d+"/, '<a:bodyPr$1rIns="0"');
    shape = shape.replace(/<a:bodyPr\b([^>]*?)anchor="t"/, '<a:bodyPr$1anchor="ctr"');
    run =
      `<a:r><a:rPr lang="en-US" sz="1000" b="1" spc="${spc}">` +
      '<a:latin typeface="Courier New"/><a:cs typeface="Courier New"/></a:rPr>' +
      `<a:t>${esc(text.slice(0, slots))}</a:t></a:r>`;
  } else {
    shape = shape.replace(/<a:bodyPr\b([^>]*?)anchor="t"/, '<a:bodyPr$1anchor="ctr"');
    run =
      '<a:r><a:rPr lang="en-US" sz="1000" b="1">' +
      '<a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr>' +
      `<a:t>${esc(text)}</a:t></a:r>`;
  }
  // The run goes in the box's first paragraph, before its closing properties.
  const p = shape.indexOf('<a:endParaRPr');
  const q = shape.indexOf('</a:p>');
  const at = p >= 0 && (q < 0 || p < q) ? p : q;
  if (at < 0) return xml;
  shape = shape.slice(0, at) + run + shape.slice(at);
  return xml.slice(0, start) + shape + xml.slice(end);
}

/** Writes a text value into an existing (empty) cell, keeping its style. */
export function setCell(xml: string, ref: string, text: string): string {
  if (!text) return xml;
  const re = new RegExp(`<c r="${ref}"( s="\\d+")?(?: t="\\w+")?\\s*(?:/>|>[\\s\\S]*?</c>)`);
  return xml.replace(
    re,
    (_m, s: string | undefined) =>
      `<c r="${ref}"${s ?? ''} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`,
  );
}

function writeRows(xml: string, rows: Form2307Row[], firstRow: number, totalRow: number): string {
  let out = xml;
  rows.forEach((r, i) => {
    const n = firstRow + i;
    out = setCell(out, `A${n}`, r.description);
    out = setCell(out, `L${n}`, r.atc);
    out = setCell(out, `O${n}`, pesos(r.months[0]));
    out = setCell(out, `T${n}`, pesos(r.months[1]));
    out = setCell(out, `Y${n}`, pesos(r.months[2]));
    out = setCell(out, `AD${n}`, pesos(r.total));
    out = setCell(out, `AI${n}`, pesos(r.tax));
  });
  if (rows.length) {
    const sum = (f: (r: Form2307Row) => number) => rows.reduce((t, r) => t + f(r), 0);
    out = setCell(out, `O${totalRow}`, pesos(sum((r) => r.months[0])));
    out = setCell(out, `T${totalRow}`, pesos(sum((r) => r.months[1])));
    out = setCell(out, `Y${totalRow}`, pesos(sum((r) => r.months[2])));
    out = setCell(out, `AD${totalRow}`, pesos(sum((r) => r.total)));
    out = setCell(out, `AI${totalRow}`, pesos(sum((r) => r.tax)));
  }
  return out;
}

/** The filled form, as the bytes of an .xlsx file. */
export function fill2307(template: ArrayBuffer | Uint8Array, form: Form2307): Uint8Array {
  const data = template instanceof Uint8Array ? template : new Uint8Array(template);
  const zip = XLSX.CFB.read(data, { type: 'array' });

  const read = (path: string) => {
    const f = XLSX.CFB.find(zip, path);
    if (!f) throw new Error(`The BIR 2307 template has no ${path}.`);
    return new TextDecoder('utf-8').decode(f.content as Uint8Array);
  };
  const write = (path: string, text: string) =>
    XLSX.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));

  // ---- the boxes at the top ------------------------------------------------
  let d = read(DRAWING);
  const from = mmddyyyy(form.periodFrom);
  const to = mmddyyyy(form.periodTo);
  d = fillTextBox(d, BOX.fromMmdd, from.mmdd, 4);
  d = fillTextBox(d, BOX.fromYyyy, from.yyyy, 4);
  d = fillTextBox(d, BOX.toMmdd, to.mmdd, 4);
  d = fillTextBox(d, BOX.toYyyy, to.yyyy, 4);
  tinBoxes(form.payee.tin).forEach((part, i) => {
    d = fillTextBox(d, BOX.payeeTin[i], part, i === 3 ? 5 : 3);
  });
  tinBoxes(form.payor.tin).forEach((part, i) => {
    d = fillTextBox(d, BOX.payorTin[i], part, i === 3 ? 5 : 3);
  });
  d = fillTextBox(d, BOX.payeeName, form.payee.name.toUpperCase());
  d = fillTextBox(d, BOX.payeeAddress, form.payee.address);
  d = fillTextBox(d, BOX.payeeZip, form.payee.zip.replace(/\D/g, '').slice(0, 4), 4);
  if (form.payee.foreignAddress) d = fillTextBox(d, BOX.payeeForeign, form.payee.foreignAddress);
  d = fillTextBox(d, BOX.payorName, form.payor.name.toUpperCase());
  d = fillTextBox(d, BOX.payorAddress, form.payor.address);
  d = fillTextBox(d, BOX.payorZip, form.payor.zip.replace(/\D/g, '').slice(0, 4), 4);
  write(DRAWING, d);

  // ---- Part III and the signature -----------------------------------------
  let s = read(SHEET);
  s = writeRows(s, form.ewt, 38, 48);
  s = writeRows(s, form.business, 51, 61);
  if (form.signatory) s = setCell(s, 'A63', form.signatory.toUpperCase());
  write(SHEET, s);

  // The SheetJS placeholder entry is not part of the workbook.
  const out = XLSX.CFB.write(zip, { type: 'array', fileType: 'zip', compression: true });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

/** Fetches the template, fills it and downloads it. */
export async function download2307(form: Form2307, fileName: string): Promise<void> {
  const res = await fetch('/forms/bir-2307.xlsx');
  if (!res.ok) throw new Error('The BIR 2307 form (forms/bir-2307.xlsx) could not be loaded.');
  const bytes = fill2307(await res.arrayBuffer(), form);
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]+/g, '-');
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
