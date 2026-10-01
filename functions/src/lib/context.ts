import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { db, COL } from './firebase';

/**
 * Authorisation for callable functions.
 *
 * Every callable begins with `requireCaller(request, [...roles])`. There is no
 * default-allow path: a function that forgets to call this has no protection at
 * all, because the Admin SDK ignores security rules. Reviewers should treat a
 * callable without a `requireCaller` line at the top as a defect.
 */

export interface Caller {
  uid: string;
  email: string;
  name: string;
  position?: string;
  roles: string[];
  officeScope: string[];
  fundScope: string[];
  /** Best-effort client IP, recorded in the audit trail. */
  ip?: string;
  userAgent?: string;
}

export type Role =
  | 'SUPER_ADMIN'
  | 'MUNICIPAL_ACCOUNTANT'
  | 'ACCOUNTING_REVIEWER'
  | 'ACCOUNTING_ENCODER'
  | 'BUDGET_OFFICER'
  | 'BUDGET_STAFF'
  | 'MUNICIPAL_TREASURER'
  | 'TREASURY_STAFF'
  | 'DEPARTMENT_USER'
  | 'AUDITOR';

export const POSTING_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];
export const CERTIFYING_ROLES: Role[] = ['SUPER_ADMIN', 'BUDGET_OFFICER'];
export const PERIOD_CONTROL_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];
export const APPROVING_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

/**
 * Resolves and authorises the caller.
 *
 * Roles come from Firebase Auth custom claims, not from the `users` document.
 * The claim is signed by Firebase and cannot be forged by a client; the
 * document is merely a readable mirror for the administration screen. Reading
 * roles from the document instead would let anyone who can write their own
 * profile grant themselves posting authority.
 */
export async function requireCaller(
  request: CallableRequest,
  allowedRoles?: Role[],
): Promise<Caller> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to CFMS to perform this operation.');
  }

  const token = request.auth.token as Record<string, unknown>;
  const roles = Array.isArray(token.roles) ? (token.roles as string[]) : [];

  if (token.active === false) {
    throw new HttpsError(
      'permission-denied',
      'This CFMS account has been deactivated. Contact the system administrator.',
    );
  }

  if (allowedRoles && allowedRoles.length > 0) {
    const permitted = roles.some((r) => (allowedRoles as string[]).includes(r));
    if (!permitted) {
      throw new HttpsError(
        'permission-denied',
        `This operation requires one of: ${allowedRoles.join(', ')}. Your account holds: ${roles.join(', ') || 'no roles'}.`,
      );
    }
  }

  return {
    uid: request.auth.uid,
    email: (token.email as string) ?? '',
    name: (token.name as string) ?? (token.displayName as string) ?? (token.email as string) ?? request.auth.uid,
    position: token.position as string | undefined,
    roles,
    officeScope: Array.isArray(token.officeScope) ? (token.officeScope as string[]) : [],
    fundScope: Array.isArray(token.fundScope) ? (token.fundScope as string[]) : [],
    ip: request.rawRequest?.ip,
    userAgent: request.rawRequest?.headers?.['user-agent'] as string | undefined,
  };
}

export function hasRole(caller: Caller, ...roles: Role[]): boolean {
  return caller.roles.some((r) => (roles as string[]).includes(r));
}

/**
 * A department user may only act on their own office's documents. Enforced
 * here as well as in security rules, because a callable runs with Admin
 * credentials and the rules do not apply to it.
 */
export function assertOfficeInScope(caller: Caller, officeId: string): void {
  if (caller.officeScope.length === 0) return;
  if (!caller.officeScope.includes(officeId)) {
    throw new HttpsError(
      'permission-denied',
      'This document belongs to an office outside your access scope.',
    );
  }
}

export function assertFundInScope(caller: Caller, fundCode: string): void {
  if (caller.fundScope.length === 0) return;
  if (!caller.fundScope.includes(fundCode)) {
    throw new HttpsError('permission-denied', `You do not have access to the ${fundCode} fund.`);
  }
}

/**
 * Four-eyes control: the person approving a document may not be the person who
 * created it. Municipal accounting offices are small, so this is configurable -
 * but it is on by default, and turning it off is a recorded settings change.
 */
export async function assertNotSelfApproval(
  caller: Caller,
  createdByUid: string | undefined,
  documentRef: string,
): Promise<void> {
  if (!createdByUid || createdByUid !== caller.uid) return;

  const settings = await db.collection(COL.settings).doc('general').get();
  const allowSelfApproval = settings.exists && settings.data()?.allowSelfApproval === true;

  if (!allowSelfApproval) {
    throw new HttpsError(
      'failed-precondition',
      `${documentRef} was prepared by you. Segregation of duties requires a different user to approve it. An administrator can relax this in Administration > Settings if the office has no second reviewer.`,
    );
  }
}

/** Turns a rules-module CheckResult into a client-facing error. */
export function assertOk(
  result: { ok: boolean; violations: Array<{ code: string; message: string; details?: unknown }> },
  fallbackMessage = 'The transaction failed validation.',
): void {
  if (result.ok) return;
  const first = result.violations[0];
  throw new HttpsError('failed-precondition', first?.message ?? fallbackMessage, {
    violations: result.violations,
  });
}

export function notFound(what: string): HttpsError {
  return new HttpsError('not-found', `${what} was not found. It may have been cancelled or deleted.`);
}

export function invalid(message: string, details?: unknown): HttpsError {
  return new HttpsError('invalid-argument', message, details);
}

export function conflict(message: string, details?: unknown): HttpsError {
  return new HttpsError('aborted', message, details);
}

/**
 * Turns an unexpected failure into something the person at the screen can act
 * on.
 *
 * A callable that throws anything other than an HttpsError reaches the browser
 * as the single word "internal". That is the correct default for a public API -
 * it leaks nothing - but CFMS is not a public API. Every caller here is an
 * authenticated municipal officer, and "internal" tells them nothing except
 * that something broke, which costs a round trip to the Cloud Functions log
 * before anybody can even begin.
 *
 * So an unexpected error is logged in full, with a stack, and the caller is
 * told what operation failed and what the underlying message said. An
 * HttpsError raised deliberately is passed through untouched - those already
 * say what they mean.
 */
export async function reporting<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(`${what} failed`, err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpsError('internal', `${what} could not be completed. ${detail}`);
  }
}
