import type { Centavos, IsoDate } from '@/types/common';

/**
 * Patch 178 - reconciling the Treasury's cash records with the Accounting
 * records.
 *
 * ---------------------------------------------------------------------------
 * TWO RECONCILIATIONS, ONE METHOD
 * ---------------------------------------------------------------------------
 *   Cash in Local Treasury   the Treasury's cash book (built from the RCDs)
 *                            against the General Ledger, 10101010.
 *   Cash in Bank             the Treasury's Cash in Bank book for one bank
 *                            account (deposits, checks, ADA, bank entries)
 *                            against the General Ledger account of that bank
 *                            account, with the account as its subsidiary.
 *
 * Both records are cut into the DOCUMENTS that moved the money, and each
 * document is looked for on both sides:
 *
 *   - an RCD, RCI or RADAI is one document: on the Treasury side, what the
 *     report says; on the Accounting side, its journal entry (and that
 *     entry's reversal, if any);
 *   - a deposit, check or ADA on no report, a bank entry keyed by the
 *     Treasury, and a journal entry made in Accounting are each their own.
 *
 * A document whose two figures agree is AGREED and is not a reconciling
 * item. Every other one is, and says why: certified but not yet journalized,
 * journalized after the date, journalized for a different amount, in the
 * books with no RCD behind it, and so on.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATEMENT ALWAYS CLOSES - AND WHY IT IS STILL CHECKED
 * ---------------------------------------------------------------------------
 * Each item is the books' figure less the Treasury's figure for one document,
 * so the Treasury balance plus the items IS the books' balance, to the
 * centavo, by construction. The value is not in the arithmetic; it is in
 * naming every peso of the difference against a document somebody can pull.
 * The statement still computes "unexplained" from the General Ledger read
 * separately, so a ledger line that no document claims cannot hide.
 *
 * ---------------------------------------------------------------------------
 * SAME MONEY, TWO REFERENCES
 * ---------------------------------------------------------------------------
 * A bank charge keyed by the Treasury and the Accountant's journal entry for
 * it are one event under two references. Where a Treasury-only item and a
 * books-only item have the same amount, the same direction and dates within
 * 45 days of each other, they are paired as "recorded in both under different
 * references" - shown, so somebody can confirm it, but with no effect.
 */

export interface ReconLedgerEntry {
  id: string;
  jevId: string;
  jevNo: string;
  entryDate: IsoDate;
  accountCode: string;
  debit: Centavos;
  credit: Centavos;
  sourceType: string;
  sourceId?: string | null;
  referenceNo?: string | null;
  particulars?: string | null;
  subsidiaryId?: string | null;
}

export interface ReconReport {
  id: string;
  reportType: string;
  reportNo?: string | null;
  reportDate: IsoDate;
  status: string;
  forwardedAt?: string | null;
  jevId?: string | null;
  jevNo?: string | null;
  accountableOfficerName?: string | null;
  cancelledReason?: string | null;
  lines?: Array<{ sourceId: string; sourceNo: string; amount: number; excluded?: boolean }>;
  deposits?: Array<{ sourceId: string; depositSlipNo?: string | null; amount: number }>;
}

export type ReconSide = 'TREASURY_ONLY' | 'BOOKS_ONLY' | 'DIFFERENT' | 'PAIRED';

export interface ReconItem {
  key: string;
  side: ReconSide;
  date: IsoDate;
  reference: string;
  description: string;
  /** Why the two records differ on this document, in plain words. */
  cause: string;
  /** The document's net effect on cash per the Treasury records (+ in, - out). */
  treasury: Centavos;
  /** Its net effect per the General Ledger. */
  books: Centavos;
  /** books - treasury: what this item adds to the Treasury balance. */
  effect: Centavos;
  /** For a PAIRED item, the key of the item it was paired with. */
  pairedWith?: string;
}

export interface ReconResult {
  asOf: IsoDate;
  treasuryBalance: Centavos;
  bookBalance: Centavos;
  items: ReconItem[];
  /** Documents on which the two records agree. */
  agreed: { count: number; amount: Centavos };
  subtotals: Record<'TREASURY_ONLY' | 'BOOKS_ONLY' | 'DIFFERENT', Centavos>;
  /** treasuryBalance + every item's effect. */
  bridged: Centavos;
  /** bookBalance - bridged. Zero when every difference is accounted for. */
  unexplained: Centavos;
}

const peso = (c: number) =>
  `${c < 0 ? '-' : ''}${(Math.abs(c) / 100).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const REPORT_NAME: Record<string, string> = {
  RCD: 'RCD',
  RCI: 'RCI',
  RADAI: 'RADAI',
  RCDISB: 'RCDisb',
  ERCD_AR: 'eRCD',
  ERCD_EOR: 'eRCD',
};

export const REPORTED_STATUSES = new Set(['CERTIFIED', 'JOURNALIZED']);

function reportLabel(r: ReconReport): string {
  return `${REPORT_NAME[r.reportType] ?? r.reportType} ${r.reportNo || '(no number)'}`;
}

/** The ledger's documents: an entry and its reversals are one. */
function ledgerKeyer(
  ledger: ReconLedgerEntry[],
  reports: ReconReport[],
  extra?: (e: ReconLedgerEntry) => string | null,
) {
  const reportById = new Map(reports.map((r) => [r.id, r]));
  const reportByJev = new Map<string, ReconReport>();
  for (const r of reports) if (r.jevId) reportByJev.set(r.jevId, r);

  const own = (e: ReconLedgerEntry): string => {
    if (e.sourceType === 'OPENING') return 'OPENING';
    const byJev = reportByJev.get(e.jevId);
    if (byJev) return `rep:${byJev.id}`;
    if (e.sourceId && reportById.has(e.sourceId)) return `rep:${e.sourceId}`;
    const x = extra?.(e);
    if (x) return x;
    return `jev:${e.jevId}`;
  };

  // A reversal belongs with the entry it reverses (sourceId = original jevId).
  const keyOfJev = new Map<string, string>();
  for (const e of ledger) if (e.sourceType !== 'REVERSING') keyOfJev.set(e.jevId, own(e));
  return (e: ReconLedgerEntry): string => {
    if (e.sourceType === 'REVERSING' && e.sourceId) {
      const orig = reportByJev.get(e.sourceId);
      if (orig) return `rep:${orig.id}`;
      return keyOfJev.get(e.sourceId) ?? `jev:${e.sourceId}`;
    }
    return own(e);
  };
}

interface Bucket {
  key: string;
  treasury: Centavos;
  books: Centavos;
  /** Books entries for this key dated after asOf (for timing causes). */
  laterBooks: ReconLedgerEntry[];
  booksEntries: ReconLedgerEntry[];
  treasuryDate?: IsoDate;
  treasuryRef?: string;
  treasuryDesc?: string;
  treasuryDocs: string[];
}

function bucket(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) {
    b = { key, treasury: 0, books: 0, laterBooks: [], booksEntries: [], treasuryDocs: [] };
    map.set(key, b);
  }
  return b;
}

function sideOf(b: Bucket): 'TREASURY_ONLY' | 'BOOKS_ONLY' | 'DIFFERENT' {
  if (b.books === 0 && b.booksEntries.length === 0) return 'TREASURY_ONLY';
  if (b.treasury === 0 && !b.treasuryDesc) return 'BOOKS_ONLY';
  return 'DIFFERENT';
}

function booksOnlyCause(entries: ReconLedgerEntry[], fy: number, what: string): string {
  const e = entries[0];
  if (!e) return 'In the books.';
  const j = `JEV ${e.jevNo}`;
  switch (e.sourceType) {
    case 'OPENING':
      return `Beginning balance per the books (opening entry ${j}). The Treasury's ${what} does not carry it.`;
    case 'DV':
      return `${j} from a disbursement voucher - money paid out of this cash with no ${what === 'cash book' ? 'RCD' : 'check or ADA'} in the Treasury records.`;
    case 'REVERSING':
      return `${j} reverses an entry dated before ${fy}, or one not on this account.`;
    case 'ADJUSTING':
    case 'MANUAL':
    case 'CLOSING':
    case 'PRIOR_PERIOD':
      return `Entry made in Accounting (${j}${e.particulars ? `: ${e.particulars}` : ''}). No Treasury record behind it.`;
    default:
      return `${j} (${e.sourceType}${e.particulars ? `: ${e.particulars}` : ''}). No Treasury record behind it.`;
  }
}

function finish(
  asOf: IsoDate,
  buckets: Map<string, Bucket>,
  bookBalance: Centavos,
  describe: (
    b: Bucket,
    side: 'TREASURY_ONLY' | 'BOOKS_ONLY' | 'DIFFERENT',
  ) => {
    date: IsoDate;
    reference: string;
    description: string;
    cause: string;
  },
): ReconResult {
  let treasuryBalance = 0;
  const items: ReconItem[] = [];
  let agreedCount = 0;
  let agreedAmount = 0;

  for (const b of buckets.values()) {
    treasuryBalance += b.treasury;
    if (b.treasury === b.books) {
      if (b.treasury !== 0 || b.treasuryDesc) {
        agreedCount += 1;
        agreedAmount += Math.abs(b.treasury);
      }
      continue;
    }
    const side = sideOf(b);
    items.push({
      key: b.key,
      side,
      ...describe(b, side),
      treasury: b.treasury,
      books: b.books,
      effect: b.books - b.treasury,
    });
  }

  // Same money, two references (see the note at the top).
  const tOnly = items.filter((i) => i.side === 'TREASURY_ONLY');
  const bOnly = items.filter((i) => i.side === 'BOOKS_ONLY' && i.key !== 'OPENING');
  for (const t of tOnly) {
    const days = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    const match = bOnly
      .filter((b) => !b.pairedWith && b.books === t.treasury)
      .sort((x, y) => Math.abs(days(x.date) - days(t.date)) - Math.abs(days(y.date) - days(t.date)))
      .find((b) => Math.abs(days(b.date) - days(t.date)) <= 45);
    if (!match) continue;
    t.pairedWith = match.key;
    match.pairedWith = t.key;
  }
  const paired = items.filter((i) => i.pairedWith);
  const rest = items.filter((i) => !i.pairedWith);
  const pairedItems: ReconItem[] = [];
  for (const t of paired.filter((i) => i.side === 'TREASURY_ONLY')) {
    const b = paired.find((i) => i.key === t.pairedWith)!;
    pairedItems.push({
      key: `${t.key}+${b.key}`,
      side: 'PAIRED',
      date: t.date,
      reference: `${t.reference} / ${b.reference}`,
      description: t.description,
      cause: `Recorded by the Treasury as ${t.reference} on ${t.date} and in the books as ${b.reference} on ${b.date}, for the same ${peso(Math.abs(t.treasury))}. The same event under two references - confirm it.`,
      treasury: t.treasury,
      books: b.books,
      effect: 0,
    });
  }

  const order: Record<ReconSide, number> = {
    TREASURY_ONLY: 0,
    BOOKS_ONLY: 1,
    DIFFERENT: 2,
    PAIRED: 3,
  };
  const all = [...rest, ...pairedItems].sort(
    (a, b) =>
      order[a.side] - order[b.side] ||
      a.date.localeCompare(b.date) ||
      a.reference.localeCompare(b.reference),
  );

  const subtotals = { TREASURY_ONLY: 0, BOOKS_ONLY: 0, DIFFERENT: 0 };
  for (const i of all) if (i.side !== 'PAIRED') subtotals[i.side] += i.effect;
  const bridged =
    treasuryBalance + subtotals.TREASURY_ONLY + subtotals.BOOKS_ONLY + subtotals.DIFFERENT;

  return {
    asOf,
    treasuryBalance,
    bookBalance,
    items: all,
    agreed: { count: agreedCount, amount: agreedAmount },
    subtotals,
    bridged,
    unexplained: bookBalance - bridged,
  };
}

function laterNote(b: Bucket): string {
  const later = b.laterBooks[0];
  return later
    ? ` Its entry, JEV ${later.jevNo}, is dated ${later.entryDate}, after the date.`
    : '';
}

// ===========================================================================
// CASH IN LOCAL TREASURY
// ===========================================================================

/** What an RCD did to the cash in the treasury: collections in, deposits out. */
export function rcdCashEffect(r: ReconReport): { collections: Centavos; deposits: Centavos } {
  return {
    collections: (r.lines ?? [])
      .filter((l) => !l.excluded)
      .reduce((s, l) => s + (l.amount || 0), 0),
    deposits: (r.deposits ?? []).reduce((s, d) => s + (d.amount || 0), 0),
  };
}

export function reconcileLocalTreasury(input: {
  fiscalYear: number;
  asOf: IsoDate;
  /** Every RCD of the fund and year, whatever its status. */
  rcds: ReconReport[];
  /** Every General Ledger line of the fund and year on Cash - Local Treasury. */
  ledger: ReconLedgerEntry[];
  /** Deposits, to claim a deposit's own (pre-patch-159) journal entry for its RCD. */
  deposits?: Array<{ id: string; treasuryReportId?: string | null }>;
}): ReconResult {
  const { asOf, rcds } = input;
  const reportById = new Map(rcds.map((r) => [r.id, r]));
  const depositReport = new Map<string, string>();
  for (const d of input.deposits ?? [])
    if (d.treasuryReportId) depositReport.set(d.id, d.treasuryReportId);
  for (const r of rcds) for (const d of r.deposits ?? []) depositReport.set(d.sourceId, r.id);

  const keyOf = ledgerKeyer(input.ledger, rcds, (e) =>
    e.sourceId && depositReport.has(e.sourceId) ? `rep:${depositReport.get(e.sourceId)}` : null,
  );

  const buckets = new Map<string, Bucket>();

  for (const r of rcds) {
    if (!REPORTED_STATUSES.has(r.status) || r.reportDate > asOf) continue;
    const { collections, deposits } = rcdCashEffect(r);
    const b = bucket(buckets, `rep:${r.id}`);
    b.treasury += collections - deposits;
    b.treasuryDate = r.reportDate;
    b.treasuryRef = reportLabel(r);
    b.treasuryDesc = `${r.accountableOfficerName ?? 'RCD'}: collections ${peso(collections)}, deposits ${peso(deposits)}`;
  }

  let bookBalance = 0;
  for (const e of input.ledger) {
    const k = keyOf(e);
    const b = bucket(buckets, k);
    if (e.entryDate > asOf) {
      b.laterBooks.push(e);
      continue;
    }
    bookBalance += e.debit - e.credit;
    b.books += e.debit - e.credit;
    b.booksEntries.push(e);
  }

  return finish(asOf, buckets, bookBalance, (b, side) => {
    const r = b.key.startsWith('rep:') ? reportById.get(b.key.slice(4)) : undefined;
    const first = b.booksEntries[0];
    const date = b.treasuryDate ?? first?.entryDate ?? asOf;
    const reference = r ? reportLabel(r) : first ? `JEV ${first.jevNo}` : b.key;

    if (side === 'TREASURY_ONLY' && r) {
      const cause =
        r.status === 'CERTIFIED'
          ? r.forwardedAt === null
            ? 'Certified by the Treasurer, not yet forwarded to Accounting.'
            : 'Forwarded to Accounting, not yet journalized.'
          : b.laterBooks.length
            ? 'Journalized, but after the date.'
            : 'Taken up by Accounting with no entry on Cash - Local Treasury.';
      return { date, reference, description: b.treasuryDesc ?? '', cause: cause + laterNote(b) };
    }
    if (side === 'BOOKS_ONLY') {
      const description = first?.particulars || (r ? reportLabel(r) : '');
      if (r) {
        const cause =
          r.status === 'CANCELLED'
            ? `The RCD was withdrawn${r.cancelledReason ? ` (${r.cancelledReason})` : ''}, but its entry JEV ${first?.jevNo} still stands at the date.`
            : r.reportDate > asOf
              ? `The RCD is dated ${r.reportDate}, after the date; its entry JEV ${first?.jevNo} is dated ${first?.entryDate}.`
              : `The RCD is ${r.status.toLowerCase()}; its entry JEV ${first?.jevNo} is already in the books.`;
        return { date: first?.entryDate ?? date, reference, description, cause };
      }
      return {
        date: first?.entryDate ?? date,
        reference,
        description,
        cause: booksOnlyCause(b.booksEntries, input.fiscalYear, 'cash book'),
      };
    }
    // DIFFERENT
    const dr = b.booksEntries.reduce((s, e) => s + e.debit, 0);
    const cr = b.booksEntries.reduce((s, e) => s + e.credit, 0);
    const eff = r ? rcdCashEffect(r) : { collections: 0, deposits: 0 };
    return {
      date,
      reference,
      description: b.treasuryDesc ?? '',
      cause:
        `Journalized for a different amount. Per the RCD: collections ${peso(eff.collections)}, deposits ${peso(eff.deposits)}. ` +
        `Per the books: debits ${peso(dr)}, credits ${peso(cr)} to Cash - Local Treasury` +
        `${b.booksEntries[0] ? ` (JEV ${b.booksEntries[0].jevNo})` : ''}. Check the entry against the report.` +
        laterNote(b),
    };
  });
}

// ===========================================================================
// CASH IN BANK
// ===========================================================================

export interface BankBookInput {
  bankAccountId: string;
  fiscalYear: number;
  beginningBalance: Centavos;
  manualEntries: Array<{
    id: string;
    entryDate: IsoDate;
    kind: string;
    inflow: boolean;
    referenceNo?: string | null;
    particulars: string;
    amount: Centavos;
    voided?: boolean;
  }>;
  deposits: Array<{
    id: string;
    fiscalYear: number;
    depositDate: IsoDate;
    depositSlipNo: string;
    amount: Centavos;
    status: string;
    collectingOfficerName?: string | null;
    rcdNo?: string | null;
    jevId?: string | null;
    treasuryReportId?: string | null;
  }>;
  checks: Array<{
    id: string;
    fiscalYear: number;
    checkDate: IsoDate;
    checkNo: string;
    payeeName: string;
    netAmount: Centavos;
    status: string;
    treasuryReportId?: string | null;
  }>;
  adas: Array<{
    id: string;
    fiscalYear: number;
    adaDate: IsoDate;
    adaNo: string;
    payeeName: string;
    amount: Centavos;
    status: string;
    treasuryReportId?: string | null;
  }>;
}

/** The statuses at which money has actually moved, as the Cash in Bank book counts it. */
export const BANK_BOOK_STATUS = {
  deposit: new Set(['IN_TRANSIT', 'CREDITED']),
  check: new Set(['RELEASED', 'CLEARED']),
  ada: new Set(['SUBMITTED', 'DEBITED']),
};

export function reconcileCashInBank(input: {
  asOf: IsoDate;
  book: BankBookInput;
  /** Every report of the fund and year (RCD, RCI, RADAI, eRCD), whatever its status. */
  reports: ReconReport[];
  /** Every General Ledger line of the fund and year on the bank account's GL account. */
  ledger: ReconLedgerEntry[];
  /**
   * True when this is the only bank account on that GL account in the fund, so
   * a line with no subsidiary can only be this account's.
   */
  onlyAccountOnCode: boolean;
}): ReconResult {
  const { asOf, book } = input;
  const fy = book.fiscalYear;
  const reportById = new Map(input.reports.map((r) => [r.id, r]));
  const reportByJev = new Map<string, ReconReport>();
  for (const r of input.reports) if (r.jevId) reportByJev.set(r.jevId, r);

  const depositKey = (d: BankBookInput['deposits'][number]): string => {
    if (d.jevId && reportByJev.has(d.jevId)) return `rep:${reportByJev.get(d.jevId)!.id}`;
    if (d.jevId) return `jev:${d.jevId}`;
    if (d.treasuryReportId && reportById.has(d.treasuryReportId))
      return `rep:${d.treasuryReportId}`;
    return `dep:${d.id}`;
  };
  const depositById = new Map(book.deposits.map((d) => [d.id, d]));

  const ledger = input.ledger.filter(
    (e) => e.subsidiaryId === book.bankAccountId || (!e.subsidiaryId && input.onlyAccountOnCode),
  );
  const keyOf = ledgerKeyer(ledger, input.reports, (e) => {
    const d = e.sourceId ? depositById.get(e.sourceId) : undefined;
    return d ? depositKey(d) : null;
  });

  const buckets = new Map<string, Bucket>();
  const addT = (
    key: string,
    amount: number,
    date: IsoDate,
    ref: string,
    desc: string,
    doc: string,
  ) => {
    const b = bucket(buckets, key);
    b.treasury += amount;
    if (!b.treasuryDate || date < b.treasuryDate) b.treasuryDate = date;
    if (!b.treasuryRef) b.treasuryRef = ref;
    b.treasuryDesc = b.treasuryDesc ? b.treasuryDesc : desc;
    b.treasuryDocs.push(doc);
  };

  addT(
    'OPENING',
    book.beginningBalance,
    `${fy}-01-01`,
    'Beginning balance',
    'Beginning balance per the Cash in Bank book',
    'beginning',
  );

  for (const e of book.manualEntries) {
    if (e.voided || e.entryDate > asOf) continue;
    addT(
      `man:${e.id}`,
      e.inflow ? e.amount : -e.amount,
      e.entryDate,
      e.referenceNo || 'Bank entry',
      e.particulars,
      e.kind,
    );
  }
  for (const d of book.deposits) {
    if (d.fiscalYear !== fy || !BANK_BOOK_STATUS.deposit.has(d.status) || d.depositDate > asOf)
      continue;
    addT(
      depositKey(d),
      d.amount,
      d.depositDate,
      `Deposit slip ${d.depositSlipNo}`,
      `Deposit - ${d.collectingOfficerName ?? d.rcdNo ?? 'collections'}`,
      `slip ${d.depositSlipNo}`,
    );
  }
  for (const c of book.checks) {
    if (c.fiscalYear !== fy || !BANK_BOOK_STATUS.check.has(c.status) || c.checkDate > asOf)
      continue;
    addT(
      c.treasuryReportId && reportById.has(c.treasuryReportId)
        ? `rep:${c.treasuryReportId}`
        : `chk:${c.id}`,
      -c.netAmount,
      c.checkDate,
      `Check No. ${c.checkNo}`,
      `Check - ${c.payeeName}`,
      `Check No. ${c.checkNo}`,
    );
  }
  for (const a of book.adas) {
    if (a.fiscalYear !== fy || !BANK_BOOK_STATUS.ada.has(a.status) || a.adaDate > asOf) continue;
    addT(
      a.treasuryReportId && reportById.has(a.treasuryReportId)
        ? `rep:${a.treasuryReportId}`
        : `ada:${a.id}`,
      -a.amount,
      a.adaDate,
      `ADA No. ${a.adaNo}`,
      `ADA - ${a.payeeName}`,
      `ADA No. ${a.adaNo}`,
    );
  }

  let bookBalance = 0;
  for (const e of ledger) {
    const b = bucket(buckets, keyOf(e));
    if (e.entryDate > asOf) {
      b.laterBooks.push(e);
      continue;
    }
    bookBalance += e.debit - e.credit;
    b.books += e.debit - e.credit;
    b.booksEntries.push(e);
  }

  return finish(asOf, buckets, bookBalance, (b, side) => {
    const r = b.key.startsWith('rep:') ? reportById.get(b.key.slice(4)) : undefined;
    const first = b.booksEntries[0];
    const date = b.treasuryDate ?? first?.entryDate ?? asOf;
    const docs = b.treasuryDocs.filter((d) => d !== 'beginning');
    const docList =
      docs.length > 4
        ? `${docs.slice(0, 4).join(', ')} and ${docs.length - 4} more`
        : docs.join(', ');
    const reference = r
      ? reportLabel(r)
      : b.key === 'OPENING'
        ? 'Beginning balance'
        : (b.treasuryRef ?? (first ? `JEV ${first.jevNo}` : b.key));
    const description = r
      ? docList || (first?.particulars ?? '')
      : (b.treasuryDesc ?? first?.particulars ?? '');

    if (b.key === 'OPENING') {
      const opening = b.booksEntries.reduce((s, e) => s + e.debit - e.credit, 0);
      return {
        date: `${fy}-01-01`,
        reference,
        description: 'Balance at the start of the year',
        cause:
          b.booksEntries.length === 0
            ? `The Cash in Bank book starts at ${peso(b.treasury)}; the books carry no opening entry for this account.`
            : `The Cash in Bank book starts at ${peso(b.treasury)}; the opening entry in the books (JEV ${first?.jevNo}) is ${peso(opening)}. Set the book's opening balance to agree, or correct the opening entry.`,
      };
    }

    if (side === 'TREASURY_ONLY') {
      if (r) {
        const cause =
          r.status === 'CERTIFIED'
            ? r.forwardedAt === null
              ? `On ${reportLabel(r)}, certified by the Treasurer and not yet forwarded to Accounting.`
              : `On ${reportLabel(r)}, forwarded to Accounting and not yet journalized.`
            : r.status === 'JOURNALIZED'
              ? b.laterBooks.length
                ? `On ${reportLabel(r)}, journalized after the date.`
                : `On ${reportLabel(r)}, journalized without touching this bank account.`
              : `On ${reportLabel(r)}, which is ${r.status.toLowerCase()}.`;
        return { date, reference, description, cause: cause + laterNote(b) };
      }
      if (b.key.startsWith('man:')) {
        return {
          date,
          reference,
          description,
          cause:
            'Keyed by the Treasury from the bank (interest, charges, NTA and the like), not yet taken up in the books by a journal entry.',
        };
      }
      if (b.key.startsWith('chk:')) {
        return {
          date,
          reference,
          description,
          cause: 'Released, but on no RCI of this fund and year - so not yet in the books.',
        };
      }
      if (b.key.startsWith('ada:')) {
        return {
          date,
          reference,
          description,
          cause:
            'Submitted to the bank, but on no RADAI of this fund and year - so not yet in the books.',
        };
      }
      return {
        date,
        reference,
        description,
        cause:
          'Deposit in the Cash in Bank book with no journal entry on this account.' + laterNote(b),
      };
    }

    if (side === 'BOOKS_ONLY') {
      if (r) {
        return {
          date: first?.entryDate ?? date,
          reference,
          description: first?.particulars ?? '',
          cause:
            r.status === 'CANCELLED'
              ? `${reportLabel(r)} was withdrawn, but its entry JEV ${first?.jevNo} still stands at the date.`
              : `${reportLabel(r)} is journalized (JEV ${first?.jevNo}), but none of its documents is in the Cash in Bank book at the date - check their dates and status (a check must be released, an ADA submitted, a deposit in transit).`,
        };
      }
      return {
        date: first?.entryDate ?? date,
        reference,
        description: first?.particulars ?? '',
        cause: booksOnlyCause(b.booksEntries, fy, 'Cash in Bank book'),
      };
    }

    // DIFFERENT
    let detail = '';
    if (r?.reportType === 'RCI') {
      const text = b.booksEntries.map((e) => e.particulars ?? '').join(' | ');
      const missing = docs.filter((d) => {
        const no = d.replace(/^Check No\.\s*/, '');
        return !new RegExp(`Check No\\.\\s*${no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(
          text,
        );
      });
      if (missing.length) detail = ` Not in the entry: ${missing.join(', ')}.`;
    }
    return {
      date,
      reference,
      description,
      cause:
        `Per the Treasury ${peso(b.treasury)}; per the books ${peso(b.books)}` +
        `${first ? ` (JEV ${first.jevNo})` : ''}.` +
        detail +
        (r
          ? ' A document on the report is not at the status the book counts, or the entry was changed.'
          : ' Check the amount on both records.') +
        laterNote(b),
    };
  });
}
