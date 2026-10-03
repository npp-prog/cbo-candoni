import { describe, it, expect } from 'vitest';
import { compareRefs, newestFirst } from './registerOrder';

const order = (refs: Array<string | null | undefined>, dates?: string[]) =>
  newestFirst(
    refs.map((ref, i) => ({ ref, date: dates?.[i] ?? '2026-10-01' })),
    (r) => r,
  ).map((r) => r.ref);

describe('compareRefs', () => {
  it('reads a padded sequence in order', () => {
    expect(compareRefs('100-26-10-0009', '100-26-10-0010')).toBeLessThan(0);
  });

  it('reads an unpadded one the same way', () => {
    // Staff assign the OBR and DV numbers by hand now, so nobody can promise
    // the padding. As text, "100-26-10-9" sorts AFTER "100-26-10-10".
    expect(compareRefs('100-26-10-9', '100-26-10-10')).toBeLessThan(0);
  });

  it('puts an earlier month before a later one', () => {
    expect(compareRefs('100-26-09-0100', '100-26-10-0001')).toBeLessThan(0);
  });

  it('compares the text parts as text', () => {
    expect(compareRefs('RCD-0001', 'RCI-0001')).toBeLessThan(0);
  });

  it('calls two identical numbers equal', () => {
    expect(compareRefs('100-26-10-0001', '100-26-10-0001')).toBe(0);
  });

  it('separates two numbers of equal value but different width', () => {
    expect(compareRefs('07', '7')).not.toBe(0);
  });

  it('puts a shorter number first when one is a prefix of the other', () => {
    expect(compareRefs('100-26', '100-26-10')).toBeLessThan(0);
  });
});

describe('newestFirst', () => {
  it('puts the highest number at the top', () => {
    expect(order(['100-26-10-0001', '100-26-10-0003', '100-26-10-0002'])).toEqual([
      '100-26-10-0003',
      '100-26-10-0002',
      '100-26-10-0001',
    ]);
  });

  it('does not sort an unpadded number into the wrong place', () => {
    expect(order(['100-26-10-9', '100-26-10-10'])).toEqual(['100-26-10-10', '100-26-10-9']);
  });

  it('puts a row with no number yet at the very top', () => {
    // A draft being encoded this minute. It is the row the clerk is coming
    // back to; the bottom of four hundred finished documents is the one place
    // it certainly should not be.
    expect(order(['100-26-10-0002', null, '100-26-10-0003'])).toEqual([
      null,
      '100-26-10-0003',
      '100-26-10-0002',
    ]);
    expect(order(['100-26-10-0002', '  ', '100-26-10-0003'])[0]).toBe('  ');
  });

  it('falls back to the date, newest first, when numbers tie', () => {
    const rows = order(
      ['100-26-10-0001', '100-26-10-0001'],
      ['2026-10-01', '2026-10-05'],
    );
    expect(rows).toHaveLength(2);
    const sorted = newestFirst(
      [
        { ref: 'X', date: '2026-10-01' },
        { ref: 'X', date: '2026-10-05' },
      ],
      (r) => r,
    );
    expect(sorted[0].date).toBe('2026-10-05');
  });

  it('orders two unnumbered rows by date, newest first', () => {
    const sorted = newestFirst(
      [
        { ref: '', date: '2026-10-01' },
        { ref: '', date: '2026-10-05' },
      ],
      (r) => r,
    );
    expect(sorted[0].date).toBe('2026-10-05');
  });

  it('does not change the list it was given', () => {
    const rows = [{ ref: 'A1', date: '2026-01-01' }, { ref: 'A2', date: '2026-01-01' }];
    newestFirst(rows, (r) => r);
    expect(rows.map((r) => r.ref)).toEqual(['A1', 'A2']);
  });

  it('leaves an empty list empty', () => {
    expect(newestFirst([], (r: Numbered) => r)).toEqual([]);
  });
});

type Numbered = { ref?: string | null; date?: string | null };
