import { describe, it, expect } from 'vitest';
import { withoutUndefined } from './firestoreValues';

/**
 * The case this was written for: a Report of Collections and Deposits whose
 * lines carry no payee id, because a receipt has no payee. Firestore refused
 * the whole document and the Treasurer lost the form.
 */
describe('withoutUndefined', () => {
  it('drops an undefined key', () => {
    expect(withoutUndefined({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('keeps null, which means something', () => {
    // Null says "this line has no payee id". An absent key says nothing, and
    // the difference matters when somebody reads the record back.
    expect(withoutUndefined({ payeeId: null })).toEqual({ payeeId: null });
    expect('payeeId' in withoutUndefined({ payeeId: null })).toBe(true);
  });

  it('keeps zero, empty string and false', () => {
    // An amount of zero and an empty particulars are real values. A filter
    // written as `if (!v) continue` would have eaten all three.
    const out = withoutUndefined({ amount: 0, particulars: '', excluded: false });
    expect(out).toEqual({ amount: 0, particulars: '', excluded: false });
  });

  it('cleans the lines of a report without renumbering them', () => {
    const lines = [
      { sourceNo: '1234', payeeId: undefined, amount: 200 },
      { sourceNo: '1235', payeeId: 'p1', amount: 300 },
    ];
    expect(withoutUndefined(lines)).toEqual([
      { sourceNo: '1234', amount: 200 },
      { sourceNo: '1235', payeeId: 'p1', amount: 300 },
    ]);
  });

  it('keeps an array the same length, even holding undefined', () => {
    // Dropping an element would renumber a report's lines, which is a worse
    // fault than the one being fixed.
    expect(withoutUndefined([1, undefined, 3])).toHaveLength(3);
  });

  it('reaches into nested objects', () => {
    expect(
      withoutUndefined({ entry: { accountCode: '10101010', subsidiaryId: undefined } }),
    ).toEqual({ entry: { accountCode: '10101010' } });
  });

  it('leaves a Date alone rather than taking it apart', () => {
    // A Date has no enumerable own properties, so rebuilding one from them
    // would produce an empty object and store the wrong thing.
    const when = new Date('2026-10-07T00:00:00Z');
    const out = withoutUndefined({ when });
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.toISOString()).toBe(when.toISOString());
  });

  it('leaves a class instance alone', () => {
    // Stands in for a Firestore Timestamp, FieldValue or DocumentReference:
    // values in their own right, not payloads to be rebuilt.
    class Sentinel {
      constructor(readonly kind: string) {}
    }
    const out = withoutUndefined({ stamp: new Sentinel('serverTimestamp') });
    expect(out.stamp).toBeInstanceOf(Sentinel);
    expect(out.stamp.kind).toBe('serverTimestamp');
  });

  it('passes primitives and null straight through', () => {
    expect(withoutUndefined(5)).toBe(5);
    expect(withoutUndefined('x')).toBe('x');
    expect(withoutUndefined(null)).toBeNull();
  });
});
