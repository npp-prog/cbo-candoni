import { DocumentReference, GeoPoint, Timestamp } from 'firebase-admin/firestore';

/**
 * Patch 172 - Firestore values to JSON and back, for the backup file.
 *
 * JSON has no word for a timestamp, a document reference, a location or raw
 * bytes, so each is written as a small tagged object ({"__cfms":"ts",...})
 * and turned back into the real thing on restore. Everything else - text,
 * numbers, true/false, lists, maps - is JSON already.
 */

type Tagged = { __cfms: string; [k: string]: unknown };

export function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return { __cfms: 'ts', s: v.seconds, n: v.nanoseconds };
  if (v instanceof GeoPoint) return { __cfms: 'geo', lat: v.latitude, lng: v.longitude };
  if (v instanceof DocumentReference) return { __cfms: 'ref', path: v.path };
  if (v instanceof Uint8Array) return { __cfms: 'bytes', b64: Buffer.from(v).toString('base64') };
  if (typeof v === 'number' && !Number.isFinite(v)) return { __cfms: 'num', v: String(v) };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = encodeValue(x);
    }
    return out;
  }
  return v;
}

export function decodeValue(v: unknown, refFor: (path: string) => unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, refFor));
  const t = v as Tagged;
  if (typeof t.__cfms === 'string') {
    switch (t.__cfms) {
      case 'ts':
        return new Timestamp(Number(t.s), Number(t.n));
      case 'geo':
        return new GeoPoint(Number(t.lat), Number(t.lng));
      case 'ref':
        return refFor(String(t.path));
      case 'bytes':
        return Buffer.from(String(t.b64), 'base64');
      case 'num':
        return Number(t.v);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    out[k] = decodeValue(x, refFor);
  return out;
}
