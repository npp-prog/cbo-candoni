import type { Centavos, IsoDate } from '@/types/common';

/**
 * The Augmentation Form, LBE Form No. 2. Patch 116.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, page 186 ("revised as of
 * reprinting for FY 2024"). CFMS printed it once before - patch 47, as a
 * report of its own under Budget - and patch 61 took that screen away with
 * the menu item, at the office's request, because an augmentation is recorded
 * on the Appropriation screen and a second door to it was a door too many.
 *
 * It is back as what it actually is: the paper an augmentation is signed on.
 * Recorded on the Appropriation screen, the augmentation is printed on this
 * form for the Budget Officer, the Accountant and the Local Chief Executive to
 * sign, and is approved and posted in CFMS afterwards - the same order as a
 * prepared Allotment Release Order.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE
 * ---------------------------------------------------------------------------
 * Two halves side by side, not one list:
 *
 *   Sources of Funds - FROM        |  Uses of Funds - TO
 *   (1) Object of Expenditures     |  (4) Object of Expenditures
 *   (2) Expense Class              |  (5) Expense Class
 *   (3) Amount                     |  (6) Amount
 *   TOTAL                          |  TOTAL
 *
 * The rows do not pair off - three lines of savings may fund one augmented
 * item - so the two sides are independent lists and only their totals must
 * agree. CFMS stores an augmentation as lines of opposite sign: the negative
 * ones are the savings taken (FROM), the positive ones the items augmented
 * (TO). The form has no negative column, so both print as positive figures.
 */

export interface AugmentationLine {
  officeName: string;
  accountCode?: string;
  accountName?: string;
  fppCode?: string;
  fppName?: string;
  expenseClass: string;
  /** Negative on the savings side, positive on the augmented side. */
  amount: Centavos;
  particulars?: string | null;
}

export interface AugmentationRow {
  /** Columns 1 and 4: the object of expenditure as the ordinance names it. */
  objectOfExpenditure: string;
  /** Not a column of the form; printed small under the object, for the reader. */
  officeName: string;
  /** Columns 2 and 5. */
  expenseClass: string;
  /** Columns 3 and 6, always positive. */
  amount: Centavos;
}

export interface AugmentationSheet {
  fiscalYear: number;
  /** The Local Government Unit line. */
  lgu: string;
  /**
   * The letterhead printed under the seal - Republic, the municipality, the
   * address - from Settings, as on the other printed forms. Patch 117.
   */
  headingLines: string[];
  /** Office: Executive/Sanggunian - the form asks which. */
  office: 'Executive' | 'Sanggunian';
  /** The authority for the use of savings, as recorded. */
  ordinanceNo: string;
  authorityDate?: IsoDate;
  from: AugmentationRow[];
  to: AugmentationRow[];
  totalFrom: Centavos;
  totalTo: Centavos;
  /** The two totals agree, which they must before it can be posted. */
  balanced: boolean;
  /** Not yet posted: printed with the band that says so. */
  prepared: boolean;
  preparedBy?: string | null;
}

/**
 * The object of expenditure as the form wants it: the object code and title
 * where the ordinance named one, and otherwise the programme or project it
 * appropriated to - printing an empty column would hide what was augmented.
 */
export function objectOfExpenditure(l: AugmentationLine): string {
  if (l.accountCode && l.accountName) return `${l.accountCode} - ${l.accountName}`;
  if (l.accountName) return l.accountName;
  return l.fppName || l.fppCode || '';
}

/**
 * Whose savings these are. The form prints "Office: Executive/Sanggunian",
 * and the Sanggunian's offices - the Sangguniang Bayan and the Vice Mayor who
 * presides over it - are the only legislative ones. Every line in the set
 * belonging to one of them makes it a Sanggunian augmentation; anything else
 * is the Executive's.
 */
export function officeOf(lines: AugmentationLine[]): 'Executive' | 'Sanggunian' {
  const legislative = (name: string) => /sangguni|vice[\s-]*mayor/i.test(name);
  return lines.length > 0 && lines.every((l) => legislative(l.officeName))
    ? 'Sanggunian'
    : 'Executive';
}

const byOfficeThenObject = (a: AugmentationRow, b: AugmentationRow) =>
  a.officeName.localeCompare(b.officeName) ||
  a.expenseClass.localeCompare(b.expenseClass) ||
  a.objectOfExpenditure.localeCompare(b.objectOfExpenditure);

export function buildAugmentationSheet(input: {
  fiscalYear: number;
  lgu: string;
  headingLines?: string[];
  ordinanceNo: string;
  authorityDate?: IsoDate;
  lines: AugmentationLine[];
  prepared: boolean;
  preparedBy?: string | null;
}): AugmentationSheet {
  const from: AugmentationRow[] = [];
  const to: AugmentationRow[] = [];
  for (const l of input.lines) {
    if (!l.amount) continue;
    const row: AugmentationRow = {
      objectOfExpenditure: objectOfExpenditure(l),
      officeName: l.officeName,
      expenseClass: l.expenseClass,
      amount: Math.abs(l.amount),
    };
    (l.amount < 0 ? from : to).push(row);
  }
  const totalFrom = from.reduce((t, r) => t + r.amount, 0);
  const totalTo = to.reduce((t, r) => t + r.amount, 0);
  return {
    fiscalYear: input.fiscalYear,
    lgu: input.lgu,
    headingLines: input.headingLines ?? [],
    office: officeOf(input.lines),
    ordinanceNo: input.ordinanceNo.trim(),
    authorityDate: input.authorityDate,
    from: from.sort(byOfficeThenObject),
    to: to.sort(byOfficeThenObject),
    totalFrom,
    totalTo,
    balanced: totalFrom === totalTo && totalFrom > 0,
    prepared: input.prepared,
    preparedBy: input.preparedBy ?? null,
  };
}

/** The notes the manual prints under the form, word for word. */
export const LBE_FORM_2_NOTES = [
  'Savings can augment only existing items of appropriation in the Appropriation Ordinance.',
  'Savings can augment only items of appropriation in the same expense (e.g., PS to PS and MOOE to MOOE). Savings from CO cannot be used for augmentation purposes.',
  'An ordinance is needed to authorize the augmentation unless provision of the same is already reflected in the General Provisions of the Appropriation Ordinance covering the annual budget of the LGU.',
];
