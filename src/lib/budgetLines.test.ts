import { describe, it, expect } from 'vitest';
import {
  appropriationShapeProblems,
  appropriationApprovalProblems,
  personnelServicesNeedsObject,
  appropriationLineLabel,
} from './budgetLines';

/** A complete line appropriated by object of expenditure. */
const byObject = {
  fundCode: 'GF',
  officeId: 'office-1',
  fppCode: '50203010',
  accountCode: '50203010',
  accountName: 'Office Supplies Expenses',
  expenseClass: 'MOOE',
};

/** A complete line appropriated by programme - no object code, on purpose. */
const byProgramme = {
  fundCode: 'GF',
  officeId: 'office-1',
  fppCode: '01',
  fppName: 'Construction of Barangay Health Station, Payauan',
  accountCode: '',
  expenseClass: 'CO',
};

describe('appropriationShapeProblems', () => {
  it('passes a line appropriated by object', () => {
    expect(appropriationShapeProblems(byObject)).toEqual([]);
  });

  /**
   * THE DEFECT THIS FILE EXISTS FOR.
   *
   * Approval demanded an account code outright, so a line the ordinance made
   * to a PROJECT - where the object code is empty on purpose, and becomes
   * known only when the obligation is raised - could be saved as a draft and
   * then never approved. The refusal told the office to record it again, which
   * would produce another line it could not approve either.
   */
  it('passes a line appropriated by programme, with no object code', () => {
    expect(appropriationShapeProblems(byProgramme)).toEqual([]);
  });

  it('refuses a line appropriated to neither', () => {
    const problems = appropriationShapeProblems({
      ...byObject,
      fppCode: '',
      accountCode: '',
    });
    expect(problems).toContain('account code or budget programme');
  });

  it('treats whitespace as absent', () => {
    expect(
      appropriationShapeProblems({ ...byObject, fppCode: '   ', accountCode: '  ' }),
    ).toContain('account code or budget programme');
  });

  it('still requires the fund, the office and the expense class', () => {
    expect(appropriationShapeProblems({ ...byObject, fundCode: '' })).toContain('fund');
    expect(appropriationShapeProblems({ ...byObject, officeId: '' })).toContain('office');
    expect(appropriationShapeProblems({ ...byObject, expenseClass: '' })).toContain(
      'expense classification',
    );
  });

  /** Named all at once, so a draft wrong in two ways is corrected once. */
  it('names everything missing rather than the first thing', () => {
    expect(
      appropriationShapeProblems({
        fundCode: '',
        officeId: '',
        fppCode: '',
        accountCode: '',
        expenseClass: '',
      }),
    ).toHaveLength(4);
  });
});

describe('personnelServicesNeedsObject', () => {
  /**
   * PS is appropriated by object, always. Salaries and the rest are named in
   * the ordinance by their own object codes; there is no "Personnel Services"
   * project to appropriate to. The upload refuses a PS row without one and the
   * recording form refuses one too - approval had no opinion, which let in by
   * one door what the other two turn away.
   */
  it('refuses Personnel Services appropriated by programme', () => {
    expect(personnelServicesNeedsObject({ ...byProgramme, expenseClass: 'PS' })).toBe(true);
    expect(appropriationApprovalProblems({ ...byProgramme, expenseClass: 'PS' })).toHaveLength(1);
  });

  it('allows Personnel Services appropriated by object', () => {
    expect(personnelServicesNeedsObject({ ...byObject, expenseClass: 'PS' })).toBe(false);
    expect(appropriationApprovalProblems({ ...byObject, expenseClass: 'PS' })).toEqual([]);
  });

  it('allows MOOE and CO by programme', () => {
    for (const expenseClass of ['MOOE', 'CO', 'FE']) {
      expect(
        appropriationApprovalProblems({ ...byProgramme, expenseClass }),
        expenseClass,
      ).toEqual([]);
    }
  });
});

describe('appropriationLineLabel', () => {
  /**
   * Four sentences used to be built as `accountCode + accountName`, and on a
   * by-programme line they came out with a hole in them: "available against
   * for Office of the Municipal Mayor". That is in the confirmation dialog for
   * an act that cannot be undone, which is the worst place for the office to
   * wonder whether the system knows what it is approving.
   */
  it('names a by-object line by its account', () => {
    expect(appropriationLineLabel(byObject)).toBe('50203010 Office Supplies Expenses');
  });

  it('names a by-programme line by its programme', () => {
    expect(appropriationLineLabel(byProgramme)).toBe(
      '01 Construction of Barangay Health Station, Payauan',
    );
  });

  it('never returns an empty string, which would leave a hole in a sentence', () => {
    expect(appropriationLineLabel({})).toBe('this budget line');
    expect(appropriationLineLabel({ accountCode: '', fppCode: '' })).toBe('this budget line');
  });

  it('copes with a code and no name, and a name and no code', () => {
    expect(appropriationLineLabel({ accountCode: '50203010' })).toBe('50203010');
    expect(appropriationLineLabel({ fppName: 'Health Station' })).toBe('Health Station');
  });
});
