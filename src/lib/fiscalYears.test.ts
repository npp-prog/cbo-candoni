import { describe, expect, it } from 'vitest';
import { fiscalYearList, nearestFiscalYear, nextFiscalYear } from './fiscalYears';

describe('fiscal years offered', () => {
  it('starts with 2026 and 2027 only - nothing before CFMS but its comparative year', () => {
    expect(fiscalYearList([])).toEqual([2027, 2026]);
    expect(fiscalYearList([2023, 2024, 2025])).toEqual([2027, 2026]);
  });

  it('adds the years the administrator added, newest first', () => {
    expect(fiscalYearList([2028, 2029])).toEqual([2029, 2028, 2027, 2026]);
  });

  it('offers only the year after the latest to add', () => {
    expect(nextFiscalYear([])).toBe(2028);
    expect(nextFiscalYear([2028])).toBe(2029);
  });

  it('moves a year no longer offered to the nearest one', () => {
    expect(nearestFiscalYear([2027, 2026], 2026)).toBe(2026);
    expect(nearestFiscalYear([2028, 2027, 2026], 2027)).toBe(2027);
    expect(nearestFiscalYear([2027, 2026], 2024)).toBe(2026);
  });
});
