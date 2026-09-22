import { HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { db, COL } from './firebase';

/**
 * Accounting period control.
 *
 * Nothing may be posted into a closed period. This is checked at posting time,
 * inside the posting transaction, rather than when a document is drafted -
 * a voucher may legitimately sit in review while its period closes, and the
 * right answer then is to move its posting date, not to lose the work.
 */

export function periodDocId(fiscalYear: number, period: number, fundCode: string): string {
  return `${fiscalYear}_${String(period).padStart(2, '0')}_${fundCode}`;
}

export type PeriodStatus = 'OPEN' | 'TEMPORARILY_LOCKED' | 'CLOSED' | 'REOPENED';

/**
 * Reads a period's status. An absent document means the period has never been
 * touched, which is treated as OPEN: a municipality should not have to
 * pre-create twelve period documents per fund before it can record anything.
 */
export async function periodStatus(
  fiscalYear: number,
  period: number,
  fundCode: string,
  tx?: Transaction,
): Promise<PeriodStatus> {
  const ref = db.collection(COL.accountingPeriods).doc(periodDocId(fiscalYear, period, fundCode));
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return 'OPEN';
  return ((snap.data()?.status as PeriodStatus) ?? 'OPEN');
}

export async function assertPeriodOpen(
  fiscalYear: number,
  period: number,
  fundCode: string,
  ref: string,
  tx?: Transaction,
): Promise<void> {
  const status = await periodStatus(fiscalYear, period, fundCode, tx);

  if (status === 'OPEN' || status === 'REOPENED') return;

  if (status === 'TEMPORARILY_LOCKED') {
    throw new HttpsError(
      'failed-precondition',
      `${ref} falls in ${monthName(period)} ${fiscalYear} (${fundCode}), which is temporarily locked while the month is being reviewed. Ask the Municipal Accountant to unlock it.`,
    );
  }

  throw new HttpsError(
    'failed-precondition',
    `${ref} falls in ${monthName(period)} ${fiscalYear} (${fundCode}), which is closed. Post it to an open period, or ask an administrator to reopen the period with a documented reason.`,
  );
}

/** Also refuses postings into a fiscal year that has been closed out. */
export async function assertFiscalYearOpen(fiscalYear: number, tx?: Transaction): Promise<void> {
  const ref = db.collection(COL.fiscalYears).doc(String(fiscalYear));
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return;
  const status = snap.data()?.status as string | undefined;
  if (status === 'CLOSED') {
    throw new HttpsError(
      'failed-precondition',
      `Fiscal year ${fiscalYear} has been closed. Prior period adjustments must be posted to the current year using a Prior Period Adjustment entry.`,
    );
  }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthName(period: number): string {
  return MONTHS[period - 1] ?? String(period);
}

export function periodOf(isoDate: string): number {
  return Number(isoDate.slice(5, 7));
}

export function yearOf(isoDate: string): number {
  return Number(isoDate.slice(0, 4));
}

export function todayPh(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
