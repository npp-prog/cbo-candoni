import { describe, it, expect } from 'vitest';
import {
  FPP_CODES,
  FPP_SECTORS,
  checkFppCode,
  findFpp,
  fppLabel,
  fppSectorOf,
  searchFpp,
} from './fppCodes';

/**
 * These tests guard a transcription.
 *
 * The list in fppCodes.ts was copied out of Annex A of the GAM for LGUs
 * Volume III. Nothing in CFMS can tell whether a code was mistyped on the way
 * in - a wrong digit still looks like a code, still sorts, still prints. It
 * would surface months later as a registry that does not foot, or as an
 * expenditure reported under the wrong sector to the Department of Budget.
 *
 * So the structural rules the manual's own numbering obeys are asserted here,
 * and a sample of entries is pinned verbatim.
 */

describe('the Annex A list', () => {
  it('carries all 138 codes', () => {
    expect(FPP_CODES).toHaveLength(138);
  });

  it('gives every code exactly once', () => {
    const codes = FPP_CODES.map((f) => f.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('writes every code as four digits', () => {
    for (const f of FPP_CODES) {
      expect(f.code, f.name).toMatch(/^\d{4}$/);
    }
  });

  /**
   * The manual's numbering is not decorative: the first digit IS the sector.
   * A code filed under the wrong sector heading during transcription would
   * report that function's spending in the wrong place for the whole year,
   * and this is the one check that catches it.
   */
  it('files every code under the sector its first digit names', () => {
    for (const f of FPP_CODES) {
      expect(`${f.code[0]}000`, `${f.code} ${f.name}`).toBe(f.sector);
    }
  });

  it('names eight sectors, and no 2000', () => {
    expect(Object.keys(FPP_SECTORS)).toHaveLength(8);
    expect(FPP_SECTORS).not.toHaveProperty('2000');
  });

  it('gives every code an office heading and a name', () => {
    for (const f of FPP_CODES) {
      expect(f.office.length, f.code).toBeGreaterThan(0);
      expect(f.name.length, f.code).toBeGreaterThan(0);
    }
  });

  /** Pinned verbatim against the manual, one from each sector. */
  it.each([
    ['1011', 'Executive Services (Governor/Mayor)', 'General Administration'],
    ['1021', 'Legislative Services', 'Legislation'],
    ['1071', 'Budgeting Services (Budget Officer)', 'General Administration'],
    ['1081', 'Accounting Services (Accountant)', 'General Administration'],
    ['1091', 'Treasury Services (Treasurer)', 'General Administration'],
    [
      '1102',
      'Assessment of Real Property (Assessor)',
      'Real Property Tax Administration (Tax Mapping, Revision of Assessment, etc.)',
    ],
    ['1201', 'Local Disaster Risk Reduction and Management Office', 'General Administration'],
    ['3321', 'Public Education', 'Elementary Schools'],
    ['4411', 'Health Services (Health Officer)', 'General Administration'],
    ['5999', 'Miscellaneous, Labor and Employment', 'Others'],
    ['6522', 'Sanitary Services', 'Garbage Collections'],
    ['7611', 'Social Welfare Services (Social Welfare & Development Officer)', 'General Administration'],
    ['8751', 'Engineering Services', 'General Administration'],
    ['8811', 'Operation of Markets', 'General Administration'],
    ['9941', 'Disaster Risk Reduction and Management', 'Relief Recovery'],
  ])('%s is %s / %s', (code, office, name) => {
    const f = findFpp(code);
    expect(f, code).toBeDefined();
    expect(f!.office).toBe(office);
    expect(f!.name).toBe(name);
  });

  /**
   * The reason `office` is carried at all. Nineteen entries share the name
   * "General Administration"; without the heading the picker would show
   * nineteen identical rows.
   */
  it('has many functions sharing one name, told apart only by the office', () => {
    const general = FPP_CODES.filter((f) => f.name === 'General Administration');
    expect(general.length).toBeGreaterThan(10);
    expect(new Set(general.map((f) => f.office)).size).toBe(general.length);
  });
});

describe('fppSectorOf', () => {
  it('reads the sector off the first digit', () => {
    expect(fppSectorOf('8751')).toBe('8000');
    expect(fppSectorOf('1011')).toBe('1000');
  });

  /**
   * Deliberate: a code the GAM does not list still belongs to a sector. The
   * municipality may run a function Annex A has no entry for, and its
   * spending still has to be reported somewhere.
   */
  it('places a code that is not in Annex A', () => {
    expect(findFpp('8765')).toBeUndefined();
    expect(fppSectorOf('8765')).toBe('8000');
  });

  it('refuses what is not a four-digit code', () => {
    expect(fppSectorOf('875')).toBeNull();
    expect(fppSectorOf('87510')).toBeNull();
    expect(fppSectorOf('87A1')).toBeNull();
    expect(fppSectorOf('')).toBeNull();
  });

  it('refuses the sector the GAM does not use', () => {
    expect(fppSectorOf('2011')).toBeNull();
  });
});

describe('fppLabel', () => {
  it('writes both halves, so two General Administrations are not one', () => {
    expect(fppLabel('1081')).toBe('1081 - Accounting Services (Accountant): General Administration');
    expect(fppLabel('1091')).toBe('1091 - Treasury Services (Treasurer): General Administration');
  });

  it('gives back an unknown code unchanged rather than inventing a name', () => {
    expect(fppLabel('8765')).toBe('8765');
  });
});

describe('searchFpp', () => {
  it('finds by code', () => {
    expect(searchFpp('8751').map((f) => f.code)).toContain('8751');
  });

  it('finds by the office, which is where the user starts', () => {
    const hits = searchFpp('treasur');
    expect(hits.map((f) => f.code)).toContain('1091');
  });

  it('finds by the function name', () => {
    expect(searchFpp('garbage').map((f) => f.code)).toEqual(['6522']);
  });

  it('is not case sensitive', () => {
    expect(searchFpp('ENGINEERING').map((f) => f.code)).toContain('8751');
  });

  it('returns the head of the list for an empty query', () => {
    expect(searchFpp('')[0].code).toBe('1011');
  });

  it('honours the limit', () => {
    expect(searchFpp('', 5)).toHaveLength(5);
  });
});

describe('checkFppCode', () => {
  it('passes a code from Annex A', () => {
    expect(checkFppCode('8751').ok).toBe(true);
  });

  it('refuses a missing code', () => {
    expect(checkFppCode('').violations[0].code).toBe('FPP_MISSING');
  });

  it('refuses what is not four digits', () => {
    expect(checkFppCode('875').violations[0].code).toBe('FPP_NOT_FOUR_DIGITS');
  });

  it('refuses a sector the GAM does not have', () => {
    expect(checkFppCode('2011').violations[0].code).toBe('FPP_NO_SECTOR');
  });

  /**
   * A warning, not a rejection - and the distinction matters. Refusing would
   * stop an appropriation ordinance being recorded because of a code the
   * manual happens not to list. Saying nothing would let it through unseen.
   */
  it('warns about a code outside Annex A without refusing it', () => {
    const r = checkFppCode('8765');
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('FPP_NOT_IN_ANNEX_A');
    expect(r.violations[0].message).toContain('Economic Services');
  });
});
