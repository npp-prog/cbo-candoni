/**
 * Patch 175 - real property tax receipted on Accountable Form No. 56.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE OFFICE ASKED FOR
 * ---------------------------------------------------------------------------
 * Neil: "In Collection for Real Property, of the total collection, 50% goes to
 * General Fund and another 50% to Special Education Fund. For 50% general
 * fund, 35% goes to Province and recorded as Due to LGU with Subsidiary Ledger
 * for the Province name, 25% goes to Barangay recorded as Due to LGU with
 * subsidiary for Barangay Name, then the remaining 40% goes to the
 * Municipality and recorded as Real Property Tax or Penalty or Discount. Then
 * in 50% collection to SEF, 50% goes to the Province recorded as Due to LGU
 * with Subsidiary Ledger for the Province name and remaining 50% to
 * Municipality and recorded as Due to Other Fund since it will be adjusted in
 * the SEF Books. This is only done when using Accountable Form 56."
 *
 * And on the two open points: the municipality's share of tax paid IN ADVANCE
 * goes to Deferred Real Property Tax (its discount to Discount on Advance
 * Payment of RPT), as the GAM has it; arrears go to Real Property Tax - Basic
 * like the current year.
 *
 * ---------------------------------------------------------------------------
 * HOW ONE RECEIPT IS RECORDED
 * ---------------------------------------------------------------------------
 * The whole receipt is a General Fund collection. For each property on it the
 * officer types what the taxpayer paid, as the Abstract of RPT Collections
 * columns have it, for the basic tax and for the Special Education Tax:
 *
 *     tax - immediate and prior years, current year, advance
 *     penalty - prior years, current year
 *     discount - current year, advance                (reduces the cash)
 *
 * Every figure is split by the sharing, and the receipt's lines are the
 * result:
 *
 *   BASIC   35% Province   Cr Due to LGUs - <province>
 *           25% Barangay   Cr Due to LGUs - <barangay of the property>
 *           40% Municipal  Cr Real Property Tax - Basic     (prior, current)
 *                          Cr Deferred Real Property Tax    (advance)
 *                          Cr Fines and Penalties - Property Taxes
 *                          Dr Discount on RPT - Basic       (current discount)
 *                          Dr Discount on Advance Payment of RPT (advance)
 *   SEF     50% Province   Cr Due to LGUs - <province>
 *           50% Municipal  Cr Due to Other Funds - Special Education Fund
 *
 * A discount reduces the province's and the barangay's Due to LGUs line; the
 * municipality's own discount is shown as a debit to its discount account, so
 * a receipt line may be NEGATIVE. The RCD entry turns a negative line into a
 * debit (TreasuryReports and treasuryEntry.reportedCashDebit).
 *
 * ---------------------------------------------------------------------------
 * THE ODD CENTAVO
 * ---------------------------------------------------------------------------
 * Integer centavos, largest remainder: each figure splits into parts that add
 * back to the figure exactly, and the odd centavo goes to the part with the
 * largest fraction. On the office's own sample (penalty 3,165.42) that gives
 * Province 1,107.90, Municipal 1,266.17, Barangay 791.35 - the figures on the
 * worksheet.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ENGINE HAS A COPY
 * ---------------------------------------------------------------------------
 * The browser writes the receipt. When the Treasurer certifies the RCD, the
 * engine works the lines out again from the same figures and refuses a
 * receipt whose lines disagree - so the split between the province, the
 * barangays and the municipality is never only what a browser said it was.
 * scripts/sync-rules.mjs copies this file to functions/src/lib/af56.ts.
 */

export type Centavos = number;

export interface Af56Amounts {
  /** Immediate and prior years. */
  prior: Centavos;
  current: Centavos;
  advance: Centavos;
  penaltyPrior: Centavos;
  penaltyCurrent: Centavos;
  /** Discounts are typed positive and reduce the collection. */
  discountCurrent: Centavos;
  discountAdvance: Centavos;
}

export interface Af56Subsidiary {
  subsidiaryType: string;
  subsidiaryId: string;
  subsidiaryName: string;
}

export interface Af56Property {
  declaredOwner: string;
  barangayId: string;
  barangayName: string;
  /** No./Street, as the form has it beside the barangay. */
  location?: string | null;
  lotBlock?: string | null;
  tdNo?: string | null;
  assessedLand?: Centavos | null;
  assessedImprovement?: Centavos | null;
  /** The period settled, as the abstract prints it, e.g. 2012(1-3). */
  period?: string | null;
  installmentNo?: string | null;
  basic: Af56Amounts;
  sef: Af56Amounts;
  /** The barangay's subsidiary ledger account (a Name of type Barangay). */
  barangaySubsidiary: Af56Subsidiary | null;
}

export interface Af56Detail {
  /** The Calendar Year printed on the form. */
  calendarYear: string;
  payment: 'FULL' | 'INSTALLMENT';
  previousReceiptNo?: string | null;
  previousReceiptDate?: string | null;
  previousReceiptYear?: string | null;
  /** The province's subsidiary ledger account (a Name). */
  provinceSubsidiary: Af56Subsidiary | null;
  properties: Af56Property[];
}

export interface Af56Line {
  accountCode: string;
  accountName: string;
  amount: Centavos;
  particulars: string;
  subsidiaryType: string | null;
  subsidiaryId: string | null;
  subsidiaryName: string | null;
}

export const AF56_ACCOUNTS = {
  dueToLgus: { code: '20201070', name: 'Due to LGUs' },
  dueToOtherFunds: { code: '20301010', name: 'Due to Other Funds' },
  rptBasic: { code: '40102040', name: 'Real Property Tax - Basic' },
  rptBasicDiscount: { code: '40102041', name: 'Discount on Real Property Tax - Basic' },
  deferredRpt: { code: '20501010', name: 'Deferred Real Property Tax' },
  deferredRptDiscount: {
    code: '20501011',
    name: 'Discount on Advance Payment of Real Property Tax',
  },
  penalties: { code: '40105020', name: 'Tax Revenue - Fines and Penalties - Property Taxes' },
} as const;

/** Accounts a discount debits: the entry's debits to these are not cash. */
export const AF56_DISCOUNT_ACCOUNTS: readonly string[] = [
  AF56_ACCOUNTS.rptBasicDiscount.code,
  AF56_ACCOUNTS.deferredRptDiscount.code,
];

/** Basis points of 10,000. Local Government Code Sections 271 and 272. */
export const BASIC_SHARING = { province: 3_500, municipal: 4_000, barangay: 2_500 } as const;
export const SEF_SHARING = { province: 5_000, municipal: 5_000 } as const;

/** The subsidiary the municipality's SEF half is kept under. */
export const SEF_FUND_SUBSIDIARY: Af56Subsidiary = {
  subsidiaryType: 'FUND',
  subsidiaryId: 'SEF',
  subsidiaryName: 'Special Education Fund',
};

export const ZERO_AMOUNTS: Af56Amounts = {
  prior: 0,
  current: 0,
  advance: 0,
  penaltyPrior: 0,
  penaltyCurrent: 0,
  discountCurrent: 0,
  discountAdvance: 0,
};

export const AMOUNT_KEYS: Array<keyof Af56Amounts> = [
  'prior',
  'current',
  'advance',
  'penaltyPrior',
  'penaltyCurrent',
  'discountCurrent',
  'discountAdvance',
];

/** AF56, AF 56, AF-56, 56: the real property tax receipt. */
export function isAf56(formCode: string | null | undefined): boolean {
  const c = String(formCode ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return c === 'AF56' || c === '56' || c === 'AFNO56';
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

export function amountsOf(a: Partial<Af56Amounts> | null | undefined): Af56Amounts {
  const out = { ...ZERO_AMOUNTS };
  for (const k of AMOUNT_KEYS) out[k] = n(a?.[k]);
  return out;
}

/** Tax (all three periods), penalty, discount and the net the payor paid. */
export function totalsOf(a: Af56Amounts) {
  const tax = a.prior + a.current + a.advance;
  const penalty = a.penaltyPrior + a.penaltyCurrent;
  const discount = a.discountCurrent + a.discountAdvance;
  return { tax, penalty, discount, net: tax + penalty - discount };
}

/**
 * Split by basis points, exactly: floor each part, then hand the leftover
 * centavos to the parts with the largest fractions (ties to the first).
 */
export function splitShares(amount: Centavos, rates: number[]): Centavos[] {
  const sign = amount < 0 ? -1 : 1;
  const m = Math.abs(Math.round(amount));
  const parts = rates.map((r, i) => {
    const exact = (m * r) / 10_000;
    return { i, value: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = m - parts.reduce((s, p) => s + p.value, 0);
  for (const p of [...parts].sort((a, b) => b.frac - a.frac || a.i - b.i)) {
    if (left <= 0) break;
    p.value += 1;
    left -= 1;
  }
  return parts.map((p) => p.value * sign);
}

export interface BasicShare {
  province: Centavos;
  municipal: Centavos;
  barangay: Centavos;
}
export interface SefShare {
  province: Centavos;
  municipal: Centavos;
}

export function basicShare(amount: Centavos): BasicShare {
  const [province, municipal, barangay] = splitShares(amount, [
    BASIC_SHARING.province,
    BASIC_SHARING.municipal,
    BASIC_SHARING.barangay,
  ]);
  return { province, municipal, barangay };
}

export function sefShare(amount: Centavos): SefShare {
  const [province, municipal] = splitShares(amount, [SEF_SHARING.province, SEF_SHARING.municipal]);
  return { province, municipal };
}

/** Every figure of one property, split. Discounts stay positive here. */
export function propertyShares(p: Af56Property) {
  const b = amountsOf(p.basic);
  const s = amountsOf(p.sef);
  const basic = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, basicShare(b[k])])) as Record<
    keyof Af56Amounts,
    BasicShare
  >;
  const sef = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, sefShare(s[k])])) as Record<
    keyof Af56Amounts,
    SefShare
  >;
  return { basic, sef };
}

const signed = (k: keyof Af56Amounts, v: Centavos) =>
  k === 'discountCurrent' || k === 'discountAdvance' ? -v : v;

export type Af56AccountKey = keyof typeof AF56_ACCOUNTS;
export type Af56Accounts = Record<Af56AccountKey, { code: string; name: string }>;

/**
 * Patch 179 - the municipality's accounts, found in the office's own Chart of
 * Accounts by what they are called.
 *
 * The defaults are the GAM codes (40102040 Real Property Tax - Basic, and so
 * on). A chart that keeps real property tax under another code, or that uses
 * 40102040 for something else (one had "Franchise Tax" there), would have put
 * the municipality's share on the wrong account. So each account is looked up:
 *
 *   - the default code is kept when the chart's account at that code is the
 *     one expected (its name says so), or when the chart has no such code;
 *   - otherwise the chart is searched for the account whose name matches, and
 *     that account's code is used;
 *   - with no match anywhere, the default stays and `af56ChartWarnings` says
 *     what to correct in the Chart of Accounts.
 */
const NAME_TESTS: Record<Af56AccountKey, (name: string) => boolean> = {
  dueToLgus: (n) => /due\s*to\s*lgu/i.test(n),
  dueToOtherFunds: (n) => /due\s*to\s*other\s*funds?/i.test(n),
  rptBasic: (n) =>
    /real\s*property\s*tax|\brpt\b/i.test(n) &&
    /basic/i.test(n) &&
    !/discount|deferred|receivable|advance|transfer|idle|levy|special/i.test(n),
  rptBasicDiscount: (n) =>
    /discount/i.test(n) && /real\s*property\s*tax|\brpt\b/i.test(n) && !/advance|deferred/i.test(n),
  deferredRpt: (n) =>
    /deferred/i.test(n) && /real\s*property\s*tax|\brpt\b/i.test(n) && !/discount/i.test(n),
  deferredRptDiscount: (n) =>
    /discount/i.test(n) && /advance/i.test(n) && /real\s*property\s*tax|\brpt\b/i.test(n),
  penalties: (n) => /fines?\s*(and|&)\s*penalt/i.test(n) && /property/i.test(n),
};

export function resolveAf56Accounts(
  chart: Array<{ code: string; name: string; active?: boolean | null }> | null | undefined,
): Af56Accounts {
  const out = { ...AF56_ACCOUNTS } as Af56Accounts;
  if (!chart || chart.length === 0) return out;
  const live = chart.filter((a) => a.active !== false);
  for (const key of Object.keys(AF56_ACCOUNTS) as Af56AccountKey[]) {
    const def = AF56_ACCOUNTS[key];
    const test = NAME_TESTS[key];
    const atCode = live.find((a) => a.code === def.code);
    if (atCode && test(atCode.name)) {
      out[key] = { code: def.code, name: atCode.name };
      continue;
    }
    const found = live.filter((a) => test(a.name)).sort((x, y) => x.code.localeCompare(y.code))[0];
    if (found) out[key] = { code: found.code, name: found.name };
  }
  return out;
}

/** What the Chart of Accounts has to be corrected for, in plain words. */
export function af56ChartWarnings(
  chart: Array<{ code: string; name: string; active?: boolean | null }> | null | undefined,
): string[] {
  if (!chart || chart.length === 0) return [];
  const resolved = resolveAf56Accounts(chart);
  const out: string[] = [];
  for (const key of [
    'rptBasic',
    'rptBasicDiscount',
    'deferredRpt',
    'penalties',
  ] as Af56AccountKey[]) {
    const r = resolved[key];
    const at = chart.find((a) => a.code === r.code);
    if (at && !NAME_TESTS[key](at.name)) {
      out.push(
        `The Chart of Accounts calls ${r.code} "${at.name}", but CFMS posts the municipal share of real property tax there as "${AF56_ACCOUNTS[key].name}". Add or rename the account under Master Data > Chart of Accounts.`,
      );
    }
  }
  return out;
}

/** The municipality's own account for its share of each basic figure. */
function municipalAccounts(
  acc: Af56Accounts,
): Record<keyof Af56Amounts, { code: string; name: string; words: string }> {
  return {
    prior: { ...acc.rptBasic, words: 'Basic RPT, prior years - municipal share 40%' },
    current: { ...acc.rptBasic, words: 'Basic RPT, current year - municipal share 40%' },
    advance: { ...acc.deferredRpt, words: 'Basic RPT paid in advance - municipal share 40%' },
    penaltyPrior: { ...acc.penalties, words: 'RPT penalty, prior years - municipal share 40%' },
    penaltyCurrent: { ...acc.penalties, words: 'RPT penalty, current year - municipal share 40%' },
    discountCurrent: {
      ...acc.rptBasicDiscount,
      words: 'Discount on basic RPT - municipal share 40%',
    },
    discountAdvance: {
      ...acc.deferredRptDiscount,
      words: 'Discount on advance RPT - municipal share 40%',
    },
  };
}

/**
 * The receipt's lines, gathered by account and subsidiary. Lines that come to
 * nothing are left out; a discount line is negative. `accounts` is the result
 * of `resolveAf56Accounts` (patch 179); without it, the GAM defaults.
 */
export function af56Lines(detail: Af56Detail, accounts: Af56Accounts = AF56_ACCOUNTS): Af56Line[] {
  const MUNICIPAL_ACCOUNT = municipalAccounts(accounts);
  const order: string[] = [];
  const map = new Map<string, Af56Line>();
  const add = (
    account: { code: string; name: string },
    sub: Af56Subsidiary | null,
    amount: Centavos,
    particulars: string,
  ) => {
    if (!amount) return;
    const key = `${account.code}|${sub ? `${sub.subsidiaryType}:${sub.subsidiaryId}` : ''}`;
    const line = map.get(key);
    if (line) {
      line.amount += amount;
      return;
    }
    order.push(key);
    map.set(key, {
      accountCode: account.code,
      accountName: account.name,
      amount,
      particulars,
      subsidiaryType: sub?.subsidiaryType ?? null,
      subsidiaryId: sub?.subsidiaryId ?? null,
      subsidiaryName: sub?.subsidiaryName ?? null,
    });
  };

  const province = detail.provinceSubsidiary;
  // Province first, then each barangay, then the municipality's own lines, so
  // the receipt reads in the order the worksheet does.
  for (const p of detail.properties) {
    const sh = propertyShares(p);
    for (const k of AMOUNT_KEYS) {
      add(
        accounts.dueToLgus,
        province,
        signed(k, sh.basic[k].province),
        'RPT - provincial share (basic 35%, SEF 50%)',
      );
      add(
        accounts.dueToLgus,
        province,
        signed(k, sh.sef[k].province),
        'RPT - provincial share (basic 35%, SEF 50%)',
      );
    }
  }
  for (const p of detail.properties) {
    const sh = propertyShares(p);
    for (const k of AMOUNT_KEYS) {
      add(
        accounts.dueToLgus,
        p.barangaySubsidiary,
        signed(k, sh.basic[k].barangay),
        `Basic RPT - barangay share 25%`,
      );
    }
  }
  for (const p of detail.properties) {
    const sh = propertyShares(p);
    for (const k of AMOUNT_KEYS) {
      const acc = MUNICIPAL_ACCOUNT[k];
      add(acc, null, signed(k, sh.basic[k].municipal), acc.words);
    }
  }
  for (const p of detail.properties) {
    const sh = propertyShares(p);
    for (const k of AMOUNT_KEYS) {
      add(
        accounts.dueToOtherFunds,
        SEF_FUND_SUBSIDIARY,
        signed(k, sh.sef[k].municipal),
        'SEF - municipal share 50%, for the SEF books',
      );
    }
  }
  return order.map((k) => map.get(k)!).filter((l) => l.amount !== 0);
}

/** What the payor paid: basic and SEF, net of discounts. */
export function af56Total(detail: Af56Detail): { basic: Centavos; sef: Centavos; total: Centavos } {
  let basic = 0;
  let sef = 0;
  for (const p of detail.properties) {
    basic += totalsOf(amountsOf(p.basic)).net;
    sef += totalsOf(amountsOf(p.sef)).net;
  }
  return { basic, sef, total: basic + sef };
}

/** What has to be put right before the receipt can be recorded. */
export function af56Problems(detail: Af56Detail, fundCode?: string): string[] {
  const out: string[] = [];
  if (fundCode !== undefined && String(fundCode).toUpperCase() !== 'GF') {
    out.push(
      'A receipt on Accountable Form No. 56 is recorded in the General Fund: the SEF half goes to Due to Other Funds and is taken up in the SEF books. Choose GF at the top of the screen.',
    );
  }
  if (!String(detail.calendarYear ?? '').trim())
    out.push('Type the Calendar Year the payment is for.');
  if (!detail.provinceSubsidiary) {
    out.push(
      "The province's subsidiary ledger is not found: add the province under Master Data > Names (e.g. PROVINCE OF NEGROS OCCIDENTAL).",
    );
  }
  if (!detail.properties.length) out.push('Add at least one property.');
  detail.properties.forEach((p, i) => {
    const at = `Property ${i + 1}`;
    if (!String(p.declaredOwner ?? '').trim())
      out.push(`${at}: type the name of the declared owner.`);
    if (!p.barangayId) out.push(`${at}: choose the barangay where the property is.`);
    else if (!p.barangaySubsidiary) {
      out.push(
        `${at}: barangay ${p.barangayName || ''} has no subsidiary ledger - add it under Master Data > Names, Type Barangay.`,
      );
    }
    for (const [label, raw] of [
      ['basic tax', p.basic],
      ['SEF', p.sef],
    ] as const) {
      const a = amountsOf(raw);
      if (AMOUNT_KEYS.some((k) => a[k] < 0))
        out.push(`${at}: the ${label} figures cannot be negative.`);
      if (a.discountCurrent > a.current)
        out.push(
          `${at}: the ${label} discount for the current year is more than the current year's tax.`,
        );
      if (a.discountAdvance > a.advance)
        out.push(`${at}: the ${label} discount on the advance is more than the advance.`);
    }
    if (totalsOf(amountsOf(p.basic)).net + totalsOf(amountsOf(p.sef)).net <= 0) {
      out.push(`${at}: no amount has been typed.`);
    }
  });
  return out;
}

/**
 * Whether a receipt's lines are exactly what its AF 56 figures give. The
 * engine refuses to certify an RCD carrying one that is not.
 */
export function af56LinesAgree(
  detail: Af56Detail,
  lines: Array<{
    accountCode?: string | null;
    amount?: number | null;
    subsidiaryType?: string | null;
    subsidiaryId?: string | null;
  }>,
  /** Patch 179: the accounts resolved from the chart. The GAM defaults also agree. */
  accounts?: Af56Accounts,
): boolean {
  const key = (l: {
    accountCode?: string | null;
    subsidiaryType?: string | null;
    subsidiaryId?: string | null;
  }) =>
    `${String(l.accountCode ?? '')}|${l.subsidiaryId ? `${l.subsidiaryType ?? ''}:${l.subsidiaryId}` : ''}`;
  const sum = (
    ls: Array<{
      accountCode?: string | null;
      amount?: number | null;
      subsidiaryType?: string | null;
      subsidiaryId?: string | null;
    }>,
  ) => {
    const m = new Map<string, number>();
    for (const l of ls) m.set(key(l), (m.get(key(l)) ?? 0) + Math.round(Number(l.amount ?? 0)));
    for (const [k, v] of [...m]) if (v === 0) m.delete(k);
    return m;
  };
  const have = sum(lines);
  const same = (want: Map<string, number>) => {
    if (want.size !== have.size) return false;
    for (const [k, v] of want) if (have.get(k) !== v) return false;
    return true;
  };
  // A receipt recorded before the chart was corrected keeps the defaults.
  return same(sum(af56Lines(detail))) || (!!accounts && same(sum(af56Lines(detail, accounts))));
}

/** Name matching for subsidiary ledgers: case, punctuation and order free. */
export function nameKey(name: string, drop: string[] = []): string {
  const words = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !drop.includes(w));
  return words.sort().join(' ');
}

/** The Name of type Barangay standing for a barangay ("Barangay Agboy" = "AGBOY"). */
export function findBarangayName<
  T extends { name: string; payeeType?: string | null; active?: boolean | null },
>(barangayName: string, names: T[]): T | null {
  const want = nameKey(barangayName, ['BARANGAY', 'BRGY']);
  if (!want) return null;
  const hits = names.filter(
    (x) =>
      x.active !== false &&
      x.payeeType === 'BARANGAY' &&
      nameKey(x.name, ['BARANGAY', 'BRGY']) === want,
  );
  return hits.length === 1 ? hits[0] : null;
}

/** The Name standing for the province: "Province of X" or "X Province". */
export function findProvinceName<T extends { name: string; active?: boolean | null }>(
  province: string,
  names: T[],
): T | null {
  const want = nameKey(province, ['PROVINCE', 'OF', 'PROVINCIAL', 'GOVERNMENT']);
  if (!want) return null;
  const hits = names.filter((x) => {
    if (x.active === false) return false;
    const k = String(x.name ?? '').toUpperCase();
    if (!/PROVINCE|PROVINCIAL/.test(k)) return false;
    return nameKey(x.name, ['PROVINCE', 'OF', 'PROVINCIAL', 'GOVERNMENT', 'THE']) === want;
  });
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// Patch 176: the matching entry in the Special Education Fund
// ---------------------------------------------------------------------------

/*
 * Neil: "make a matching entry in SEF: Dr Due from Other Funds, Cr Special
 * Education Tax and SET Penalty (Cr) or Discount (Dr)."
 *
 * The General Fund holds the municipality's 50% of the SEF as Due to Other
 * Funds. When the RCD carrying AF 56 receipts is journalized, the engine posts
 * this entry in the SEF books, from the same receipts:
 *
 *   Dr 10304050 Due from Other Funds - General Fund        net SEF share
 *     Cr 40102050 Special Education Tax                    prior + current
 *     Cr 20501020 Deferred Special Education Tax           advance
 *     Cr 40105020 Fines and Penalties - Property Taxes     penalties
 *   Dr 40102051 Discount on Special Education Tax          current discount
 *   Dr 20501021 Discount on Advance Payment of SET         advance discount
 *
 * The advance follows the basic tax's rule (Deferred, as Neil chose for it).
 * The Due from Other Funds debit is exactly the Due to Other Funds the
 * receipts credited in the General Fund, so the two funds' interfund accounts
 * agree to the centavo.
 */
export const SEF_BOOK_ACCOUNTS = {
  dueFromOtherFunds: { code: '10304050', name: 'Due from Other Funds' },
  set: { code: '40102050', name: 'Special Education Tax' },
  setDiscount: { code: '40102051', name: 'Discount on Special Education Tax' },
  deferredSet: { code: '20501020', name: 'Deferred Special Education Tax' },
  deferredSetDiscount: {
    code: '20501021',
    name: 'Discount on Advance Payment of Special Education Tax',
  },
  penalties: AF56_ACCOUNTS.penalties,
} as const;

export const GF_FUND_SUBSIDIARY: Af56Subsidiary = {
  subsidiaryType: 'FUND',
  subsidiaryId: 'GF',
  subsidiaryName: 'General Fund',
};

export interface SefBookLine {
  accountCode: string;
  accountName: string;
  debit: Centavos;
  credit: Centavos;
  subsidiaryType: string | null;
  subsidiaryId: string | null;
  subsidiaryName: string | null;
  particulars: string;
}

/** The municipality's 50% of the SEF on these receipts, by figure. */
export function municipalSefShares(details: Af56Detail[]): Af56Amounts {
  const out = { ...ZERO_AMOUNTS };
  for (const d of details) {
    for (const p of d.properties ?? []) {
      const sh = propertyShares(p);
      for (const k of AMOUNT_KEYS) out[k] += sh.sef[k].municipal;
    }
  }
  return out;
}

/** The SEF-books entry for these receipts; empty when there is no SEF. */
export function sefBooksEntry(details: Af56Detail[], reference = ''): SefBookLine[] {
  const m = municipalSefShares(details);
  const net =
    m.prior +
    m.current +
    m.advance +
    m.penaltyPrior +
    m.penaltyCurrent -
    m.discountCurrent -
    m.discountAdvance;
  const per = reference ? ` per ${reference}` : '';
  const line = (
    account: { code: string; name: string },
    debit: number,
    credit: number,
    particulars: string,
    sub: Af56Subsidiary | null = null,
  ): SefBookLine => ({
    accountCode: account.code,
    accountName: account.name,
    debit,
    credit,
    subsidiaryType: sub?.subsidiaryType ?? null,
    subsidiaryId: sub?.subsidiaryId ?? null,
    subsidiaryName: sub?.subsidiaryName ?? null,
    particulars,
  });
  const lines = [
    line(
      SEF_BOOK_ACCOUNTS.dueFromOtherFunds,
      net,
      0,
      `Municipal share of SEF held by the General Fund${per}`,
      GF_FUND_SUBSIDIARY,
    ),
    line(
      SEF_BOOK_ACCOUNTS.setDiscount,
      m.discountCurrent,
      0,
      `Discount on SET - municipal share${per}`,
    ),
    line(
      SEF_BOOK_ACCOUNTS.deferredSetDiscount,
      m.discountAdvance,
      0,
      `Discount on advance SET - municipal share${per}`,
    ),
    line(
      SEF_BOOK_ACCOUNTS.set,
      0,
      m.prior + m.current,
      `Special Education Tax - municipal share 50%${per}`,
    ),
    line(
      SEF_BOOK_ACCOUNTS.deferredSet,
      0,
      m.advance,
      `SET paid in advance - municipal share 50%${per}`,
    ),
    line(
      SEF_BOOK_ACCOUNTS.penalties,
      0,
      m.penaltyPrior + m.penaltyCurrent,
      `SET penalty - municipal share 50%${per}`,
    ),
  ];
  return lines.filter((l) => l.debit !== 0 || l.credit !== 0);
}
