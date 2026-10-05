import { describe, it, expect } from 'vitest';
import { programDocId, programCodeSlug } from './budgetPrograms';

describe('programDocId', () => {
  /*
   * The whole reason the year is in the id. While it was the code alone,
   * uploading the FY2027 ordinance overwrote the FY2026 programme of the same
   * code - the name changed underneath last year's appropriations and nothing
   * anywhere said so.
   */
  it('keeps the same code in two years as two records', () => {
    expect(programDocId(2026, '8711')).not.toBe(programDocId(2027, '8711'));
    expect(programDocId(2026, '8711')).toBe('2026__8711');
  });

  /*
   * The other half: loading the same ordinance twice has to update the
   * programme rather than make a second copy of it.
   */
  it('is stable for the same code in the same year', () => {
    expect(programDocId(2026, '8711')).toBe(programDocId(2026, '8711'));
    expect(programDocId(2026, ' 8711 ')).toBe(programDocId(2026, '8711'));
  });

  /*
   * A difference in case is a typing accident, never a different programme.
   * Two records under one code is how an appropriation ends up matched to
   * whichever the picker happened to show.
   */
  it('does not let case make a second programme', () => {
    expect(programDocId(2026, '8711A')).toBe(programDocId(2026, '8711a'));
  });

  it('survives the punctuation an annex actually uses', () => {
    expect(programCodeSlug('8711-01')).toBe('8711-01');
    expect(programCodeSlug('1000 Gen. Admin.')).toBe('1000-gen-admin');
    // Firestore forbids a slash in a document id outright.
    expect(programCodeSlug('8711/01')).toBe('8711-01');
  });

  it('leaves no leading or trailing separator', () => {
    expect(programCodeSlug('  .8711.  ')).toBe('8711');
  });
});
