import {
  AMOUNT_KEYS,
  amountsOf,
  propertyShares,
  totalsOf,
  type Af56Amounts,
  type Af56Detail,
} from '@/lib/af56';

/**
 * Patch 175 - the Abstract of Real Property Tax Collections from the AF 56
 * receipts themselves, in the office's own worksheet layout: one row per
 * official receipt with the basic tax and the Special Education Tax side by
 * side, and the sharing summary below it (Province 35 / Municipal 40 /
 * Barangay 25 for the basic tax, 50 / 50 for the SEF).
 *
 * The shares are the SAME figures the receipts were recorded with - each
 * receipt's split, added up - so the summary agrees with Due to LGUs, the
 * RPT accounts and Due to Other Funds in the ledger to the centavo.
 */

export interface Af56Receipt {
  id?: string;
  orNumber: string;
  orDate: string;
  payorName: string;
  status?: string;
  collectingOfficerName?: string;
  rpt?: Af56Detail | null;
}

export interface TaxColumns {
  prior: number;
  current: number;
  advance: number;
  penalty: number;
  discountCurrent: number;
  discountAdvance: number;
  total: number;
}

export interface Af56AbstractRow {
  orDate: string;
  orNumber: string;
  declarant: string;
  period: string;
  barangays: string;
  basic: TaxColumns;
  sef: TaxColumns;
  total: number;
}

export interface ShareRow {
  label: string;
  total: number;
  province: number;
  municipal: number;
  /** Basic tax only. */
  barangay: number;
}

export interface Af56Summary {
  basic: { tax: ShareRow[]; penalty: ShareRow[]; discount: ShareRow[]; total: ShareRow };
  sef: { tax: ShareRow[]; penalty: ShareRow[]; discount: ShareRow[]; total: ShareRow };
}

const columns = (a: Af56Amounts): TaxColumns => ({
  prior: a.prior,
  current: a.current,
  advance: a.advance,
  penalty: a.penaltyPrior + a.penaltyCurrent,
  discountCurrent: a.discountCurrent,
  discountAdvance: a.discountAdvance,
  total: totalsOf(a).net,
});

const addCols = (x: TaxColumns, y: TaxColumns): TaxColumns => ({
  prior: x.prior + y.prior,
  current: x.current + y.current,
  advance: x.advance + y.advance,
  penalty: x.penalty + y.penalty,
  discountCurrent: x.discountCurrent + y.discountCurrent,
  discountAdvance: x.discountAdvance + y.discountAdvance,
  total: x.total + y.total,
});

const ZERO_COLS: TaxColumns = {
  prior: 0,
  current: 0,
  advance: 0,
  penalty: 0,
  discountCurrent: 0,
  discountAdvance: 0,
  total: 0,
};

const LABELS: Record<keyof Af56Amounts, string> = {
  prior: 'Prior Years',
  current: 'Current Year',
  advance: 'Advance Payment',
  penaltyPrior: 'Prior Years',
  penaltyCurrent: 'Current Year',
  discountCurrent: 'Current Year',
  discountAdvance: 'Advance Discount',
};

export function buildAf56Abstract(input: {
  receipts: Af56Receipt[];
  fromDate: string;
  toDate: string;
  officer?: string;
}) {
  const inRange = input.receipts
    .filter((r) => r.rpt && r.status !== 'CANCELLED')
    .filter((r) => r.orDate >= input.fromDate && r.orDate <= input.toDate)
    .filter((r) => !input.officer || (r.collectingOfficerName ?? '').trim() === input.officer)
    .sort((a, b) => a.orDate.localeCompare(b.orDate) || a.orNumber.localeCompare(b.orNumber));

  const rows: Af56AbstractRow[] = inRange.map((r) => {
    const d = r.rpt!;
    let basic = { ...ZERO_COLS };
    let sef = { ...ZERO_COLS };
    for (const p of d.properties) {
      basic = addCols(basic, columns(amountsOf(p.basic)));
      sef = addCols(sef, columns(amountsOf(p.sef)));
    }
    const owners = [...new Set(d.properties.map((p) => p.declaredOwner.trim()).filter(Boolean))];
    return {
      orDate: r.orDate,
      orNumber: r.orNumber,
      declarant: owners.length > 1 ? `${owners[0]} et al.` : (owners[0] ?? r.payorName),
      period: [...new Set(d.properties.map((p) => (p.period ?? '').trim()).filter(Boolean))].join(
        ', ',
      ),
      barangays: [...new Set(d.properties.map((p) => p.barangayName).filter(Boolean))].join(', '),
      basic,
      sef,
      total: basic.total + sef.total,
    };
  });

  const totals = rows.reduce(
    (t, r) => ({
      basic: addCols(t.basic, r.basic),
      sef: addCols(t.sef, r.sef),
      total: t.total + r.total,
    }),
    { basic: { ...ZERO_COLS }, sef: { ...ZERO_COLS }, total: 0 },
  );

  // ---- the sharing, from each receipt's own split -------------------------
  const blank = (label: string): ShareRow => ({
    label,
    total: 0,
    province: 0,
    municipal: 0,
    barangay: 0,
  });
  const basicBy = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, blank(LABELS[k])])) as Record<
    keyof Af56Amounts,
    ShareRow
  >;
  const sefBy = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, blank(LABELS[k])])) as Record<
    keyof Af56Amounts,
    ShareRow
  >;
  const byBarangay = new Map<string, number>();

  for (const r of inRange) {
    for (const p of r.rpt!.properties) {
      const b = amountsOf(p.basic);
      const s = amountsOf(p.sef);
      const sh = propertyShares(p);
      for (const k of AMOUNT_KEYS) {
        const sign = k === 'discountCurrent' || k === 'discountAdvance' ? -1 : 1;
        basicBy[k].total += b[k];
        basicBy[k].province += sh.basic[k].province;
        basicBy[k].municipal += sh.basic[k].municipal;
        basicBy[k].barangay += sh.basic[k].barangay;
        sefBy[k].total += s[k];
        sefBy[k].province += sh.sef[k].province;
        sefBy[k].municipal += sh.sef[k].municipal;
        const name = p.barangayName || '(no barangay)';
        byBarangay.set(name, (byBarangay.get(name) ?? 0) + sign * sh.basic[k].barangay);
      }
    }
  }

  const net = (rowsOf: Record<keyof Af56Amounts, ShareRow>, label: string): ShareRow => {
    const out = blank(label);
    for (const k of AMOUNT_KEYS) {
      const sign = k === 'discountCurrent' || k === 'discountAdvance' ? -1 : 1;
      out.total += sign * rowsOf[k].total;
      out.province += sign * rowsOf[k].province;
      out.municipal += sign * rowsOf[k].municipal;
      out.barangay += sign * rowsOf[k].barangay;
    }
    return out;
  };

  const summary: Af56Summary = {
    basic: {
      tax: [basicBy.prior, basicBy.current, basicBy.advance],
      penalty: [basicBy.penaltyPrior, basicBy.penaltyCurrent],
      discount: [basicBy.discountCurrent, basicBy.discountAdvance],
      total: net(basicBy, 'TOTAL COLLECTION (BASIC TAX)'),
    },
    sef: {
      tax: [sefBy.prior, sefBy.current, sefBy.advance],
      penalty: [sefBy.penaltyPrior, sefBy.penaltyCurrent],
      discount: [sefBy.discountCurrent, sefBy.discountAdvance],
      total: net(sefBy, 'TOTAL COLLECTION (SET)'),
    },
  };

  return {
    rows,
    totals,
    summary,
    byBarangay: [...byBarangay.entries()]
      .filter(([, v]) => v !== 0)
      .map(([barangayName, share]) => ({ barangayName, share }))
      .sort((a, b) => a.barangayName.localeCompare(b.barangayName)),
  };
}
