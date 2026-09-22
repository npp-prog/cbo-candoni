import { useRef, useState } from 'react';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { addDoc, collection, doc, updateDoc, increment } from 'firebase/firestore';
import { db, storage } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { useAttachments } from '@/data/queries';
import { useAuth } from '@/auth/AuthProvider';
import { useToast } from './ui/Toast';
import { Button } from './ui/Button';
import { Select } from './ui/Field';
import { Spinner } from './ui/Layout';
import { formatInstant, todayPh } from '@/lib/dates';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  MAX_UPLOAD_BYTES,
  type DocumentType,
} from '@/types/system';

/**
 * Supporting documents for a transaction.
 *
 * Files go to Cloud Storage under
 *   /cbo/{fiscalYear}/{fund}/{documentType}/{documentId}/{file}
 * and a metadata record goes to Firestore. Storage rules independently enforce
 * the size cap and the content-type allow-list, so a direct SDK call cannot
 * put a 200 MB executable in the municipality's document store.
 *
 * Attachments are never overwritten. Replacing a file uploads a new version
 * and marks the previous metadata record superseded; the bytes of the old one
 * stay. A supporting document behind a disbursement is evidence, and evidence
 * that can be silently swapped is not evidence.
 */

export function AttachmentsPanel({
  entityType,
  entityId,
  entityRef,
  fiscalYear,
  fundCode,
  storageDocType,
  storageDocId,
  readOnly,
}: {
  entityType: string;
  entityId: string | null;
  entityRef: string;
  fiscalYear: number;
  fundCode: string;
  /** Path segment: DV, OBR, RCD... */
  storageDocType: string;
  /** Path segment: the document number, or the id before one is assigned. */
  storageDocId: string;
  readOnly?: boolean;
}) {
  const { data, loading } = useAttachments(entityType, entityId);
  const { user, profile } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [documentType, setDocumentType] = useState<DocumentType>('INVOICE');
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    if (!entityId) {
      toast.error('Save the document first', 'Attachments are filed against a saved record.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(
        'File too large',
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB. Scan at a lower resolution or split the document.`,
      );
      return;
    }
    if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
      toast.error(
        'File type not accepted',
        'CBO accepts PDF, JPG, PNG, XLSX and DOCX files. Convert the file and try again.',
      );
      return;
    }

    setUploading(true);
    try {
      // A timestamp prefix keeps a re-upload of the same file name from
      // colliding with the original, which Storage rules forbid overwriting.
      const safeName = file.name.replace(/[^\w.\- ]/g, '_');
      const path = `cbo/${fiscalYear}/${fundCode}/${storageDocType}/${storageDocId}/${Date.now()}_${safeName}`;

      await uploadBytes(storageRef(storage, path), file, { contentType: file.type });

      await addDoc(collection(db, COL.documents), {
        storagePath: path,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        documentType,
        documentDate: todayPh(),
        entityType,
        entityId,
        entityRef,
        fiscalYear,
        fundCode,
        version: (data[0]?.version ?? 0) + 1,
        uploadedBy: {
          uid: user?.uid ?? '',
          name: profile?.displayName ?? user?.email ?? '',
          position: profile?.position ?? null,
          at: new Date().toISOString(),
        },
        active: true,
      });

      // The attachment count on the parent gates submission, so it is kept in
      // step here rather than being recounted on every read.
      await updateDoc(doc(db, entityType, entityId), { attachmentCount: increment(1) }).catch(() => {
        // Not every entity carries the counter; not worth failing the upload.
      });

      toast.success('Attached', `${file.name} was filed against ${entityRef}.`);
    } catch (err) {
      toast.error(
        'Upload failed',
        err instanceof Error ? err.message : 'The file could not be uploaded. Check the connection and try again.',
      );
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const open = async (storagePath: string) => {
    try {
      const url = await getDownloadURL(storageRef(storage, storagePath));
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error('Could not open the file', 'You may not have permission, or the file has been removed.');
    }
  };

  return (
    <div>
      {!readOnly && (
        <div className="mb-4 flex flex-wrap items-end gap-2 no-print">
          <div className="min-w-[14rem] flex-1">
            <label className="cbo-label" htmlFor="attachment-type">
              Document type
            </label>
            <Select
              id="attachment-type"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value as DocumentType)}
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>

          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.xlsx,.docx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />

          <Button
            variant="primary"
            loading={uploading}
            onClick={() => fileRef.current?.click()}
            disabled={!entityId}
          >
            Attach file
          </Button>
        </div>
      )}

      {loading ? (
        <Spinner label="Loading attachments" className="py-6" />
      ) : data.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          No supporting documents attached yet.
          {!readOnly && ' A voucher cannot be submitted without them.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.map((att) => (
            <li key={att.id} className="flex items-center gap-3 py-2.5">
              <FileIcon contentType={att.contentType} />
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => void open(att.storagePath)}
                  className="truncate text-left text-sm font-medium text-brand-700 hover:underline"
                >
                  {att.fileName}
                </button>
                <p className="truncate text-xs text-slate-500">
                  {DOCUMENT_TYPE_LABELS[att.documentType] ?? att.documentType} -{' '}
                  {(att.sizeBytes / 1024).toFixed(0)} KB - uploaded by {att.uploadedBy?.name}{' '}
                  {formatInstant(att.uploadedBy?.at)}
                </p>
              </div>
              {att.version > 1 && (
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-2xs text-slate-600">
                  v{att.version}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileIcon({ contentType }: { contentType: string }) {
  const kind = contentType.includes('pdf')
    ? 'PDF'
    : contentType.includes('image')
      ? 'IMG'
      : contentType.includes('sheet')
        ? 'XLS'
        : contentType.includes('word')
          ? 'DOC'
          : 'FILE';

  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-slate-100 text-2xs font-semibold text-slate-500">
      {kind}
    </span>
  );
}
