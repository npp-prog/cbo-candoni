import { describe, expect, it, vi, beforeEach } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Timestamp } from 'firebase-admin/firestore';

/*
 * Patch 172. The backup engine end to end, against an in-memory Firestore and
 * Cloud Storage: back up, damage the data, look at the preview, put back what
 * is missing, return everything, and refuse a file that was altered.
 */

const store = new Map<string, Map<string, Record<string, unknown>>>();
const files = new Map<string, Buffer>();
const audits: Array<Record<string, unknown>> = [];
let autoId = 0;

function col(name: string) {
  if (!store.has(name)) store.set(name, new Map());
  const m = store.get(name)!;
  const docRef = (id: string) => ({
    id,
    path: `${name}/${id}`,
    get: async () => ({ exists: m.has(id), data: () => m.get(id), id }),
    set: async (d: Record<string, unknown>) => void m.set(id, d),
    delete: async () => void m.delete(id),
    __col: name,
  });
  const query = {
    get: async () => {
      const docs = [...m].map(([id, d]) => ({ id, data: () => d, ref: docRef(id) }));
      return { docs, size: docs.length };
    },
  };
  return {
    id: name,
    doc: (id?: string) => docRef(id ?? `auto${++autoId}`),
    get: query.get,
    where: () => ({
      orderBy: () => ({ offset: () => ({ get: async () => ({ docs: [], size: 0 }) }) }),
    }),
  };
}

vi.mock('../lib/firebase', () => ({
  ENFORCE_APP_CHECK: false,
  REGION: 'asia-southeast1',
  COL: { backups: 'backups' },
  db: {
    listCollections: async () => [...store.keys()].map((n) => col(n)),
    collection: (n: string) => col(n),
    doc: (p: string) => col(p.split('/')[0]).doc(p.split('/')[1]),
    bulkWriter: () => {
      const ops: Array<() => Promise<void>> = [];
      return {
        set: (ref: { set: (d: unknown) => Promise<void> }, d: Record<string, unknown>) => {
          ops.push(() => ref.set(d));
          return Promise.resolve();
        },
        delete: (ref: { delete: () => Promise<void> }) => {
          ops.push(() => ref.delete());
          return Promise.resolve();
        },
        close: async () => {
          for (const o of ops) await o();
        },
      };
    },
  },
  storage: {
    bucket: () => ({
      file: (path: string) => ({
        save: async (b: Buffer) => void files.set(path, b),
        download: async (opts?: { start?: number; end?: number }) => {
          const b = files.get(path);
          if (!b) throw new Error('no such file');
          return [
            opts?.start !== undefined ? b.subarray(opts.start, (opts.end ?? b.length - 1) + 1) : b,
          ];
        },
        delete: async () => void files.delete(path),
      }),
    }),
  },
}));
vi.mock('../lib/audit', () => ({
  audit: async (a: Record<string, unknown>) => void audits.push(a),
}));

process.env.GCLOUD_PROJECT = 'cbo-candoni-dev';
const B = await import('./backup');

const req = (data: unknown, roles = ['SUPER_ADMIN']) =>
  ({
    data,
    auth: { uid: 'u1', token: { roles, name: 'Neil' } },
    rawRequest: { headers: {} },
  }) as never;
const run = <T>(fn: unknown, data: unknown, roles?: string[]) =>
  (fn as { run: (r: unknown) => Promise<T> }).run(req(data, roles));

beforeEach(() => {
  store.clear();
  files.clear();
  audits.length = 0;
  col('vouchers')
    .doc('v1')
    .set({ amount: 100, at: Timestamp.fromMillis(1700000000123) });
  col('vouchers').doc('v2').set({ amount: 200 });
  col('auditLogs').doc('a1').set({ e: 'one' });
});

describe('backup and restore', () => {
  it('only the Super Administrator', async () => {
    await expect(run(B.createBackup, {}, ['MUNICIPAL_ACCOUNTANT'])).rejects.toThrow(/SUPER_ADMIN/);
  });

  it('backs up, then puts back what is missing and returns what was changed', async () => {
    const rec = await run<{ id: string; path: string; docCount: number }>(B.createBackup, {});
    expect(rec.docCount).toBe(3);
    expect(gunzipSync(files.get(rec.path)!).toString().split('\n')).toHaveLength(5);

    // Damage.
    store.get('vouchers')!.delete('v1');
    store.get('vouchers')!.set('v2', { amount: 999 });
    store.get('vouchers')!.set('v3', { amount: 3 });
    store.get('auditLogs')!.set('a1', { e: 'changed' });

    const pv = await run<{
      counts: Record<string, { missing: number; changed: number; newer: number }>;
    }>(B.previewRestore, { source: { backupId: rec.id } });
    expect(pv.counts.vouchers).toMatchObject({ missing: 1, changed: 1, newer: 1 });

    await expect(
      run(B.restoreBackup, {
        source: { backupId: rec.id },
        mode: 'MISSING',
        confirm: 'yes',
        reason: 'x'.repeat(20),
      }),
    ).rejects.toThrow(/RESTORE/);

    const r1 = await run<{
      created: number;
      overwritten: number;
      removed: number;
      safetyBackup: string | null;
    }>(B.restoreBackup, {
      source: { backupId: rec.id },
      mode: 'MISSING',
      confirm: 'RESTORE',
      reason: 'v1 deleted by mistake',
    });
    expect(r1).toMatchObject({ created: 1, overwritten: 0, removed: 0, safetyBackup: null });
    const v1 = store.get('vouchers')!.get('v1')!;
    expect(v1.at).toBeInstanceOf(Timestamp);
    expect((v1.at as Timestamp).toMillis()).toBe(1700000000123);
    expect(store.get('vouchers')!.get('v2')).toEqual({ amount: 999 });

    const r2 = await run<{
      created: number;
      overwritten: number;
      removed: number;
      safetyBackup: string | null;
    }>(B.restoreBackup, {
      source: { backupId: rec.id },
      mode: 'REPLACE',
      confirm: 'RESTORE',
      reason: 'vouchers damaged by import',
    });
    expect(r2).toMatchObject({ created: 0, overwritten: 1, removed: 1 });
    expect(r2.safetyBackup).toMatch(/before-restore/);
    expect(store.get('vouchers')!.get('v2')).toEqual({ amount: 200 });
    expect(store.get('vouchers')!.has('v3')).toBe(false);
    // The audit trail is never overwritten.
    expect(store.get('auditLogs')!.get('a1')).toEqual({ e: 'changed' });
    expect(audits.some((a) => a.severity === 'CRITICAL')).toBe(true);
  });

  it('hands the file over in pieces and refuses an altered upload', async () => {
    const rec = await run<{ id: string; path: string; size: number }>(B.createBackup, {});
    const ch = await run<{ next: number | null; data: string; size: number }>(B.readBackupChunk, {
      backupId: rec.id,
      offset: 0,
    });
    expect(ch.next).toBeNull();
    expect(Buffer.from(ch.data, 'base64').equals(files.get(rec.path)!)).toBe(true);

    const altered = gunzipSync(files.get(rec.path)!)
      .toString()
      .replace('"amount":200', '"amount":201');
    files.set('restore-uploads/u1/bad.jsonl.gz', gzipSync(altered));
    await expect(
      run(B.previewRestore, { source: { uploadPath: 'restore-uploads/u1/bad.jsonl.gz' } }),
    ).rejects.toThrow(/damaged/);
    await expect(
      run(B.previewRestore, { source: { uploadPath: 'restore-uploads/u2/x.jsonl.gz' } }),
    ).rejects.toThrow(/not uploaded by you/);
  });

  it('never restores into another project', async () => {
    const rec = await run<{ id: string }>(B.createBackup, {});
    process.env.GCLOUD_PROJECT = 'cbo-candoni-prod';
    await expect(run(B.previewRestore, { source: { backupId: rec.id } })).rejects.toThrow(
      /only into the project/,
    );
    process.env.GCLOUD_PROJECT = 'cbo-candoni-dev';
  });
});
