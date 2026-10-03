import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { asHttpsError } from './callable';

/* The wrapper writes the whole fault to the Cloud Functions log, which is the
 * point of it. Here that would bury the test output in stack traces, so it is
 * captured instead - and asserted on, so "it logs" is tested rather than
 * assumed. */
let logged: unknown[][] = [];

beforeAll(() => {
  vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

/**
 * These tests pin the one behaviour the whole wrapper exists for: the person
 * in front of the screen is told WHAT went wrong.
 *
 * Before this, every unexpected server fault reached the browser as the single
 * word "internal" - no message, no field, no indication of whether anything had
 * been saved.
 */
describe('asHttpsError', () => {
  it('passes a deliberate refusal through untouched', () => {
    const refusal = new HttpsError(
      'failed-precondition',
      'This appropriation is already approved.',
    );

    const out = asHttpsError(refusal);

    expect(out).toBe(refusal);
    expect(out.code).toBe('failed-precondition');
    expect(out.message).toBe('This appropriation is already approved.');
  });

  it('carries the real text of an unexpected fault to the browser', () => {
    const out = asHttpsError(new Error('Cannot increment a non-numeric value'));

    expect(out).toBeInstanceOf(HttpsError);
    expect(out.code).toBe('internal');
    // The whole point: the message is no longer the bare word "internal".
    expect(out.message).toContain('Cannot increment a non-numeric value');
    expect(out.message).not.toBe('internal');
  });

  it('says plainly that nothing was saved', () => {
    const out = asHttpsError(new Error('whatever broke'));

    expect(out.message).toContain('nothing was saved');
  });

  it('includes a Firestore error code so the fault can be looked up', () => {
    const firestoreish = Object.assign(new Error('3 INVALID_ARGUMENT: bad field'), {
      code: 3,
    });

    const out = asHttpsError(firestoreish);

    expect(out.message).toContain('3 INVALID_ARGUMENT: bad field');
    expect(out.message).toContain('Error 3');
  });

  it('names the operation when one is given', () => {
    const out = asHttpsError(new Error('boom'), 'approveAppropriation');

    expect((out.details as { operation?: string }).operation).toBe('approveAppropriation');
  });

  it('survives something thrown that is not an Error at all', () => {
    const out = asHttpsError('a bare string');

    expect(out.code).toBe('internal');
    expect(out.message).toContain('a bare string');
  });

  it('writes the whole fault, stack and all, to the Cloud Functions log', () => {
    logged = [];
    asHttpsError(new Error('something deep'), 'releaseAllotment');

    expect(logged).toHaveLength(1);
    const detail = logged[0][1] as { operation: string; message: string; stack: string | null };
    expect(detail.operation).toBe('releaseAllotment');
    expect(detail.message).toBe('something deep');
    expect(detail.stack).toContain('callable.test.ts');
  });

  it('never logs a deliberate refusal - those are not faults', () => {
    logged = [];
    asHttpsError(new HttpsError('failed-precondition', 'The period is closed.'));

    expect(logged).toHaveLength(0);
  });
});
