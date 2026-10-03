import {
  onCall as baseOnCall,
  HttpsError,
  type CallableOptions,
  type CallableRequest,
} from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';

/**
 * A drop-in replacement for `onCall` that makes an unexpected failure legible.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * A Firebase callable returns a readable message to the browser ONLY when the
 * server throws an `HttpsError`. Every other exception - a Firestore rejection,
 * a null dereference, a bad argument to `FieldValue.increment` - is swallowed
 * by the Functions runtime and arrives at the browser as the single word:
 *
 *     internal
 *
 * No message. No field. No clue. The user sees "Could not approve: internal"
 * and there is nothing in front of them that says what went wrong or whether
 * anything was saved. The real error exists only in the Cloud Functions log,
 * which the people using CFMS cannot read and should not have to.
 *
 * That is not a small inconvenience. It is the same failure shape that has bitten
 * this project three times already: SOMETHING ASSERTED AND NEVER CHECKED AGAINST
 * THE PLACE THAT MATTERS. A system that cannot say what it refused, or why it
 * broke, cannot be corrected by the person standing in front of it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 * An `HttpsError` - every deliberate refusal in CFMS - passes through
 * untouched. Those messages are already written for the reader.
 *
 * Anything else is logged in full (with its stack, for the record) and
 * re-thrown as an `HttpsError` carrying the real text of the fault, so the
 * screen shows what actually happened instead of "internal".
 *
 * NOTHING ABOUT THE TRANSACTION CHANGES. An exception inside
 * `db.runTransaction` still aborts the transaction and still writes nothing.
 * This only changes what the user is told afterwards.
 */

/** Firestore and gRPC errors carry a numeric or string `code` beside the message. */
function describe(err: unknown): { text: string; reason: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      text: err.message || err.name,
      reason: code === undefined ? err.name : `${err.name} ${String(code)}`,
    };
  }
  return { text: String(err), reason: typeof err };
}

export function asHttpsError(err: unknown, operation?: string): HttpsError {
  if (err instanceof HttpsError) return err;

  const { text, reason } = describe(err);
  const where = operation ? ` while running ${operation}` : '';

  logger.error(`Unhandled error in a CFMS callable${where}`, {
    operation: operation ?? null,
    reason,
    message: text,
    stack: err instanceof Error ? err.stack : null,
  });

  return new HttpsError(
    'internal',
    `CFMS could not complete this operation and nothing was saved. The engine stopped with: ${text} (${reason}). This is a fault in CFMS rather than something wrong with what you entered - send this message on, and the whole detail is in the Cloud Functions log.`,
    { reason, operation: operation ?? null },
  );
}

/**
 * Use exactly as `onCall` from firebase-functions. The only difference is what
 * the browser is told when the handler throws something unforeseen.
 */
/* The two `any`s below are deliberate: they are exactly the defaults
 * firebase-functions' own `onCall` uses. Narrowing them here would change the
 * type of `request.data` in every handler, which is not what this wrapper is
 * for - it changes what the user is TOLD, not what the code may do. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function onCall<T = any, R = any>(
  opts: CallableOptions,
  handler: (request: CallableRequest<T>) => Promise<R>,
) {
  return baseOnCall<T, Promise<R>>(opts, async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      throw asHttpsError(err);
    }
  });
}
