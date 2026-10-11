import {
  holdsSerial,
  normaliseFormCode,
  officerHoldings,
  type CustodyMovement,
} from './formCustody';
import { toNumber, pad } from './serials';
import { af56Lines, af56Problems, isAf56, type Af56Detail } from './af56';

/**
 * Patch 173 - THE OFFLINE COLLECTION APP, and the two files that tie it to
 * CFMS.
 *
 * A Treasury collecting officer records receipts on a laptop with no internet
 * (the CFMS Collections app, an installed Windows program). Two files pass
 * between it and CFMS, and both are defined here, once, so the app and CFMS
 * cannot drift apart. The app keeps a copy of this file (its
 * scripts/sync-from-cfms.mjs), the same way the engine keeps its copies.
 *
 *   SETUP FILE   CFMS -> app. Downloaded on Treasury > Collections > Offline
 *                app setup, for one collecting officer: the funds, the
 *                Chart of Accounts (patch 174: the receipt names the account
 *                code itself, as CFMS's own collection form does), the
 *                accountable form types, and the officer's own booklet
 *                movements - so the app checks a serial against the booklets
 *                issued to him with exactly the rule CFMS uses (formCustody).
 *
 *   ABSTRACT     app -> CFMS. The receipts, written in the columns of the
 *                Abstract of Collections that Treasury > Collections > Bulk
 *                upload already reads (pages/treasury/parseAbstract.ts):
 *                one row per revenue line, a cancelled receipt as one row
 *                marked CANCELLED. One file for counter receipts, one for
 *                eORs, one for ARs - the upload takes one kind at a time.
 *
 * Nothing new is needed on the CFMS side to receive the data: the files go
 * through the same upload, with the same checks (booklet, account,
 * subsidiary, duplicate), as an abstract from the old system. The upload
 * takes either Treasury's revenue codes or, since patch 174, the account
 * code itself.
 */

// ---------------------------------------------------------------------------
// The setup file
// ---------------------------------------------------------------------------

export const SETUP_FORMAT = 'CFMS-OFFLINE-SETUP';
/** 2 since patch 174: the Chart of Accounts in place of the revenue codes. */
export const SETUP_VERSION = 2;

export interface OfflineSetup {
  format: typeof SETUP_FORMAT;
  version: number;
  /** The Firebase project it was downloaded from, e.g. cbo-candoni-prod. */
  projectId: string;
  generatedAt: string;
  generatedBy: string;
  /** The fiscal year the booklet movements were read for (and the one before). */
  fiscalYear: number;
  /** The three heading lines of the municipality's forms. */
  headingLines: string[];
  treasurer: { name: string; position: string };
  /** The collecting officer, exactly as on Master Data > Employees. */
  officer: { id: string; name: string; position: string };
  funds: Array<{ code: string; name: string }>;
  /** The postable accounts of the Chart of Accounts, as CFMS's collection form offers them. */
  accounts: Array<{
    code: string;
    name: string;
    /** The account is kept per party: the line names a subsidiary (default: the payor). */
    perParty: boolean;
  }>;
  /**
   * Patch 174: the subsidiary ledgers - every name on Master Data > Names
   * (payees, and employees not already a Name). A line on a per-party
   * account must name one of them, or the payor must be one.
   */
  subsidiaries: Array<{
    name: string;
    type: 'PAYEE' | 'EMPLOYEE';
    /** Patch 176: the Name's id and type (BARANGAY, GOVERNMENT_AGENCY...), for AF 56. */
    id?: string;
    payeeType?: string;
  }>;
  /** Patch 176: the province (Settings) and the barangays, for AF 56 receipts. */
  province?: string;
  barangays?: Array<{ id: string; name: string }>;
  /** Set by the app when the accounts or subsidiary ledgers were updated from an Excel/CSV list. */
  listsUpdatedAt?: string;
  formTypes: Array<{ code: string; name: string; printedAs: string; serialLength: number }>;
  /** This officer's booklet movements (issues to him, returns from him). */
  movements: CustodyMovement[];
}

/** Whether a line on this account must name its subsidiary (as the import decides). */
export function isPerParty(accountCode: string, requiresSubsidiary?: boolean): boolean {
  return !String(accountCode).trim().startsWith('4') || requiresSubsidiary === true;
}

export function setupFileName(officerName: string, isoDate: string): string {
  const who = officerName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `CFMS-Offline-Setup_${who}_${isoDate}.json`;
}

/** Reads a setup file's text, refusing anything that is not one. */
export function readSetup(text: string): OfflineSetup {
  let s: OfflineSetup;
  try {
    s = JSON.parse(text) as OfflineSetup;
  } catch {
    throw new Error('That is not a CFMS setup file (it cannot be read).');
  }
  if (s?.format !== SETUP_FORMAT) throw new Error('That is not a CFMS offline setup file.');
  if (s.version > SETUP_VERSION) {
    throw new Error('That setup file was made by a newer CFMS. Update this app first.');
  }
  if (!Array.isArray(s.accounts)) {
    throw new Error(
      'That setup file is from an older CFMS (it has revenue codes, not the Chart of Accounts). Download it again from CFMS.',
    );
  }
  if (!Array.isArray(s.subsidiaries)) s.subsidiaries = [];
  if (!s.officer?.name || !Array.isArray(s.funds)) {
    throw new Error('That setup file is incomplete. Download it again from CFMS.');
  }
  return s;
}

/**
 * "DELA CRUZ, Juan M." and "Juan M. Dela Cruz" read the same - the matching
 * the upload uses for a subsidiary (lib/names.ts nameKey).
 */
export function subsidiaryKey(name: string): string {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** The subsidiary ledgers a name matches: exactly one is what the upload needs. */
export function subsidiaryMatches(setup: OfflineSetup, name: string) {
  const k = subsidiaryKey(name);
  return k ? setup.subsidiaries.filter((x) => subsidiaryKey(x.name) === k) : [];
}

/**
 * The subsidiary ledgers as the Bulk upload sees them
 * (functions/src/treasury/collectionsImport.ts): every active Name, and every
 * active employee not already tied to a Name.
 */
export function subsidiaryLedgers(
  payees: Array<{
    id?: string;
    name?: string;
    active?: boolean;
    employeeId?: string;
    payeeType?: string;
  }>,
  employees: Array<{ id: string; displayName?: string; active?: boolean; payeeId?: string }>,
): OfflineSetup['subsidiaries'] {
  const tied = new Set(payees.map((p) => p.employeeId).filter(Boolean));
  const out: OfflineSetup['subsidiaries'] = [];
  for (const p of payees) {
    if (p.active === false || !p.name) continue;
    out.push({
      name: p.name,
      type: p.employeeId ? 'EMPLOYEE' : 'PAYEE',
      // Patch 176: the id and type, so an AF 56 receipt finds the province's
      // and the barangays' Names.
      ...(p.id ? { id: p.id } : {}),
      ...(p.payeeType ? { payeeType: p.payeeType } : {}),
    });
  }
  for (const e of employees) {
    if (e.active === false || !e.displayName || tied.has(e.id) || e.payeeId) continue;
    out.push({ name: e.displayName, type: 'EMPLOYEE' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// The receipts the app keeps
// ---------------------------------------------------------------------------

/** CASH: a counter receipt on an accountable form. EOR / AR: an e-collection. */
export type OfflineKind = 'CASH' | 'EOR' | 'AR';

export const OFFLINE_KIND_LABELS: Record<OfflineKind, string> = {
  CASH: 'Official Receipt (cash)',
  EOR: 'e-Collection - eOR',
  AR: "e-Collection - Intermediary's AR",
};

export interface OfflineLine {
  /** The account credited - Chart of Accounts code, as on CFMS's collection form. */
  accountCode: string;
  /** The particulars printed on the receipt; the account's name by default. */
  description: string;
  /** Centavos. */
  amount: number;
  /** For a per-party account: whose subsidiary ledger. Blank means the payor. */
  subsidiary?: string;
}

export interface OfflineReceipt {
  id: string;
  kind: OfflineKind;
  fundCode: string;
  /** YYYY-MM-DD */
  orDate: string;
  /** CASH: the accountable form type code (AF51). */
  formCode?: string;
  /** The O.R. / eOR / AR number. */
  orNumber: string;
  payorName: string;
  payorTin?: string;
  /** e-Collections: the transaction reference number. */
  trn?: string;
  lines: OfflineLine[];
  /** Centavos; zero when cancelled. */
  totalAmount: number;
  cancelled: boolean;
  cancelReason?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the receipt goes into a report (batch); it is locked from then on. */
  batchId?: string;
  /**
   * Patch 176: real property tax on Accountable Form No. 56 - the figures
   * typed per property. The lines are worked out from them (af56.ts), and
   * CFMS works them out again on upload.
   */
  rpt?: Af56Detail | null;
}

/** Patch 176: a counter receipt on AF 56 (real property tax). */
export function isAf56Receipt(r: Pick<OfflineReceipt, 'kind' | 'formCode'>): boolean {
  return r.kind === 'CASH' && isAf56(r.formCode);
}

/** Patch 176: the receipt lines of an AF 56 receipt, from its figures. */
export function af56ReceiptLines(rpt: Af56Detail): OfflineLine[] {
  return af56Lines(rpt).map((l) => ({
    accountCode: l.accountCode,
    description: l.particulars,
    amount: l.amount,
    ...(l.subsidiaryName ? { subsidiary: l.subsidiaryName } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Checking a receipt - the same rules the upload will apply
// ---------------------------------------------------------------------------

export function holdingsFor(setup: OfflineSetup, formCode: string, date: string) {
  return officerHoldings(setup.movements, setup.officer.id, formCode, date);
}

/** The form types the officer holds any serial of on a date. */
export function formsHeld(setup: OfflineSetup, date: string) {
  return setup.formTypes.filter((t) => holdingsFor(setup, t.code, date).length > 0);
}

/** The lowest serial held on the date that no receipt has used yet. */
export function nextFreeSerial(
  setup: OfflineSetup,
  formCode: string,
  date: string,
  receipts: OfflineReceipt[],
): string | null {
  const held = holdingsFor(setup, formCode, date);
  const used = new Set(
    receipts
      .filter(
        (r) => r.kind === 'CASH' && normaliseFormCode(r.formCode) === normaliseFormCode(formCode),
      )
      .map((r) => toNumber(r.orNumber))
      .filter((n): n is number => n !== null),
  );
  const width =
    setup.formTypes.find((t) => normaliseFormCode(t.code) === normaliseFormCode(formCode))
      ?.serialLength ?? 0;
  for (const range of held) {
    for (let n = range.from; n <= range.to; n++) {
      if (!used.has(n)) return width ? pad(n, width) : String(n);
    }
  }
  return null;
}

/** What is wrong with a receipt, in words; empty when it may be saved. */
export function receiptProblems(
  r: OfflineReceipt,
  setup: OfflineSetup,
  others: OfflineReceipt[],
): string[] {
  const p: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.orDate)) p.push('the date is missing');
  if (!setup.funds.some((f) => f.code === r.fundCode)) p.push('choose the fund');
  const no = r.orNumber.trim();
  if (!no)
    p.push(r.kind === 'CASH' ? 'the O.R. number is missing' : 'the receipt number is missing');

  const sameNumber = others.find(
    (o) =>
      o.id !== r.id &&
      o.kind === r.kind &&
      o.orNumber.trim() === no &&
      (r.kind !== 'CASH' || normaliseFormCode(o.formCode) === normaliseFormCode(r.formCode)),
  );
  if (no && sameNumber) p.push(`No. ${no} is already used (${sameNumber.orDate})`);

  if (r.kind === 'CASH') {
    if (!r.formCode) p.push('choose the accountable form');
    else if (no && /^\d{4}-\d{2}-\d{2}$/.test(r.orDate)) {
      if (!holdsSerial(holdingsFor(setup, r.formCode, r.orDate), no)) {
        p.push(
          `${r.formCode} No. ${no} was not issued to ${setup.officer.name} by ${r.orDate} (or was returned) - CFMS will refuse it`,
        );
      }
    }
  } else if (!r.cancelled && !(r.trn ?? '').trim()) {
    p.push('the TRN (transaction reference number) is missing');
  }

  // Patch 176: an AF 56 receipt is checked on its figures, not its lines.
  if (!r.cancelled && isAf56Receipt(r)) {
    if (!r.payorName.trim()) p.push("the payor's name is missing");
    if (!r.rpt) p.push('type the real property tax paid');
    else p.push(...af56Problems(r.rpt, r.fundCode));
    return p;
  }

  if (!r.cancelled) {
    if (!r.payorName.trim()) p.push("the payor's name is missing");
    if (!r.lines.length) p.push('add at least one line');
    r.lines.forEach((l, i) => {
      const account = setup.accounts.find((a) => a.code === l.accountCode);
      if (!account) p.push(`line ${i + 1}: choose the account`);
      else if (account.perParty && setup.subsidiaries.length) {
        const wanted = (l.subsidiary ?? '').trim() || r.payorName.trim();
        const hits = subsidiaryMatches(setup, wanted);
        if (hits.length !== 1) {
          p.push(
            `line ${i + 1}: ${account.code} ${account.name} is kept per subsidiary ledger - ${
              !wanted
                ? 'choose the subsidiary'
                : hits.length === 0
                  ? `"${wanted}" is not a subsidiary ledger in CFMS (Master Data > Names); choose one, or load a newer setup file`
                  : `${hits.length} subsidiary ledgers are called "${wanted}"; choose the exact one`
            }`,
          );
        }
      }
      if (!(l.amount > 0)) p.push(`line ${i + 1}: the amount is missing`);
    });
    if (/cancel/i.test(r.remarks ?? '')) {
      p.push('remarks may not contain the word "cancel" unless the receipt is cancelled');
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// The Abstract file
// ---------------------------------------------------------------------------

/**
 * The columns, in order. Each header is one the Abstract upload recognises
 * (parseAbstract.ts COLUMNS) - change one here and the round-trip test in
 * CFMS fails.
 */
export const ABSTRACT_HEADERS = [
  'Date',
  'Primary Report No.',
  'Accountable Form',
  'Serial/O.R. No.',
  'Payor',
  'Collector',
  'Fund',
  'Account Code',
  'Account Name',
  'Amount',
  'Remarks',
  'TRN',
  'Subsidiary',
  // Patch 176: an AF 56 receipt's figures (JSON), on its first row. CFMS
  // works its lines out again from them.
  'RPT Detail',
] as const;

export type AbstractRow = Record<(typeof ABSTRACT_HEADERS)[number], string | number>;

/**
 * The rows of one Abstract file: one per revenue line, in date and number
 * order; a cancelled receipt as a single row at zero marked CANCELLED, so the
 * serial series has no gap.
 */
export function abstractRows(
  receipts: OfflineReceipt[],
  ctx: { reportNo: string; setup: OfflineSetup },
): AbstractRow[] {
  const formLabel = (code?: string) => {
    const t = ctx.setup.formTypes.find(
      (f) => normaliseFormCode(f.code) === normaliseFormCode(code),
    );
    return t?.code ?? code ?? '';
  };
  const kindLabel = (k: OfflineKind) => (k === 'EOR' ? 'eOR' : k === 'AR' ? 'AR' : '');
  const ordered = [...receipts].sort(
    (a, b) =>
      a.orDate.localeCompare(b.orDate) ||
      (toNumber(a.orNumber) ?? 0) - (toNumber(b.orNumber) ?? 0) ||
      a.orNumber.localeCompare(b.orNumber),
  );
  const rows: AbstractRow[] = [];
  for (const r of ordered) {
    const base = {
      Date: r.orDate,
      'Primary Report No.': ctx.reportNo,
      'Accountable Form': r.kind === 'CASH' ? formLabel(r.formCode) : kindLabel(r.kind),
      'Serial/O.R. No.': r.orNumber.trim(),
      Payor: r.payorName.trim(),
      Collector: ctx.setup.officer.name,
      Fund: r.fundCode,
      TRN: r.kind === 'CASH' ? '' : (r.trn ?? '').trim(),
      'RPT Detail': '',
    };
    if (r.cancelled) {
      rows.push({
        ...base,
        'Account Code': '',
        'Account Name': '',
        Amount: 0,
        Remarks: `CANCELLED${r.cancelReason ? ` - ${r.cancelReason}` : ''}`,
        Subsidiary: '',
      });
      continue;
    }
    const rpt = isAf56Receipt(r) && r.rpt ? JSON.stringify(r.rpt) : '';
    r.lines.forEach((l, i) => {
      rows.push({
        ...base,
        'Account Code': l.accountCode,
        'Account Name': l.description,
        Amount: Math.round(l.amount) / 100,
        Remarks: r.remarks ?? '',
        Subsidiary: (l.subsidiary ?? '').trim(),
        'RPT Detail': i === 0 ? rpt : '',
      });
    });
  }
  return rows;
}

/** e.g. CFMS-Collections_DELA-CRUZ-JUAN_JDC-2027-001_Cash.xlsx */
export function abstractFileName(officerName: string, reportNo: string, kind: OfflineKind): string {
  const who = officerName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const k = kind === 'CASH' ? 'Cash' : kind === 'EOR' ? 'eOR' : 'AR';
  return `CFMS-Collections_${who}_${reportNo}_${k}.xlsx`;
}

/**
 * The same rows as CSV text (comma-separated, every value quoted), for the
 * "Save as CSV" choice. Every value is written as text - an O.R. number
 * 0007100001 keeps its zeros - and the Bulk upload reads a CSV as text
 * (patch 174), so it comes back exactly as written.
 */
export function abstractCsv(rows: AbstractRow[]): string {
  const q = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [ABSTRACT_HEADERS.map(q).join(',')];
  for (const r of rows) lines.push(ABSTRACT_HEADERS.map((h) => q(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function abstractCsvFileName(
  officerName: string,
  reportNo: string,
  kind: OfflineKind,
): string {
  return abstractFileName(officerName, reportNo, kind).replace(/\.xlsx$/, '.csv');
}
