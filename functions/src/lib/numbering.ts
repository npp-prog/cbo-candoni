import type { Transaction } from 'firebase-admin/firestore';
import { db, COL } from './firebase';

/**
 * Document number issuance.
 *
 * The only correct place to assign a document number is inside the same
 * Firestore transaction that commits the document. Anything else - generating
 * a number on the client, reading the last number and adding one, reserving a
 * number then writing later - produces duplicates under concurrency, and a
 * duplicate DV number is an audit finding.
 *
 * `counters/{counterId}` holds one integer per sequence. A transaction reads
 * it, increments it, and writes both the counter and the document. Firestore
 * aborts and retries the whole transaction if another writer touched the
 * counter in between, so two users submitting at the same instant receive
 * consecutive numbers rather than the same one.
 */

export type ResetPolicy = 'YEAR' | 'MONTH' | 'NEVER';

export interface NumberingConfig {
  docType: string;
  pattern: string;
  sequenceLength: number;
  resetOn: ResetPolicy;
  perFund: boolean;
}

const DEFAULTS: Record<string, NumberingConfig> = {
  OBR: { docType: 'OBR', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  DV: { docType: 'DV', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  JEV: { docType: 'JEV', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  RCD: { docType: 'RCD', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  LIQ: { docType: 'LIQ', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  PAYROLL: { docType: 'PAYROLL', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  ADA: { docType: 'ADA', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  RCI: { docType: 'RCI', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  RADAI: { docType: 'RADAI', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  RCDISB: { docType: 'RCDISB', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  // An officer's accountability for paper is not kept fund by fund: one
  // booklet of receipts collects into whichever fund the payor is paying.
  RAAF: { docType: 'RAAF', pattern: 'RAAF-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: false },
  ALLOT: { docType: 'ALLOT', pattern: '{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
  APPROP: { docType: 'APPROP', pattern: '{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
};

export function counterId(input: {
  docType: string;
  fundCode: string;
  fiscalYear: number;
  month: number;
  resetOn: ResetPolicy;
  perFund: boolean;
}): string {
  const fund = input.perFund ? input.fundCode : 'ALL';
  switch (input.resetOn) {
    case 'MONTH':
      return `${input.docType}__${fund}__${input.fiscalYear}__${String(input.month).padStart(2, '0')}`;
    case 'YEAR':
      return `${input.docType}__${fund}__${input.fiscalYear}`;
    case 'NEVER':
      return `${input.docType}__${fund}`;
  }
}

export function renderNumber(
  cfg: NumberingConfig,
  parts: { bookCode: string; fundCode: string; fiscalYear: number; month: number; sequence: number },
): string {
  const yyyy = String(parts.fiscalYear).padStart(4, '0');
  return cfg.pattern
    .replace(/\{BOOK\}/g, parts.bookCode)
    .replace(/\{FUND\}/g, parts.fundCode)
    .replace(/\{TYPE\}/g, cfg.docType)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(-2))
    .replace(/\{MM\}/g, String(parts.month).padStart(2, '0'))
    .replace(/\{SEQ\}/g, String(parts.sequence).padStart(cfg.sequenceLength, '0'));
}

/** Loads the configured rule, falling back to the built-in default. */
export async function loadNumberingConfig(docType: string): Promise<NumberingConfig> {
  const snap = await db.collection(COL.numberingRules).doc(docType).get();
  if (!snap.exists) {
    const fallback = DEFAULTS[docType];
    if (!fallback) {
      throw new Error(`No numbering rule configured for document type ${docType}.`);
    }
    return fallback;
  }
  const d = snap.data() as Partial<NumberingConfig>;
  return {
    docType,
    pattern: d.pattern ?? DEFAULTS[docType]?.pattern ?? '{BOOK}-{YY}-{MM}-{SEQ}',
    sequenceLength: d.sequenceLength ?? 4,
    resetOn: (d.resetOn as ResetPolicy) ?? 'MONTH',
    perFund: d.perFund ?? true,
  };
}

/**
 * Issue the next number for a document type inside a transaction.
 *
 * IMPORTANT ORDERING NOTE: Firestore transactions require all reads before any
 * write. The counter read must therefore happen in the read phase of the
 * calling transaction, before the caller starts writing. Callers pass in the
 * already-loaded config to keep this function write-only where possible; the
 * counter itself is read here via `tx.get`, so call this before any `tx.set`.
 */
export async function issueNumber(
  tx: Transaction,
  cfg: NumberingConfig,
  parts: { bookCode: string; fundCode: string; fiscalYear: number; month: number },
): Promise<string> {
  const id = counterId({
    docType: cfg.docType,
    fundCode: parts.fundCode,
    fiscalYear: parts.fiscalYear,
    month: parts.month,
    resetOn: cfg.resetOn,
    perFund: cfg.perFund,
  });

  const ref = db.collection(COL.counters).doc(id);
  const snap = await tx.get(ref);
  const current = snap.exists ? ((snap.data()?.value as number) ?? 0) : 0;
  const next = current + 1;

  tx.set(
    ref,
    {
      value: next,
      docType: cfg.docType,
      fundCode: cfg.perFund ? parts.fundCode : 'ALL',
      fiscalYear: parts.fiscalYear,
      month: cfg.resetOn === 'MONTH' ? parts.month : null,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );

  return renderNumber(cfg, { ...parts, sequence: next });
}

/** Look up a fund's book code (e.g. "100" for the General Fund). */
export async function bookCodeForFund(fundCode: string): Promise<string> {
  const snap = await db.collection(COL.funds).doc(fundCode).get();
  if (!snap.exists) {
    throw new Error(`Fund ${fundCode} is not configured.`);
  }
  return (snap.data()?.bookCode as string) ?? fundCode;
}
