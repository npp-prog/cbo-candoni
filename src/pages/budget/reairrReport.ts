import type { Centavos, IsoDate } from '@/types/common';

/**
 * The Registry of Estimated and Actual Income/Revenues and Receipts.
 *
 * GAM for LGUs, Appendix 23. This is the statutory book for the Estimated
 * Receipts module: the ordinance's income estimates on one side, what the
 * Treasury actually collected on the other, account by account.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SECTIONS ARE NOT FOOTED THE SAME WAY, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * The RAAO foots both its sections monthly. This form does not, and reading
 * instruction 2 against instruction 3 says why:
 *
 *   A. Estimates - "at the start of the year the ... Estimates based on the
 *      Appropriation Ordinance shall [be] posted... Additional estimates as a
 *      result of supplemental budgets shall be posted in the same manner. It
 *      shall be totaled AT THE END OF THE YEAR."
 *
 *   B. Actual Collections - "shall be totaled MONTHLY and shall be labeled as
 *      the total amount for the month. A cumulative total shall be maintained
 *      by adding ... the current month to the Total to Date of the previous
 *      month."
 *
 * An estimate is an authority for the year, not an event in a month. Cutting
 * it to a month would invent a monthly estimate the Local Finance Committee
 * never certified - the same refusal made when the LBAc reports were built,
 * and for the same reason. So Section A carries the year's estimate whatever
 * period is on the filter, and only Section B moves.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE LINES COME FROM
 * ---------------------------------------------------------------------------
 * Instruction 1 is specific about both:
 *
 *   "Date - date indicated in the Appropriation Ordinance for the income
 *    estimates (A) or Report of Collections and Deposits (RCD) for the actual
 *    collections (B)"
 *
 * So Section B is one line per RCD, not one per Official Receipt. That is the
 * manual's choice and it is also the readable one: an RCD is a day's takings
 * with the accounts already summarised on it, and a register of every OR would
 * run to thousands of lines a year and be read by nobody.
 */

export interface ReairrEstimate {
  accountCode: string;
  accountName: string;
  incomeClass: string;
  annual: Centavos;
  /** What the figures were loaded from, if anything. Shown as Particulars. */
  sourceFile?: string;
}

export interface ReairrRcd {
  rcdNo: string;
  rcdDate: IsoDate;
  status: string;
  accountSummary: Array<{ accountCode: string; accountName: string; amount: Centavos }>;
  totalCollections: Centavos;
  /** What the line says in Particulars. Defaults to the RCD wording. */
  particulars?: string;
}

/**
 * Which reports count as collected.
 *
 * A DRAFT report is a treasurer's working paper and a CANCELLED one collected
 * nothing. SUBMITTED, VERIFIED and POSTED are all reports that have left the
 * collecting officer's hands, and the money behind them is in.
 */
export const COLLECTED = new Set(['SUBMITTED', 'VERIFIED', 'POSTED']);

// ---------------------------------------------------------------------------
// PATCH 131 - THE REPORTS THE TREASURY ACTUALLY FILES NOW
// ---------------------------------------------------------------------------
// Until patch 131 this registry read only the old `rcds` collection. Every
// Report of Collections and Deposits made since the Treasury Reports screen
// (RCD 111, 2.00, journalized as JEV 100-2026-10-0007) lives in
// `treasuryReports`, so a collection could be in the General Ledger and on
// the SRE and still be missing here. Both are read now.
//
// WHICH ONES COUNT. A treasury report counts once it is JOURNALIZED - the
// Accountant has posted its entry, so the registry agrees with the books
// (and with the SRE and LBAc Form No. 1, which read the books). A CERTIFIED
// report is in Accounting's hands but not yet in the books; it is shown as a
// note, not counted, so the two never disagree by money nobody has posted.
//
// THE ACCOUNTS. Read off the report's entry: each account credited, net of
// any debit to it. The debit to cash comes out negative and is dropped. The
// entry is what was posted, so the columns are the General Ledger's.
// ---------------------------------------------------------------------------

/** The treasury reports that report money coming in. */
export const COLLECTION_REPORT_TYPES = new Set(['RCD', 'ERCD_AR', 'ERCD_EOR']);

export interface CollectionReportLike {
  reportType: string;
  reportNo?: string;
  reportDate: IsoDate;
  status: string;
  totalAmount: Centavos;
  entry?: Array<{ accountCode: string; accountName: string; debit: Centavos; credit: Centavos }>;
}

const REPORT_PARTICULARS: Record<string, string> = {
  RCD: 'Collections per Report of Collections and Deposits',
  ERCD_AR: 'Collections per Report of e-Collections and Deposits (by Intermediary)',
  ERCD_EOR: 'Collections per Report of e-Collections and Deposits',
};

/**
 * A treasury report as a registry line. Null for a report that is not a
 * collection. JOURNALIZED becomes POSTED, the status this registry counts;
 * every other status passes through and is not counted.
 */
export function collectionReportAsRcd(r: CollectionReportLike): ReairrRcd | null {
  if (!COLLECTION_REPORT_TYPES.has(r.reportType)) return null;
  const net = new Map<string, { name: string; amount: Centavos }>();
  for (const l of r.entry ?? []) {
    const code = String(l.accountCode ?? '').trim();
    if (!code) continue;
    const cur = net.get(code) ?? { name: l.accountName ?? '', amount: 0 };
    cur.amount += (l.credit ?? 0) - (l.debit ?? 0);
    if (!cur.name && l.accountName) cur.name = l.accountName;
    net.set(code, cur);
  }
  const accountSummary = [...net.entries()]
    .filter(([, v]) => v.amount > 0)
    .map(([accountCode, v]) => ({ accountCode, accountName: v.name, amount: v.amount }));
  return {
    rcdNo: r.reportNo ?? '',
    rcdDate: r.reportDate,
    status: r.status === 'JOURNALIZED' ? 'POSTED' : r.status,
    accountSummary,
    totalCollections: r.totalAmount ?? 0,
    particulars: REPORT_PARTICULARS[r.reportType],
  };
}

/** Certified collection reports not yet journalized: shown, not counted. */
export function awaitingJournal(reports: CollectionReportLike[]): {
  count: number;
  total: Centavos;
  numbers: string[];
} {
  const waiting = reports.filter(
    (r) => COLLECTION_REPORT_TYPES.has(r.reportType) && r.status === 'CERTIFIED',
  );
  return {
    count: waiting.length,
    total: waiting.reduce((t, r) => t + (r.totalAmount ?? 0), 0),
    numbers: waiting.map((r) => r.reportNo ?? '').filter(Boolean),
  };
}

export interface ReairrEntry {
  date: IsoDate;
  reference: string;
  particulars: string;
  amount: Centavos;
  byAccount: Record<string, Centavos>;
}

export interface Reairr {
  /** The income account columns, in code order: the heads of both sections. */
  accountCodes: string[];
  accountNames: Record<string, string>;

  /** Section A. One line per source document, totalled for the year. */
  estimates: ReairrEntry[];
  estimateTotal: Centavos;
  estimateByAccount: Record<string, Centavos>;

  /** Section B. */
  collectionsBroughtForward: Centavos;
  collectionsBroughtForwardByAccount: Record<string, Centavos>;
  collections: ReairrEntry[];
  collectionsThisPeriod: Centavos;
  collectionsThisPeriodByAccount: Record<string, Centavos>;
  collectionsToDate: Centavos;
  collectionsToDateByAccount: Record<string, Centavos>;

  /**
   * Estimate less collections to date, per account and in total.
   *
   * Positive means the estimate has not yet been realised. Negative means more
   * was collected than was estimated, which is not an error - it is the figure
   * a supplemental budget is argued from.
   */
  shortfall: Centavos;
  shortfallByAccount: Record<string, Centavos>;
}

const addTo = (m: Record<string, Centavos>, code: string, amount: Centavos) => {
  const k = code || '-';
  m[k] = (m[k] ?? 0) + amount;
};

export function buildReairr(input: {
  estimates: ReairrEstimate[];
  rcds: ReairrRcd[];
  from: IsoDate;
  to: IsoDate;
  /** Shown as the Particulars of the estimate line. */
  estimateParticulars?: string;
  estimateDate?: IsoDate;
}): Reairr {
  const accounts = new Set<string>();
  const accountNames: Record<string, string> = {};

  const estimateByAccount: Record<string, Centavos> = {};
  let estimateTotal = 0;
  for (const e of input.estimates) {
    if (e.annual === 0) continue;
    accounts.add(e.accountCode);
    accountNames[e.accountCode] = e.accountName;
    addTo(estimateByAccount, e.accountCode, e.annual);
    estimateTotal += e.annual;
  }

  /*
   * One estimate line, not one per account.
   *
   * The manual's Section A has a line per SOURCE DOCUMENT - the annual budget,
   * then each supplemental - with the accounts spread across the columns. CFMS
   * holds one current figure per account and no history of which ordinance put
   * it there, so there is one line, and it is labelled with what the figures
   * were loaded from rather than being called "Annual Budget" on no evidence.
   *
   * When Candoni starts recording supplemental budgets as their own load, this
   * becomes several lines without the shape of the form changing.
   */
  const estimates: ReairrEntry[] =
    estimateTotal === 0
      ? []
      : [
          {
            date: input.estimateDate ?? '',
            reference: '',
            particulars: input.estimateParticulars || 'Income estimates on record',
            amount: estimateTotal,
            byAccount: { ...estimateByAccount },
          },
        ];

  const bfBy: Record<string, Centavos> = {};
  let bf = 0;
  const collections: ReairrEntry[] = [];

  for (const r of input.rcds) {
    if (!COLLECTED.has(r.status)) continue;
    if (r.rcdDate > input.to) continue;

    const byAccount: Record<string, Centavos> = {};
    let amount = 0;
    for (const a of r.accountSummary ?? []) {
      accounts.add(a.accountCode);
      if (a.accountName) accountNames[a.accountCode] = a.accountName;
      addTo(byAccount, a.accountCode, a.amount);
      amount += a.amount;
    }

    if (r.rcdDate < input.from) {
      bf += amount;
      for (const [code, v] of Object.entries(byAccount)) addTo(bfBy, code, v);
      continue;
    }
    collections.push({
      date: r.rcdDate,
      reference: r.rcdNo,
      particulars: r.particulars ?? 'Collections per Report of Collections and Deposits',
      amount,
      byAccount,
    });
  }

  collections.sort(
    (a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference),
  );

  const thisPeriodByAccount: Record<string, Centavos> = {};
  let thisPeriod = 0;
  for (const e of collections) {
    thisPeriod += e.amount;
    for (const [code, v] of Object.entries(e.byAccount)) addTo(thisPeriodByAccount, code, v);
  }

  const toDateByAccount = { ...bfBy };
  for (const [code, v] of Object.entries(thisPeriodByAccount)) addTo(toDateByAccount, code, v);
  const collectionsToDate = bf + thisPeriod;

  const accountCodes = [...accounts].sort();
  const shortfallByAccount: Record<string, Centavos> = {};
  for (const code of accountCodes) {
    shortfallByAccount[code] = (estimateByAccount[code] ?? 0) - (toDateByAccount[code] ?? 0);
  }

  return {
    accountCodes,
    accountNames,
    estimates,
    estimateTotal,
    estimateByAccount,
    collectionsBroughtForward: bf,
    collectionsBroughtForwardByAccount: bfBy,
    collections,
    collectionsThisPeriod: thisPeriod,
    collectionsThisPeriodByAccount: thisPeriodByAccount,
    collectionsToDate,
    collectionsToDateByAccount: toDateByAccount,
    shortfall: estimateTotal - collectionsToDate,
    shortfallByAccount,
  };
}
