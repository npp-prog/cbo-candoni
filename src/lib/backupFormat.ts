/**
 * Patch 172 - THE CFMS BACKUP FILE, and what a restore would do.
 *
 * ---------------------------------------------------------------------------
 * THE FILE
 * ---------------------------------------------------------------------------
 * A backup is ONE file, `CFMS-Backup_<project>_<date>_<time>.jsonl.gz`:
 *
 *   - JSON Lines: plain text, one record per line. Unzipped (7-Zip, WinRAR,
 *     or Windows' own "Extract") it opens in Notepad and can be read by any
 *     tool. Nothing in it is proprietary.
 *   - gzip-compressed, because the text of a year's ledger repeats itself a
 *     great deal and shrinks to about a tenth.
 *
 * Line 1 is the HEADER: what the file is, which Firebase project it came
 * from, when, by whom, and how many records of each collection it holds.
 * Then one line per Firestore document:
 *
 *   {"c":"vouchers","id":"abc123","d":{ ...every field... }}
 *
 * The last line is the FOOTER: the record count again and a SHA-256 of all
 * the record lines. A file that was cut short, edited or damaged no longer
 * matches its own footer, and CFMS refuses to restore from it rather than
 * restore half a set of books.
 *
 * Firestore values JSON has no word for - a timestamp, a document reference,
 * a location, raw bytes - are written as a small tagged object,
 * {"__cfms":"ts", ...}, and turned back into the real thing on restore.
 *
 * Shared by the browser (what the screen explains) and the engine (which
 * writes and reads the files) - scripts/sync-rules.
 */

export const BACKUP_FORMAT = 'CFMS-BACKUP';
export const BACKUP_VERSION = 1;

export type BackupKind = 'MANUAL' | 'AUTOMATIC' | 'SAFETY';

export const BACKUP_KIND_LABELS: Record<BackupKind, string> = {
  MANUAL: 'Taken by hand',
  AUTOMATIC: 'Nightly',
  SAFETY: 'Before a restore',
};

/** Automatic (nightly) backups kept; older ones are removed. */
export const AUTOMATIC_KEPT = 30;

/**
 * Not backed up: the register of backups itself (it describes the files, it
 * is not data of the books).
 */
export const NOT_BACKED_UP = ['backups'];

/**
 * The audit trail is never overwritten or deleted by a restore - not even by
 * "return everything to the backup". A restore can only put back audit
 * entries that are missing. The record of what happened, including the
 * restore itself, survives every restore.
 */
export const APPEND_ONLY = ['auditLogs'];

export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  version: number;
  projectId: string;
  createdAt: string;
  createdBy: string;
  kind: BackupKind;
  note?: string | null;
  /** Records per collection. */
  collections: Record<string, number>;
  docCount: number;
}

export interface BackupFooter {
  end: true;
  docCount: number;
  /** SHA-256, hex, of the record lines joined with "\n". */
  sha256: string;
}

export interface BackupRecordLine {
  /** Collection. */
  c: string;
  id: string;
  /** The document's fields, encoded. */
  d: Record<string, unknown>;
}

/** e.g. CFMS-Backup_cbo-candoni-prod_2026-10-10_1530.jsonl.gz (Philippine time). */
export function backupFileName(projectId: string, isoInstant: string, kind: BackupKind): string {
  const ph = new Date(new Date(isoInstant).getTime() + 8 * 3600 * 1000).toISOString();
  const stamp = `${ph.slice(0, 10)}_${ph.slice(11, 13)}${ph.slice(14, 16)}${ph.slice(17, 19)}`;
  const tag = kind === 'MANUAL' ? '' : kind === 'AUTOMATIC' ? '_nightly' : '_before-restore';
  return `CFMS-Backup_${projectId}_${stamp}${tag}.jsonl.gz`;
}

/**
 * JSON with the keys of every object in sorted order, so two copies of the
 * same document always give the same text - which is how a restore tells a
 * document that changed from one that did not.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

// ---------------------------------------------------------------------------
// What a restore would do
// ---------------------------------------------------------------------------

/**
 *   MISSING  Put back what is missing. Every record in the backup that is no
 *            longer in the database is created again, exactly as it was.
 *            Nothing that exists is touched. Safe at any time - for a record
 *            deleted by mistake, a collection lost.
 *   REPLACE  Return the database to the backup. Every record goes back to
 *            what the backup holds: missing ones are created, changed ones
 *            are overwritten, and records made after the backup are removed.
 *            For damage that cannot be repaired record by record. Work done
 *            since the backup is undone - which is why a safety backup is
 *            taken first, automatically. The audit trail is only added to.
 */
export type RestoreMode = 'MISSING' | 'REPLACE';

export const RESTORE_MODE_LABELS: Record<RestoreMode, string> = {
  MISSING: 'Put back what is missing',
  REPLACE: 'Return everything to the backup',
};

export interface RestoreCounts {
  /** Records of this collection in the backup. */
  inBackup: number;
  /** In the backup, not in the database. */
  missing: number;
  /** In both, but different. */
  changed: number;
  /** In both and the same. */
  same: number;
  /** In the database, not in the backup (made after it). */
  newer: number;
}

/**
 * Compares a backup with the database, collection by collection. Each side
 * is given as collection -> (id -> the record's stable text).
 */
export function compareForRestore(
  backup: Map<string, Map<string, string>>,
  database: Map<string, Map<string, string>>,
): Record<string, RestoreCounts> {
  const out: Record<string, RestoreCounts> = {};
  const names = new Set([...backup.keys(), ...database.keys()]);
  for (const name of [...names].sort()) {
    if (NOT_BACKED_UP.includes(name)) continue;
    const b = backup.get(name) ?? new Map<string, string>();
    const d = database.get(name) ?? new Map<string, string>();
    const c: RestoreCounts = { inBackup: b.size, missing: 0, changed: 0, same: 0, newer: 0 };
    for (const [id, text] of b) {
      const now = d.get(id);
      if (now === undefined) c.missing++;
      else if (now === text) c.same++;
      else c.changed++;
    }
    for (const id of d.keys()) if (!b.has(id)) c.newer++;
    out[name] = c;
  }
  return out;
}

/** What each mode would write, in all. */
export function restoreEffect(
  counts: Record<string, RestoreCounts>,
  mode: RestoreMode,
): { created: number; overwritten: number; removed: number } {
  let created = 0;
  let overwritten = 0;
  let removed = 0;
  for (const [name, c] of Object.entries(counts)) {
    created += c.missing;
    if (mode === 'REPLACE' && !APPEND_ONLY.includes(name)) {
      overwritten += c.changed;
      removed += c.newer;
    }
  }
  return { created, overwritten, removed };
}

// ---------------------------------------------------------------------------
// Writing and reading the file's text
// ---------------------------------------------------------------------------

export type Records = Map<string, Map<string, Record<string, unknown>>>;

/** A refusal while reading a backup; `wrongProject` marks the one that is not damage. */
export class BackupFileError extends Error {
  constructor(
    message: string,
    readonly wrongProject = false,
  ) {
    super(message);
  }
}

/**
 * The whole text of a backup file, before compression. Collections and
 * records in name order, so the same database always gives the same file.
 * `sha256` is passed in (the engine uses Node's), so this file stays free of
 * any library.
 */
export function buildBackupText(
  records: Records,
  meta: Pick<BackupHeader, 'projectId' | 'createdAt' | 'createdBy' | 'kind' | 'note'>,
  sha256: (text: string) => string,
): { text: string; header: BackupHeader; footer: BackupFooter } {
  const lines: string[] = [];
  const collections: Record<string, number> = {};
  for (const [name, docs] of [...records].sort(([a], [b]) => a.localeCompare(b))) {
    if (NOT_BACKED_UP.includes(name)) continue;
    collections[name] = docs.size;
    for (const [id, d] of [...docs].sort(([a], [b]) => a.localeCompare(b))) {
      const line: BackupRecordLine = { c: name, id, d };
      lines.push(stableStringify(line));
    }
  }
  const body = lines.join('\n');
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    ...meta,
    collections,
    docCount: lines.length,
  };
  const footer: BackupFooter = { end: true, docCount: lines.length, sha256: sha256(body) };
  const text = [
    JSON.stringify(header),
    ...(lines.length ? [body] : []),
    JSON.stringify(footer),
  ].join('\n');
  return { text, header, footer };
}

/**
 * Reads a backup file's text back, refusing anything that is not a CFMS
 * backup, was cut short or altered (its check figure no longer matches), was
 * made by a newer CFMS, or came from another Firebase project.
 */
export function parseBackupText(
  text: string,
  expectedProject: string,
  sha256: (text: string) => string,
  label: string,
): { header: BackupHeader; records: Records } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  let header: BackupHeader;
  let footer: BackupFooter;
  try {
    header = JSON.parse(lines[0]) as BackupHeader;
    footer = JSON.parse(lines[lines.length - 1]) as BackupFooter;
  } catch {
    throw new BackupFileError(
      `${label} is not a CFMS backup file: its first or last line cannot be read.`,
    );
  }
  if (lines.length < 2 || header?.format !== BACKUP_FORMAT || footer?.end !== true) {
    throw new BackupFileError(`${label} is not a CFMS backup file.`);
  }
  if (header.version > BACKUP_VERSION) {
    throw new BackupFileError(
      `${label} was made by a newer CFMS (format ${header.version}). Update CFMS first.`,
    );
  }
  const body = lines.slice(1, -1);
  if (body.length !== footer.docCount || sha256(body.join('\n')) !== footer.sha256) {
    throw new BackupFileError(
      `${label} is damaged or was changed after it was made: its contents no longer match its own check figure. Nothing can be restored from it.`,
    );
  }
  if (header.projectId !== expectedProject) {
    throw new BackupFileError(
      `${label} was taken from the Firebase project "${header.projectId}", and this is "${expectedProject}". A backup is restored only into the project it came from, so development and production data never mix.`,
      true,
    );
  }
  const records: Records = new Map();
  for (const l of body) {
    const r = JSON.parse(l) as BackupRecordLine;
    if (!records.has(r.c)) records.set(r.c, new Map());
    records.get(r.c)!.set(r.id, r.d);
  }
  return { header, records };
}
