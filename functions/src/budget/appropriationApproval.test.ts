import { describe, it, expect } from 'vitest';
import { appropriationField, planAppropriationApproval } from './appropriationApproval';

const zero = { appropriationRevised: 0, allotmentReleased: 0 };

describe('planAppropriationApproval', () => {
  /**
   * The fault this exists to prevent: two rows of one ordinance on the same
   * budget line. Approved one after another in one transaction, the second
   * write would replace the first and 30,000 would vanish from the budget.
   */
  it('sums two lines on the same budget line before anything is written', () => {
    const plan = planAppropriationApproval(
      [
        {
          id: 'a',
          keyId: 'K',
          kind: 'ORIGINAL',
          amount: 100_000_00,
          label: 'Supplies',
        },
        {
          id: 'b',
          keyId: 'K',
          kind: 'ORIGINAL',
          amount: 30_000_00,
          label: 'Supplies',
        },
        { id: 'c', keyId: 'J', kind: 'ORIGINAL', amount: 5_00, label: 'Fuel' },
      ],
      new Map([['K', zero]]),
    );
    expect(plan.ok).toBe(true);
    expect(plan.byKey.get('K')?.delta.appropriationOriginal).toBe(130_000_00);
    expect(plan.byKey.get('K')?.lineIds).toEqual(['a', 'b']);
    expect(plan.byKey.size).toBe(2);
    expect(plan.total).toBe(130_005_00);
  });

  it('refuses an adjustment that would drive a line negative', () => {
    const plan = planAppropriationApproval(
      [
        {
          id: 'a',
          keyId: 'K',
          kind: 'ADJUSTMENT',
          amount: -60_00,
          label: 'Supplies, Mayor',
        },
      ],
      new Map([['K', { appropriationRevised: 50_00, allotmentReleased: 0 }]]),
    );
    expect(plan.ok).toBe(false);
    expect(plan.problems[0]).toMatch(/Supplies, Mayor.*cannot be negative/);
  });

  it('refuses one that would cut below the allotment already released', () => {
    const plan = planAppropriationApproval(
      [
        {
          id: 'a',
          keyId: 'K',
          kind: 'ADJUSTMENT',
          amount: -40_00,
          label: 'Supplies',
        },
      ],
      new Map([['K', { appropriationRevised: 100_00, allotmentReleased: 90_00 }]]),
    );
    expect(plan.ok).toBe(false);
    expect(plan.problems[0]).toMatch(/below the 90.00 already released/);
  });

  it('lets a negative line through when another line on it covers it', () => {
    const plan = planAppropriationApproval(
      [
        {
          id: 'a',
          keyId: 'K',
          kind: 'ADJUSTMENT',
          amount: -60_00,
          label: 'Supplies',
        },
        {
          id: 'b',
          keyId: 'K',
          kind: 'ADJUSTMENT',
          amount: 20_00,
          label: 'Supplies',
        },
      ],
      new Map([['K', { appropriationRevised: 50_00, allotmentReleased: 0 }]]),
    );
    expect(plan.ok).toBe(true);
  });
});

describe('appropriationField', () => {
  it('puts each kind in its own component of the appropriation', () => {
    expect(appropriationField('ORIGINAL')).toBe('appropriationOriginal');
    expect(appropriationField('SUPPLEMENTAL')).toBe('appropriationSupplemental');
    expect(appropriationField('CONTINUING')).toBe('appropriationContinuing');
    expect(appropriationField('ADJUSTMENT')).toBe('appropriationAdjustments');
    expect(appropriationField('REALIGNMENT')).toBe('appropriationAdjustments');
  });
});
