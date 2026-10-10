import { describe, expect, it } from 'vitest';
import { cleanAccess, levelAllows, narrowed, treasuryAreaFor } from './access';

describe('access per user (patch 169)', () => {
  it('knows which Treasury book a screen belongs to', () => {
    expect(treasuryAreaFor('/treasury/collections/rcd')).toBe('treasury.collections');
    expect(treasuryAreaFor('/treasury/checks/rci')).toBe('treasury.checks');
    expect(treasuryAreaFor('/treasury/payroll/new')).toBe('treasury.payroll');
    expect(treasuryAreaFor('/treasury/raaf')).toBe('treasury.forms');
    expect(treasuryAreaFor('/reports/abstract-of-collections')).toBe('treasury.collections');
    expect(treasuryAreaFor('/treasury/cash-in-bank')).toBeNull();
  });

  it('narrows the role: view only lets view, print and export through', () => {
    expect(levelAllows('VIEW', 'view')).toBe(true);
    expect(levelAllows('VIEW', 'create')).toBe(false);
    expect(levelAllows('HIDDEN', 'view')).toBe(false);
    expect(levelAllows(undefined, 'post')).toBe(true);
  });

  it('applies the Treasury book of the screen', () => {
    const access = { 'treasury.checks': 'HIDDEN' as const, 'treasury.payroll': 'VIEW' as const };
    expect(narrowed(true, access, 'treasury', 'view', '/treasury/checks')).toBe(false);
    expect(narrowed(true, access, 'treasury', 'view', '/treasury/payroll')).toBe(true);
    expect(narrowed(true, access, 'treasury', 'create', '/treasury/payroll/new')).toBe(false);
    expect(narrowed(true, access, 'treasury', 'create', '/treasury/collections')).toBe(true);
    // A question about another module is not answered by the screen's book...
    expect(narrowed(true, access, 'budget', 'view', '/treasury/checks')).toBe(true);
    // ...except by the route guard.
    expect(narrowed(true, access, 'reports', 'view', '/treasury/checks', true)).toBe(false);
    // Never wider than the role.
    expect(narrowed(false, {}, 'treasury', 'view')).toBe(false);
  });

  it('keeps only known keys and the narrowing levels', () => {
    expect(
      cleanAccess(
        {
          budget: 'VIEW',
          treasury: 'FULL',
          'treasury.forms': 'HIDDEN',
          root: 'HIDDEN',
          reports: 'ALL',
        },
        ['budget', 'treasury', 'reports'],
      ),
    ).toEqual({ budget: 'VIEW', 'treasury.forms': 'HIDDEN' });
  });
});
