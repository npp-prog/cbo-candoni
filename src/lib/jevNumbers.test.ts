import { describe, it, expect } from 'vitest';
import { UNNUMBERED_JEV, hasJevNumber } from './jevNumbers';

describe('hasJevNumber', () => {
  it('recognises a real journal number', () => {
    expect(hasJevNumber('100-26-03-0147')).toBe(true);
  });

  it('does not mistake the placeholder for a number', () => {
    // The case that matters: if this returned true, the engine would skip
    // issuing a number at posting and every ledger line would carry the word
    // "(unnumbered)" in its JEV No. column.
    expect(hasJevNumber(UNNUMBERED_JEV)).toBe(false);
    expect(hasJevNumber('  (unnumbered)  ')).toBe(false);
  });

  it('treats an absent or blank value as no number', () => {
    expect(hasJevNumber(undefined)).toBe(false);
    expect(hasJevNumber(null)).toBe(false);
    expect(hasJevNumber('')).toBe(false);
    expect(hasJevNumber('   ')).toBe(false);
  });
});
