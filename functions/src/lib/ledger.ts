import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db, COL } from './firebase';
import { checkDoubleEntry, type EntryLine } from './rules';
import type { Caller } from './context';
import { auditInTransaction } from './audit';

/**
 * The General Ledger.
 *
 * This module contains the only code in CBO that writes `ledgerEntries`.
 * Security rules deny every client write to that collection, so the invariant
 * "a ledger entry exists if and only if a JEV was posted through
 * `postJevInTransaction`" holds by construction rather than by convention.
 *
 * Three properties are maintained:
 *
 *   1. Entries are immutable. Nothing updates or deletes a ledger entry.
 *      A correction is a new, reversing JEV. This is what lets a trial balance
 *      printed today still reconcile to the same figures next year.
 *
 *   2. Debits equal credits, always, checked immediately before the write.
 *
 *   3. Every entry is traceable to its source document, and every source
 *      document points back at its JEV.
 */

export interface JevLineData {
  lineNo: number;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  officeId?: string | null;
  officeName?: string | null;
  responsibilityCenterId?: string | null;
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
  cashFlowClass?: string | null;
  particulars?: string | null;
}

export interface JevData {
  jevNo: string;
  jevDate: string;
  fiscalYear: number;
  period: number;
  fundCode: string;
  book: string;
  sourceType: string;
  sourceId?: string | null;
  referenceNo?: string | null;
  payeeId?: string | null;
  payeeName?: string | null;
  particulars: string;
  lines: JevLineData[];
  totalDebit: number;
  totalCredit: number;
  status: string;
}

/**
 * Creates a JEV document in DRAFT.
 *
 * Generated JEVs (from a DV, an RCD, a payroll) are created in DRAFT rather
 * than posted directly. Approving a voucher and posting to the ledger are two
 * separate acts, performed by two different roles; collapsing them would let a
 * single person move money through the books unreviewed.
 */
export function createJevInTransaction(
  tx: Transaction,
  caller: Caller,
  data: Omit<JevData, 'totalDebit' | 'totalCredit' | 'status'>,
): { jevId: string; totalDebit: number; totalCredit: number } {
  const lines: EntryLine[] = data.lines.map((l) => ({
    lineNo: l.lineNo,
    accountCode: l.accountCode,
    debit: l.debit,
    credit: l.credit,
  }));

  const check = checkDoubleEntry(lines);
  if (!check.ok) {
    throw new HttpsError('failed-precondition', check.violations[0].message, {
      violations: check.violations,
    });
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of data.lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }

  const ref = db.collection(COL.jevs).doc();
  const now = new Date().toISOString();

  tx.create(ref, {
    ...data,
    totalDebit,
    totalCredit,
    status: 'DRAFT',
    createdBy: {
      uid: caller.uid,
      name: caller.name,
      position: caller.position ?? null,
      at: now,
    },
  });

  return { jevId: ref.id, totalDebit, totalCredit };
}

/**
 * Posts a JEV to the General Ledger.
 *
 * Writes one immutable `ledgerEntries` document per JEV line and flips the JEV
 * to POSTED. Callers must have already:
 *   - verified the caller holds a posting role
 *   - verified the accounting period is open
 *   - completed every read the transaction needs (Firestore forbids reads
 *     after writes within a transaction)
 *
 * Returns the number of ledger entries written, which the caller can surface
 * so a user has a concrete confirmation rather than a silent success.
 */
export function postJevInTransaction(
  tx: Transaction,
  caller: Caller,
  jevId: string,
  jev: JevData,
  opts: { isReversal?: boolean } = {},
): { ledgerEntryCount: number; postedAt: string } {
  if (jev.status === 'POSTED') {
    throw new HttpsError(
      'failed-precondition',
      `JEV ${jev.jevNo} has already been posted. A posted entry cannot be posted twice; to correct it, create a reversing entry.`,
    );
  }
  if (jev.status === 'CANCELLED' || jev.status === 'REVERSED') {
    throw new HttpsError(
      'failed-precondition',
      `JEV ${jev.jevNo} is ${jev.status.toLowerCase()} and cannot be posted.`,
    );
  }

  // Re-check the balance at the moment of posting, not only at creation.
  // The document could have been edited in between by someone with draft
  // edit rights.
  const check = checkDoubleEntry(
    jev.lines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debit: l.debit,
      credit: l.credit,
    })),
  );
  if (!check.ok) {
    throw new HttpsError('failed-precondition', check.violations[0].message, {
      violations: check.violations,
    });
  }

  const postedAt = new Date().toISOString();

  for (const line of jev.lines) {
    const entryRef = db.collection(COL.ledgerEntries).doc();
    tx.create(entryRef, {
      fiscalYear: jev.fiscalYear,
      period: jev.period,
      fundCode: jev.fundCode,
      entryDate: jev.jevDate,

      jevId,
      jevNo: jev.jevNo,
      jevLineNo: line.lineNo,
      book: jev.book,

      accountCode: line.accountCode,
      accountName: line.accountName,
      // Signed amount makes a trial balance a single sum rather than two.
      signedAmount: line.debit - line.credit,
      debit: line.debit,
      credit: line.credit,

      officeId: line.officeId ?? null,
      officeName: line.officeName ?? null,
      responsibilityCenterId: line.responsibilityCenterId ?? null,
      subsidiaryType: line.subsidiaryType ?? null,
      subsidiaryId: line.subsidiaryId ?? null,
      subsidiaryName: line.subsidiaryName ?? null,
      cashFlowClass: line.cashFlowClass ?? null,

      sourceType: jev.sourceType,
      sourceId: jev.sourceId ?? null,
      referenceNo: jev.referenceNo ?? null,
      payeeId: jev.payeeId ?? null,
      payeeName: jev.payeeName ?? null,
      particulars: line.particulars ?? jev.particulars,

      postedAt,
      postedByUid: caller.uid,
      isReversal: opts.isReversal ?? false,
    });
  }

  tx.update(db.collection(COL.jevs).doc(jevId), {
    status: 'POSTED',
    postedAt,
    postedBy: {
      uid: caller.uid,
      name: caller.name,
      position: caller.position ?? null,
      at: postedAt,
    },
  });

  auditInTransaction(tx, {
    caller,
    event: 'POST',
    entityType: COL.jevs,
    entityId: jevId,
    entityRef: `JEV ${jev.jevNo}`,
    fiscalYear: jev.fiscalYear,
    fundCode: jev.fundCode,
    remarks: `Posted ${jev.lines.length} ledger entries totalling ${(jev.totalDebit / 100).toFixed(2)}.`,
    severity: 'NOTICE',
  });

  return { ledgerEntryCount: jev.lines.length, postedAt };
}

/**
 * Builds the mirror of a posted JEV: the same lines with debit and credit
 * swapped. Used by `reverseJev`.
 *
 * Reversal rather than deletion is not bureaucratic ceremony. A deleted entry
 * leaves the books balanced but the history false; a reversal leaves both the
 * original error and its correction visible, which is what an auditor needs to
 * see in order to conclude the error was handled honestly.
 */
export function buildReversalLines(lines: JevLineData[]): JevLineData[] {
  return lines.map((l) => ({
    ...l,
    debit: l.credit,
    credit: l.debit,
    particulars: l.particulars ? `Reversal of: ${l.particulars}` : 'Reversal',
  }));
}

/**
 * Reads the General Ledger balance of one account, for one fund and year,
 * up to and including a period.
 *
 * Used by bank reconciliation to obtain the book balance, so that the figure a
 * reconciliation is built on comes from the ledger and is never typed in by
 * hand. A reconciliation against a manually entered book balance proves
 * nothing.
 */
export async function ledgerBalance(input: {
  fiscalYear: number;
  fundCode: string;
  accountCode: string;
  throughPeriod?: number;
}): Promise<number> {
  let query = db
    .collection(COL.ledgerEntries)
    .where('fiscalYear', '==', input.fiscalYear)
    .where('fundCode', '==', input.fundCode)
    .where('accountCode', '==', input.accountCode);

  if (input.throughPeriod !== undefined) {
    query = query.where('period', '<=', input.throughPeriod);
  }

  const snap = await query.get();
  let balance = 0;
  for (const doc of snap.docs) {
    balance += (doc.data().signedAmount as number) ?? 0;
  }
  return balance;
}

/**
 * Trial balance for a fund and period. Returns one row per account with its
 * debit and credit totals, and asserts that the whole thing foots.
 *
 * If this ever throws, a ledger entry was written by something other than
 * `postJevInTransaction`. That is a security incident, not an accounting
 * discrepancy, and the message says so.
 */
export async function trialBalance(input: {
  fiscalYear: number;
  fundCode: string;
  throughPeriod: number;
}): Promise<{
  rows: Array<{ accountCode: string; accountName: string; debit: number; credit: number; balance: number }>;
  totalDebit: number;
  totalCredit: number;
}> {
  const snap = await db
    .collection(COL.ledgerEntries)
    .where('fiscalYear', '==', input.fiscalYear)
    .where('fundCode', '==', input.fundCode)
    .where('period', '<=', input.throughPeriod)
    .get();

  const byAccount = new Map<string, { accountName: string; debit: number; credit: number }>();

  for (const doc of snap.docs) {
    const d = doc.data();
    const key = d.accountCode as string;
    const acc = byAccount.get(key) ?? { accountName: d.accountName as string, debit: 0, credit: 0 };
    acc.debit += (d.debit as number) ?? 0;
    acc.credit += (d.credit as number) ?? 0;
    byAccount.set(key, acc);
  }

  const rows = [...byAccount.entries()]
    .map(([accountCode, v]) => ({
      accountCode,
      accountName: v.accountName,
      debit: v.debit,
      credit: v.credit,
      balance: v.debit - v.credit,
    }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);

  if (totalDebit !== totalCredit) {
    throw new HttpsError(
      'internal',
      `The General Ledger does not foot for ${input.fundCode} ${input.fiscalYear} through period ${input.throughPeriod}: debits ${(totalDebit / 100).toFixed(2)} against credits ${(totalCredit / 100).toFixed(2)}. Ledger entries can only be written by the posting function, so this indicates data was altered outside CBO. Report this to the system administrator before relying on any report.`,
    );
  }

  return { rows, totalDebit, totalCredit };
}
