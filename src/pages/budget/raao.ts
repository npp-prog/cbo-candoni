import { COMMITTED, RELEASED } from '@/lib/budgetPeriods';
import type { Centavos, IsoDate } from '@/types/common';

/**
 * The Registry of Appropriations, Allotments and Obligations.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY THERE ARE FOUR OF THEM
 * ---------------------------------------------------------------------------
 * GAM for LGUs, Appendices 19 to 22. The manual prescribes four registries,
 * one per allotment class - Capital Outlay, Maintenance and Other Operating
 * Expenses, Personal Services, Financial Expenses - and their instructions are
 * word for word identical apart from the title. So this is one computation,
 * and the class is a parameter.
 *
 * They are NOT four views of the summary registry CBO already had. That screen
 * answers "where does this budget line stand"; this one is the book itself:
 * every allotment and every obligation as a dated line, in the order they
 * happened, footed at the end of the month. An auditor reads the second, and
 * a summary with the same title would not survive being read as one.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE THE MANUAL PRESCRIBES
 * ---------------------------------------------------------------------------
 * Each sheet is one Function/Program/Project, within one fund, for one month,
 * and has two sections:
 *
 *   Section A - Budget.  The appropriation, then every allotment released.
 *   Section B - Actual.  Every obligation incurred.
 *
 * Both are footed the same way, and the sequence is the manual's, not one
 * invented here (Appendix 19, instructions 7 to 10):
 *
 *   "At the start of the second month, the totals of the previous month shall
 *    be posted on the first line... At the end of the second and succeeding
 *    months, the footings shall be made first for the totals for the month,
 *    then on the following line the accumulated total as of the period."
 *
 * So each section carries three figures and not one: brought forward, this
 * month, and accumulated. `figuresForPeriod` in budgetPeriods.ts splits the
 * same way and off the same documents, which is what lets the registry and the
 * summary agree.
 *
 * And instruction 11: "To determine the unobligated balance of the allotments,
 * the total obligations shall be deducted from the total of allotments." That
 * is `unobligatedBalance`, computed from the accumulated figures, never from
 * the month alone.
 *
 * ---------------------------------------------------------------------------
 * ONE THING THE MANUAL SAYS THAT CANDONI DOES NOT DO
 * ---------------------------------------------------------------------------
 * Instruction 9 reads "Reference/Obligation Number - ... the no. in the CAFOA
 * for obligation", and instruction 6 of Section B says "Every obligation
 * incurred as supported by a CAFOA".
 *
 * The CAFOA - the Certification on Appropriations, Funds and Obligation of
 * Allotment, Appendix 28 - is suspended, and CBO does not produce one. The
 * document that carries the obligation here is the Obligation Request, and its
 * number is what goes in the reference column.
 *
 * That substitution is recorded here rather than left to be noticed, because a
 * column headed "CAFOA No." holding an OBR number is the kind of thing that
 * gets queried in an audit and cannot be explained from the screen.
 */

export type RaaoClass = 'PS' | 'MOOE' | 'CO' | 'FE';

/** The four registries, and the appendix each one answers to. */
export const RAAO_FORMS: Record<
  RaaoClass,
  { appendix: number; acronym: string; title: string }
> = {
  CO: {
    appendix: 19,
    acronym: 'RAAOCO',
    title: 'Registry of Appropriations, Allotments and Obligations - Capital Outlay',
  },
  MOOE: {
    appendix: 20,
    acronym: 'RAAOMOOE',
    title:
      'Registry of Appropriations, Allotments and Obligations - Maintenance and Other Operating Expenses',
  },
  PS: {
    appendix: 21,
    acronym: 'RAAOPS',
    title: 'Registry of Appropriations, Allotments and Obligations - Personal Services',
  },
  FE: {
    appendix: 22,
    acronym: 'RAAOFE',
    title: 'Registry of Appropriations, Allotments and Obligations - Financial Expenses',
  },
};

// ---------------------------------------------------------------------------
// What the computation reads
// ---------------------------------------------------------------------------

export interface RaaoAllotment {
  allotmentDate: IsoDate;
  status: string;
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName?: string;
  accountCode: string;
  expenseClass: string;
  amount: Centavos;
  /** The Allotment Release Order number, where the line came from one. */
  aroNo?: string;
  allotmentNo?: string;
  particulars?: string;
}

export interface RaaoObligationLine {
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName?: string;
  /** The object code the APPROPRIATION carried; empty on a project line. */
  appropriatedAccountCode?: string;
  expenseClass: string;
  amount: Centavos;
}

export interface RaaoObligation {
  obrNo: string;
  obrDate: IsoDate;
  status: string;
  particulars?: string;
  lines: RaaoObligationLine[];
}

/** One budget line's appropriation, as the balances hold it. */
export interface RaaoAppropriation {
  officeId: string;
  fppCode: string;
  accountCode: string;
  expenseClass: string;
  appropriationRevised: Centavos;
}

// ---------------------------------------------------------------------------
// What it produces
// ---------------------------------------------------------------------------

/** One dated line of the register. */
export interface RaaoEntry {
  date: IsoDate;
  /** The ARO number, or the OBR number. Never a CAFOA number - see above. */
  reference: string;
  particulars: string;
  amount: Centavos;
  /** The Details columns: how the amount splits across object codes. */
  byAccount: Record<string, Centavos>;
}

export interface RaaoSection {
  /** Posted on the first line: everything before this period. */
  broughtForward: Centavos;
  broughtForwardByAccount: Record<string, Centavos>;
  entries: RaaoEntry[];
  /** The footing for the month. */
  thisPeriod: Centavos;
  thisPeriodByAccount: Record<string, Centavos>;
  /** The line after it: brought forward plus this month. */
  toDate: Centavos;
  toDateByAccount: Record<string, Centavos>;
}

export interface RaaoSheet {
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  /**
   * The Details column heads.
   *
   * Instruction 12: "the amount columns shall be headed by the classification
   * codes of the expenditures for which releases of allotments were made and
   * against which expenditures shall be charged." So the columns are whatever
   * object codes this sheet actually uses, in code order - not a fixed set,
   * and not every code in the chart.
   */
  accountCodes: string[];
  /** Section A's appropriation figure, which is authority, not an event. */
  appropriation: Centavos;
  budget: RaaoSection;
  actual: RaaoSection;
  /** Instruction 11: total allotments less total obligations, accumulated. */
  unobligatedBalance: Centavos;
}

// ---------------------------------------------------------------------------

const addTo = (m: Record<string, Centavos>, code: string, amount: Centavos) => {
  const k = code || '-';
  m[k] = (m[k] ?? 0) + amount;
};

const sheetKey = (officeId: string, fppCode: string) => `${officeId}__${fppCode}`;

interface Building {
  officeId: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  accounts: Set<string>;
  appropriation: Centavos;
  budget: { bf: Centavos; bfBy: Record<string, Centavos>; entries: RaaoEntry[] };
  actual: { bf: Centavos; bfBy: Record<string, Centavos>; entries: RaaoEntry[] };
}

const close = (s: Building['budget']): RaaoSection => {
  const thisPeriodByAccount: Record<string, Centavos> = {};
  let thisPeriod = 0;
  for (const e of s.entries) {
    thisPeriod += e.amount;
    for (const [code, amount] of Object.entries(e.byAccount)) {
      addTo(thisPeriodByAccount, code, amount);
    }
  }
  const toDateByAccount = { ...s.bfBy };
  for (const [code, amount] of Object.entries(thisPeriodByAccount)) {
    addTo(toDateByAccount, code, amount);
  }
  return {
    broughtForward: s.bf,
    broughtForwardByAccount: s.bfBy,
    // The manual posts the register in the order things happened. Two entries
    // on one date keep their reference order so a sheet reads the same today
    // as it did last month.
    entries: [...s.entries].sort(
      (a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference),
    ),
    thisPeriod,
    thisPeriodByAccount,
    toDate: s.bf + thisPeriod,
    toDateByAccount,
  };
};

/**
 * Build every sheet of one registry.
 *
 * `from` and `to` bound the period, inclusive, as plain YYYY-MM-DD strings.
 * Anything dated after `to` is left out entirely; anything before `from` is
 * brought forward rather than listed, which is what the manual asks for.
 */
export function buildRaao(input: {
  expenseClass: RaaoClass;
  allotments: RaaoAllotment[];
  obligations: RaaoObligation[];
  appropriations: RaaoAppropriation[];
  from: IsoDate;
  to: IsoDate;
  /** Limit to one office; omit for every office in the fund. */
  officeId?: string | null;
}): RaaoSheet[] {
  const { expenseClass, from, to, officeId } = input;
  const sheets = new Map<string, Building>();

  const at = (
    office: { officeId: string; officeName: string },
    fpp: { fppCode: string; fppName?: string },
  ): Building => {
    const key = sheetKey(office.officeId, fpp.fppCode);
    const existing = sheets.get(key);
    if (existing) {
      // The first document to mention a line wins the name only if it had one:
      // an allotment raised without an FPP name should not blank out a name a
      // later obligation carries.
      if (!existing.fppName && fpp.fppName) existing.fppName = fpp.fppName;
      return existing;
    }
    const created: Building = {
      officeId: office.officeId,
      officeName: office.officeName,
      fppCode: fpp.fppCode,
      fppName: fpp.fppName || '',
      accounts: new Set<string>(),
      appropriation: 0,
      budget: { bf: 0, bfBy: {}, entries: [] },
      actual: { bf: 0, bfBy: {}, entries: [] },
    };
    sheets.set(key, created);
    return created;
  };

  for (const a of input.appropriations) {
    if (a.expenseClass !== expenseClass) continue;
    if (officeId && a.officeId !== officeId) continue;
    if (a.appropriationRevised === 0) continue;
    const sheet = at({ officeId: a.officeId, officeName: '' }, { fppCode: a.fppCode });
    sheet.appropriation += a.appropriationRevised;
    if (a.accountCode) sheet.accounts.add(a.accountCode);
  }

  for (const a of input.allotments) {
    if (a.expenseClass !== expenseClass) continue;
    if (!RELEASED.has(a.status)) continue;
    if (a.allotmentDate > to) continue;
    if (officeId && a.officeId !== officeId) continue;

    const sheet = at(a, a);
    if (!sheet.officeName) sheet.officeName = a.officeName;
    if (a.accountCode) sheet.accounts.add(a.accountCode);

    if (a.allotmentDate < from) {
      sheet.budget.bf += a.amount;
      addTo(sheet.budget.bfBy, a.accountCode, a.amount);
      continue;
    }
    sheet.budget.entries.push({
      date: a.allotmentDate,
      // The ARO is the document the manual means by "the Local Budget
      // Matrix/Advice of Allotment". Where a line was released without one -
      // a bulk load, say - its own number is the next best reference, and an
      // empty column would tell the reader nothing at all.
      reference: a.aroNo || a.allotmentNo || '',
      particulars: a.particulars || '',
      amount: a.amount,
      byAccount: { [a.accountCode || '-']: a.amount },
    });
  }

  for (const o of input.obligations) {
    if (!COMMITTED.has(o.status)) continue;
    if (o.obrDate > to) continue;

    for (const l of o.lines ?? []) {
      if (l.expenseClass !== expenseClass) continue;
      if (officeId && l.officeId !== officeId) continue;

      const sheet = at(l, l);
      if (!sheet.officeName) sheet.officeName = l.officeName;
      const code = l.appropriatedAccountCode ?? '';
      if (code) sheet.accounts.add(code);

      if (o.obrDate < from) {
        sheet.actual.bf += l.amount;
        addTo(sheet.actual.bfBy, code, l.amount);
        continue;
      }
      // One Obligation Request can charge several lines of one sheet. They are
      // merged into a single register entry, because the register lists
      // documents and the reader is looking for the OBR, not for its line 3.
      const existing = sheet.actual.entries.find((e) => e.reference === o.obrNo);
      if (existing) {
        existing.amount += l.amount;
        addTo(existing.byAccount, code, l.amount);
        continue;
      }
      sheet.actual.entries.push({
        date: o.obrDate,
        reference: o.obrNo,
        particulars: o.particulars || '',
        amount: l.amount,
        byAccount: { [code || '-']: l.amount },
      });
    }
  }

  return [...sheets.values()]
    .map((s) => {
      const budget = close(s.budget);
      const actual = close(s.actual);
      return {
        officeId: s.officeId,
        officeName: s.officeName,
        fppCode: s.fppCode,
        fppName: s.fppName,
        accountCodes: [...s.accounts].sort(),
        appropriation: s.appropriation,
        budget,
        actual,
        unobligatedBalance: budget.toDate - actual.toDate,
      };
    })
    // A sheet with nothing on it at all is not printed. A sheet with an
    // appropriation and no activity IS - that is a function the ordinance
    // funded and nobody has drawn on, which is exactly what a registry is for.
    .filter(
      (s) =>
        s.appropriation !== 0 ||
        s.budget.toDate !== 0 ||
        s.actual.toDate !== 0 ||
        s.budget.entries.length > 0 ||
        s.actual.entries.length > 0,
    )
    .sort(
      (a, b) => a.officeName.localeCompare(b.officeName) || a.fppCode.localeCompare(b.fppCode),
    );
}

/** The four sheets' figures added up, for the cover total of one registry. */
export function totalRaao(sheets: RaaoSheet[]) {
  return sheets.reduce(
    (acc, s) => ({
      appropriation: acc.appropriation + s.appropriation,
      allotmentToDate: acc.allotmentToDate + s.budget.toDate,
      allotmentThisPeriod: acc.allotmentThisPeriod + s.budget.thisPeriod,
      obligationToDate: acc.obligationToDate + s.actual.toDate,
      obligationThisPeriod: acc.obligationThisPeriod + s.actual.thisPeriod,
      unobligatedBalance: acc.unobligatedBalance + s.unobligatedBalance,
    }),
    {
      appropriation: 0,
      allotmentToDate: 0,
      allotmentThisPeriod: 0,
      obligationToDate: 0,
      obligationThisPeriod: 0,
      unobligatedBalance: 0,
    },
  );
}
