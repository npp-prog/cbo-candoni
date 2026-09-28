import { describe, expect, it } from 'vitest';
import {
  accountability,
  analyzeContinuity,
  bookletEnd,
  bookletStart,
  collapse,
  contains,
  count,
  describe as describeRanges,
  normalise,
  rangeFrom,
  renderSet,
  splitIntoBooklets,
  subtract,
  toNumber,
} from './serials';

const r = (from: number, to: number, width = 10) => ({ from, to, width });

describe('single serials', () => {
  it('treats padded and unpadded serials as the same receipt', () => {
    expect(toNumber('0007700678')).toBe(7700678);
    expect(toNumber('7700678')).toBe(7700678);
  });

  it('refuses to guess at a serial it cannot read', () => {
    expect(toNumber('A-1234')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
  });
});

describe('booklets', () => {
  it('places a serial in its booklet of fifty', () => {
    // 7705385 sits in the booklet 7705351-7705400.
    expect(bookletStart(7705385)).toBe(7705351);
    expect(bookletEnd(7705385)).toBe(7705400);
  });

  it('puts the first and last serial of a booklet in that booklet', () => {
    expect(bookletStart(50)).toBe(1);
    expect(bookletEnd(50)).toBe(50);
    expect(bookletStart(51)).toBe(51);
  });

  it('splits an issuance that crosses a booklet boundary', () => {
    const parts = splitIntoBooklets(r(7705801, 7705868));
    expect(parts).toEqual([
      r(7705801, 7705850),
      r(7705851, 7705868),
    ]);
  });

  it('leaves a run inside one booklet alone', () => {
    expect(splitIntoBooklets(r(7705801, 7705820))).toEqual([r(7705801, 7705820)]);
  });
});

describe('range arithmetic', () => {
  it('merges runs that are contiguous even when they arrived separately', () => {
    expect(normalise([r(1, 10), r(11, 20)])).toEqual([r(1, 20)]);
  });

  it('keeps runs apart when there is a hole between them', () => {
    expect(normalise([r(1, 10), r(12, 20)])).toEqual([r(1, 10), r(12, 20)]);
  });

  it('subtracts a range out of the middle and leaves two', () => {
    expect(subtract([r(1, 100)], [r(41, 60)])).toEqual([r(1, 40), r(61, 100)]);
  });

  it('subtracts a range that is not held and changes nothing', () => {
    expect(subtract([r(1, 50)], [r(80, 90)])).toEqual([r(1, 50)]);
  });

  it('counts what it holds', () => {
    expect(count([r(1, 50), r(101, 150)])).toBe(100);
  });

  it('knows whether one set is wholly inside another', () => {
    expect(contains([r(1, 100)], [r(20, 30)])).toBe(true);
    expect(contains([r(1, 100)], [r(90, 110)])).toBe(false);
  });
});

describe('collapsing encoded receipts into runs', () => {
  it('turns a month of receipts into the lines that print', () => {
    const ranges = collapse(['0000000101', '0000000102', '0000000103', '0000000107']);
    expect(renderSet(ranges)).toEqual([
      { from: '0000000101', to: '0000000103', qty: 3 },
      { from: '0000000107', to: '0000000107', qty: 1 },
    ]);
  });

  it('counts a repeated serial once, because a duplicate is a finding', () => {
    const ranges = collapse(['000101', '000102', '000102']);
    expect(count(ranges)).toBe(2);
  });
});

describe('continuity', () => {
  it('reports a hole in the serials used', () => {
    const report = analyzeContinuity(['0101', '0102', '0105']);
    expect(report.gaps).toEqual([{ after: '0102', before: '0105', missing: 2 }]);
  });

  it('reports a serial issued twice', () => {
    const report = analyzeContinuity(['0101', '0101', '0102']);
    expect(report.duplicates).toEqual([{ serial: '0101', times: 2 }]);
  });

  it('keeps a serial it cannot read rather than dropping it', () => {
    expect(analyzeContinuity(['0101', 'CANCELLED']).unreadable).toEqual(['CANCELLED']);
  });
});

describe('accountability', () => {
  it('foots beginning plus receipt less issued to the ending balance', () => {
    const a = accountability({
      beginning: [r(7705351, 7705400)],
      receipt: [r(7705401, 7705500)],
      issued: [r(7705351, 7705420)],
    });

    expect(a.beginning.qty).toBe(50);
    expect(a.receipt.qty).toBe(100);
    expect(a.issued.qty).toBe(70);
    expect(a.ending.qty).toBe(80);
    expect(a.discrepancy).toBeNull();
  });

  it('splits the ending balance at booklet boundaries for the report', () => {
    const a = accountability(
      { beginning: [r(7705351, 7705500)], receipt: [], issued: [r(7705351, 7705420)] },
      50,
    );
    expect(a.ending.ranges).toEqual([
      { from: '0007705421', to: '0007705450', qty: 30 },
      { from: '0007705451', to: '0007705500', qty: 50 },
    ]);
  });

  it('refuses to foot when a serial was issued that was never received', () => {
    const a = accountability({
      beginning: [r(100, 150)],
      receipt: [],
      issued: [r(140, 160)],
    });
    expect(a.discrepancy).toContain('without ever being received');
    expect(a.discrepancy).toContain('151');
  });

  it('accounts for spoiled forms separately from issued ones', () => {
    const a = accountability({
      beginning: [r(1, 100)],
      receipt: [],
      issued: [r(1, 40)],
      withdrawn: [r(41, 45)],
    });
    expect(a.issued.qty).toBe(40);
    expect(a.withdrawn.qty).toBe(5);
    expect(a.ending.qty).toBe(55);
    expect(describeRanges(a.ending.ranges)).toBe('0000000046 to 0000000100');
  });

  it('is empty and quiet when the officer holds nothing', () => {
    const a = accountability({ beginning: [], receipt: [], issued: [] });
    expect(a.ending.qty).toBe(0);
    expect(a.ending.ranges).toEqual([]);
    expect(a.discrepancy).toBeNull();
    expect(describeRanges(a.ending.ranges)).toBe('—');
  });
});

describe('rangeFrom', () => {
  it('reads a range as the office writes it', () => {
    expect(rangeFrom('0007705351', '0007705400')).toEqual({
      from: 7705351,
      to: 7705400,
      width: 10,
    });
  });

  it('refuses a range that runs backwards', () => {
    expect(rangeFrom('0000000100', '0000000050')).toBeNull();
  });
});
