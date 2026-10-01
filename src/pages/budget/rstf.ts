import type { Centavos, IsoDate } from '@/types/common';

/**
 * The Registry of Special Trust Fund.
 *
 * GAM for LGUs, Appendix 18. "This registry shall be maintained for each trust
 * receipt for specific purpose. All receipts to the specific trust shall be
 * recorded in the RSTF and all charges to the specific trust receipt as
 * supported by FURS shall be recognized in the RSTF."
 *
 * In CFMS the unit "each trust receipt for specific purpose" names is the Trust
 * Fund programme built in patch 38: a source agency, a purpose, a reference
 * document and a programmed ceiling. So one sheet per programme.
 *
 * ---------------------------------------------------------------------------
 * THE LEDGER DOES NOT CLOSE AT THE END OF THE YEAR
 * ---------------------------------------------------------------------------
 * Instruction 3, in full: "The SL shall not be closed at the end of the year."
 *
 * That is not a detail. Every other register in CFMS is a fiscal-year document
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
 * The Receipt side is worked too, now that a Trust Fund collection line
 * carries the programme it was received under. Every receipt reported on a
 * posted RCD lands here as its own dated line with its own official receipt
 * number, which is what instruction 1 asks for, and the total is the figure
 * `postRcd` maintained inside the transaction that posted it.
 *
 * Two things are still reported rather than relied on, and both are visible on
 * the face of the register:
 *
 *   THE STATED FIGURE IS KEPT BESIDE THE WORKED ONE. A programme is recorded
 *   in CFMS when its memorandum of agreement is signed, and the money arrives
 *   afterwards - so the Accountant's figure is what the source has promised
 *   and the worked figure is what has actually been receipted. Neither
 *   overwrites the other; the difference is shown. A programme whose receipts
 *   were all taken in before this existed reads as nil received against a
 *   stated figure, which is true and is the thing to go and fix.
 *
 *   A COLLECTION CARRYING NO PROGRAMME IS NAMED, NOT DROPPED. The link is
 *   optional, because refusing a receipt for want of master data would stop
 *   the Treasury taking money in. What that costs is a receipt that belongs on
 *   some sheet and is on none, so those are listed by receipt number on the
 *   register rather than left out of it.
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
  /** Stated by the Accountant. Carried beside the worked figure, not used. */
  received: Centavos;
  /**
   * Worked from the receipts by postRcd. The register is struck on this.
   *
   * Optional because a programme recorded before this field existed carries no
   * value for it, and `undefined - utilised` is NaN - a balance column of
   * "NaN" on every old sheet. It reads as nil until the next receipt posts,
   * which is true: no receipt in CFMS has yet named the programme.
   */
  receivedPosted?: Centavos;
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

/** One line of one official receipt, as the collection records it. */
export interface RstfCollectionLine {
  trustProgramId?: string;
  amount: Centavos;
  accountName?: string;
}

export interface RstfCollection {
  orNumber: string;
  orDate: IsoDate;
  payorName: string;
  status: string;
  /** Set when the receipt has been reported on an RCD. */
  rcdNo?: string;
  lines: RstfCollectionLine[];
}

/**
 * Receipts on the register are receipts that have been REPORTED.
 *
 * `receivedPosted` on the programme is written by `postRcd`, so a collection
 * still sitting in the drawer is not in that figure. Listing it here would put
 * a line on the sheet that the total beside it does not include, and a sheet
 * whose lines do not add up to its own total is worse than one that is a day
 * behind.
 */
export const REPORTED = new Set(['IN_RCD', 'DEPOSITED']);

export interface RstfSheet {
  program: RstfProgram;

  /** The Receipt side, one dated line per official receipt reported. */
  receipts: RstfEntry[];
  /** Receipts falling inside the period on the filter. */
  receivedThisPeriod: Centavos;
  /** The programme's whole life, maintained by postRcd. The balance uses this. */
  receiptTotal: Centavos;
  /** What the Accountant states the source has remitted. */
  receiptStated: Centavos;
  /** stated less worked. Zero where the receipts account for all of it. */
  receiptDrift: Centavos;
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

/** A reported Trust Fund receipt that names no programme. */
export interface UnattributedReceipt {
  orNumber: string;
  orDate: IsoDate;
  payorName: string;
  amount: Centavos;
}

export interface RstfRegistry {
  sheets: RstfSheet[];
  /**
   * Reported receipts carrying no programme, newest first. Every one of these
   * belongs on a sheet above and is on none of them.
   */
  unattributed: UnattributedReceipt[];
  unattributedTotal: Centavos;
}

export function buildRstf(input: {
  programs: RstfProgram[];
  obligations: RstfObligation[];
  /** Trust Fund collections. Omit where the register is read without them. */
  collections?: RstfCollection[];
  from: IsoDate;
  to: IsoDate;
  /** Omit to show every programme, including closed ones. */
  activeOnly?: boolean;
}): RstfRegistry {
  const byProgram = new Map<string, RstfEntry[]>();
  const totals = new Map<string, Centavos>();

  // --- the Receipt side ----------------------------------------------------
  const receiptsByProgram = new Map<string, RstfEntry[]>();
  const receivedInPeriod = new Map<string, Centavos>();
  const unattributed: UnattributedReceipt[] = [];

  for (const c of input.collections ?? []) {
    if (!REPORTED.has(c.status)) continue;

    for (const l of c.lines ?? []) {
      if (!l.trustProgramId) {
        /*
         * No programme. The money came in and is on no sheet, so it is named
         * here with its receipt number - the one thing that lets somebody find
         * the receipt and say which programme it belongs to.
         */
        const existing = unattributed.find((u) => u.orNumber === c.orNumber);
        if (existing) existing.amount += l.amount;
        else
          unattributed.push({
            orNumber: c.orNumber,
            orDate: c.orDate,
            payorName: c.payorName,
            amount: l.amount,
          });
        continue;
      }

      const list = receiptsByProgram.get(l.trustProgramId) ?? [];
      // One receipt may carry two lines against one programme. The register
      // lists documents, so they merge into the one line the reader wants.
      const existing = list.find((e) => e.reference === c.orNumber);
      if (existing) existing.amount += l.amount;
      else
        list.push({
          date: c.orDate,
          reference: c.orNumber,
          particulars: c.payorName || l.accountName || '',
          amount: l.amount,
        });
      receiptsByProgram.set(l.trustProgramId, list);

      if (c.orDate >= input.from && c.orDate <= input.to) {
        receivedInPeriod.set(
          l.trustProgramId,
          (receivedInPeriod.get(l.trustProgramId) ?? 0) + l.amount,
        );
      }
    }
  }

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

  const byDateThenRef = (a: RstfEntry, b: RstfEntry) =>
    a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference);

  const sheets = input.programs
    .filter((p) => !input.activeOnly || p.status === 'ACTIVE')
    .map((p) => {
      const utilisations = (byProgram.get(p.id) ?? []).sort(byDateThenRef);
      const receipts = (receiptsByProgram.get(p.id) ?? []).sort(byDateThenRef);
      const posted = p.receivedPosted ?? 0;

      /*
       * The balance is struck against the WORKED figure, not the stated one.
       * The register is a record of what came in and what was committed
       * against it, and what came in is the receipts. The stated figure is
       * carried beside it so the difference is visible, and takes no part in
       * the arithmetic.
       */
      return {
        program: p,
        receipts,
        receivedThisPeriod: receivedInPeriod.get(p.id) ?? 0,
        receiptTotal: posted,
        receiptStated: p.received,
        receiptDrift: p.received - posted,
        receiptYear: p.startYear ?? null,
        utilisations,
        utilisedThisPeriod: totals.get(p.id) ?? 0,
        utilisedToDate: p.utilised,
        disbursedToDate: p.disbursed,
        balance: posted - p.utilised,
        unpaidUtilisations: p.utilised - p.disbursed,
        availableToUtilise: p.programmed - p.utilised,
      };
    })
    .sort(
      (a, b) =>
        a.program.sourceAgency.localeCompare(b.program.sourceAgency) ||
        a.program.programName.localeCompare(b.program.programName),
    );

  return {
    sheets,
    unattributed: unattributed.sort((a, b) => b.orDate.localeCompare(a.orDate)),
    unattributedTotal: unattributed.reduce((t, u) => t + u.amount, 0),
  };
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
