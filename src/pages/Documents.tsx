import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { limit, orderBy, where } from 'firebase/firestore';
import { ref as storageRef, getDownloadURL } from 'firebase/storage';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useCollection } from '@/hooks/useFirestore';
import { useFilters } from '@/context/FilterContext';
import { storage } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { formatInstant } from '@/lib/dates';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type DocumentAttachment, type DocumentType } from '@/types/system';
import { fundLabel } from './budget/Obligations';

/**
 * Document management.
 *
 * Attachments are filed against the transaction they support, so this screen
 * is a way to search across all of them at once - useful when an auditor asks
 * for "every purchase order from the third quarter" rather than for the
 * documents behind one voucher.
 *
 * Files are opened through a signed URL obtained at click time rather than a
 * permanent public link, so access follows the Storage rules on every open.
 */
export default function Documents() {
  const { fiscalYear, fundCode } = useFilters();
  const toast = useToast();
  const [documentType, setDocumentType] = useState<string>('');
  const [entityType, setEntityType] = useState<string>('');

  const { data, loading, error } = useCollection<DocumentAttachment>(
    COL.documents,
    [
      where('fiscalYear', '==', fiscalYear),
      where('active', '==', true),
      orderBy('uploadedBy.at', 'desc'),
      limit(500),
    ],
    ['documents', fiscalYear],
  );

  const rows = useMemo(
    () =>
      data
        .filter((d) => d.fundCode === fundCode)
        .filter((d) => !documentType || d.documentType === documentType)
        .filter((d) => !entityType || d.entityType === entityType),
    [data, fundCode, documentType, entityType],
  );

  const open = async (path: string) => {
    try {
      const url = await getDownloadURL(storageRef(storage, path));
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error('Could not open the file', 'You may not have permission, or the file has been removed.');
    }
  };

  const linkFor = (doc: DocumentAttachment): string | null => {
    switch (doc.entityType) {
      case COL.disbursementVouchers:
        return `/accounting/disbursements/${doc.entityId}`;
      case COL.obligations:
        return `/budget/obligations/${doc.entityId}`;
      case COL.jevs:
        return `/accounting/others/${doc.entityId}`;
      default:
        return null;
    }
  };

  const columns: Column<DocumentAttachment>[] = [
    {
      key: 'fileName',
      header: 'File',
      value: (d) => d.fileName,
      cell: (d) => (
        <button
          onClick={() => void open(d.storagePath)}
          className="text-left text-sm font-medium text-brand-700 hover:underline"
        >
          {d.fileName}
        </button>
      ),
    },
    {
      key: 'documentType',
      header: 'Document type',
      width: '14rem',
      value: (d) => DOCUMENT_TYPE_LABELS[d.documentType] ?? d.documentType,
      cell: (d) => <span className="text-xs">{DOCUMENT_TYPE_LABELS[d.documentType] ?? d.documentType}</span>,
    },
    {
      key: 'entity',
      header: 'Filed against',
      value: (d) => d.entityRef,
      cell: (d) => {
        const to = linkFor(d);
        return to ? (
          <Link to={to} className="font-mono text-xs text-brand-700 hover:underline">
            {d.entityRef}
          </Link>
        ) : (
          <span className="font-mono text-xs text-slate-600">{d.entityRef}</span>
        );
      },
    },
    {
      key: 'size',
      header: 'Size',
      width: '6rem',
      align: 'right',
      kind: 'number',
      value: (d) => d.sizeBytes,
      cell: (d) => <span className="font-mono text-xs tabular">{(d.sizeBytes / 1024).toFixed(0)} KB</span>,
    },
    {
      key: 'uploaded',
      header: 'Uploaded',
      value: (d) => d.uploadedBy?.at ?? '',
      cell: (d) => (
        <div className="text-xs">
          <span className="text-navy-800">{d.uploadedBy?.name}</span>
          <span className="block text-slate-500">{formatInstant(d.uploadedBy?.at)}</span>
        </div>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      width: '5rem',
      align: 'center',
      value: (d) => d.version,
      cell: (d) => (d.version > 1 ? <Badge tone="violet">v{d.version}</Badge> : <span className="text-xs text-slate-400">v1</span>),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle={`Supporting documents - ${fundLabel(fundCode)}, fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Documents' }]}
      />

      <Alert tone="info" className="mb-4">
        Documents are attached to the transaction they support, from the voucher or obligation
        screen. Attachments are never overwritten: uploading a replacement creates a new version
        and marks the previous one superseded, so the evidence behind a payment cannot be quietly
        swapped.
      </Alert>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(d) => d.id}
        loading={loading}
        error={error}
        searchPlaceholder="File name, document reference or uploader"
        emptyTitle="No documents"
        emptyMessage="Supporting documents appear here once they are attached to a transaction."
        pageSize={50}
        filters={
          <>
            <Select
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Document type"
            >
              <option value="">All document types</option>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t as DocumentType]}
                </option>
              ))}
            </Select>
            <Select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Filed against"
            >
              <option value="">All transaction types</option>
              <option value={COL.disbursementVouchers}>Disbursement vouchers</option>
              <option value={COL.obligations}>Obligations</option>
              <option value={COL.jevs}>Journal entries</option>
              <option value={COL.liquidations}>Liquidations</option>
              <option value={COL.payrolls}>Payrolls</option>
            </Select>
          </>
        }
        exportMeta={{
          title: 'Document Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />
    </div>
  );
}
