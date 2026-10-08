import { useMemo, useState } from 'react';
import { ReturnLink } from '@/components/ui/BackButton';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Select, TextInput } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useAuditLogs } from '@/data/queries';
import { formatInstant } from '@/lib/dates';
import { COL } from '@/lib/collections';
import type { AuditLog } from '@/types/system';

/**
 * The audit trail.
 *
 * Immutable and append-only: security rules deny every client write, update
 * and delete on `auditLogs`, and the accounting engine writes each record
 * inside the same Firestore transaction as the change it describes. An audit
 * entry written afterwards, outside the transaction, can be lost if the
 * process dies in between - which would leave a financial change with no
 * record of who made it.
 *
 * The default view is critical events only. Over a year the trail runs to tens
 * of thousands of rows, and a reviewer opening this screen almost always wants
 * the small number that matter: budget overrides, reopened periods, reversed
 * entries, permission changes and settings changes.
 */

const EVENT_LABELS: Record<string, string> = {
  LOGIN: 'Sign-in',
  LOGIN_FAILED: 'Failed sign-in',
  LOGOUT: 'Sign-out',
  CREATE: 'Created',
  EDIT: 'Edited',
  SUBMIT: 'Submitted',
  REVIEW: 'Reviewed',
  APPROVE: 'Approved',
  CERTIFY: 'Certified',
  POST: 'Posted',
  CANCEL: 'Cancelled',
  REVERSE: 'Reversed',
  PRINT: 'Printed',
  EXPORT: 'Exported',
  UPLOAD: 'Uploaded',
  DOWNLOAD: 'Downloaded',
  PERMISSION_CHANGE: 'Permission change',
  PERIOD_CLOSE: 'Period closed',
  PERIOD_REOPEN: 'Period reopened',
  BUDGET_OVERRIDE: 'Budget override',
  ATTACHMENTS_LOCKED: 'Supporting documents closed',
  SETTINGS_CHANGE: 'Settings change',
};

export default function AuditTrail() {
  const [severity, setSeverity] = useState<string>('CRITICAL');
  const [event, setEvent] = useState<string>('');
  const [actor, setActor] = useState<string>('');
  const [detail, setDetail] = useState<AuditLog | null>(null);

  const { data, loading, error } = useAuditLogs({ severity: severity || undefined });

  const rows = useMemo(
    () =>
      data
        .filter((l) => !event || l.event === event)
        .filter((l) => !actor || l.actorName?.toLowerCase().includes(actor.toLowerCase())),
    [data, event, actor],
  );

  const criticalCount = data.filter((l) => l.severity === 'CRITICAL').length;

  const linkFor = (log: AuditLog): string | null => {
    switch (log.entityType) {
      case COL.disbursementVouchers:
        return `/accounting/disbursements/${log.entityId}`;
      case COL.obligations:
        return `/budget/obligations/${log.entityId}`;
      case COL.jevs:
        return `/accounting/general-transactions/${log.entityId}`;
      default:
        return null;
    }
  };

  const columns: Column<AuditLog>[] = [
    {
      key: 'at',
      header: 'When',
      width: '13rem',
      value: (l) => l.at,
      cell: (l) => <span className="text-xs text-navy-800">{formatInstant(l.at)}</span>,
    },
    {
      key: 'actor',
      header: 'User',
      value: (l) => l.actorName,
      cell: (l) => (
        <div>
          <span className="text-sm text-navy-900">{l.actorName}</span>
          <span className="block text-2xs text-slate-500">{(l.actorRoles ?? []).join(', ')}</span>
        </div>
      ),
    },
    {
      key: 'event',
      header: 'Action',
      width: '11rem',
      value: (l) => EVENT_LABELS[l.event] ?? l.event,
      cell: (l) => (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-navy-800">{EVENT_LABELS[l.event] ?? l.event}</span>
          {l.severity === 'CRITICAL' && <Badge tone="rose">Critical</Badge>}
          {l.severity === 'NOTICE' && <Badge tone="amber">Notice</Badge>}
        </div>
      ),
    },
    {
      key: 'entity',
      header: 'Document',
      value: (l) => l.entityRef ?? '',
      cell: (l) => {
        if (!l.entityRef) return <span className="text-slate-400">-</span>;
        const to = linkFor(l);
        return to ? (
          <ReturnLink to={to} className="font-mono text-xs text-brand-700 hover:underline">
            {l.entityRef}
          </ReturnLink>
        ) : (
          <span className="font-mono text-xs text-slate-600">{l.entityRef}</span>
        );
      },
    },
    {
      key: 'context',
      header: 'Fund and year',
      width: '8rem',
      value: (l) => `${l.fundCode ?? ''} ${l.fiscalYear ?? ''}`,
      cell: (l) => (
        <span className="text-xs text-slate-600">
          {[l.fundCode, l.fiscalYear].filter(Boolean).join(' ') || '-'}
        </span>
      ),
      optional: true,
    },
    {
      key: 'remarks',
      header: 'Remarks',
      value: (l) => l.remarks ?? '',
      cell: (l) => (
        <span className="line-clamp-2 text-xs text-slate-700" title={l.remarks ?? ''}>
          {l.remarks ?? '-'}
        </span>
      ),
    },
    {
      key: 'view',
      header: '',
      width: '5rem',
      sortable: false,
      fixed: true,
      value: () => '',
      cell: (l) =>
        (l.changes?.length ?? 0) > 0 || l.ipAddress ? (
          <Button size="sm" variant="ghost" onClick={() => setDetail(l)}>
            Detail
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Audit Trail"
        subtitle="Every consequential action in CFMS, recorded permanently and readable by the Commission on Audit."
        breadcrumbs={[{ label: 'Audit Trail' }]}
      />

      {severity === 'CRITICAL' && criticalCount > 0 && (
        <Alert tone="warning" className="mb-4">
          {criticalCount} critical event{criticalCount === 1 ? '' : 's'} in the most recent
          records: budget overrides, reopened accounting periods, reversed journal entries,
          permission changes and settings changes. Each one is a deliberate act by a named officer
          with a recorded reason.
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(l) => l.id}
        loading={loading}
        error={error}
        searchPlaceholder="User, document reference or remarks"
        emptyTitle="No audit records"
        emptyMessage="Nothing matching these filters has been recorded."
        pageSize={50}
        filters={
          <>
            <Select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Severity"
            >
              <option value="CRITICAL">Critical events only</option>
              <option value="NOTICE">Notices</option>
              <option value="INFO">Routine</option>
              <option value="">Everything (most recent 200)</option>
            </Select>

            <Select
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Action"
            >
              <option value="">All actions</option>
              {Object.entries(EVENT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>

            <TextInput
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="Filter by user"
              className="w-44 py-1.5 text-sm"
              aria-label="User"
            />
          </>
        }
        exportMeta={{ title: 'Audit Trail Report' }}
      />

      {detail && (
        <Modal
          open
          onClose={() => setDetail(null)}
          title={EVENT_LABELS[detail.event] ?? detail.event}
          description={`${detail.actorName} - ${formatInstant(detail.at)}`}
          size="lg"
          footer={<Button onClick={() => setDetail(null)}>Close</Button>}
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label="Document">{detail.entityRef ?? '-'}</Detail>
            <Detail label="Collection">{detail.entityType ?? '-'}</Detail>
            <Detail label="Roles held at the time">{(detail.actorRoles ?? []).join(', ') || '-'}</Detail>
            <Detail label="IP address">{detail.ipAddress ?? 'Not recorded'}</Detail>
          </dl>

          {detail.remarks && (
            <div className="mt-4 rounded border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-sm text-navy-800">
              {detail.remarks}
            </div>
          )}

          {(detail.changes?.length ?? 0) > 0 && (
            <div className="mt-5">
              <p className="cbo-label">What changed</p>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="cbo-th">Field</th>
                    <th className="cbo-th">Before</th>
                    <th className="cbo-th">After</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.changes!.map((c, i) => (
                    <tr key={i}>
                      <td className="cbo-td font-mono text-xs">{c.field}</td>
                      <td className="cbo-td">
                        <pre className="whitespace-pre-wrap break-all text-2xs text-slate-600">
                          {JSON.stringify(c.previous, null, 1)}
                        </pre>
                      </td>
                      <td className="cbo-td">
                        <pre className="whitespace-pre-wrap break-all text-2xs text-navy-900">
                          {JSON.stringify(c.next, null, 1)}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {detail.userAgent && (
            <p className="mt-4 break-all text-2xs text-slate-400">{detail.userAgent}</p>
          )}
        </Modal>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-navy-900">{children}</dd>
    </div>
  );
}
