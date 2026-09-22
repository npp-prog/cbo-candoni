import type { ActorStamp, Id, IsoDate, IsoTimestamp } from './common';

/**
 * Users, roles, workflow, documents, audit trail and notifications.
 */

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------

export const ROLES = [
  'SUPER_ADMIN',
  'MUNICIPAL_ACCOUNTANT',
  'ACCOUNTING_REVIEWER',
  'ACCOUNTING_ENCODER',
  'BUDGET_OFFICER',
  'BUDGET_STAFF',
  'MUNICIPAL_TREASURER',
  'TREASURY_STAFF',
  'DEPARTMENT_USER',
  'AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Administrator',
  MUNICIPAL_ACCOUNTANT: 'Municipal Accountant',
  ACCOUNTING_REVIEWER: 'Accounting Reviewer',
  ACCOUNTING_ENCODER: 'Accounting Encoder',
  BUDGET_OFFICER: 'Municipal Budget Officer',
  BUDGET_STAFF: 'Budget Staff',
  MUNICIPAL_TREASURER: 'Municipal Treasurer',
  TREASURY_STAFF: 'Treasury Staff',
  DEPARTMENT_USER: 'Department User',
  AUDITOR: 'Auditor / COA (read-only)',
};

/** The modules permissions are scoped to. */
export const MODULES = [
  'dashboard',
  'budget',
  'accounting',
  'treasury',
  'reconciliation',
  'reports',
  'masterData',
  'documents',
  'administration',
  'auditTrail',
] as const;
export type Module = (typeof MODULES)[number];

/** The verbs permissions are granted over. */
export const ACTIONS = [
  'view',
  'create',
  'edit',
  'review',
  'approve',
  'post',
  'cancel',
  'print',
  'export',
  'delete',
] as const;
export type Action = (typeof ACTIONS)[number];

/** A permission string, e.g. `accounting:post`. */
export type Permission = `${Module}:${Action}`;

export interface RoleDefinition {
  id: Id;
  role: Role;
  label: string;
  description: string;
  permissions: Permission[];
  /** Built-in roles cannot be deleted, only copied. */
  builtIn: boolean;
  updatedAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// users/{uid}
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: Id;
  uid: Id;
  email: string;
  displayName: string;
  position?: string;
  officeId?: Id;
  officeName?: string;
  roles: Role[];
  /**
   * A department user only sees their own office's transactions. Empty means
   * no office restriction (accounting, budget, treasury and audit roles).
   */
  officeScope: Id[];
  /** Funds this user may transact in. Empty means all funds. */
  fundScope: string[];
  active: boolean;
  mfaEnrolled: boolean;
  lastLoginAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
  /**
   * Mirrors the Firebase Auth custom claims. The claims are authoritative for
   * security rules; this copy exists so the administration screen can show them
   * without an Admin SDK round-trip.
   */
  claimsSyncedAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// workflowHistory/{id}
// ---------------------------------------------------------------------------

export interface WorkflowEvent {
  id: Id;
  /** Collection name of the document, e.g. "disbursementVouchers". */
  entityType: string;
  entityId: Id;
  /** Human reference shown in the timeline, e.g. "DV 100-26-09-0001". */
  entityRef: string;
  fiscalYear: number;
  fundCode: string;

  action:
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
  previousStatus?: string;
  newStatus: string;
  actor: ActorStamp;
  remarks?: string;
  /** Role the document now sits with. */
  assignedToRole?: string;
  at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// auditLogs/{id}
// ---------------------------------------------------------------------------

/**
 * Immutable audit trail. Written only by Cloud Functions; security rules deny
 * every client write, update and delete on this collection.
 */
export interface AuditLog {
  id: Id;
  at: IsoTimestamp;
  actorUid: Id;
  actorName: string;
  actorRoles: string[];
  /** Best-effort; taken from the callable context, absent for triggers. */
  ipAddress?: string;
  userAgent?: string;

  event:
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

  entityType?: string;
  entityId?: Id;
  entityRef?: string;
  fiscalYear?: number;
  fundCode?: string;

  /** Field-level before/after for EDIT events. Amounts in centavos. */
  changes?: Array<{ field: string; previous: unknown; next: unknown }>;
  remarks?: string;
  /** Severity so that overrides and permission changes can be filtered out. */
  severity: 'INFO' | 'NOTICE' | 'CRITICAL';
}

// ---------------------------------------------------------------------------
// documents/{id}   (metadata; the bytes live in Cloud Storage)
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = [
  'PURCHASE_REQUEST',
  'PURCHASE_ORDER',
  'INVOICE',
  'OFFICIAL_RECEIPT',
  'INSPECTION_ACCEPTANCE_REPORT',
  'OBR',
  'DV',
  'PAYROLL',
  'TRAVEL_ORDER',
  'ITINERARY_OF_TRAVEL',
  'CERTIFICATE_OF_APPEARANCE',
  'LIQUIDATION_REPORT',
  'DEPOSIT_SLIP',
  'BANK_STATEMENT',
  'CONTRACT',
  'BAC_DOCUMENT',
  'CERTIFICATION',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  PURCHASE_REQUEST: 'Purchase Request',
  PURCHASE_ORDER: 'Purchase Order',
  INVOICE: 'Invoice',
  OFFICIAL_RECEIPT: 'Official Receipt',
  INSPECTION_ACCEPTANCE_REPORT: 'Inspection and Acceptance Report',
  OBR: 'Obligation Request and Status',
  DV: 'Disbursement Voucher',
  PAYROLL: 'Payroll',
  TRAVEL_ORDER: 'Travel Order',
  ITINERARY_OF_TRAVEL: 'Itinerary of Travel',
  CERTIFICATE_OF_APPEARANCE: 'Certificate of Appearance',
  LIQUIDATION_REPORT: 'Liquidation Report',
  DEPOSIT_SLIP: 'Bank Deposit Slip',
  BANK_STATEMENT: 'Bank Statement',
  CONTRACT: 'Contract',
  BAC_DOCUMENT: 'BAC Document',
  CERTIFICATION: 'Certification',
  OTHER: 'Other Supporting Document',
};

export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/** 25 MB. Enforced in the UI and again in Storage rules. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface DocumentAttachment {
  id: Id;
  /** Storage path: /cbo/{fiscalYear}/{fund}/{docType}/{documentId}/{file} */
  storagePath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;

  documentType: DocumentType;
  documentDate?: IsoDate;
  description?: string;

  /** What this attachment is filed against. */
  entityType: string;
  entityId: Id;
  entityRef: string;
  fiscalYear: number;
  fundCode: string;

  version: number;
  /** Set on the previous version when a file is replaced. */
  supersededByDocumentId?: Id;
  supersedesDocumentId?: Id;

  uploadedBy: ActorStamp;
  /** SHA-256 of the bytes, so tampering with storage is detectable. */
  checksum?: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// notifications/{id}
// ---------------------------------------------------------------------------

export interface Notification {
  id: Id;
  recipientUid?: Id;
  /** Role-addressed notifications, e.g. everything awaiting the Accountant. */
  recipientRole?: Role;
  kind:
    | 'PENDING_REVIEW'
    | 'RETURNED'
    | 'APPROVED'
    | 'REJECTED'
    | 'PENDING_LIQUIDATION'
    | 'OVERDUE_CASH_ADVANCE'
    | 'UNRECONCILED'
    | 'MISSING_DOCUMENT'
    | 'DEADLINE';
  title: string;
  body: string;
  entityType?: string;
  entityId?: Id;
  link?: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  read: boolean;
  createdAt: IsoTimestamp;
  readAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// settings/{key}
// ---------------------------------------------------------------------------

export interface SystemSettings {
  id: Id;
  municipality: string;
  province: string;
  region?: string;
  /** Printed on the face of every report. */
  reportHeaderLines: string[];
  logoStoragePath?: string;

  /** Default signatories for report footers. */
  signatories: {
    preparedBy?: { name: string; position: string };
    reviewedBy?: { name: string; position: string };
    certifiedBy?: { name: string; position: string };
    approvedBy?: { name: string; position: string };
  };

  currentFiscalYear: number;
  /** Days after which a cash advance is flagged overdue, by type. */
  cashAdvanceDueDays: Record<string, number>;
  /** Months after which an unpresented check becomes stale. Statutory: 6. */
  checkStaleMonths: number;
  /** Whether budget overrides are permitted at all, and by which role. */
  allowBudgetOverride: boolean;
  budgetOverrideRoles: Role[];
  sessionTimeoutMinutes: number;
  updatedAt?: IsoTimestamp;
  updatedBy?: ActorStamp;
}
