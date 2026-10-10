import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION, storage } from '../lib/firebase';
import { requireCaller, invalid, type Caller, type Role } from '../lib/context';
import { audit } from '../lib/audit';
import {
  APPEND_ONLY,
  AUTOMATIC_KEPT,
  NOT_BACKED_UP,
  BackupFileError,
  backupFileName,
  buildBackupText,
  compareForRestore,
  parseBackupText,
  restoreEffect,
  stableStringify,
  type BackupHeader,
  type BackupKind,
  type Records,
  type RestoreCounts,
  type RestoreMode,
} from '../lib/backupFormat';
import { decodeValue, encodeValue } from '../lib/backupValues';

/**
 * Patch 172 - BACKUP AND RESTORE.
 *
 * The file format, and what each kind of restore does, is described in
 * src/lib/backupFormat.ts. This is the engine:
 *
 *   createBackup        Super Administrator: back up now.
 *   nightlyBackup       Every night at 02:15, Philippine time. The last 30
 *                       are kept.
 *   readBackupChunk     Hands a stored backup to the Super Administrator's
 *                       browser, a piece at a time, to save as a file.
 *   previewRestore      Reads a backup - a stored one, or a file uploaded
 *                       from the computer - checks it against its own
 *                       footer, and says what a restore would do, collection
 *                       by collection. Writes nothing.
 *   restoreBackup       Does it. Super Administrator only, with the word
 *                       RESTORE typed and a reason; a safety backup is taken
 *                       first when records would be overwritten or removed.
 *
 * The files are kept in the project's Cloud Storage under backups/, which no
 * browser can read or write directly (storage.rules). They leave only
 * through readBackupChunk, which checks the role every time.
 *
 * A backup taken from one Firebase project is never restored into another:
 * development data must not reach production, nor production data
 * development.
 */

const SUPER_ADMIN: Role[] = ['SUPER_ADMIN'];
const LONG = {
  region: REGION,
  enforceAppCheck: ENFORCE_APP_CHECK,
  timeoutSeconds: 1800,
  memory: '2GiB' as const,
};
const CHUNK = 4 * 1024 * 1024;

const projectId = (): string =>
  process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? 'unknown-project';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const refFor = (path: string) => db.doc(path);

// ---------------------------------------------------------------------------
// The database, read whole
// ---------------------------------------------------------------------------

async function readDatabase(): Promise<Records> {
  const out: Records = new Map();
  const collections = await db.listCollections();
  for (const col of collections) {
    if (NOT_BACKED_UP.includes(col.id)) continue;
    const snap = await col.get();
    const docs = new Map<string, Record<string, unknown>>();
    for (const d of snap.docs) docs.set(d.id, encodeValue(d.data()) as Record<string, unknown>);
    out.set(col.id, docs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing a backup
// ---------------------------------------------------------------------------

export interface BackupRecord {
  id: string;
  fileName: string;
  path: string;
  kind: BackupKind;
  note: string | null;
  createdAt: string;
  createdBy: { uid: string; name: string };
  collections: Record<string, number>;
  docCount: number;
  size: number;
  sha256: string;
}

async function writeBackup(
  who: { uid: string; name: string },
  kind: BackupKind,
  note: string | null,
): Promise<BackupRecord> {
  const data = await readDatabase();
  const createdAt = new Date().toISOString();
  const project = projectId();
  const { text, header, footer } = buildBackupText(
    data,
    { projectId: project, createdAt, createdBy: who.name, kind, note },
    sha256,
  );
  const collections = header.collections;
  const docCount = header.docCount;
  const sha = footer.sha256;
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });

  const fileName = backupFileName(project, createdAt, kind);
  const path = `backups/${fileName}`;
  await storage
    .bucket()
    .file(path)
    .save(gz, {
      resumable: false,
      contentType: 'application/gzip',
      metadata: { contentDisposition: `attachment; filename="${fileName}"` },
    });

  const ref = db.collection(COL.backups).doc();
  const record: BackupRecord = {
    id: ref.id,
    fileName,
    path,
    kind,
    note,
    createdAt,
    createdBy: who,
    collections,
    docCount,
    size: gz.length,
    sha256: sha,
  };
  await ref.set(record);
  return record;
}

const SYSTEM: Caller = {
  uid: 'system',
  email: '',
  name: 'CFMS nightly backup',
  roles: ['SYSTEM'],
  officeScope: [],
  fundScope: [],
};

export const createBackup = onCall(LONG, async (request) => {
  const caller = await requireCaller(request, SUPER_ADMIN);
  const { note } = (request.data ?? {}) as { note?: string };
  const record = await writeBackup(
    { uid: caller.uid, name: caller.name },
    'MANUAL',
    note?.trim().slice(0, 300) || null,
  );
  await audit({
    caller,
    event: 'EXPORT',
    entityType: COL.backups,
    entityId: record.id,
    entityRef: record.fileName,
    remarks: `Backup taken: ${record.docCount} records, ${(record.size / 1024).toFixed(0)} KB.`,
    severity: 'NOTICE',
  });
  return record;
});

export const nightlyBackup = onSchedule(
  {
    schedule: '15 2 * * *',
    timeZone: 'Asia/Manila',
    region: REGION,
    timeoutSeconds: 1800,
    memory: '2GiB',
  },
  async () => {
    const record = await writeBackup({ uid: 'system', name: SYSTEM.name }, 'AUTOMATIC', null);
    // Keep the newest AUTOMATIC_KEPT nightly backups; the hand-taken and the
    // safety backups are never removed by this.
    const old = await db
      .collection(COL.backups)
      .where('kind', '==', 'AUTOMATIC')
      .orderBy('createdAt', 'desc')
      .offset(AUTOMATIC_KEPT)
      .get();
    for (const d of old.docs) {
      const path = d.data().path as string | undefined;
      if (path) await storage.bucket().file(path).delete({ ignoreNotFound: true });
      await d.ref.delete();
    }
    await audit({
      caller: SYSTEM,
      event: 'EXPORT',
      entityType: COL.backups,
      entityId: record.id,
      entityRef: record.fileName,
      remarks: `Nightly backup: ${record.docCount} records.${old.size ? ` ${old.size} older nightly backup(s) removed.` : ''}`,
      severity: 'INFO',
    });
    logger.info('Nightly backup written', { file: record.fileName, records: record.docCount });
  },
);

// ---------------------------------------------------------------------------
// Handing a backup to the browser
// ---------------------------------------------------------------------------

export const readBackupChunk = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK, memory: '1GiB' },
  async (request) => {
    const caller = await requireCaller(request, SUPER_ADMIN);
    const { backupId, offset } = (request.data ?? {}) as { backupId?: string; offset?: number };
    if (!backupId) throw invalid('Which backup?');
    const snap = await db.collection(COL.backups).doc(backupId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'That backup is no longer kept.');
    const rec = snap.data() as BackupRecord;
    const start = Math.max(0, Math.floor(Number(offset ?? 0)));
    const end = Math.min(rec.size, start + CHUNK);
    const [buf] = await storage
      .bucket()
      .file(rec.path)
      .download({ start, end: end - 1 });
    if (start === 0) {
      await audit({
        caller,
        event: 'DOWNLOAD',
        entityType: COL.backups,
        entityId: rec.id,
        entityRef: rec.fileName,
        remarks: 'Backup file downloaded.',
        severity: 'NOTICE',
      });
    }
    return {
      fileName: rec.fileName,
      size: rec.size,
      offset: start,
      next: end < rec.size ? end : null,
      data: buf.toString('base64'),
    };
  },
);

// ---------------------------------------------------------------------------
// Reading a backup back
// ---------------------------------------------------------------------------

interface Source {
  backupId?: string;
  /** A file the Super Administrator uploaded: restore-uploads/{uid}/... */
  uploadPath?: string;
}

interface ParsedBackup {
  header: BackupHeader;
  records: Records;
  label: string;
}

async function loadSource(caller: Caller, source: Source | undefined): Promise<ParsedBackup> {
  let path: string;
  let label: string;
  if (source?.backupId) {
    const snap = await db.collection(COL.backups).doc(source.backupId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'That backup is no longer kept.');
    const rec = snap.data() as BackupRecord;
    path = rec.path;
    label = rec.fileName;
  } else if (source?.uploadPath) {
    if (!source.uploadPath.startsWith(`restore-uploads/${caller.uid}/`)) {
      throw new HttpsError('permission-denied', 'That file was not uploaded by you.');
    }
    path = source.uploadPath;
    label = source.uploadPath.split('/').pop() ?? source.uploadPath;
  } else {
    throw invalid('Choose a backup, or upload a backup file.');
  }

  const [gz] = await storage.bucket().file(path).download();
  let text: string;
  try {
    text = gunzipSync(gz).toString('utf8');
  } catch {
    throw invalid(
      `${label} is not a CFMS backup file (it is not a .jsonl.gz file, or it is damaged).`,
    );
  }
  try {
    const { header, records } = parseBackupText(text, projectId(), sha256, label);
    return { header, records, label };
  } catch (err) {
    if (err instanceof BackupFileError) {
      throw new HttpsError(
        err.wrongProject ? 'failed-precondition' : 'invalid-argument',
        err.message,
      );
    }
    throw err;
  }
}

function asText(m: Records) {
  const out = new Map<string, Map<string, string>>();
  for (const [c, docs] of m) {
    const t = new Map<string, string>();
    for (const [id, d] of docs) t.set(id, stableStringify(d));
    out.set(c, t);
  }
  return out;
}

export const previewRestore = onCall(LONG, async (request) => {
  const caller = await requireCaller(request, SUPER_ADMIN);
  const { source } = (request.data ?? {}) as { source?: Source };
  const backup = await loadSource(caller, source);
  const current = await readDatabase();
  const counts = compareForRestore(asText(backup.records), asText(current));
  return {
    file: backup.label,
    header: backup.header,
    counts,
    effect: {
      MISSING: restoreEffect(counts, 'MISSING'),
      REPLACE: restoreEffect(counts, 'REPLACE'),
    },
  };
});

export const restoreBackup = onCall(LONG, async (request) => {
  const caller = await requireCaller(request, SUPER_ADMIN);
  const { source, mode, confirm, reason } = (request.data ?? {}) as {
    source?: Source;
    mode?: RestoreMode;
    confirm?: string;
    reason?: string;
  };
  if (mode !== 'MISSING' && mode !== 'REPLACE') throw invalid('Choose what the restore should do.');
  if (confirm !== 'RESTORE') throw invalid('Type RESTORE to confirm.');
  if (!reason || reason.trim().length < 15) {
    throw invalid('Say why the data is being restored (at least 15 characters).');
  }

  const backup = await loadSource(caller, source);
  const current = await readDatabase();
  const backupText = asText(backup.records);
  const currentText = asText(current);
  const counts = compareForRestore(backupText, currentText);
  const effect = restoreEffect(counts, mode);

  // A safety copy of the database as it stands, before anything is
  // overwritten or removed - so a restore can itself be undone.
  let safety: BackupRecord | null = null;
  if (effect.overwritten > 0 || effect.removed > 0) {
    safety = await writeBackup(
      { uid: caller.uid, name: caller.name },
      'SAFETY',
      `Before restoring ${backup.label}`,
    );
  }

  const writer = db.bulkWriter();
  let created = 0;
  let overwritten = 0;
  let removed = 0;
  for (const [name, docs] of backup.records) {
    if (NOT_BACKED_UP.includes(name)) continue;
    const now = currentText.get(name) ?? new Map<string, string>();
    const appendOnly = APPEND_ONLY.includes(name);
    for (const [id, d] of docs) {
      const existing = now.get(id);
      if (existing === undefined) {
        void writer.set(
          db.collection(name).doc(id),
          decodeValue(d, refFor) as Record<string, unknown>,
        );
        created++;
      } else if (mode === 'REPLACE' && !appendOnly && existing !== backupText.get(name)!.get(id)) {
        void writer.set(
          db.collection(name).doc(id),
          decodeValue(d, refFor) as Record<string, unknown>,
        );
        overwritten++;
      }
    }
  }
  if (mode === 'REPLACE') {
    for (const [name, docs] of current) {
      if (NOT_BACKED_UP.includes(name) || APPEND_ONLY.includes(name)) continue;
      const kept = backup.records.get(name);
      for (const id of docs.keys()) {
        if (!kept?.has(id)) {
          void writer.delete(db.collection(name).doc(id));
          removed++;
        }
      }
    }
  }
  await writer.close();

  if (source?.uploadPath) {
    await storage.bucket().file(source.uploadPath).delete({ ignoreNotFound: true });
  }

  await audit({
    caller,
    event: 'SETTINGS_CHANGE',
    entityType: COL.backups,
    entityRef: `Restore from ${backup.label}`,
    remarks: `${mode === 'MISSING' ? 'Put back what was missing' : 'Returned everything to the backup'} from ${backup.label} (taken ${backup.header.createdAt} by ${backup.header.createdBy}): ${created} record(s) created, ${overwritten} overwritten, ${removed} removed.${safety ? ` Safety backup ${safety.fileName}.` : ''} Reason: ${reason.trim()}`,
    severity: 'CRITICAL',
  });

  return {
    created,
    overwritten,
    removed,
    safetyBackup: safety?.fileName ?? null,
    counts: counts as Record<string, RestoreCounts>,
  };
});
