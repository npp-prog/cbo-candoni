import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db, COL } from './firebase';
import { allocateSequences } from './sequences';
import { hasDocumentNumber } from './jevNumbers';

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
  // The Liquidating Officer's own series, one per fund, continuing through
  // the year so a gap in it is a question rather than a month boundary.
  PRN: { docType: 'PRN', pattern: '{BOOK}-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  // An officer's accountability for paper is not kept fund by fund: one
  // booklet of receipts collects into whichever fund the payor is paying.
  RAAF: { docType: 'RAAF', pattern: 'RAAF-{YY}-{MM}-{SEQ}', sequenceLength: 4, resetOn: 'MONTH', perFund: false },
  ALLOT: { docType: 'ALLOT', pattern: '{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
  // The Allotment Release Order. One series per fund, running through the year
  // so a gap in it is a question rather than a month boundary - the manual
  // prints "ARO No." on the face of every one of the four forms, and a series
  // that restarted each month would put four documents a year under each
  // number.
  ARO: { docType: 'ARO', pattern: 'ARO-{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
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

export interface NumberRequest {
  cfg: NumberingConfig;
  parts: { bookCode: string; fundCode: string; fiscalYear: number; month: number };
  /**
   * Already numbered - skip it and return null in its place, so the caller can
   * keep one array lined up with the other.
   */
  skip?: boolean;
}

/**
 * Issue SEVERAL numbers in one go: every counter read first, every counter
 * written after.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY issueNumber ALONE WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * `issueNumber` reads a counter and then writes it. One call is a read
 * followed by a write, which is fine. TWO calls are read, write, READ, write -
 * and Firestore refuses a read after a write inside a transaction:
 *
 *     "Firestore transactions require all reads to be executed before all
 *      writes."
 *
 * Four operations in CFMS need two numbers at once, and every one of them was
 * broken by this from the day it was written:
 *
 *     approveDv            the DV number and its JEV number
 *     postLiquidation      the liquidation number and its JEV number
 *     issueAda             the ADA number and its JEV number
 *     reserveAdaNumbers    an ADA and a RADAI number, per slot, in a loop
 *
 * The note above `issueNumber` warned about the ordering and still did not
 * prevent it, because it warned about the wrong hazard: it told callers not to
 * write before calling, and said nothing about calling twice. A rule that
 * names only one of the two ways to break it reads as a complete rule.
 *
 * So the rule is now enforced instead of written down. `check-rules.mjs` fails
 * the build if any transaction calls `issueNumber` more than once.
 *
 * ---------------------------------------------------------------------------
 * TWO NUMBERS FROM ONE COUNTER
 * ---------------------------------------------------------------------------
 * Requests that land on the same counter - N reserved ADA numbers, say - are
 * read once, handed consecutive sequence numbers, and written once with the
 * final value. That is also the only correct way to do it: two separate
 * read-modify-writes of one counter inside one transaction would both read the
 * same value and issue the same number twice.
 */
export async function issueNumbers(
  tx: Transaction,
  requests: NumberRequest[],
): Promise<Array<string | null>> {
  const wanted = requests.map((r) =>
    r.skip
      ? null
      : counterId({
          docType: r.cfg.docType,
          fundCode: r.parts.fundCode,
          fiscalYear: r.parts.fiscalYear,
          month: r.parts.month,
          resetOn: r.cfg.resetOn,
          perFund: r.cfg.perFund,
        }),
  );

  // ---- every read, before every write -------------------------------------
  const uniqueIds = [...new Set(wanted.filter((id): id is string => id !== null))];
  const snaps = await Promise.all(
    uniqueIds.map((id) => tx.get(db.collection(COL.counters).doc(id))),
  );

  const base = new Map<string, number>();
  uniqueIds.forEach((id, i) => {
    const snap = snaps[i];
    base.set(id, snap.exists ? ((snap.data()?.value as number) ?? 0) : 0);
  });

  // ---- allocate -----------------------------------------------------------
  const { sequences, finals } = allocateSequences(wanted, base);

  const out = requests.map((r, i) => {
    const sequence = sequences[i];
    return sequence === null ? null : renderNumber(r.cfg, { ...r.parts, sequence });
  });

  // ---- write --------------------------------------------------------------
  for (const id of uniqueIds) {
    const final = finals.get(id);
    if (final === undefined) continue;

    const first = requests[wanted.indexOf(id)];
    tx.set(
      db.collection(COL.counters).doc(id),
      {
        value: final,
        docType: first.cfg.docType,
        fundCode: first.cfg.perFund ? first.parts.fundCode : 'ALL',
        fiscalYear: first.parts.fiscalYear,
        month: first.cfg.resetOn === 'MONTH' ? first.parts.month : null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  }

  return out;
}

/**
 * Issue the next number for a document type inside a transaction.
 *
 * ONE PER TRANSACTION. Needing a second one means `issueNumbers` - see the
 * note on it, and the check that enforces this.
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

/**
 * Takes a number the office assigned by hand, and refuses a duplicate.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NUMBERS ARE TYPED IN AT ALL
 * ---------------------------------------------------------------------------
 * The Treasurer's office writes the RCI number in its own book before the
 * report ever reaches CFMS, under the series COA expects it to keep. A system
 * that issued its own number would quietly run a second series that disagrees
 * with the office's, and the disagreement is discovered during an audit, by
 * somebody holding the paper.
 *
 * So CFMS takes the number and does the one thing a book cannot do for itself:
 * refuses to let it be used twice. The reservation is a document whose ID IS
 * the number, created inside the same transaction as the act it belongs to, so
 * uniqueness is a database constraint rather than a check two clerks pressing
 * Save at the same moment can slip between.
 *
 * A reservation already held BY THIS DOCUMENT is not a clash. That is what is
 * left behind when an act is undone - a certification taken back, an approval
 * reversed - and it is deliberate: the office has written that number against
 * this document, and letting another take it while this one is corrected
 * leaves the book and CFMS disagreeing about whose number it is.
 *
 * Reads before it writes, as every transaction here must.
 */
export async function reserveDocumentNumber(
  tx: Transaction,
  input: Parameters<typeof prepareDocumentNumber>[1],
): Promise<string> {
  const prepared = await prepareDocumentNumber(tx, input);
  prepared.commit();
  return prepared.number;
}

/**
 * reserveDocumentNumber in two halves: the READ (and the refusal of a number
 * already used) now, the WRITE when `commit` is called. Patch 135.
 *
 * A Firestore transaction must do every read before any write. A caller that
 * also draws a JEV number (issueNumbers reads the counter, then writes it)
 * cannot call reserveDocumentNumber on either side of it: before, its write
 * precedes the counter read; after, its read follows the counter write.
 * postLiquidation did exactly that and every liquidation failed with
 * "Firestore transactions require all reads to be executed before all
 * writes". Prepare first, draw the JEV number, then commit.
 */
export async function prepareDocumentNumber(
  tx: Transaction,
  input: {
    /** The series: 'RCI', 'RCD', 'LIQ'. Part of the reservation's identity. */
    kind: string;
    fiscalYear: number;
    fundCode: string;
    /** The number as the office wrote it. */
    number: string;
    /** The document claiming it. */
    documentId: string;
    /** How to name the series in the message a user reads. */
    label?: string;
  },
): Promise<{ number: string; commit: () => void }> {
  const label = input.label ?? input.kind;
  // A draft carries the placeholder until it is numbered; that is not a number.
  const number = hasDocumentNumber(input.number) ? String(input.number).trim() : '';

  if (!number) {
    throw new HttpsError(
      'invalid-argument',
      `A ${label} number is required. Assign it from the office's own book before this step.`,
    );
  }
  if (number.length > 40) {
    throw new HttpsError('invalid-argument', `That ${label} number is too long.`);
  }

  const ref = db
    .collection(COL.documentNumbers)
    .doc(`${input.kind}__${input.fiscalYear}__${input.fundCode}__${number.toUpperCase()}`);

  const snap = await tx.get(ref);
  const heldHere =
    snap.exists && (snap.data() as { documentId?: string }).documentId === input.documentId;

  if (snap.exists && !heldHere) {
    throw new HttpsError(
      'already-exists',
      `${label} number ${number} has already been used in ${input.fiscalYear} for the ${input.fundCode} fund. Each number is used once.`,
    );
  }

  return {
    number,
    commit: () => {
      if (snap.exists) return;
      tx.create(ref, {
        docType: input.kind,
        fiscalYear: input.fiscalYear,
        fundCode: input.fundCode,
        number,
        documentId: input.documentId,
        at: new Date().toISOString(),
      });
    },
  };
}
