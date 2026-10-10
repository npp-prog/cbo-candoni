import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BackupFileError,
  backupFileName,
  buildBackupText,
  compareForRestore,
  parseBackupText,
  restoreEffect,
  stableStringify,
  type Records,
} from './backupFormat';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const meta = {
  projectId: 'cbo-candoni-prod',
  createdAt: '2026-10-10T07:30:00.000Z',
  createdBy: 'Neil',
  kind: 'MANUAL' as const,
  note: null,
};
const db = (): Records => {
  const m: Records = new Map();
  m.set(
    'vouchers',
    new Map<string, Record<string, unknown>>([
      ['v1', { amount: 100, payee: 'A' }],
      ['v2', { amount: 200 }],
    ]),
  );
  m.set('auditLogs', new Map<string, Record<string, unknown>>([['a1', { e: 'one' }]]));
  m.set('backups', new Map<string, Record<string, unknown>>([['b1', { fileName: 'x' }]]));
  return m;
};

describe('the backup file', () => {
  it('reads back exactly what was written, without the backup register', () => {
    const { text, header } = buildBackupText(db(), meta, sha);
    expect(header.collections).toEqual({ auditLogs: 1, vouchers: 2 });
    const back = parseBackupText(text, 'cbo-candoni-prod', sha, 'f');
    expect(back.records.get('vouchers')!.get('v1')).toEqual({ amount: 100, payee: 'A' });
    expect(back.records.has('backups')).toBe(false);
    expect(back.header.docCount).toBe(3);
  });

  it('is plain text, one record to a line', () => {
    const { text } = buildBackupText(db(), meta, sha);
    const lines = text.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('{"c":"auditLogs","d":{"e":"one"},"id":"a1"}');
  });

  it('refuses a file that was altered or cut short', () => {
    const { text } = buildBackupText(db(), meta, sha);
    expect(() =>
      parseBackupText(text.replace('"amount":200', '"amount":201'), 'cbo-candoni-prod', sha, 'f'),
    ).toThrow(/damaged/);
    const cut = text.split('\n');
    cut.splice(2, 1);
    expect(() => parseBackupText(cut.join('\n'), 'cbo-candoni-prod', sha, 'f')).toThrow(/damaged/);
    expect(() => parseBackupText('hello', 'cbo-candoni-prod', sha, 'f')).toThrow(BackupFileError);
  });

  it('refuses a backup from another project', () => {
    const { text } = buildBackupText(db(), meta, sha);
    try {
      parseBackupText(text, 'cbo-candoni-dev', sha, 'f');
      expect.unreachable();
    } catch (e) {
      expect((e as BackupFileError).wrongProject).toBe(true);
    }
  });

  it('names the file by project, date and time (Philippine time)', () => {
    expect(backupFileName('cbo-candoni-prod', meta.createdAt, 'MANUAL')).toBe(
      'CFMS-Backup_cbo-candoni-prod_2026-10-10_153000.jsonl.gz',
    );
    expect(backupFileName('p', meta.createdAt, 'AUTOMATIC')).toMatch(/_nightly\.jsonl\.gz$/);
  });
});

describe('what a restore would do', () => {
  const text = (r: Records) =>
    new Map(
      [...r].map(([c, m]) => [c, new Map([...m].map(([id, d]) => [id, stableStringify(d)]))]),
    );

  it('counts missing, changed and newer records, collection by collection', () => {
    const backup = db();
    const now = db();
    now.get('vouchers')!.delete('v1');
    now.get('vouchers')!.set('v2', { amount: 999 });
    now.get('vouchers')!.set('v3', { amount: 3 });
    now.get('auditLogs')!.set('a1', { e: 'changed' });
    now.get('auditLogs')!.set('a2', { e: 'new' });
    const counts = compareForRestore(text(backup), text(now));
    expect(counts.vouchers).toEqual({ inBackup: 2, missing: 1, changed: 1, same: 0, newer: 1 });
    expect(counts.backups).toBeUndefined();
    expect(restoreEffect(counts, 'MISSING')).toEqual({ created: 1, overwritten: 0, removed: 0 });
    // The audit trail is only added to, even when everything else is returned.
    expect(restoreEffect(counts, 'REPLACE')).toEqual({ created: 1, overwritten: 1, removed: 1 });
  });
});
