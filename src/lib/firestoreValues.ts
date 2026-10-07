/**
 * Making a payload safe for Firestore.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE ABSENT FIELD LOSES A WHOLE FORM
 * ---------------------------------------------------------------------------
 * Firestore refuses a document containing `undefined`. It does not drop the
 * field and carry on - it rejects the ENTIRE write, with "Unsupported field
 * value: undefined (found in document ...)" and a document id, which tells the
 * person at the desk nothing at all.
 *
 * So a single optional field nobody filled in throws away everything that was
 * typed. That is exactly what happened to the Report of Collections and
 * Deposits: a collection has no payee id, the report line carried
 * `payeeId: undefined`, and the Treasurer pressed Save draft and got an error
 * about `addDoc`. The form was right. A field that was legitimately empty
 * destroyed it.
 *
 * Each call site should still write `?? null` where a field is genuinely
 * optional, because null SAYS the line has no payee and an absent key says
 * nothing. This is the floor under that, so the next one missed costs nothing.
 *
 * In its own file, with no Firebase import, so it can be tested without
 * standing up Firebase - the same reason `src/lib/entity.ts` exists.
 */

/**
 * A copy of `value` with every `undefined` property removed, at any depth.
 *
 * Arrays keep their length and their positions: dropping an element would
 * renumber the lines of a report, which is worse than the problem being
 * solved. Only object KEYS are dropped.
 */
export function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutUndefined(entry)) as unknown as T;
  }

  /*
   * Only PLAIN objects are taken apart. A Date, a Firestore Timestamp, a
   * FieldValue such as serverTimestamp(), a GeoPoint or a DocumentReference
   * are values in their own right, and rebuilding one from its enumerable
   * properties would produce a different thing that Firestore would then
   * refuse or, worse, store wrongly.
   */
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    out[key] = withoutUndefined(entry);
  }
  return out as T;
}
