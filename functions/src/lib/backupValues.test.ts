import { describe, expect, it } from 'vitest';
import { GeoPoint, Timestamp } from 'firebase-admin/firestore';
import { decodeValue, encodeValue } from './backupValues';

describe('backup values', () => {
  it('round-trips the Firestore types JSON has no word for', () => {
    const doc = {
      at: new Timestamp(1700000000, 123000000),
      where: new GeoPoint(10.5, 122.9),
      raw: Buffer.from('abc'),
      list: [1, 'two', { three: new Timestamp(5, 6) }],
      nested: { amount: 1234_56, none: null },
    };
    const json = JSON.parse(JSON.stringify(encodeValue(doc)));
    const back = decodeValue(json, (p) => `ref:${p}`) as typeof doc;
    expect(back.at).toBeInstanceOf(Timestamp);
    expect(back.at.isEqual(doc.at)).toBe(true);
    expect(back.where.isEqual(doc.where)).toBe(true);
    expect(Buffer.from(back.raw).toString()).toBe('abc');
    expect((back.list[2] as { three: Timestamp }).three.seconds).toBe(5);
    expect(back.nested).toEqual({ amount: 1234_56, none: null });
  });

  it('turns a tagged reference back through the given function', () => {
    expect(decodeValue({ __cfms: 'ref', path: 'payees/p1' }, (p) => `ref:${p}`)).toBe(
      'ref:payees/p1',
    );
  });
});
