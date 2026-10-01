import { describe, it, expect } from 'vitest';
import {
  LBE_FORM_2_NOTES,
  buildAugmentationForms,
  type AugmentationAppropriation,
} from './augmentationForm';

const line = (over: Partial<AugmentationAppropriation> = {}): AugmentationAppropriation => ({
  id: 'A1',
  kind: 'REALIGNMENT',
  instrument: 'AUGMENTATION',
  status: 'APPROVED',
  authorityReference: 'Ordinance No. 2026-04',
  authorityDate: '2026-06-18',
  officeId: 'OFF1',
  officeName: 'Municipal Engineering Office',
  accountCode: '50203010',
  accountName: 'Office Supplies Expenses',
  fppCode: '8751',
  fppName: 'Engineering Services',
  expenseClass: 'MOOE',
  amount: -120_000_00,
  particulars: 'Savings from unfilled supply requisitions',
  ...over,
});

const build = (appropriations: AugmentationAppropriation[]) =>
  buildAugmentationForms({ appropriations });

describe('what reaches the form', () => {
  it('takes an approved augmentation', () => {
    const forms = build([line(), line({ id: 'A2', amount: 120_000_00 })]);
    expect(forms).toHaveLength(1);
    expect(forms[0].from).toHaveLength(1);
    expect(forms[0].to).toHaveLength(1);
  });

  /** A draft has authorised nothing, and a cancelled one has authorised nothing any more. */
  it.each(['DRAFT', 'CANCELLED'])('leaves out a %s line', (status) => {
    expect(build([line({ status })])).toEqual([]);
  });

  /**
   * A supplemental budget moves authority under an ordinance of the
   * Sanggunian, not under the omnibus authority. It is a different act in law
   * and it is not this form.
   */
  it('leaves out a supplemental realignment', () => {
    expect(build([line({ instrument: 'SUPPLEMENTAL' })])).toEqual([]);
  });

  it('leaves out an original appropriation', () => {
    expect(build([line({ kind: 'ORIGINAL', instrument: undefined })])).toEqual([]);
  });

  it('leaves out a line left at zero', () => {
    expect(build([line({ amount: 0 })])).toEqual([]);
  });
});

describe('the two halves of the form', () => {
  /**
   * The negative half of a realignment is the savings taken; the positive half
   * is the item augmented. The form has no negative column, so both print as
   * positive amounts on their own side.
   */
  it('puts savings on the FROM side and the augmented item on the TO side', () => {
    const [form] = build([
      line({ amount: -120_000_00, accountName: 'Office Supplies Expenses' }),
      line({ id: 'A2', amount: 120_000_00, accountName: 'Fuel, Oil and Lubricants Expenses' }),
    ]);
    expect(form.from[0].objectOfExpenditure).toContain('Office Supplies');
    expect(form.from[0].amount).toBe(120_000_00);
    expect(form.to[0].objectOfExpenditure).toContain('Fuel, Oil');
    expect(form.to[0].amount).toBe(120_000_00);
  });

  /**
   * The rows do not pair off. Three sources may fund one use; what has to hold
   * is that the totals agree.
   */
  it('lets several sources fund one use', () => {
    const [form] = build([
      line({ id: 'A1', amount: -50_000_00 }),
      line({ id: 'A2', amount: -70_000_00, accountCode: '50203090' }),
      line({ id: 'A3', amount: 120_000_00, accountCode: '50203070' }),
    ]);
    expect(form.from).toHaveLength(2);
    expect(form.to).toHaveLength(1);
    expect(form.totalFrom).toBe(120_000_00);
    expect(form.totalTo).toBe(120_000_00);
    expect(form.balanced).toBe(true);
  });

  /**
   * The server refuses an unbalanced realignment, so a form that does not foot
   * means something reached the records another way. It is reported rather
   * than quietly totalled.
   */
  it('reports a form that does not foot', () => {
    const [form] = build([
      line({ amount: -120_000_00 }),
      line({ id: 'A2', amount: 100_000_00 }),
    ]);
    expect(form.balanced).toBe(false);
    expect(form.totalFrom).toBe(120_000_00);
    expect(form.totalTo).toBe(100_000_00);
  });
});

describe('the object of expenditure', () => {
  it('prints the object code and its name where the ordinance carried one', () => {
    expect(build([line()])[0].from[0].objectOfExpenditure).toBe(
      '50203010 - Office Supplies Expenses',
    );
  });

  /**
   * A project line carries no object code. The project is what the ordinance
   * actually appropriated to, so printing an empty column instead would hide
   * what the savings came from.
   */
  it('falls back to the project on a line with no object code', () => {
    const [form] = build([
      line({ accountCode: '', accountName: '', fppName: 'Concreting of Barangay Road' }),
    ]);
    expect(form.from[0].objectOfExpenditure).toBe('Concreting of Barangay Road');
  });
});

describe('one form per ordinance', () => {
  it('splits lines authorised by different ordinances', () => {
    const forms = build([
      line({ authorityReference: 'Ordinance No. 2026-04' }),
      line({ id: 'A2', amount: 120_000_00, authorityReference: 'Ordinance No. 2026-04' }),
      line({ id: 'A3', authorityReference: 'Ordinance No. 2026-09' }),
      line({ id: 'A4', amount: 120_000_00, authorityReference: 'Ordinance No. 2026-09' }),
    ]);
    expect(forms.map((f) => f.ordinanceNo)).toEqual([
      'Ordinance No. 2026-04',
      'Ordinance No. 2026-09',
    ]);
  });

  /**
   * Note 3 says an ordinance is needed unless the General Provisions already
   * carry the authority. A blank reference leaves exactly that unanswered, so
   * it gets a form of its own and is marked, rather than being spread across
   * the others or dropped.
   */
  it('gathers lines with no ordinance into a form of their own, marked', () => {
    const forms = build([
      line({ authorityReference: 'Ordinance No. 2026-04' }),
      line({ id: 'A2', amount: 120_000_00, authorityReference: 'Ordinance No. 2026-04' }),
      line({ id: 'A3', authorityReference: '' }),
      line({ id: 'A4', amount: 120_000_00, authorityReference: undefined }),
    ]);
    expect(forms).toHaveLength(2);
    const blank = forms.find((f) => f.ordinanceMissing)!;
    expect(blank.from).toHaveLength(1);
    expect(blank.to).toHaveLength(1);
  });

  it('puts the form with no ordinance last, where it is not buried', () => {
    const forms = build([
      line({ id: 'A1', authorityReference: '' }),
      line({ id: 'A2', authorityReference: 'Ordinance No. 2026-01' }),
    ]);
    expect(forms[forms.length - 1].ordinanceMissing).toBe(true);
  });

  it('carries the ordinance date onto the form', () => {
    expect(build([line()])[0].authorityDate).toBe('2026-06-18');
  });
});

describe('the notes printed under the form', () => {
  it('reproduces all three from the manual', () => {
    expect(LBE_FORM_2_NOTES).toHaveLength(3);
  });

  /**
   * The second note is the one CFMS used to enforce only half of, so it is
   * pinned verbatim: if the wording is ever softened here, the form would stop
   * telling the officer the rule the system now refuses on.
   */
  it('keeps the Capital Outlay prohibition in the wording of the manual', () => {
    expect(LBE_FORM_2_NOTES[1]).toContain(
      'Savings from CO cannot be used for augmentation purposes.',
    );
  });
});
