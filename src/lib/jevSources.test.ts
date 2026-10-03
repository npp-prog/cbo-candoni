import { describe, it, expect } from 'vitest';
import { DOCUMENT_SOURCED, DIRECT_ENTRY_TYPES, isDirectEntry, directEntries } from './jevSources';
import { JEV_SOURCE_TYPES } from '@/types/enums';

describe('isDirectEntry', () => {
  it('says no to an entry raised by a disbursement voucher', () => {
    expect(isDirectEntry('DV')).toBe(false);
  });

  it('says no to every entry a treasury report raises', () => {
    expect(isDirectEntry('RCI')).toBe(false);
    expect(isDirectEntry('RADAI')).toBe(false);
    expect(isDirectEntry('RCD')).toBe(false);
    expect(isDirectEntry('RCDISB')).toBe(false);
  });

  it('says yes to the entries the Accountant writes', () => {
    expect(isDirectEntry('ADJUSTING')).toBe(true);
    expect(isDirectEntry('CLOSING')).toBe(true);
    expect(isDirectEntry('REVERSING')).toBe(true);
    expect(isDirectEntry('PRIOR_PERIOD')).toBe(true);
    expect(isDirectEntry('BANK_ADJUSTMENT')).toBe(true);
    expect(isDirectEntry('MANUAL')).toBe(true);
  });

  it('treats a source type it has never heard of as direct', () => {
    // Deliberate. An entry that turns up on a short screen somebody reads is
    // noticed; one that is filtered out of every screen is not.
    expect(isDirectEntry('SOMETHING_ADDED_NEXT_YEAR')).toBe(true);
  });

  it('treats a missing source type as direct', () => {
    expect(isDirectEntry(undefined)).toBe(true);
    expect(isDirectEntry('')).toBe(true);
  });
});

describe('the two lists together', () => {
  it('account for every source type CFMS knows of, once each', () => {
    const together = [...DOCUMENT_SOURCED, ...DIRECT_ENTRY_TYPES].sort();
    expect(together).toEqual([...JEV_SOURCE_TYPES].sort());
  });

  it('do not overlap', () => {
    for (const t of DOCUMENT_SOURCED) {
      expect(DIRECT_ENTRY_TYPES).not.toContain(t);
    }
  });
});

describe('directEntries', () => {
  it('keeps what the Accountant wrote and drops what a document raised', () => {
    const rows = [
      { id: '1', sourceType: 'DV' },
      { id: '2', sourceType: 'ADJUSTING' },
      { id: '3', sourceType: 'RCD' },
      { id: '4', sourceType: 'CLOSING' },
    ];
    expect(directEntries(rows).map((r) => r.id)).toEqual(['2', '4']);
  });

  it('leaves an empty list empty', () => {
    expect(directEntries([])).toEqual([]);
  });
});
