import { describe, expect, it } from 'vitest';
import { employeeMirror, looseNameKey, nameKey, planNameMerge } from './names';

describe('nameKey (patch 158)', () => {
  it('reads a name the same in either order', () => {
    expect(nameKey('DELA CRUZ, Juan M.')).toBe(nameKey('Juan M. Dela Cruz'));
    expect(looseNameKey('DELA CRUZ, Juan M.')).toBe(looseNameKey('Juan Dela Cruz'));
    expect(nameKey('DELA CRUZ, Juan M.')).not.toBe(nameKey('Juan Dela Cruz'));
  });
});

describe('employeeMirror', () => {
  it('keeps the employee record in step with the Name', () => {
    const m = employeeMirror(
      {
        name: 'DELA CRUZ, Juan M.',
        payeeType: 'EMPLOYEE',
        tin: '123',
        bankAccountNumber: '999',
        employeeNumber: ' 0042 ',
        position: 'Clerk',
        employmentType: 'PERMANENT',
        address: 'not mirrored',
      },
      'p1',
    );
    expect(m.id).toBe('p1');
    expect(m.data).toMatchObject({
      id: 'p1',
      payeeId: 'p1',
      displayName: 'DELA CRUZ, Juan M.',
      tin: '123',
      bankAccountNumber: '999',
      employeeNumber: '0042',
      position: 'Clerk',
      employmentType: 'PERMANENT',
      active: true,
    });
    expect(m.data.address).toBeUndefined();
  });

  it('does not blank what the employee record holds', () => {
    const m = employeeMirror({ name: 'X', tin: '', bankAccountNumber: '  ' }, 'p1');
    expect('tin' in m.data).toBe(false);
    expect('bankAccountNumber' in m.data).toBe(false);
  });

  it('writes to the employee record the Name is already tied to', () => {
    expect(employeeMirror({ name: 'X', employeeId: 'e9' }, 'p1').id).toBe('e9');
  });
});

describe('planNameMerge', () => {
  const payees = [
    { id: 'p1', name: 'Juan M. Dela Cruz', payeeType: 'EMPLOYEE' },
    { id: 'p2', name: 'Negros Hardware', payeeType: 'SUPPLIER' },
    { id: 'p3', name: 'Ana Reyes', payeeType: 'EMPLOYEE', employeeId: 'e3' },
  ];

  it('ties an employee to the payee of the same name', () => {
    const plan = planNameMerge(payees, [
      { id: 'e1', displayName: 'DELA CRUZ, Juan M.', firstName: 'Juan', lastName: 'Dela Cruz' },
    ]);
    expect(plan.links).toEqual([{ payeeId: 'p1', employeeId: 'e1' }]);
    expect(plan.creates).toEqual([]);
  });

  it('makes a Name for an employee not on the list, with the same id', () => {
    const plan = planNameMerge(payees, [
      {
        id: 'e2',
        displayName: 'SANTOS, Maria',
        employeeNumber: '7',
        employmentType: 'CASUAL',
        tin: '55',
      },
    ]);
    expect(plan.links).toEqual([]);
    expect(plan.creates[0].name).toMatchObject({
      id: 'e2',
      name: 'SANTOS, Maria',
      payeeType: 'EMPLOYEE',
      employeeId: 'e2',
      employeeNumber: '7',
      employmentType: 'CASUAL',
      tin: '55',
    });
  });

  it('leaves alone an employee already tied to a Name', () => {
    expect(planNameMerge(payees, [{ id: 'e3', displayName: 'REYES, Ana' }])).toEqual({
      links: [],
      creates: [],
    });
  });

  it('does not guess between two payees of the same name', () => {
    const plan = planNameMerge(
      [
        { id: 'a', name: 'Juan Cruz' },
        { id: 'b', name: 'JUAN CRUZ' },
      ],
      [{ id: 'e', displayName: 'CRUZ, Juan' }],
    );
    expect(plan.links).toEqual([]);
    expect(plan.creates).toHaveLength(1);
  });
});
