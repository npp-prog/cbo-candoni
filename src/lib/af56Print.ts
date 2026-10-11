import { af56Total, amountsOf, totalsOf, type Af56Detail } from './af56';
import { amountInWords, formatPeso } from './money';
import { AF56_ROWS_PER_SHEET, splitWords } from './printCalibration';

/**
 * Patch 176 - what is printed on an Accountable Form No. 56: the values for
 * AF56_FIELDS (printCalibration.ts) from one receipt. Shared by CFMS's Print
 * receipts and the CFMS Collections app, so the two print the same form.
 */

/** Properties that fit on one AF 56 (the other two rows carry Basic and SEF). */
export const AF56_MAX_PROPERTIES = 4;

const money = (v: number | null | undefined) => (v ? formatPeso(v, { symbol: false }) : '');
/** Assessed values print in whole pesos: the AF 56 columns are narrow. */
const pesos = (v: number | null | undefined) =>
  v ? Math.round(v / 100).toLocaleString('en-PH', { maximumFractionDigits: 0 }) : '';

export function af56SheetValues(
  r: {
    rpt: Af56Detail;
    orDate: string;
    payorName: string;
    totalAmount: number;
    paymentForm?: string | null;
    checkNo?: string | null;
    collectingOfficerName: string;
  },
  ctx: {
    municipality: string;
    treasurer: string;
    longDate: (iso: string) => string;
    shortDate: (iso: string) => string;
  },
): { values: Record<string, string>; rows: Array<Record<string, string>> } {
  const d = r.rpt;
  const t = af56Total(d);
  const [w1, w2] = splitWords(amountInWords(r.totalAmount), 64);
  const rows: Array<Record<string, string>> = d.properties
    .slice(0, AF56_MAX_PROPERTIES)
    .map((p) => {
      const b = totalsOf(amountsOf(p.basic));
      const paid = b.tax - b.discount;
      const land = p.assessedLand ?? 0;
      const imp = p.assessedImprovement ?? 0;
      // The column is narrow: street and barangay when they fit, else the barangay.
      const both = [p.location, p.barangayName].filter((x) => String(x ?? '').trim()).join(', ');
      return {
        owner: p.declaredOwner,
        location: both.length <= 18 ? both : p.barangayName,
        lotBlock: p.lotBlock ?? '',
        tdNo: p.tdNo ?? '',
        avLand: pesos(land),
        avImprovement: pesos(imp),
        avTotal: pesos(land + imp),
        taxDue: money(b.tax),
        instNo: d.payment === 'INSTALLMENT' ? (p.installmentNo ?? '') : '',
        instPayment: d.payment === 'INSTALLMENT' ? money(paid) : '',
        fullPayment: d.payment === 'FULL' ? money(paid) : '',
        penalty: money(b.penalty),
        total: money(b.net),
      };
    });
  rows.push({ penalty: 'BASIC', total: money(t.basic) });
  if (t.sef) rows.push({ penalty: 'SEF', total: money(t.sef) });
  const figure = formatPeso(r.totalAmount, { symbol: false });
  return {
    values: {
      municipality: ctx.municipality,
      prevReceiptNo: d.previousReceiptNo ?? '',
      prevDated: d.previousReceiptDate ? ctx.shortDate(d.previousReceiptDate) : '',
      prevYear: d.previousReceiptYear ?? '',
      date: ctx.longDate(r.orDate),
      payor: r.payorName,
      amountWords1: w1,
      amountWords2: w2,
      amountFigures: figure,
      fullMark: d.payment === 'FULL' ? 'X' : '',
      installmentMark: d.payment === 'INSTALLMENT' ? 'X' : '',
      calendarYear: d.calendarYear,
      basicMark: t.basic ? 'X' : '',
      sefMark: t.sef ? 'X' : '',
      totalFigures: figure,
      cashAmount: !r.paymentForm || r.paymentForm === 'CASH' ? figure : '',
      checkNo: r.paymentForm === 'CHECK' ? (r.checkNo ?? '') : '',
      bankDate: '',
      modeTotal: figure,
      collectingOfficer: r.collectingOfficerName,
      treasurer: ctx.treasurer,
    },
    rows: rows.slice(0, AF56_ROWS_PER_SHEET),
  };
}
