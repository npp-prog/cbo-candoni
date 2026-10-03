import { describe, it, expect } from 'vitest';
import { allocateSequences } from './sequences';

describe('allocateSequences', () => {
  it('carries on from where each counter stands', () => {
    const { sequences, finals } = allocateSequences(
      ['dv-2026-10', 'jev-2026-10'],
      new Map([
        ['dv-2026-10', 4],
        ['jev-2026-10', 11],
      ]),
    );

    expect(sequences).toEqual([5, 12]);
    expect(finals.get('dv-2026-10')).toBe(5);
    expect(finals.get('jev-2026-10')).toBe(12);
  });

  it('starts a counter that does not exist yet at one', () => {
    const { sequences, finals } = allocateSequences(['new'], new Map());

    expect(sequences).toEqual([1]);
    expect(finals.get('new')).toBe(1);
  });

  it('NEVER issues the same number twice from one counter', () => {
    // The whole reason this function exists. Ten reserved ADA numbers draw on
    // one counter; reading it ten times would issue 8 ten times over, and a
    // duplicate accountable form number is not a cosmetic fault.
    const ids = Array.from({ length: 10 }, () => 'ada-2026-10');

    const { sequences, finals } = allocateSequences(ids, new Map([['ada-2026-10', 7]]));

    expect(sequences).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(new Set(sequences).size).toBe(10);
    expect(finals.get('ada-2026-10')).toBe(17);
  });

  it('interleaves two counters without either losing its place', () => {
    const { sequences, finals } = allocateSequences(
      ['ada', 'radai', 'ada', 'radai', 'ada', 'radai'],
      new Map([
        ['ada', 100],
        ['radai', 3],
      ]),
    );

    expect(sequences).toEqual([101, 4, 102, 5, 103, 6]);
    expect(finals.get('ada')).toBe(103);
    expect(finals.get('radai')).toBe(6);
  });

  it('skips a request without consuming a number', () => {
    // A voucher being re-approved already has its DV number. The JEV counter
    // must still advance; the DV counter must not.
    const { sequences, finals } = allocateSequences(
      [null, 'jev'],
      new Map([
        ['dv', 20],
        ['jev', 40],
      ]),
    );

    expect(sequences).toEqual([null, 41]);
    expect(finals.has('dv')).toBe(false);
    expect(finals.get('jev')).toBe(41);
  });

  it('leaves every counter alone when there is nothing to issue', () => {
    const { sequences, finals } = allocateSequences([null, null], new Map([['dv', 20]]));

    expect(sequences).toEqual([null, null]);
    expect(finals.size).toBe(0);
  });
});
