import type { Transaction } from 'firebase-admin/firestore';
import { db, COL } from './firebase';
import type { Caller } from './context';

/**
 * Audit trail and workflow history.
 *
 * Both are written inside the same Firestore transaction as the change they
 * describe. That matters: an audit entry written afterwards, outside the
 * transaction, can be lost if the process dies between the two writes, leaving
 * a financial change with no record of who made it. Inside the transaction,
 * either both land or neither does.
 */

export type AuditEvent =
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'CREATE'
  | 'EDIT'
  | 'SUBMIT'
  | 'REVIEW'
  | 'APPROVE'
  | 'CERTIFY'
  | 'POST'
  | 'CANCEL'
  | 'REVERSE'
  | 'PRINT'
  | 'EXPORT'
  | 'UPLOAD'
  | 'DOWNLOAD'
  | 'PERMISSION_CHANGE'
  | 'PERIOD_CLOSE'
  | 'PERIOD_REOPEN'
  | 'BUDGET_OVERRIDE'
  | 'SETTINGS_CHANGE';

export interface AuditInput {
  caller: Caller;
  event: AuditEvent;
  entityType?: string;
  entityId?: string;
  entityRef?: string;
  fiscalYear?: number;
  fundCode?: string;
  changes?: Array<{ field: string; previous: unknown; next: unknown }>;
  remarks?: string;
  severity?: 'INFO' | 'NOTICE' | 'CRITICAL';
}

/** Events that must always be findable, whatever filter an auditor applies. */
const ALWAYS_CRITICAL: AuditEvent[] = [
  'PERMISSION_CHANGE',
  'PERIOD_REOPEN',
  'BUDGET_OVERRIDE',
  'REVERSE',
  'SETTINGS_CHANGE',
];

function buildAuditDoc(input: AuditInput) {
  const severity =
    input.severity ?? (ALWAYS_CRITICAL.includes(input.event) ? 'CRITICAL' : 'INFO');

  return {
    at: new Date().toISOString(),
    actorUid: input.caller.uid,
    actorName: input.caller.name,
    actorRoles: input.caller.roles,
    ipAddress: input.caller.ip ?? null,
    userAgent: input.caller.userAgent ?? null,
    event: input.event,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    entityRef: input.entityRef ?? null,
    fiscalYear: input.fiscalYear ?? null,
    fundCode: input.fundCode ?? null,
    changes: input.changes ?? null,
    remarks: input.remarks ?? null,
    severity,
  };
}

/** Write an audit record inside an existing transaction. Preferred form. */
export function auditInTransaction(tx: Transaction, input: AuditInput): void {
  const ref = db.collection(COL.auditLogs).doc();
  tx.create(ref, buildAuditDoc(input));
}

/** Write an audit record outside a transaction, for read-only events. */
export async function audit(input: AuditInput): Promise<void> {
  await db.collection(COL.auditLogs).add(buildAuditDoc(input));
}

// ---------------------------------------------------------------------------
// Workflow history
// ---------------------------------------------------------------------------

export type WorkflowAction =
  | 'CREATE'
  | 'SUBMIT'
  | 'REVIEW'
  | 'CERTIFY'
  | 'APPROVE'
  | 'POST'
  | 'RETURN'
  | 'REJECT'
  | 'CANCEL'
  | 'REVERSE'
  | 'REOPEN';

export interface WorkflowInput {
  caller: Caller;
  entityType: string;
  entityId: string;
  entityRef: string;
  fiscalYear: number;
  fundCode: string;
  action: WorkflowAction;
  previousStatus?: string;
  newStatus: string;
  remarks?: string;
  assignedToRole?: string;
}

export function workflowInTransaction(tx: Transaction, input: WorkflowInput): void {
  const ref = db.collection(COL.workflowHistory).doc();
  tx.create(ref, {
    entityType: input.entityType,
    entityId: input.entityId,
    entityRef: input.entityRef,
    fiscalYear: input.fiscalYear,
    fundCode: input.fundCode,
    action: input.action,
    previousStatus: input.previousStatus ?? null,
    newStatus: input.newStatus,
    actor: {
      uid: input.caller.uid,
      name: input.caller.name,
      position: input.caller.position ?? null,
      at: new Date().toISOString(),
    },
    remarks: input.remarks ?? null,
    assignedToRole: input.assignedToRole ?? null,
    at: new Date().toISOString(),
  });
}

/** Records both the audit entry and the workflow event for a state change. */
export function recordTransition(
  tx: Transaction,
  input: WorkflowInput & { event: AuditEvent; severity?: 'INFO' | 'NOTICE' | 'CRITICAL' },
): void {
  workflowInTransaction(tx, input);
  auditInTransaction(tx, {
    caller: input.caller,
    event: input.event,
    entityType: input.entityType,
    entityId: input.entityId,
    entityRef: input.entityRef,
    fiscalYear: input.fiscalYear,
    fundCode: input.fundCode,
    remarks: input.remarks,
    severity: input.severity,
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationInput {
  recipientUid?: string;
  recipientRole?: string;
  kind: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  link?: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
}

export function notifyInTransaction(tx: Transaction, input: NotificationInput): void {
  const ref = db.collection(COL.notifications).doc();
  tx.create(ref, {
    recipientUid: input.recipientUid ?? null,
    recipientRole: input.recipientRole ?? null,
    kind: input.kind,
    title: input.title,
    body: input.body,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    link: input.link ?? null,
    severity: input.severity ?? 'INFO',
    read: false,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Field-level diff for EDIT audit records. Compares only the fields given, so
 * that a large document does not produce an unreadable audit entry.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): Array<{ field: string; previous: unknown; next: unknown }> {
  const changes: Array<{ field: string; previous: unknown; next: unknown }> = [];
  for (const field of fields) {
    const prev = before[field];
    const next = after[field];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      changes.push({ field, previous: prev ?? null, next: next ?? null });
    }
  }
  return changes;
}
