import { describe, it, expect } from 'vitest';
import { rowsToFill } from './fitRows';

/** Patch 141: ruled rows fill one sheet, never push the form onto a second. */
describe('rowsToFill', () => {
  it('fills what is left of the sheet with whole rows', () => {
    expect(rowsToFill({ pageHeightPx: 700, contentPx: 450, rowPx: 25 })).toBe(10);
    expect(rowsToFill({ pageHeightPx: 700, contentPx: 450, rowPx: 25, safetyPx: 20 })).toBe(9);
  });

  it('adds none to a report that already fills the sheet, or runs past it', () => {
    expect(rowsToFill({ pageHeightPx: 700, contentPx: 690, rowPx: 25 })).toBe(0);
    expect(rowsToFill({ pageHeightPx: 700, contentPx: 1500, rowPx: 25 })).toBe(0);
  });

  it('adds none when nothing could be measured', () => {
    expect(rowsToFill({ pageHeightPx: 700, contentPx: 0, rowPx: 0 })).toBe(0);
  });
});
