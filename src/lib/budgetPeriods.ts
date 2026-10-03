import type { Centavos, IsoDate } from '@/types/common';
import { OBLIGATION_STATUSES } from '@/types/enums';

/**
 * The budget, cut by when things happened.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RUNNING BALANCES ARE NOT ENOUGH
 * ---------------------------------------------------------------------------
 * `budgetBalances` holds one figure per budget line for the whole year:
 * appropriated, released, obligated, disbursed as of now. That is what the
 * registry and the SAOB need, and it is maintained inside the same transaction
 * that writes the underlying document, which is what makes the control real.
 *
 * But the Budget Operations Manual asks for something a running total cannot
 * answer. LBAc Form No. 2 wants allotments released in PREVIOUS QUARTERS in
 * one column and THIS QUARTER in the next; the RAAO is kept for a period. A
 * year-to-date figure cannot be split after the fact.
 *
 * So these figures are computed from the documents themselves - each allotment
 * has its release date, each obligation its OBR date - and the year-to-date
 * total they produce must agree with the running balance. Where it does not,
 * something has gone wrong in one of the two, and the report says so rather
 * than picking a side.
 *
 * ---------------------------------------------------------------------------
 * WHY CANCELLED DOCUMENTS ARE EXCLUDED AND DRAFTS ARE NOT COUNTED
 * ---------------------------------------------------------------------------
 * The manual's registry records what was RELEASED and what was COMMITTED. A
 * draft allotment has been released to nobody; a cancelled obligation commits
 * nothing. Counting either would show a department authority it does not have,
 * which is the one thing the registry exists to prevent.
 * ---------------------------------------------------------------------------
 */

/** A quarter of the fiscal year, as the accountability forms report it. */
export type Quarter = 1 | 2 | 3 | 4;

/**
 * The months are abbreviated deliberately.
 *
 * Both places these labels appear are dropdowns in a filter row, where every
 * control is one fixed width so that changing the period does not slide the
 * row sideways. Spelt out, "Fourth Quarter (October to December)" needs 271px
 * of text; the box holds about 185px. The label was being cut off mid-word -
 * "First Quarter (January to M..." - which is worse than an abbreviation,
 * because a reader cannot tell a truncated label from a short one and has no
 * way to see the rest.
 *
 * Widening the box instead would mean widening EVERY control in every filter
 * row to match, to keep them uniform, for the sake of four words that abbreviate
 * without losing anything. Jan-Mar is not ambiguous.
 */
export const QUARTER_LABELS: Record<Quarter, string> = {
  1: 'First Quarter (Jan-Mar)',
  2: 'Second Quarter (Apr-Jun)',
  3: 'Third Quarter (Jul-Sep)',
  4: 'Fourth Quarter (Oct-Dec)',
};

/** The quarter a plain YYYY-MM-DD date falls in. */
export function quarterOf(date: IsoDate): Quarter {
  const month = Number(date.slice(5, 7));
  return (Math.floor((month - 1) / 3) + 1) as Quarter;
}

/**
 * First and last day of a quarter, as plain dates.
 *
 * There is deliberately no leap-year handling. A quarter ends in March, June,
 * September or December, never in February, so a 29 February branch here would
 * be a branch no input could ever take - and a dead branch in a date routine
 * reads as protection that is not there. A release dated 29 February falls
 * inside the first quarter because 29 February is before 31 March, which is
 * all the comparison needs.
 */
export function quarterRange(fiscalYear: number, quarter: Quarter): { from: IsoDate; to: IsoDate } {
  const firstMonth = (quarter - 1) * 3 + 1;
  const lastMonth = firstMonth + 2;
  const lastDay = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][lastMonth - 1];
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${fiscalYear}-${pad(firstMonth)}-01`,
    to: `${fiscalYear}-${pad(lastMonth)}-${pad(lastDay)}`,
  };
}

// ---------------------------------------------------------------------------
// The documents, in the shape this module needs
// ---------------------------------------------------------------------------

export interface PeriodAllotment {
  allotmentDate: IsoDate;
  status: string;
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName?: string;
  accountCode: string;
  accountName?: string;
  sector?: string;
  serviceSector?: string;
  expenseClass: string;
  amount: Centavos;
}

export interface PeriodObligationLine {
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName?: string;
  /** The object code the APPROPRIATION carried; empty on a project line. */
  appropriatedAccountCode?: string;
  expenseClass: string;
  amount: Centavos;
}

export interface PeriodObligation {
  obrDate: IsoDate;
  status: string;
  lines: PeriodObligationLine[];
}

/**
 * Statuses that mean the document is live.
 *
 * Taken from OBLIGATION_STATUSES rather than guessed: an obligation is
 * committed once it is CERTIFIED and stays committed through OBLIGATED, PAID
 * and CLOSED. DRAFT, SUBMITTED, BUDGET_REVIEWED and RETURNED commit nothing
 * yet, and CANCELLED commits nothing any more.
 */
/**
 * Exported because the RAAO registries need exactly the same answer.
 *
 * Two copies of "what counts as released" is how a registry comes to disagree
 * with the figures it is meant to detail - the registry would list an
 * allotment the summary had not counted, or foot to a different total, and
 * whichever was read second would be the one believed.
 */
export const RELEASED = new Set(['APPROVED']);
/**
 * What counts as committed, derived from the status list rather than typed out.
 *
 * It used to be the literal set ['CERTIFIED','OBLIGATED','PAID','CLOSED'], and
 * the moment a status was added - WITH_DV, for an obligation that has reached
 * a voucher - every obligation in that state would have dropped silently out
 * of the RAAO. A registry that quietly stops counting commitments is worse
 * than one that errors: it foots, and it is wrong.
 *
 * So the question is turned round. A status is committed UNLESS it is named
 * below. A new one is counted by default, which is the safe direction - a
 * commitment counted wrongly is visible on the face of the registry, and one
 * that vanishes is not.
 */
const NOT_COMMITTED = new Set<string>([
  'DRAFT',
  'SUBMITTED',
  'BUDGET_REVIEWED',
  'RETURNED',
  'CANCELLED',
]);

export const COMMITTED = new Set<string>(
  OBLIGATION_STATUSES.filter((s) => !NOT_COMMITTED.has(s)),
);

export interface LineKeyParts {
  officeId: string;
  fppCode: string;
  accountCode: string;
}

/** How a budget line is identified within a report. */
export const lineKey = (p: LineKeyParts): string =>
  `${p.officeId}__${p.fppCode}__${p.accountCode || '-'}`;

export interface PeriodFigures {
  key: string;
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  accountCode: string;
  expenseClass: string;
  sector: string;
  serviceSector: string;
  /** Released or obligated before the period began. */
  allotmentPrevious: Centavos;
  allotmentThisPeriod: Centavos;
  obligationPrevious: Centavos;
  obligationThisPeriod: Centavos;
}

const blank = (a: Partial<PeriodFigures> & { key: string }): PeriodFigures => ({
  officeId: '',
  officeName: '',
  fppCode: '',
  fppName: '',
  accountCode: '',
  expenseClass: 'MOOE',
  sector: '',
  serviceSector: '',
  allotmentPrevious: 0,
  allotmentThisPeriod: 0,
  obligationPrevious: 0,
  obligationThisPeriod: 0,
  ...a,
});

/**
 * Allotments and obligations split at a date.
 *
 * `from` and `to` bound the period being reported. Anything dated before
 * `from` is "previous"; anything within the range inclusive is "this period".
 * Anything AFTER `to` is left out altogether - a report for the second quarter
 * that quietly included October would not be a report for the second quarter.
 */
export function figuresForPeriod(
  allotments: PeriodAllotment[],
  obligations: PeriodObligation[],
  from: IsoDate,
  to: IsoDate,
): PeriodFigures[] {
  const map = new Map<string, PeriodFigures>();

  const at = (parts: LineKeyParts, seed: Partial<PeriodFigures>): PeriodFigures => {
    const key = lineKey(parts);
    const existing = map.get(key);
    if (existing) return existing;
    const created = blank({ key, ...parts, ...seed });
    map.set(key, created);
    return created;
  };

  for (const a of allotments) {
    if (!RELEASED.has(a.status)) continue;
    if (a.allotmentDate > to) continue;

    const row = at(
      { officeId: a.officeId, fppCode: a.fppCode, accountCode: a.accountCode },
      {
        officeName: a.officeName,
        fppName: a.fppName || a.accountName || a.fppCode,
        expenseClass: a.expenseClass,
        sector: a.sector ?? '',
        serviceSector: a.serviceSector ?? '',
      },
    );
    if (a.allotmentDate < from) row.allotmentPrevious += a.amount;
    else row.allotmentThisPeriod += a.amount;
  }

  for (const o of obligations) {
    if (!COMMITTED.has(o.status)) continue;
    if (o.obrDate > to) continue;

    for (const l of o.lines ?? []) {
      const row = at(
        {
          officeId: l.officeId,
          fppCode: l.fppCode,
          // The object code the APPROPRIATION carried, never the one this
          // obligation commits - on a project line those differ, and keying on
          // the wrong one would open a second row for a line that already has
          // its allotment on the first.
          accountCode: l.appropriatedAccountCode ?? '',
        },
        {
          officeName: l.officeName,
          fppName: l.fppName || l.fppCode,
          expenseClass: l.expenseClass,
        },
      );
      if (o.obrDate < from) row.obligationPrevious += l.amount;
      else row.obligationThisPeriod += l.amount;
    }
  }

  return [...map.values()].sort(
    (a, b) => a.officeName.localeCompare(b.officeName) || a.fppCode.localeCompare(b.fppCode),
  );
}

/** Totals a set of period figures the way the accountability forms foot. */
export function totalPeriod(rows: PeriodFigures[]) {
  return rows.reduce(
    (acc, r) => ({
      allotmentPrevious: acc.allotmentPrevious + r.allotmentPrevious,
      allotmentThisPeriod: acc.allotmentThisPeriod + r.allotmentThisPeriod,
      allotmentTotal: acc.allotmentTotal + r.allotmentPrevious + r.allotmentThisPeriod,
      obligationPrevious: acc.obligationPrevious + r.obligationPrevious,
      obligationThisPeriod: acc.obligationThisPeriod + r.obligationThisPeriod,
      obligationTotal: acc.obligationTotal + r.obligationPrevious + r.obligationThisPeriod,
    }),
    {
      allotmentPrevious: 0,
      allotmentThisPeriod: 0,
      allotmentTotal: 0,
      obligationPrevious: 0,
      obligationThisPeriod: 0,
      obligationTotal: 0,
    },
  );
}
