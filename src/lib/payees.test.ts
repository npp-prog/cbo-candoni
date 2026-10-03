import { describe, it, expect } from 'vitest';
import {
  normalisePayeeName,
  normaliseTin,
  findPayeeDuplicates,
  missingPayeeFields,
  PAYEE_CREATOR_ROLES,
} from './payees';

const PAYEES = [
  { id: 'p1', name: 'ABC Trading', tin: '123-456-789-000', payeeType: 'SUPPLIER' },
  { id: 'p2', name: 'Candoni Agri Corporation', tin: '999-888-777-000', payeeType: 'SUPPLIER' },
  { id: 'p3', name: 'Barangay Payauan', payeeType: 'BARANGAY' },
];

describe('normalisePayeeName', () => {
  it('ignores case, punctuation and stray spacing', () => {
    expect(normalisePayeeName('  A.B.C.  Trading ')).toBe('a b c trading');
    expect(normalisePayeeName('ABC Trading')).toBe('abc trading');
  });

  it('does not strip a corporate suffix', () => {
    // Two entities, two TINs. Merging them would pay one supplier under
    // another's record, which is worse than keeping a duplicate.
    expect(normalisePayeeName('Candoni Agri')).not.toBe(
      normalisePayeeName('Candoni Agri Corporation'),
    );
  });
});

describe('normaliseTin', () => {
  it('compares digits only', () => {
    expect(normaliseTin('123-456-789-000')).toBe('123456789000');
    expect(normaliseTin('123 456 789 000')).toBe('123456789000');
  });
});

describe('findPayeeDuplicates', () => {
  it('finds the same name typed differently', () => {
    const found = findPayeeDuplicates({ name: 'abc  trading' }, PAYEES);

    expect(found).toHaveLength(1);
    expect(found[0].payee.id).toBe('p1');
    expect(found[0].matchedOn).toBe('NAME');
  });

  it('finds a payee by TIN even under a different name', () => {
    const found = findPayeeDuplicates(
      { name: 'ABC Trdg', tin: '123456789000' },
      PAYEES,
    );

    expect(found).toHaveLength(1);
    expect(found[0].payee.id).toBe('p1');
    expect(found[0].matchedOn).toBe('TIN');
  });

  it('reports a payee once, on the stronger signal', () => {
    const found = findPayeeDuplicates(
      { name: 'ABC Trading', tin: '123-456-789-000' },
      PAYEES,
    );

    expect(found).toHaveLength(1);
    expect(found[0].matchedOn).toBe('TIN');
  });

  it('says nothing about a genuinely new payee', () => {
    expect(findPayeeDuplicates({ name: 'Negros Hardware', tin: '111' }, PAYEES)).toEqual([]);
  });

  it('does not treat a blank TIN as a match against payees with no TIN', () => {
    // Barangay Payauan has no TIN on file. A new payee with no TIN must not
    // match it, or every untinned payee would look like a duplicate of every
    // other one.
    const found = findPayeeDuplicates({ name: 'Barangay Cabia-an', tin: '' }, PAYEES);

    expect(found).toEqual([]);
  });

  it('matches a payee that has no TIN on its name alone', () => {
    const found = findPayeeDuplicates({ name: 'barangay payauan' }, PAYEES);

    expect(found).toHaveLength(1);
    expect(found[0].payee.id).toBe('p3');
  });
});

describe('missingPayeeFields', () => {
  it('names what is missing, in the words on the form', () => {
    expect(missingPayeeFields({ name: '   ', payeeType: '' })).toEqual(['Name', 'Type']);
    expect(missingPayeeFields({ name: 'ABC', payeeType: 'SUPPLIER' })).toEqual([]);
  });
});

describe('PAYEE_CREATOR_ROLES', () => {
  it('includes the encoders, not only the master data writers', () => {
    // The security rules allow these three deliberately: an encoder meets a
    // new supplier before anybody else does. If this list and the rules ever
    // disagree, the button appears and the save is refused - which is why
    // check-rules compares them.
    expect(PAYEE_CREATOR_ROLES).toContain('ACCOUNTING_ENCODER');
    expect(PAYEE_CREATOR_ROLES).toContain('TREASURY_STAFF');
    expect(PAYEE_CREATOR_ROLES).toContain('BUDGET_STAFF');
    expect(PAYEE_CREATOR_ROLES).toContain('SUPER_ADMIN');
  });
});
