import type { Centavos, IsoDate } from '@/types/common';

/**
 * The Augmentation Form, LBE Form No. 2.
 *
 * Budget Operations Manual for LGUs, 2023 edition, page 186, "revised as of
 * reprinting for FY 2024". The form the municipality already fills in by hand.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, WHICH IS NOT LIKE ANY OTHER FORM IN CFMS
 * ---------------------------------------------------------------------------
 * Two halves side by side, not one list:
 *
 *   Sources of Funds - FROM        |  Uses of Funds - TO
 *   (1) Object of Expenditures     |  (4) Object of Expenditures
 *   (2) Expense Class              |  (5) Expense Class
 *   (3) Amount                     |  (6) Amount
 *   TOTAL                          |  TOTAL
 *
 * The rows do NOT pair off. Three lines of savings may fund one augmented
 * item, or the other way about; what has to hold is that the two totals are
 * equal. So this produces two independent lists and the totals beside them,
 * rather than trying to zip them into rows.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE TWO SIDES COME FROM
 * ---------------------------------------------------------------------------
 * CFMS already records an augmentation: it is an appropriation of kind
 * REALIGNMENT whose instrument is AUGMENTATION, and a realignment is stored as
 * lines of equal magnitude and opposite sign. The negative half is the savings
 * taken - the FROM - and the positive half is the item augmented - the TO.
 *
 * One form per ordinance, because that is what the form's own header says:
 * "Ordinance No.: ______". Lines carrying no ordinance reference are gathered
 * into a form of their own and marked, rather than being spread silently
 * across the others or dropped - Note 3 says an ordinance is needed unless the
 * General Provisions already carry the authority, and which of those applies
 * is exactly what a blank reference leaves unanswered.
 */

/** Only an approved augmentation is on a form. A draft has authorised nothing. */
export const ON_THE_FORM = new Set(['APPROVED']);

export interface AugmentationAppropriation {
  id: string;
  kind: string;
  instrument?: string;
  status: string;
  authorityReference?: string;
  authorityDate?: IsoDate;
  officeId: string;
  officeName: string;
  accountCode: string;
  accountName: string;
  fppCode: string;
  fppName: string;
  expenseClass: string;
  /** Negative on the savings side, positive on the augmented side. */
  amount: Centavos;
  particulars?: string;
}

export interface AugmentationRow {
  /** Column 1 and 4: the object of expenditure, as the ordinance names it. */
  objectOfExpenditure: string;
  accountCode: string;
  /** Carried for the reader, not on the printed form: which office it sits in. */
  officeName: string;
  /** Column 2 and 5. */
  expenseClass: string;
  /** Column 3 and 6, always positive - the form has no negative column. */
  amount: Centavos;
  particulars: string;
}

export interface AugmentationFormData {
  /** The ordinance authorising the use of savings, or '' where none was given. */
  ordinanceNo: string;
  authorityDate?: IsoDate;
  from: AugmentationRow[];
  to: AugmentationRow[];
  totalFrom: Centavos;
  totalTo: Centavos;
  /**
   * True when the two totals agree, which they must: an augmentation neither
   * creates nor destroys authority. The server refuses an unbalanced set, so a
   * form that does not foot means something reached the records another way.
   */
  balanced: boolean;
  /** Set when the lines carried no ordinance number at all. */
  ordinanceMissing: boolean;
}

/**
 * The object of expenditure as the form wants it.
 *
 * The ordinance names an object code on most lines and a project on the rest.
 * Where there is an object code it is the object of expenditure and the form
 * says so; where there is not, the project name is what the ordinance actually
 * appropriated to, and printing an empty column instead would hide it.
 */
function objectOf(a: AugmentationAppropriation): string {
  if (a.accountCode && a.accountName) return `${a.accountCode} - ${a.accountName}`;
  if (a.accountName) return a.accountName;
  return a.fppName || a.fppCode || '';
}

export function buildAugmentationForms(input: {
  appropriations: AugmentationAppropriation[];
}): AugmentationFormData[] {
  const byOrdinance = new Map<string, AugmentationFormData>();

  for (const a of input.appropriations) {
    if (a.kind !== 'REALIGNMENT') continue;
    if (a.instrument !== 'AUGMENTATION') continue;
    if (!ON_THE_FORM.has(a.status)) continue;
    if (a.amount === 0) continue;

    const ordinanceNo = (a.authorityReference ?? '').trim();
    const form =
      byOrdinance.get(ordinanceNo) ??
      ({
        ordinanceNo,
        authorityDate: a.authorityDate,
        from: [],
        to: [],
        totalFrom: 0,
        totalTo: 0,
        balanced: true,
        ordinanceMissing: ordinanceNo === '',
      } satisfies AugmentationFormData);

    if (!form.authorityDate && a.authorityDate) form.authorityDate = a.authorityDate;

    const row: AugmentationRow = {
      objectOfExpenditure: objectOf(a),
      accountCode: a.accountCode,
      officeName: a.officeName,
      expenseClass: a.expenseClass,
      amount: Math.abs(a.amount),
      particulars: a.particulars ?? '',
    };

    if (a.amount < 0) {
      form.from.push(row);
      form.totalFrom += row.amount;
    } else {
      form.to.push(row);
      form.totalTo += row.amount;
    }
    byOrdinance.set(ordinanceNo, form);
  }

  const sortRows = (rows: AugmentationRow[]) =>
    [...rows].sort(
      (a, b) =>
        a.officeName.localeCompare(b.officeName) ||
        a.expenseClass.localeCompare(b.expenseClass) ||
        a.objectOfExpenditure.localeCompare(b.objectOfExpenditure),
    );

  return [...byOrdinance.values()]
    .map((f) => ({
      ...f,
      from: sortRows(f.from),
      to: sortRows(f.to),
      balanced: f.totalFrom === f.totalTo,
    }))
    .sort((a, b) => {
      // The form with no ordinance last: it is the one needing attention, and
      // burying it among the others is how it stops being noticed.
      if (a.ordinanceMissing !== b.ordinanceMissing) return a.ordinanceMissing ? 1 : -1;
      return a.ordinanceNo.localeCompare(b.ordinanceNo);
    });
}

/**
 * The three notes the manual prints under the form.
 *
 * Reproduced rather than paraphrased. Two of them are rules CFMS enforces and
 * the third is one it cannot, and the officer signing the form is entitled to
 * read what the manual actually says rather than a summary of it.
 */
export const LBE_FORM_2_NOTES = [
  'Savings can augment only existing items of appropriation in the Appropriation Ordinance.',
  'Savings can augment only items of appropriation in the same expense (e.g., PS to PS and MOOE to MOOE). Savings from CO cannot be used for augmentation purposes.',
  'An ordinance is needed to authorize the augmentation unless provision of the same is already reflected in the General Provisions of the Appropriation Ordinance covering the annual budget of the LGU.',
];
