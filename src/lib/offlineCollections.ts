import {
  holdsSerial,
  normaliseFormCode,
  officerHoldings,
  type CustodyMovement,
} from './formCustody';
import { toNumber, pad } from './serials';

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
 *                revenue codes (the same codes the Abstract upload maps),
 *                the accountable form types, and the officer's own booklet
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
 * through the same upload, with the same checks (booklet, revenue code,
 * subsidiary, duplicate), as an abstract from the old system.
 */

// ---------------------------------------------------------------------------
// The setup file
// ---------------------------------------------------------------------------

export const SETUP_FORMAT = 'CFMS-OFFLINE-SETUP';
export const SETUP_VERSION = 1;

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
  /** Treasury's revenue codes, as the Abstract upload maps them. */
  revenueCodes: Array<{
    code: string;
    description: string;
    accountCode: string;
    accountName: string;
    /** The account is kept per party: the line names a subsidiary (default: the payor). */
    perParty: boolean;
  }>;
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
  if (!s.officer?.name || !Array.isArray(s.funds) || !Array.isArray(s.revenueCodes)) {
    throw new Error('That setup file is incomplete. Download it again from CFMS.');
  }
  return s;
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
  revenueCode: string;
  /** The particulars printed on the receipt; the revenue code's description by default. */
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

  if (!r.cancelled) {
    if (!r.payorName.trim()) p.push("the payor's name is missing");
    if (!r.lines.length) p.push('add at least one revenue line');
    r.lines.forEach((l, i) => {
      const code = setup.revenueCodes.find((c) => c.code === l.revenueCode);
      if (!code) p.push(`line ${i + 1}: choose the revenue code`);
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
    for (const l of r.lines) {
      rows.push({
        ...base,
        'Account Code': l.revenueCode,
        'Account Name': l.description,
        Amount: Math.round(l.amount) / 100,
        Remarks: r.remarks ?? '',
        Subsidiary: (l.subsidiary ?? '').trim(),
      });
    }
  }
  return rows;
}

/** e.g. CFMS-Collections_DELA-CRUZ-JUAN_JDC-2027-001_Cash.xlsx */
export function abstractFileName(officerName: string, reportNo: string, kind: OfflineKind): string {
  const who = officerName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const k = kind === 'CASH' ? 'Cash' : kind === 'EOR' ? 'eOR' : 'AR';
  return `CFMS-Collections_${who}_${reportNo}_${k}.xlsx`;
}
