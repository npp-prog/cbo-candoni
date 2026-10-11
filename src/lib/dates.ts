import type { IsoDate, PeriodNo } from '@/types/common';

/**
 * Dates in CFMS are Philippine local dates (UTC+8), stored as plain `YYYY-MM-DD`
 * strings rather than Firestore Timestamps.
 *
 * The reason is specific: a voucher dated 30 September must belong to
 * September's accounting period no matter where the browser is or how a
 * timestamp is later rendered. A `Timestamp` of 2026-09-30T20:00+08:00 read in
 * UTC is 30 September 12:00 - still fine - but a Timestamp created from a
 * browser at UTC-5 on the evening of the 30th lands on 1 October, silently
 * moving a transaction into the next accounting period. Plain date strings
 * cannot do that. Instants (audit timestamps) *are* stored with timezone,
 * because for those the exact moment is the point.
 */

export const PH_TIMEZONE = 'Asia/Manila';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Today's date in Philippine local time, as `YYYY-MM-DD`. */
export function todayPh(): IsoDate {
  return phDateOf(new Date());
}

/**
 * Patch 180: the Philippine calendar date of an instant. A stored timestamp
 * (`2025-12-31T17:30:00.000Z`) sliced to its first ten characters gives the
 * UTC date - the day BEFORE for anything done before 8:00 AM in Candoni.
 */
export function phDateOf(instant: Date | string | null | undefined): IsoDate {
  const d = instant instanceof Date ? instant : new Date(String(instant ?? ''));
  if (Number.isNaN(d.getTime())) return '' as IsoDate;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Current instant as an ISO string with the Philippine offset. */
export function nowPhIso(): string {
  return new Date().toISOString();
}

/**
 * Patch 180: the calendar date a Date object shows on THIS computer.
 *
 * `toISOString()` gives the UTC date, and a date parsed from text ("Jul 1,
 * 2026", "07/01/2026") or read by SheetJS is local midnight - in the
 * Philippines 16:00 the day before in UTC - so every such date came out a day
 * early.
 */
export function localIsoDate(d: Date): IsoDate {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` as IsoDate;
}

export function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

/** Accounting period (1-12) a date falls in. */
export function periodOf(date: IsoDate): PeriodNo {
  return Number(date.slice(5, 7));
}

export function monthName(period: PeriodNo): string {
  return MONTHS[period - 1] ?? String(period);
}

/** "September 21, 2026" - the form used on printed reports. */
export function formatLongDate(date: IsoDate | undefined | null): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "21 Sep 2026" - compact form used in tables. */
export function formatShortDate(date: IsoDate | undefined | null): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]?.slice(0, 3)} ${y}`;
}

/** Format an audit instant for display, in Philippine time. */
export function formatInstant(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: PH_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, day] = date.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return base.toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Aging bucket used by cash-advance and payables monitoring. */
export type AgingBucket = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'OVER_90';

export const AGING_LABELS: Record<AgingBucket, string> = {
  CURRENT: 'Current',
  D1_30: '1-30 Days',
  D31_60: '31-60 Days',
  D61_90: '61-90 Days',
  OVER_90: 'Above 90 Days',
};

export function agingBucket(dueDate: IsoDate, asOf: IsoDate = todayPh()): AgingBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'CURRENT';
  if (overdue <= 30) return 'D1_30';
  if (overdue <= 60) return 'D31_60';
  if (overdue <= 90) return 'D61_90';
  return 'OVER_90';
}

/** First and last date of an accounting period, inclusive. */
export function periodRange(fiscalYear: number, period: PeriodNo): { from: IsoDate; to: IsoDate } {
  const from = `${fiscalYear}-${String(period).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(fiscalYear, period, 0)).getUTCDate();
  const to = `${fiscalYear}-${String(period).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

/** A check becomes stale six months after its date (COA / BSP practice). */
export function staleDate(checkDate: IsoDate, months = 6): IsoDate {
  return addMonths(checkDate, months);
}
