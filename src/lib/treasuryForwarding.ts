/**
 * Patch 143. Certifying a treasury report and forwarding it to Accounting are
 * two acts. Accounting receives - and may journalize - only a forwarded
 * report.
 *
 * `forwardedAt` is null on a report certified but not yet forwarded, a date
 * once forwarded, and ABSENT on a report certified before patch 143 - which
 * was forwarded in the same act, so it counts as forwarded.
 */
export interface Forwardable {
  status: string;
  forwardedAt?: string | null;
}

export function isForwarded(r: Forwardable): boolean {
  if (r.status === 'JOURNALIZED') return true;
  return r.status === 'CERTIFIED' && r.forwardedAt !== null;
}

/** Certified by the Treasurer and still in the Treasury's hands. */
export function awaitingForward(r: Forwardable): boolean {
  return r.status === 'CERTIFIED' && r.forwardedAt === null;
}
