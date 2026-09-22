import clsx from 'clsx';
import { useWorkflowHistory } from '@/data/queries';
import { formatInstant } from '@/lib/dates';
import { StatusBadge } from './ui/Badge';
import { Spinner } from './ui/Layout';

/**
 * Approval history for one document.
 *
 * Shows who did what, when, and what they said - the record a reviewer or an
 * auditor reads to understand how a voucher reached its current state. The
 * events come from `workflowHistory`, which only the Cloud Functions write, so
 * this cannot be edited into a more flattering shape after the fact.
 */

const ACTION_LABELS: Record<string, string> = {
  CREATE: 'Created',
  SUBMIT: 'Submitted',
  REVIEW: 'Reviewed',
  CERTIFY: 'Certified',
  APPROVE: 'Approved',
  POST: 'Posted',
  RETURN: 'Returned',
  REJECT: 'Rejected',
  CANCEL: 'Cancelled',
  REVERSE: 'Reversed',
  REOPEN: 'Reopened',
};

const ACTION_TONE: Record<string, string> = {
  CREATE: 'bg-slate-300',
  SUBMIT: 'bg-amber-400',
  REVIEW: 'bg-brand-500',
  CERTIFY: 'bg-brand-600',
  APPROVE: 'bg-brand-600',
  POST: 'bg-emerald-600',
  RETURN: 'bg-rose-500',
  REJECT: 'bg-rose-600',
  CANCEL: 'bg-rose-600',
  REVERSE: 'bg-violet-600',
  REOPEN: 'bg-violet-600',
};

export function WorkflowTimeline({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: string | null;
}) {
  const { data, loading } = useWorkflowHistory(entityType, entityId);

  if (loading) return <Spinner label="Loading history" className="py-6" />;

  if (data.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500">
        Nothing has happened to this document yet beyond its creation.
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 pl-6">
      {/* The connecting rail. */}
      <span className="absolute left-[0.3125rem] top-2 bottom-2 w-px bg-slate-200" aria-hidden="true" />

      {data.map((event) => (
        <li key={event.id} className="relative">
          <span
            className={clsx(
              'absolute -left-6 top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white',
              ACTION_TONE[event.action] ?? 'bg-slate-300',
            )}
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-navy-900">
              {ACTION_LABELS[event.action] ?? event.action}
            </span>
            <span className="text-sm text-slate-600">by {event.actor?.name}</span>
            {event.actor?.position && (
              <span className="text-xs text-slate-400">({event.actor.position})</span>
            )}
            <span className="ml-auto text-xs text-slate-400">{formatInstant(event.at)}</span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            {event.previousStatus && (
              <>
                <StatusBadge status={event.previousStatus} />
                <svg className="h-3 w-3 text-slate-300" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </>
            )}
            <StatusBadge status={event.newStatus} />
            {event.assignedToRole && (
              <span className="text-2xs text-slate-500">
                now with {event.assignedToRole.toLowerCase().replace(/_/g, ' ')}
              </span>
            )}
          </div>

          {event.remarks && (
            <p className="mt-1.5 rounded border-l-2 border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
              {event.remarks}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
