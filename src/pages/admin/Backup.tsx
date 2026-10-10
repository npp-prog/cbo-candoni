import { useRef, useState } from 'react';
import { orderBy, limit } from 'firebase/firestore';
import { ref as storageRef, uploadBytes } from 'firebase/storage';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, TextArea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { useCollection } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { storage } from '@/lib/firebase';
import { engine, type BackupRecordView } from '@/lib/engine';
import { formatInstant } from '@/lib/dates';
import {
  APPEND_ONLY,
  BACKUP_KIND_LABELS,
  RESTORE_MODE_LABELS,
  type RestoreCounts,
  type RestoreMode,
  type BackupHeader,
} from '@/lib/backupFormat';

/**
 * Patch 172 - Administration > Backup and Restore.
 *
 * The file and the two kinds of restore are described in
 * src/lib/backupFormat.ts; the engine is functions/src/admin/backup.ts.
 * Super Administrator only.
 */

type Source = { backupId?: string; uploadPath?: string };

interface Preview {
  source: Source;
  file: string;
  header: BackupHeader;
  counts: Record<string, RestoreCounts>;
  effect: Record<RestoreMode, { created: number; overwritten: number; removed: number }>;
}

const kb = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

export default function Backup() {
  const { hasRole, user } = useAuth();
  const isAdmin = hasRole('SUPER_ADMIN');
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const backups = useCollection<BackupRecordView>(
    isAdmin ? COL.backups : null,
    [orderBy('createdAt', 'desc'), limit(100)],
    ['backups', isAdmin],
  );

  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  if (!isAdmin) {
    return (
      <>
        <PageHeader
          title="Backup and Restore"
          breadcrumbs={[{ label: 'Administration' }, { label: 'Backup and Restore' }]}
        />
        <Alert tone="info">Only the Super Administrator may take or restore a backup.</Alert>
      </>
    );
  }

  const backUpNow = async () => {
    setBusy('backup');
    try {
      const r = await engine.createBackup({ note: note.trim() || undefined });
      toast.success('Backup taken', `${r.fileName} - ${r.docCount.toLocaleString()} records.`);
      setNote('');
    } catch (err) {
      toast.error('Backup failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const download = async (b: BackupRecordView) => {
    setBusy(`dl-${b.id}`);
    try {
      const parts: BlobPart[] = [];
      let offset: number | null = 0;
      let name = b.fileName;
      while (offset !== null) {
        const r = await engine.readBackupChunk({ backupId: b.id, offset });
        name = r.fileName;
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        parts.push(bytes);
        offset = r.next;
      }
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/gzip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast.error('Download failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const check = async (source: Source) => {
    setBusy('preview');
    try {
      const r = await engine.previewRestore({ source });
      setPreview({ source, ...r });
    } catch (err) {
      toast.error('Cannot restore from it', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const uploadAndCheck = async (file: File) => {
    if (!user) return;
    setBusy('upload');
    try {
      const path = `restore-uploads/${user.uid}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
      await uploadBytes(storageRef(storage, path), file, { contentType: 'application/gzip' });
      await check({ uploadPath: path });
    } catch (err) {
      toast.error('Upload failed', err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const list = backups.data;

  return (
    <>
      <PageHeader
        title="Backup and Restore"
        breadcrumbs={[{ label: 'Administration' }, { label: 'Backup and Restore' }]}
        subtitle="A copy of every record in CFMS, as one file - and the way back from it."
      />

      <Card className="mb-4">
        <h2 className="text-base font-semibold text-navy-900">Back up now</h2>
        <p className="mt-1 text-sm text-slate-600">
          Every record in CFMS - budget, vouchers, ledger, treasury, master data, users and the
          audit trail - is written to one file, kept here and downloadable. CFMS also takes one
          every night at 2:15 am and keeps the last 30. Download one now and then to a computer or
          flash drive kept outside the office.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Note (optional)" className="min-w-[18rem] flex-1">
            <TextInput
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Before closing December"
            />
          </Field>
          <Button variant="primary" loading={busy === 'backup'} onClick={() => void backUpNow()}>
            Back up now
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          The file is <strong>.jsonl.gz</strong>: plain text (JSON Lines), compressed. Extract it
          with 7-Zip or WinRAR and it opens in Notepad. It ends with a check figure, so a file that
          was cut short or altered is refused on restore.
        </p>
      </Card>

      <Card className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-navy-900">Restore from a file</h2>
            <p className="mt-1 text-sm text-slate-600">
              A backup file kept on this computer (.jsonl.gz). CFMS checks it and shows what a
              restore would do before anything is changed.
            </p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".gz,.jsonl.gz,application/gzip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadAndCheck(f);
              e.target.value = '';
            }}
          />
          <Button
            variant="secondary"
            loading={busy === 'upload'}
            onClick={() => fileInput.current?.click()}
          >
            Choose a backup file
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 text-base font-semibold text-navy-900">Backups kept</h2>
        {backups.loading ? null : list.length === 0 ? (
          <p className="text-sm text-slate-500">No backup yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="cbo-th">Taken</th>
                  <th className="cbo-th">Kind</th>
                  <th className="cbo-th">By</th>
                  <th className="cbo-th text-right">Records</th>
                  <th className="cbo-th text-right">Size</th>
                  <th className="cbo-th" />
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td className="cbo-td">
                      {formatInstant(b.createdAt)}
                      <span className="block text-2xs text-slate-500">{b.fileName}</span>
                      {b.note && <span className="block text-xs text-slate-600">{b.note}</span>}
                    </td>
                    <td className="cbo-td">
                      <Badge
                        tone={
                          b.kind === 'SAFETY' ? 'amber' : b.kind === 'MANUAL' ? 'blue' : 'slate'
                        }
                      >
                        {BACKUP_KIND_LABELS[b.kind]}
                      </Badge>
                    </td>
                    <td className="cbo-td">{b.createdBy?.name}</td>
                    <td className="cbo-td text-right tabular-nums">
                      {b.docCount.toLocaleString()}
                    </td>
                    <td className="cbo-td text-right tabular-nums">{kb(b.size)}</td>
                    <td className="cbo-td">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === `dl-${b.id}`}
                          onClick={() => void download(b)}
                        >
                          Download
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === 'preview' && preview === null}
                          onClick={() => void check({ backupId: b.id })}
                        >
                          Restore...
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {preview && (
        <RestoreDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onDone={() => setPreview(null)}
        />
      )}
    </>
  );
}

function RestoreDialog({
  preview,
  onClose,
  onDone,
}: {
  preview: Preview;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<RestoreMode>('MISSING');
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [running, setRunning] = useState(false);
  const effect = preview.effect[mode];
  const nothing = effect.created + effect.overwritten + effect.removed === 0;
  const ready = confirm === 'RESTORE' && reason.trim().length >= 15 && !nothing;

  const rows = Object.entries(preview.counts).filter(([, c]) => c.missing || c.changed || c.newer);

  const run = async () => {
    setRunning(true);
    try {
      const r = await engine.restoreBackup({
        source: preview.source,
        mode,
        confirm,
        reason: reason.trim(),
      });
      toast.success(
        'Restored',
        `${r.created} record(s) put back, ${r.overwritten} returned to the backup, ${r.removed} removed.${
          r.safetyBackup ? ` A safety backup was taken first: ${r.safetyBackup}.` : ''
        }`,
      );
      onDone();
    } catch (err) {
      toast.error('Restore failed', err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      onClose={running ? () => {} : onClose}
      title="Restore from a backup"
      description={preview.file}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button variant="danger" loading={running} disabled={!ready} onClick={() => void run()}>
            Restore
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">
        Taken {formatInstant(preview.header.createdAt)} by {preview.header.createdBy} -{' '}
        {preview.header.docCount.toLocaleString()} records. The file checks out against its own
        check figure.
      </p>

      <div className="mt-3 max-h-64 overflow-auto">
        {rows.length === 0 ? (
          <Alert tone="success">The database already matches this backup exactly.</Alert>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="cbo-th">Collection</th>
                <th className="cbo-th text-right">Missing now</th>
                <th className="cbo-th text-right">Changed since</th>
                <th className="cbo-th text-right">Made after the backup</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, c]) => (
                <tr key={name}>
                  <td className="cbo-td">{name}</td>
                  <td className="cbo-td text-right tabular-nums">{c.missing || ''}</td>
                  <td className="cbo-td text-right tabular-nums">{c.changed || ''}</td>
                  <td className="cbo-td text-right tabular-nums">{c.newer || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {(['MISSING', 'REPLACE'] as RestoreMode[]).map((m) => (
          <label
            key={m}
            className={`flex cursor-pointer gap-3 rounded-md border p-3 ${
              mode === m ? 'border-brand-500 bg-brand-50' : 'border-slate-200'
            }`}
          >
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} className="mt-1" />
            <span className="text-sm">
              <span className="font-semibold text-navy-900">{RESTORE_MODE_LABELS[m]}</span>
              <span className="block text-slate-600">
                {m === 'MISSING'
                  ? `Every record of the backup that is no longer in CFMS is created again, as it was. Nothing that exists is touched. For records deleted or lost. Here: ${preview.effect.MISSING.created} record(s) put back.`
                  : `Every record goes back to what the backup holds: missing ones created, changed ones overwritten, records made after the backup removed. Work done since the backup is undone. A safety backup of CFMS as it is now is taken first. The audit trail (${APPEND_ONLY.join(', ')}) is only added to, never changed. Here: ${preview.effect.REPLACE.created} put back, ${preview.effect.REPLACE.overwritten} overwritten, ${preview.effect.REPLACE.removed} removed.`}
              </span>
            </span>
          </label>
        ))}
      </div>

      {mode === 'REPLACE' && !nothing && (
        <Alert tone="warning" className="mt-3">
          Ask everyone to stop working in CFMS until the restore has finished. Anything entered
          while it runs may be lost.
        </Alert>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Why the data is being restored" className="sm:col-span-2">
          <TextArea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Written to the audit trail. At least 15 characters."
          />
        </Field>
        <Field label="Type RESTORE to confirm">
          <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} />
        </Field>
      </div>
    </Modal>
  );
}
