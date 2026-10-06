import { describe, it, expect } from 'vitest';
import { DOCUMENT_SOURCED_KINDS, isDirectEntry } from './jevSourceKinds';
import { TREASURY_REPORT_TYPES } from '@/types/enums';

/**
 * WHY THIS TEST WAS WRITTEN, AND WHEN
 *
 * Patch 91 added three treasury report types and did not add them here. The
 * list is the engine's answer to "may this posted entry's AMOUNT be
 * corrected?", and an unknown kind falls through to DIRECT - meaning editable,
 * because an entry the Accountant wrote carries nobody's figure but their own.
 *
 * So the omission would have made the journal entry of a CERTIFIED report
 * editable in Accounting: the Treasurer swears to a total, the Accountant
 * quietly posts a different one, and nothing refuses it. That is the single
 * thing the split between certifying and journalizing exists to prevent.
 *
 * Nothing caught it. The compiler could not - the list is `readonly string[]`
 * and has to be, because it is vendored into the engine and may import no
 * types. So the check is here, and it is stated as the rule rather than as a
 * list of names: every report the Treasurer certifies raises a
 * document-sourced entry.
 */
describe('which entries a document raises', () => {
  it('treats every treasury report as document-sourced', () => {
    for (const type of TREASURY_REPORT_TYPES) {
      expect(
        isDirectEntry(type),
        `${type} raises its entry from a report an officer certified. Counting it as a direct ` +
          "entry would make that entry's amount editable in Accounting.",
      ).toBe(false);
    }
  });

  it('treats the documents that raise their own entries as document-sourced', () => {
    for (const kind of ['DV', 'CHECK', 'ADA', 'PAYROLL', 'LIQUIDATION']) {
      expect(isDirectEntry(kind)).toBe(false);
    }
  });

  it('treats an entry written in Accounting as direct', () => {
    expect(isDirectEntry(null)).toBe(true);
    expect(isDirectEntry(undefined)).toBe(true);
    expect(isDirectEntry('')).toBe(true);
    expect(isDirectEntry('ADJUSTMENT')).toBe(true);
  });

  it('counts an unrecognised kind as direct rather than guessing a document', () => {
    // The conservative answer is the one that does not invent a signed
    // document behind an entry nobody has classified.
    expect(isDirectEntry('SOMETHING_NEW')).toBe(true);
  });

  it('carries no duplicates, which would hide a name being added twice', () => {
    expect(new Set(DOCUMENT_SOURCED_KINDS).size).toBe(DOCUMENT_SOURCED_KINDS.length);
  });
});
