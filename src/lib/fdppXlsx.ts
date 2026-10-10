import * as XLSX from 'xlsx';
import { FDP_CERTIFICATION, FDP_PLACE } from './fdpp';

/**
 * Patch 163 - an FDP form as an Excel sheet, laid out as the portal's own
 * templates are: the form's name and legal basis, the report title, the
 * REGION / PROVINCE / CITY/MUNICIPALITY block with CALENDAR YEAR and QUARTER,
 * the table, the certification and the signatories.
 *
 * Saved as "FDP Form 9 - Statement of Cash Flows_4thQ_2025.xlsx", the name the
 * office files them under.
 */

export type XCell = string | number | null;

export interface FdpSheetSpec {
  /** "FDP Form 9 - Statement of Cash Flows" */
  form: string;
  legalBasis?: string;
  title: string;
  year: number;
  quarter: number;
  /** Header rows of the table. */
  head: XCell[][];
  body: XCell[][];
  /** Columns (0-based) whose numbers are pesos. */
  moneyColumns: number[];
  widths: number[];
  signatories: Array<{ name: string; position: string; label?: string }>;
  note?: string;
  /** Form 6b's OFFICE line. */
  office?: string;
  /** False on Form 6b, which has no certification paragraph. */
  certification?: boolean;
}

const PESO = '#,##0.00;(#,##0.00);"-"';
const ORD = ['', '1st', '2nd', '3rd', '4th'];

export function fdpFileName(form: string, quarter: number, year: number): string {
  return `${form}_${ORD[quarter] ?? quarter}Q_${year}`;
}

export function fdpWorkbook(spec: FdpSheetSpec): XLSX.WorkBook {
  const a: XCell[][] = [];
  a.push([spec.form]);
  if (spec.legalBasis) a.push([spec.legalBasis]);
  a.push([spec.title.toUpperCase()]);
  a.push(['REGION:', FDP_PLACE.region, '', 'CALENDAR YEAR:', spec.year]);
  a.push(['PROVINCE:', FDP_PLACE.province, '', 'QUARTER:', spec.quarter]);
  a.push(
    spec.office
      ? ['CITY/MUNICIPALITY:', FDP_PLACE.municipality, '', 'OFFICE:', spec.office]
      : ['CITY/MUNICIPALITY:', FDP_PLACE.municipality],
  );
  a.push([]);
  for (const h of spec.head) a.push(h);
  const first = a.length;
  for (const r of spec.body) a.push(r);
  const last = a.length;
  a.push([]);
  if (spec.certification !== false) a.push([FDP_CERTIFICATION]);
  a.push([]);
  const labels: XCell[] = [];
  spec.signatories.forEach((sg, i) => {
    if (sg.label)
      labels[i * Math.max(2, Math.floor(spec.widths.length / spec.signatories.length))] = sg.label;
  });
  if (labels.length) a.push(Array.from(labels, (v) => v ?? ''));
  a.push([]);
  const span = Math.max(2, Math.floor(spec.widths.length / spec.signatories.length));
  const names: XCell[] = [];
  const posts: XCell[] = [];
  spec.signatories.forEach((s, i) => {
    names[i * span] = s.name.toUpperCase();
    posts[i * span] = s.position;
  });
  a.push(Array.from(names, (v) => v ?? ''));
  a.push(Array.from(posts, (v) => v ?? ''));
  if (spec.note) {
    a.push([]);
    a.push([spec.note]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(a);
  for (let r = first; r < last; r++) {
    for (const c of spec.moneyColumns) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') {
        cell.t = 'n';
        cell.z = PESO;
      }
    }
  }
  sheet['!cols'] = spec.widths.map((wch) => ({ wch }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, spec.form.replace(/^FDP /, '').slice(0, 31));
  return book;
}

export function downloadFdp(spec: FdpSheetSpec): void {
  const name = fdpFileName(spec.form, spec.quarter, spec.year).replace(/[\\/:*?"<>|]+/g, '-');
  XLSX.writeFile(fdpWorkbook(spec), `${name}.xlsx`, { compression: true });
}
