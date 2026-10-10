/**
 * Patch 162 - BIR FORM 2307, Certificate of Creditable Tax Withheld at Source.
 *
 * A voucher that withholds tax owes the payee a 2307 for the quarter. This
 * file works out WHAT the certificate says, from the voucher's deductions:
 *
 *   - the period: the calendar quarter of the voucher's date;
 *   - Part I, the payee (TIN, name, registered address, ZIP) from Names;
 *   - Part II, the payor - the municipality (Settings: TIN, address, ZIP);
 *   - Part III, one row per ATC: the income payment (the base the tax was
 *     computed on) in the month of the quarter the voucher falls in, and the
 *     tax withheld. Expanded withholding tax (EWT) goes in the upper table;
 *     VAT withheld and percentage tax ("Money Payments Subject to
 *     Withholding of Business Tax") in the lower.
 *
 * bir2307Xlsx.ts writes it onto the BIR's own Excel form.
 */

export interface Form2307Row {
  description: string;
  atc: string;
  /** Income payment in the 1st, 2nd and 3rd month of the quarter, centavos. */
  months: [number, number, number];
  total: number;
  tax: number;
}

export interface Form2307 {
  periodFrom: string;
  periodTo: string;
  payee: { tin: string; name: string; address: string; zip: string; foreignAddress?: string };
  payor: { tin: string; name: string; address: string; zip: string };
  ewt: Form2307Row[];
  business: Form2307Row[];
  /** "NAME - Position", printed over the payor's signature line. */
  signatory: string;
}

export interface DeductionLike {
  taxCodeId?: string | null;
  code?: string | null;
  description?: string | null;
  base: number;
  amount: number;
}

export interface TaxCodeLike {
  id: string;
  code: string;
  description: string;
  kind: string;
  atc?: string | null;
}

/** The calendar quarter a date falls in, and which month of it. */
export function quarterOf(date: string): { from: string; to: string; monthIndex: 0 | 1 | 2 } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const q = Math.floor((m - 1) / 3);
  const first = q * 3 + 1;
  const last = first + 2;
  const lastDay = new Date(Date.UTC(y, last, 0)).getUTCDate();
  const mm = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${y}-${mm(first)}-01`,
    to: `${y}-${mm(last)}-${mm(lastDay)}`,
    monthIndex: ((m - 1) % 3) as 0 | 1 | 2,
  };
}

/** A TIN in the form's four boxes: 3-3-3 and a 5-digit branch code. */
export function tinBoxes(tin: string | null | undefined): [string, string, string, string] {
  const d = String(tin ?? '').replace(/\D/g, '');
  if (!d) return ['', '', '', ''];
  const branch = d.slice(9);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), branch ? branch.padStart(5, '0') : '00000'];
}

const isBusinessTax = (kind: string) => kind === 'VAT_WITHHOLDING' || kind === 'PERCENTAGE_TAX';

/**
 * The certificate for one voucher. Null when the voucher withholds no EWT,
 * VAT or percentage tax - there is nothing to certify.
 */
export function form2307FromVoucher(input: {
  date: string;
  deductions: DeductionLike[];
  taxCodes: TaxCodeLike[];
  payee: { tin?: string | null; name: string; address?: string | null; zip?: string | null };
  payor: { tin?: string | null; name: string; address?: string | null; zip?: string | null };
  signatory?: { name?: string | null; position?: string | null } | null;
}): Form2307 | null {
  const q = quarterOf(input.date);
  const ewt = new Map<string, Form2307Row>();
  const business = new Map<string, Form2307Row>();

  for (const d of input.deductions) {
    if (!(d.amount > 0)) continue;
    const tc =
      input.taxCodes.find((t) => d.taxCodeId && t.id === d.taxCodeId) ??
      input.taxCodes.find((t) => d.code && t.code === d.code);
    if (!tc) continue;
    const bucket = tc.kind === 'EWT' ? ewt : isBusinessTax(tc.kind) ? business : null;
    if (!bucket) continue;
    const atc = String(tc.atc ?? '').trim() || tc.code;
    const row = bucket.get(atc) ?? {
      description: tc.description,
      atc,
      months: [0, 0, 0] as [number, number, number],
      total: 0,
      tax: 0,
    };
    row.months[q.monthIndex] += d.base || 0;
    row.total += d.base || 0;
    row.tax += d.amount;
    bucket.set(atc, row);
  }
  if (ewt.size === 0 && business.size === 0) return null;

  const sig = input.signatory;
  return {
    periodFrom: q.from,
    periodTo: q.to,
    payee: {
      tin: String(input.payee.tin ?? ''),
      name: input.payee.name,
      address: String(input.payee.address ?? ''),
      zip: String(input.payee.zip ?? ''),
    },
    payor: {
      tin: String(input.payor.tin ?? ''),
      name: input.payor.name,
      address: String(input.payor.address ?? ''),
      zip: String(input.payor.zip ?? ''),
    },
    ewt: [...ewt.values()].slice(0, 10),
    business: [...business.values()].slice(0, 10),
    signatory: sig?.name ? `${sig.name}${sig.position ? ` - ${sig.position}` : ''}` : '',
  };
}

/** Pesos as the form prints them: 12,345.60; blank for nil. */
export function pesos(centavos: number): string {
  if (!centavos) return '';
  return (centavos / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** MM/DD/YYYY as the form's date boxes take it, without the slashes. */
export function mmddyyyy(date: string): { mmdd: string; yyyy: string } {
  return { mmdd: `${date.slice(5, 7)}${date.slice(8, 10)}`, yyyy: date.slice(0, 4) };
}
