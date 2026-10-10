// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/formCustody.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
import { rangeFrom, subtract, toNumber, union, type NumericRange } from './serials';

/**
 * Patch 161 - A RECEIPT MUST COME FROM A BOOKLET THE COLLECTOR HOLDS.
 *
 * An Official Receipt is an accountable form: the Treasurer issues booklets
 * to a collecting officer, and the officer answers for every serial in them
 * (Section C of the RCD, and the RAAF). A collection written on a serial the
 * officer was never issued - or had already returned, spoiled or cancelled -
 * is money received on paper nobody is accountable for. So a collection is
 * recorded only on a serial the movement ledger says the officer held on the
 * day.
 *
 * Replays the ledger the way the RAAF does (functions/src/treasury/
 * accountableForms.ts, foldCustody), for one officer and one form.
 */

export const normaliseFormCode = (code: string | null | undefined) =>
  String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export interface CustodyMovement {
  formCode: string;
  kind: string;
  movementDate: string;
  serialFrom: string;
  serialTo: string;
  custodianId?: string | null;
  fromCustodianId?: string | null;
  voided?: boolean;
}

/** The serials of one form an officer holds at the end of a day. */
export function officerHoldings(
  movements: CustodyMovement[],
  officerId: string,
  formCode: string,
  onDate: string,
): NumericRange[] {
  const code = normaliseFormCode(formCode);
  let held: NumericRange[] = [];
  const ordered = movements
    .filter((m) => !m.voided && normaliseFormCode(m.formCode) === code && m.movementDate <= onDate)
    .sort((a, b) => a.movementDate.localeCompare(b.movementDate));
  for (const m of ordered) {
    const r = rangeFrom(m.serialFrom, m.serialTo);
    if (!r) continue;
    if (m.kind === 'ISSUE' && m.custodianId === officerId) held = union(held, [r]);
    else if (
      (m.kind === 'RETURN' || m.kind === 'SPOILED' || m.kind === 'CANCELLED') &&
      m.fromCustodianId === officerId
    )
      held = subtract(held, [r]);
  }
  return held;
}

export function holdsSerial(held: NumericRange[], serial: string): boolean {
  const n = toNumber(serial);
  if (n === null) return false;
  return held.some((r) => n >= r.from && n <= r.to);
}
