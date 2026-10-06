import { describe, it, expect } from 'vitest';
import { entityFrom } from './entity';

/**
 * The heading on every prescribed COA form.
 *
 * Until patch 89 it was written out in two components, in two different and
 * both wrong forms. It comes from Settings now, and what these guard is the
 * half-filled Settings record - which is the normal state of a settings screen
 * somebody has been into once.
 */
describe('entityFrom', () => {
  it('uses the municipality’s own heading before anybody has set one', () => {
    expect(entityFrom(null).headingLines).toEqual([
      'Republic of the Philippines',
      'MUNICIPAL GOVERNMENT OF CANDONI',
      'Municipal Building, Rizal St., Candoni, Negros Occidental, 6110',
    ]);
  });

  it('takes what Settings says', () => {
    expect(
      entityFrom({ entityName: 'CITY GOVERNMENT OF X', address: '1 Main St' }).headingLines,
    ).toEqual(['Republic of the Philippines', 'CITY GOVERNMENT OF X', '1 Main St']);
  });

  /*
   * The case that matters. A blank or whitespace-only box would otherwise
   * print an empty line where the entity's name goes, and a COA form with no
   * entity name on it is not a form.
   */
  it('falls back rather than printing an empty line', () => {
    const blank = entityFrom({ entityName: '', address: '   ' });
    expect(blank.headingLines[1]).toBe('MUNICIPAL GOVERNMENT OF CANDONI');
    expect(blank.headingLines[2]).toContain('Rizal St.');
  });

  it('never lets the first line be changed', () => {
    expect(entityFrom({ entityName: 'X' }).headingLines[0]).toBe('Republic of the Philippines');
  });

  /*
   * An official nobody has named prints blank, deliberately. A signature line
   * is signed by hand anyway, and an empty printed name says "nobody has told
   * CFMS" rather than naming the wrong person after an election.
   */
  it('leaves an unnamed official blank but keeps the designation', () => {
    const e = entityFrom({});
    expect(e.localTreasurer).toEqual({ name: '', position: 'Local Treasurer' });
    expect(e.municipalMayor.position).toBe('Municipal Mayor');
  });

  it('takes an official from Settings when there is one', () => {
    const e = entityFrom({
      officials: { localTreasurer: { name: 'A. Santos', position: 'Local Treasurer' } },
    });
    expect(e.localTreasurer.name).toBe('A. Santos');
    expect(e.municipalMayor.name).toBe('');
  });
});
