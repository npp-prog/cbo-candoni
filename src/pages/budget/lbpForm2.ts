import type { Centavos, IsoDate } from '@/types/common';
import { COMMITTED } from '@/lib/budgetPeriods';
import { findSector } from '@/lib/sectors';

/**
 * LBP Form No. 2 - Programmed Appropriation and Obligation by Object of
 * Expenditure. Budget Operations Manual for LGUs, 2023 Edition, pages 62-63.
 * Patch 119.
 *
 * One form per Department/Office, with seven columns:
 *
 *   (1) Object of Expenditure         (2) Account Code
 *   (3) Past Year - Actual
 *   (4) Current Year, First Semester - Actual
 *   (5) Current Year, Second Semester - Estimates
 *   (6) Current Year Total (4 + 5)
 *   (7) Budget Year - Proposed
 *
 * grouped under Personal Services, MOOE, Financial Expenses, Capital Outlays
 * and Special Purpose Appropriations, and signed by the Department Head, the
 * Local Budget Officer and the Local Chief Executive.
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH COLUMN COMES FROM
 * ---------------------------------------------------------------------------
 * COLUMN 7 is the ordinance: its lines, summed by office and object.
 *
 * COLUMNS 3 AND 4 are obligations in the books - "actual expenditures ... as
 * certified by the Local Accountant" - of the past year, and of January to
 * June of the current year. Where CFMS holds no books for those years (the
 * first budget it is used for) they print as dashes, which is honest.
 *
 * COLUMN 5 is the Department Head's own estimate, which the books do not
 * hold. What they do hold is the nearest thing: the current year's revised
 * appropriation less what has been obligated in its first semester, which is
 * what the office may still spend. It is offered as that - a figure to be
 * corrected on the paper if the office expects otherwise - and the sheet says
 * so in its note.
 *
 * ---------------------------------------------------------------------------
 * SPECIAL PURPOSE APPROPRIATIONS
 * ---------------------------------------------------------------------------
 * The manual lists the 20% Development Fund, the LDRRMF, debt service and the
 * rest under their own heading. In CFMS those are SECTORS, and the two that
 * are funding sources rather than services are known to `findSector`. A line
 * whose sector is one of those is printed under the SPA heading, named for
 * its sector, rather than among the office's ordinary objects.
 */

export interface Form2Line {
  officeId: string;
  officeName: string;
  accountCode?: string;
  accountName?: string;
  fppCode?: string;
  fppName?: string;
  sector?: string | null;
  expenseClass: string;
  amount: Centavos;
}

export interface Form2Obligation {
  obrDate: IsoDate;
  status: string;
  lines: Array<{ officeId: string; accountCode: string; amount: Centavos }>;
}

export interface Form2Balance {
  officeId: string;
  accountCode: string;
  appropriationRevised: Centavos;
}

export interface Form2Row {
  object: string;
  accountCode: string;
  pastYear: Centavos;
  firstSemester: Centavos;
  secondSemester: Centavos;
  currentTotal: Centavos;
  proposed: Centavos;
}

export interface Form2Group {
  /** Personal Services, MOOE, Financial Expenses, Capital Outlays, or the SPA's own name. */
  heading: string;
  rows: Form2Row[];
  total: Form2Row;
}

export interface Form2Office {
  officeId: string;
  officeName: string;
  groups: Form2Group[];
  spas: Form2Group[];
  total: Form2Row;
}

export interface Form2Sheet {
  budgetYear: number;
  lgu: string;
  headingLines: string[];
  reference: string;
  kindLabel: string;
  offices: Form2Office[];
  grand: Form2Row;
  /** Not yet approved: printed with the band that says so. */
  prepared: boolean;
}

const CLASS_HEADINGS: Array<[string, string]> = [
  ['PS', 'Personal Services'],
  ['MOOE', 'Maintenance and Other Operating Expenses'],
  ['FE', 'Financial Expenses'],
  ['CO', 'Capital Outlays'],
];

const zero = (object: string, accountCode = ''): Form2Row => ({
  object,
  accountCode,
  pastYear: 0,
  firstSemester: 0,
  secondSemester: 0,
  currentTotal: 0,
  proposed: 0,
});

const add = (into: Form2Row, r: Form2Row) => {
  into.pastYear += r.pastYear;
  into.firstSemester += r.firstSemester;
  into.secondSemester += r.secondSemester;
  into.currentTotal += r.currentTotal;
  into.proposed += r.proposed;
};

const objectOf = (l: Form2Line): string => {
  if (l.accountCode && l.accountName) return l.accountName;
  return l.fppName || l.fppCode || l.accountCode || '';
};

/** January to June of a year, inclusive. */
export const inFirstSemester = (date: string, year: number): boolean =>
  date >= `${year}-01-01` && date <= `${year}-06-30`;

function obligatedByKey(
  obligations: Form2Obligation[],
  within: (date: string) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of obligations) {
    if (!COMMITTED.has(o.status) || !within(o.obrDate)) continue;
    for (const l of o.lines) {
      const k = `${l.officeId}__${l.accountCode}`;
      out.set(k, (out.get(k) ?? 0) + l.amount);
    }
  }
  return out;
}

export function buildLbpForm2(input: {
  budgetYear: number;
  lgu: string;
  headingLines: string[];
  reference: string;
  kindLabel: string;
  prepared: boolean;
  /** The ordinance's lines - column 7. Negative lines (a realignment's source) are left out. */
  lines: Form2Line[];
  /** Obligations of the PAST year (budget year - 2). */
  pastYear: Form2Obligation[];
  /** Obligations of the CURRENT year (budget year - 1). */
  currentYear: Form2Obligation[];
  /** The current year's balances, for column 5. */
  currentBalances: Form2Balance[];
}): Form2Sheet {
  const past = obligatedByKey(input.pastYear, () => true);
  const first = obligatedByKey(input.currentYear, (d) => inFirstSemester(d, input.budgetYear - 1));
  const revised = new Map(
    input.currentBalances.map((b) => [`${b.officeId}__${b.accountCode}`, b.appropriationRevised]),
  );

  const offices = new Map<string, Form2Office>();
  for (const l of input.lines) {
    if (l.amount <= 0) continue;
    const office =
      offices.get(l.officeId) ??
      ({
        officeId: l.officeId,
        officeName: l.officeName,
        groups: CLASS_HEADINGS.map(([, heading]) => ({ heading, rows: [], total: zero('Total') })),
        spas: [],
        total: zero('Total Appropriations'),
      } satisfies Form2Office);
    offices.set(l.officeId, office);

    const sector = findSector(l.sector);
    const spa = sector?.fundingSource ? sector.name : null;
    const classIndex = Math.max(
      0,
      CLASS_HEADINGS.findIndex(([code]) => code === l.expenseClass),
    );
    let group: Form2Group;
    if (spa) {
      group =
        office.spas.find((g) => g.heading === spa) ??
        (() => {
          const g = { heading: spa, rows: [], total: zero('Subtotal') };
          office.spas.push(g);
          return g;
        })();
    } else {
      group = office.groups[classIndex];
    }

    const code = l.accountCode ?? '';
    const key = `${l.officeId}__${code}`;
    const object = objectOf(l);
    let row = group.rows.find((r) => r.accountCode === code && r.object === object);
    if (!row) {
      row = zero(object, code);
      /*
       * Columns 3 to 5 are read once per object, when the row is made, so two
       * lines of the ordinance on the same object do not count the history
       * twice.
       */
      row.pastYear = past.get(key) ?? 0;
      row.firstSemester = first.get(key) ?? 0;
      /*
       * Columns 5 and 6 are left BLANK (patch 129, Neil). The second
       * semester is an estimate the Department Head makes, and the total
       * cannot be added up without it - so both are written in by hand.
       */
      row.secondSemester = 0;
      row.currentTotal = 0;
      void revised;
      group.rows.push(row);
    }
    row.proposed += l.amount;
  }

  const grand = zero('Total Appropriations');
  const list = [...offices.values()]
    .sort((a, b) => a.officeName.localeCompare(b.officeName))
    .map((office) => {
      for (const g of [...office.groups, ...office.spas]) {
        g.rows.sort(
          (a, b) => a.accountCode.localeCompare(b.accountCode) || a.object.localeCompare(b.object),
        );
        g.total = zero(g.total.object);
        for (const r of g.rows) add(g.total, r);
        add(office.total, g.total);
      }
      add(grand, office.total);
      return office;
    });

  return {
    budgetYear: input.budgetYear,
    lgu: input.lgu,
    headingLines: input.headingLines,
    reference: input.reference,
    kindLabel: input.kindLabel,
    offices: list,
    grand,
    prepared: input.prepared,
  };
}
