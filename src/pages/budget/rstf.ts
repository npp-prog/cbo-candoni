import type { Centavos, IsoDate } from '@/types/common';

/**
 * The Registry of Special Trust Fund.
 *
 * GAM for LGUs, Appendix 18. "This registry shall be maintained for each trust
 * receipt for specific purpose. All receipts to the specific trust shall be
 * recorded in the RSTF and all charges to the specific trust receipt as
 * supported by FURS shall be recognized in the RSTF."
 *
 * In CBO the unit "each trust receipt for specific purpose" names is the Trust
 * Fund programme built in patch 38: a source agency, a purpose, a reference
 * document and a programmed ceiling. So one sheet per programme.
 *
 * ---------------------------------------------------------------------------
 * THE LEDGER DOES NOT CLOSE AT THE END OF THE YEAR
 * ---------------------------------------------------------------------------
 * Instruction 3, in full: "The SL shall not be closed at the end of the year."
 *
 * That is not a detail. Every other register in CBO is a fiscal-year document
 * and is filtered by the year on the toolbar; this one is a programme's whole
 * life, and a trust programme routinely runs across three or four years. A
 * balance that reset each January would say a programme had been fully
 * utilised when it had not.
 *
 * So this computation reports TWO different things and labels them as two:
 *
 *   - the utilisations of the period on the filter, listed line by line from
 *     the Funding Utilization Requests, and
 *   - the programme's life-to-date figures, which are the ones the balance is
 *     struck from.
 *
 * It deliberately does NOT derive a "brought forward" by subtracting one from
 * the other. That subtraction is only right while the filter is on the current
 * year: open a past year and the life-to-date figure already contains
 * utilisations that have not happened yet as far as that sheet is concerned,
 * and the brought-forward line would silently absorb them. Two labelled
 * figures cannot be misread that way.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS WORKED AND WHAT IS STATED
 * ---------------------------------------------------------------------------
 * The Utilization side is worked: every line is a certified FURS, and the
 * life-to-date total is the figure the Cloud Function maintains inside the
 * transaction that certifies one.
 *
 * The Receipt side is NOT. CBO still does not tie a Trust Fund collection to a
 * programme, so `received` is the Accountant's statement of what the source
 * has remitted. The manual wants a dated line per receipt with its own
 * reference and the year the trust was granted; what CBO can produce is one
 * figure. It is carried here flagged as stated, and the screen says so - four
 * columns that look equally solid, one of which nothing verifies, is the
 * quiet kind of wrong.
 */

/**
 * Statuses in which an obligation has actually committed trust money.
 *
 * This is the server's rule, not a looser one: `applyTrustDelta` adds to
 * `utilised` when an OBR is CERTIFIED (becoming OBLIGATED) and subtracts when
 * it is cancelled. A SUBMITTED, BUDGET_REVIEWED or RETURNED request has
 * committed nothing, and counting one here would make the register disagree
 * with the programme figure printed beside it.
 */
export const UTILISED = new Set(['CERTIFIED', 'OBLIGATED', 'PAID', 'CLOSED']);

export interface RstfProgram {
  id: string;
  programCode: string;
  programName: string;
  sourceAgency: string;
  reference: string;
  /** The RCA code the trust liability sits in. Stated by the Accountant. */
  accountCode?: string;
  startYear?: number;
  programmed: Centavos;
  /** Stated, not worked. See above. */
  received: Centavos;
  utilised: Centavos;
  disbursed: Centavos;
  status: string;
}

export interface RstfObligationLine {
  trustProgramId?: string;
  amount: Centavos;
}

export interface RstfObligation {
  obrNo: string;
  obrDate: IsoDate;
  status: string;
  particulars?: string;
  lines: RstfObligationLine[];
}

export interface RstfEntry {
  date: IsoDate;
  particulars: string;
  reference: string;
  amount: Centavos;
}

export interface RstfSheet {
  program: RstfProgram;

  /** The Receipt side: one line, and it is a statement, not a document. */
  receiptTotal: Centavos;
  receiptIsStated: true;
  /** Instruction 1's "Year - the year when the special trust fund is granted". */
  receiptYear: number | null;

  /** The Utilization side, for the period on the filter. */
  utilisations: RstfEntry[];
  utilisedThisPeriod: Centavos;

  /** The programme's whole life, which is what the balance is struck from. */
  utilisedToDate: Centavos;
  disbursedToDate: Centavos;
  /** received - utilised. Negative means more was committed than came in. */
  balance: Centavos;
  /** utilised - disbursed: committed and not yet paid. */
  unpaidUtilisations: Centavos;
  /** programmed - utilised: what a further FURS may still draw on. */
  availableToUtilise: Centavos;
}

export function buildRstf(input: {
  programs: RstfProgram[];
  obligations: RstfObligation[];
  from: IsoDate;
  to: IsoDate;
  /** Omit to show every programme, including closed ones. */
  activeOnly?: boolean;
}): RstfSheet[] {
  const byProgram = new Map<string, RstfEntry[]>();
  const totals = new Map<string, Centavos>();

  for (const o of input.obligations) {
    if (!UTILISED.has(o.status)) continue;
    if (o.obrDate < input.from || o.obrDate > input.to) continue;

    for (const l of o.lines ?? []) {
      if (!l.trustProgramId) continue;
      const list = byProgram.get(l.trustProgramId) ?? [];
      // One request may carry several lines against one programme. The register
      // lists documents, so they merge into the one entry the reader is
      // looking for.
      const existing = list.find((e) => e.reference === o.obrNo);
      if (existing) existing.amount += l.amount;
      else
        list.push({
          date: o.obrDate,
          reference: o.obrNo,
          particulars: o.particulars || '',
          amount: l.amount,
        });
      byProgram.set(l.trustProgramId, list);
      totals.set(l.trustProgramId, (totals.get(l.trustProgramId) ?? 0) + l.amount);
    }
  }

  return input.programs
    .filter((p) => !input.activeOnly || p.status === 'ACTIVE')
    .map((p) => {
      const utilisations = (byProgram.get(p.id) ?? []).sort(
        (a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference),
      );
      return {
        program: p,
        receiptTotal: p.received,
        receiptIsStated: true as const,
        receiptYear: p.startYear ?? null,
        utilisations,
        utilisedThisPeriod: totals.get(p.id) ?? 0,
        utilisedToDate: p.utilised,
        disbursedToDate: p.disbursed,
        balance: p.received - p.utilised,
        unpaidUtilisations: p.utilised - p.disbursed,
        availableToUtilise: p.programmed - p.utilised,
      };
    })
    .sort(
      (a, b) =>
        a.program.sourceAgency.localeCompare(b.program.sourceAgency) ||
        a.program.programName.localeCompare(b.program.programName),
    );
}

/** Every sheet added up, for the cover of the registry. */
export function totalRstf(sheets: RstfSheet[]) {
  return sheets.reduce(
    (acc, s) => ({
      programmed: acc.programmed + s.program.programmed,
      received: acc.received + s.receiptTotal,
      utilisedThisPeriod: acc.utilisedThisPeriod + s.utilisedThisPeriod,
      utilisedToDate: acc.utilisedToDate + s.utilisedToDate,
      disbursedToDate: acc.disbursedToDate + s.disbursedToDate,
      balance: acc.balance + s.balance,
      unpaidUtilisations: acc.unpaidUtilisations + s.unpaidUtilisations,
    }),
    {
      programmed: 0,
      received: 0,
      utilisedThisPeriod: 0,
      utilisedToDate: 0,
      disbursedToDate: 0,
      balance: 0,
      unpaidUtilisations: 0,
    },
  );
}
