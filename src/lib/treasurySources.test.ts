import { describe, it, expect } from 'vitest';
import {
  TREASURY_SOURCE_COLLECTION,
  TREASURY_SOURCE_REPORT_FIELD,
  sourceCollectionFor,
} from './treasurySources';
import { TREASURY_REPORT_TYPES } from '@/types/enums';
import { COL } from './collections';

/**
 * The mapping the engine and the screen both read.
 *
 * It is vendored into the functions build, so the two copies cannot differ -
 * `npm run verify` fails on drift. What these tests cover is the other half:
 * that the one copy is complete, and that the plain strings in it are the same
 * strings the rest of the application calls those registers by.
 */
describe('TREASURY_SOURCE_COLLECTION', () => {
  /**
   * The one that fails when a seventh report type arrives.
   *
   * A type with no source register is not a cosmetic gap. The engine claims
   * each covered document when the report is certified and releases it when the
   * report is withdrawn; a type it cannot resolve either throws at the worst
   * moment or - worse - claims nothing and leaves the documents free to be
   * reported a second time.
   */
  it('names a register for every treasury report type', () => {
    for (const type of TREASURY_REPORT_TYPES) {
      expect(sourceCollectionFor(type), `${type} has no source register`).toBeTruthy();
    }
    expect(Object.keys(TREASURY_SOURCE_COLLECTION).sort()).toEqual([...TREASURY_REPORT_TYPES].sort());
  });

  /**
   * The strings are written out rather than imported, because the file is
   * copied into the engine and must import nothing. That is a real risk of a
   * typo nobody would see - a wrong name reads an empty collection rather than
   * failing - so it is checked against the names the rest of CFMS uses.
   */
  it('uses the same register names as the rest of the application', () => {
    expect(TREASURY_SOURCE_COLLECTION.RCI).toBe(COL.checks);
    expect(TREASURY_SOURCE_COLLECTION.RADAI).toBe(COL.ada);
    expect(TREASURY_SOURCE_COLLECTION.RCD).toBe(COL.collections);
    expect(TREASURY_SOURCE_COLLECTION.RCDISB).toBe(COL.payrolls);
    expect(TREASURY_SOURCE_COLLECTION.ERCD_AR).toBe(COL.collections);
    expect(TREASURY_SOURCE_COLLECTION.ERCD_EOR).toBe(COL.collections);
  });

  it('puts all three collection reports on one register', () => {
    // An e-collection is an ordinary collections document carrying a kind.
    // What divides the pile is eCollections.ts; this only says which pile.
    expect(TREASURY_SOURCE_COLLECTION.ERCD_AR).toBe(TREASURY_SOURCE_COLLECTION.RCD);
    expect(TREASURY_SOURCE_COLLECTION.ERCD_EOR).toBe(TREASURY_SOURCE_COLLECTION.RCD);
  });

  it('returns null for a type it does not know, rather than throwing', () => {
    // The screen leaves such a line unclickable. Throwing here would unmount
    // the report page over a row nobody could open anyway.
    expect(sourceCollectionFor('RAAF')).toBeNull();
    expect(sourceCollectionFor('')).toBeNull();
  });

  it('names the claim field the engine writes', () => {
    expect(TREASURY_SOURCE_REPORT_FIELD).toBe('treasuryReportId');
  });
});
