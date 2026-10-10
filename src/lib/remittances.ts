/**
 * Patch 160 - the collector's REMITTANCE to the Liquidating Officer.
 *
 * The collecting officer issues receipts and hands the money over to the
 * Liquidating Officer (for Collection). Usually the remittance is exactly
 * what was collected; sometimes it is short. Which receipts are then still
 * unremitted?
 *
 * The office's rule: a remittance is applied to the collector's receipts IN
 * ACCOUNTABLE-FORM SERIES ORDER - the form, then the receipt number, lowest
 * first. So every receipt before the point the money ran out is remitted,
 * the receipt where it ran out is partly remitted, and everything after is
 * still with the collector. Remittances are applied oldest first, each one
 * picking up where the last stopped.
 *
 * Nothing is stored on the receipts: the allocation is worked out from the
 * receipts and the remittances every time, so cancelling a remittance (or
 * correcting a receipt before it is reported) simply moves the line.
 *
 * Cash collections only - an e-collection never passes through the
 * collector's hands.
 */

export interface RemittableReceipt {
  id: string;
  orNumber: string;
  orDate: string;
  totalAmount: number;
  status: string;
  eCollectionKind?: string | null;
  collectingOfficerId?: string | null;
  collectingOfficerName?: string | null;
  accountableForm?: string | null;
  accountableFormId?: string | null;
}

export interface RemittanceRecord {
  id: string;
  remittanceDate: string;
  amount: number;
  status: string;
  collectingOfficerId?: string | null;
  collectingOfficerName?: string | null;
  createdAt?: unknown;
}

export type RemittedState = 'REMITTED' | 'PARTIAL' | 'NOT_REMITTED';

export interface ReceiptRemittance {
  remitted: number;
  unremitted: number;
  state: RemittedState;
}

export interface OfficerRemittance {
  key: string;
  name: string;
  collected: number;
  remitted: number;
  /** Collected and not yet remitted. */
  unremitted: number;
  /** Remitted beyond what the receipts on file account for. */
  excess: number;
}

export interface Allocation {
  collectionId: string;
  orNumber: string;
  amount: number;
}

/** The officer a receipt or a remittance belongs to. */
export const officerKeyOf = (x: {
  collectingOfficerId?: string | null;
  collectingOfficerName?: string | null;
}) =>
  String(x.collectingOfficerId ?? '').trim() ||
  `name:${String(x.collectingOfficerName ?? '')
    .trim()
    .toUpperCase()}`;

const formOf = (r: RemittableReceipt) =>
  String(r.accountableForm ?? r.accountableFormId ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const digits = (s: string) => {
  const m = String(s).match(/\d+/g);
  return m ? Number(m.join('')) : NaN;
};

/** Accountable-form series order: the form, then the receipt number. */
export function seriesOrder(a: RemittableReceipt, b: RemittableReceipt): number {
  const f = formOf(a).localeCompare(formOf(b));
  if (f) return f;
  const na = digits(a.orNumber);
  const nb = digits(b.orNumber);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a.orNumber).localeCompare(String(b.orNumber)) || a.orDate.localeCompare(b.orDate);
}

/** A cash receipt that has money to remit. */
export const isRemittable = (r: RemittableReceipt) =>
  !r.eCollectionKind && r.status !== 'CANCELLED' && (r.totalAmount || 0) > 0;

const stamp = (v: unknown): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  const t = v as { seconds?: number; toMillis?: () => number };
  if (typeof t.toMillis === 'function') return String(t.toMillis()).padStart(16, '0');
  if (typeof t.seconds === 'number') return String(t.seconds * 1000).padStart(16, '0');
  return '';
};

export function allocateRemittances(
  receipts: RemittableReceipt[],
  remittances: RemittanceRecord[],
): {
  byReceipt: Map<string, ReceiptRemittance>;
  byRemittance: Map<string, Allocation[]>;
  officers: OfficerRemittance[];
} {
  const byReceipt = new Map<string, ReceiptRemittance>();
  const byRemittance = new Map<string, Allocation[]>();
  const officers = new Map<string, OfficerRemittance>();

  const cash = receipts.filter(isRemittable);
  const perOfficer = new Map<string, RemittableReceipt[]>();
  for (const r of cash) {
    const k = officerKeyOf(r);
    perOfficer.set(k, [...(perOfficer.get(k) ?? []), r]);
    const o = officers.get(k) ?? {
      key: k,
      name: String(r.collectingOfficerName ?? ''),
      collected: 0,
      remitted: 0,
      unremitted: 0,
      excess: 0,
    };
    o.collected += r.totalAmount;
    officers.set(k, o);
  }

  const live = remittances
    .filter((m) => m.status !== 'CANCELLED' && (m.amount || 0) > 0)
    .sort(
      (a, b) =>
        a.remittanceDate.localeCompare(b.remittanceDate) ||
        stamp(a.createdAt).localeCompare(stamp(b.createdAt)) ||
        a.id.localeCompare(b.id),
    );

  const queue = new Map<string, { list: RemittableReceipt[]; i: number; left: number }>();
  for (const [k, list] of perOfficer) {
    const sorted = [...list].sort(seriesOrder);
    queue.set(k, { list: sorted, i: 0, left: sorted[0]?.totalAmount ?? 0 });
  }
  const paid = new Map<string, number>();

  for (const m of live) {
    const k = officerKeyOf(m);
    const o = officers.get(k) ?? {
      key: k,
      name: String(m.collectingOfficerName ?? ''),
      collected: 0,
      remitted: 0,
      unremitted: 0,
      excess: 0,
    };
    officers.set(k, o);
    o.remitted += m.amount;

    const q = queue.get(k);
    let money = m.amount;
    const alloc: Allocation[] = [];
    while (q && money > 0 && q.i < q.list.length) {
      const r = q.list[q.i];
      const take = Math.min(money, q.left);
      alloc.push({ collectionId: r.id, orNumber: r.orNumber, amount: take });
      paid.set(r.id, (paid.get(r.id) ?? 0) + take);
      money -= take;
      q.left -= take;
      if (q.left === 0) {
        q.i += 1;
        q.left = q.list[q.i]?.totalAmount ?? 0;
      }
    }
    o.excess += money;
    byRemittance.set(m.id, alloc);
  }

  for (const r of cash) {
    const remitted = paid.get(r.id) ?? 0;
    byReceipt.set(r.id, {
      remitted,
      unremitted: r.totalAmount - remitted,
      state: remitted >= r.totalAmount ? 'REMITTED' : remitted > 0 ? 'PARTIAL' : 'NOT_REMITTED',
    });
  }
  for (const o of officers.values()) {
    o.unremitted = Math.max(0, o.collected - (o.remitted - o.excess));
  }

  return {
    byReceipt,
    byRemittance,
    officers: [...officers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** "0001-0045, 0047" - the receipts an allocation covers, in runs. */
export function describeAllocation(alloc: Allocation[], totals: Map<string, number>): string {
  const parts: string[] = [];
  let runFrom: string | null = null;
  let runTo: string | null = null;
  let prev = NaN;
  const flush = () => {
    if (runFrom) parts.push(runFrom === runTo ? runFrom : `${runFrom}-${runTo}`);
  };
  for (const a of alloc) {
    const full = (totals.get(a.collectionId) ?? a.amount) === a.amount;
    const n = digits(a.orNumber);
    if (!full) {
      flush();
      runFrom = runTo = null;
      prev = NaN;
      parts.push(`${a.orNumber} (part)`);
      continue;
    }
    if (runFrom && Number.isFinite(prev) && n === prev + 1) {
      runTo = a.orNumber;
    } else {
      flush();
      runFrom = runTo = a.orNumber;
    }
    prev = n;
  }
  flush();
  return parts.join(', ');
}
