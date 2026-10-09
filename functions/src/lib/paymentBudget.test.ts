import { describe, it, expect } from 'vitest';
import { obligationStatusFor, isTrustFund } from './paymentBudget';

/** Patch 121: an obligation's status follows its vouchered and paid figures. */
describe('obligationStatusFor', () => {
  it('is OBLIGATED until a voucher covers it, WITH_DV until an instrument pays it, then PAID', () => {
    expect(obligationStatusFor('OBLIGATED', 100_00, 0, 0)).toBe('OBLIGATED');
    expect(obligationStatusFor('OBLIGATED', 100_00, 40_00, 0)).toBe('OBLIGATED');
    expect(obligationStatusFor('OBLIGATED', 100_00, 100_00, 0)).toBe('WITH_DV');
    expect(obligationStatusFor('WITH_DV', 100_00, 100_00, 60_00)).toBe('WITH_DV');
    expect(obligationStatusFor('WITH_DV', 100_00, 100_00, 100_00)).toBe('PAID');
  });

  it('goes back when a check is cancelled, and back again when the voucher is', () => {
    expect(obligationStatusFor('PAID', 100_00, 100_00, 0)).toBe('WITH_DV');
    expect(obligationStatusFor('WITH_DV', 100_00, 0, 0)).toBe('OBLIGATED');
  });

  it('leaves a closed or cancelled obligation alone - those are decisions, not arithmetic', () => {
    expect(obligationStatusFor('CLOSED', 100_00, 100_00, 100_00)).toBe('CLOSED');
    expect(obligationStatusFor('CANCELLED', 100_00, 0, 0)).toBe('CANCELLED');
  });

  it('never calls a zero obligation paid', () => {
    expect(obligationStatusFor('OBLIGATED', 0, 0, 0)).toBe('OBLIGATED');
  });
});

describe('isTrustFund', () => {
  it('reads TF whatever the case or spacing', () => {
    expect(isTrustFund('TF')).toBe(true);
    expect(isTrustFund(' tf ')).toBe(true);
    expect(isTrustFund('GF')).toBe(false);
    expect(isTrustFund(undefined)).toBe(false);
  });
});
