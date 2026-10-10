import * as XLSX from 'xlsx';
import { brsFileName, sheetSuffix, type Brs } from './brs';

/**
 * Patch 163 - the BRS as the office's Excel workbook: two sheets,
 *   BR_<Mon><Year>  the statement (Particular | Book | Bank | Explanatory Note)
 *   S_<Mon><Year>   the schedules (Date | Reference No | Name | Amount | Remarks)
 * saved as BRS_<account no>_<MM><Mon><YYYY>.xlsx.
 */

const PESO = '#,##0.00;(#,##0.00);"-"';

export interface BrsHeader {
  entityName: string;
  statementDate: string;
  bankName: string;
  branch: string;
  fundLabel: string;
  accountNumber: string;
  preparedBy: { name: string; position: string };
  certifiedBy: { name: string; position: string };
}

type Cell = string | number | null;

const pesos = (c: number) => Math.round(c) / 100;

function money(sheet: XLSX.WorkSheet, r: number, c: number) {
  const ref = XLSX.utils.encode_cell({ r, c });
  const cell = sheet[ref];
  if (cell && typeof cell.v === 'number') {
    cell.t = 'n';
    cell.z = PESO;
  }
}

export function brsWorkbook(brs: Brs, h: BrsHeader): XLSX.WorkBook {
  // ---- BR_ : the statement ------------------------------------------------
  const a: Cell[][] = [];
  a.push([h.entityName.toUpperCase()]);
  a.push(['BANK RECONCILIATION STATEMENT']);
  a.push([`For the Month of ${brs.monthLabel}`]);
  a.push([]);
  a.push(['Bank Name:', h.bankName, 'Fund:', h.fundLabel]);
  a.push(['Branch:', h.branch, 'Account No.:', h.accountNumber]);
  a.push([]);
  a.push(['Particular', 'Book', 'Bank', 'Explanatory Note']);
  const moneyRows: number[] = [];
  moneyRows.push(a.length);
  a.push(['Unadjusted Balances', pesos(brs.bookBalance), pesos(brs.bankBalance), '']);
  a.push(['Reconciling Items:', null, null, '']);
  for (const l of brs.lines) {
    moneyRows.push(a.length);
    a.push([
      `     ${l.label}`,
      l.column === 'BOOK' ? pesos(l.amount) : null,
      l.column === 'BANK' ? pesos(l.amount) : null,
      l.note,
    ]);
  }
  moneyRows.push(a.length);
  a.push(['Adjusted Balances', pesos(brs.adjustedBook), pesos(brs.adjustedBank), '']);
  a.push([]);
  a.push([]);
  a.push(['Prepared by:', '', 'Certified Correct:']);
  a.push([]);
  a.push([h.preparedBy.name.toUpperCase(), '', h.certifiedBy.name.toUpperCase()]);
  a.push([h.preparedBy.position, '', h.certifiedBy.position]);

  const br = XLSX.utils.aoa_to_sheet(a);
  for (const r of moneyRows) {
    money(br, r, 1);
    money(br, r, 2);
  }
  br['!cols'] = [{ wch: 52 }, { wch: 18 }, { wch: 18 }, { wch: 34 }];
  br['!merges'] = [0, 1, 2].map((r) => ({ s: { r, c: 0 }, e: { r, c: 3 } }));

  // ---- S_ : the schedules -------------------------------------------------
  const s: Cell[][] = [];
  s.push([h.entityName.toUpperCase()]);
  s.push(['SCHEDULES OF RECONCILING ITEMS']);
  s.push([`For the Month of ${brs.monthLabel}`]);
  s.push([`${h.bankName} - Account No. ${h.accountNumber} - ${h.fundLabel}`]);
  const amountRows: number[] = [];
  brs.lines.forEach((l, i) => {
    s.push([]);
    s.push([`${i + 1}. ${l.label} (${l.column === 'BOOK' ? 'Book' : 'Bank'})`]);
    s.push(['Date', 'Reference No', 'Name', 'Amount', 'Remarks']);
    if (l.items.length === 0) s.push(['', '', 'None', null, '']);
    for (const it of l.items) {
      amountRows.push(s.length);
      s.push([it.date, it.ref, it.name, pesos(it.amount), it.remarks]);
    }
    amountRows.push(s.length);
    s.push(['', '', 'Subtotal', pesos(l.amount), '']);
  });
  const sc = XLSX.utils.aoa_to_sheet(s);
  for (const r of amountRows) money(sc, r, 3);
  sc['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 44 }, { wch: 18 }, { wch: 44 }];

  const book = XLSX.utils.book_new();
  const suffix = sheetSuffix(h.statementDate);
  XLSX.utils.book_append_sheet(book, br, `BR_${suffix}`);
  XLSX.utils.book_append_sheet(book, sc, `S_${suffix}`);
  return book;
}

export function downloadBrs(brs: Brs, h: BrsHeader): void {
  const name = brsFileName(h.accountNumber, h.statementDate).replace(/[\\/:*?"<>|]+/g, '-');
  XLSX.writeFile(brsWorkbook(brs, h), `${name}.xlsx`, { compression: true });
}
