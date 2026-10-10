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
    | 'ATTACHMENTS_LOCKED'
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

/**
 * The documents the municipality actually files.
 *
 * Deliberately short. The first version of this list ran to seventeen types -
 * purchase requests, travel orders, certificates of appearance, BAC documents -
 * on the reasoning that naming more things makes the register more useful.
 *
 * It does the opposite. Every one of those is an attachment TO a voucher, not a
 * document the office files in its own right, and offering them as choices only
 * splits the same evidence across a dozen labels according to which clerk
 * uploaded it. What the office files, and what COA asks for by name, is the
 * voucher, the liquidation report and the four treasury reports. Everything
 * else is a supporting document, and that is what it is called.
 */
export const DOCUMENT_TYPES = [
  'OBR',
  'DV',
  'LIQUIDATION_REPORT',
  'RCD',
  'ABSTRACT_OF_COLLECTIONS',
  'RCI',
  'RADAI',
  'RCDISB',
  // Patch 156: the payrolls an RCDisb reports, filed with it.
  'PAYROLL',
  // COA Circular 2021-014's reports of electronic money, and the proof the
  // money reached the bank. The circular asks for the proof by name: Annex F
  // is submitted to Accounting "together with the corresponding proof of
  // deposit", and Annex G says a photocopy of it "should be attached to this
  // report". It is a second right answer beside the signed report, the way the
  // Abstract is beside the RCD - not a loose "supporting document".
  'ERCD',
  'PROOF_OF_DEPOSIT',
  // The appropriation ordinance itself, attached to its record. Patch 119.
  'ORDINANCE',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  OBR: 'Obligation Request',
  DV: 'Disbursement Voucher',
  LIQUIDATION_REPORT: 'Liquidation Report',
  RCD: 'Report of Collections and Deposits (RCD)',
  ABSTRACT_OF_COLLECTIONS: 'Abstract of Collections',
  RCI: 'Report of Checks Issued (RCI)',
  RADAI: 'Report of ADA Issued (RADAI)',
  RCDISB: 'Report of Cash Disbursement (RCDisb)',
  PAYROLL: 'Payroll',
  ERCD: 'Report of e-Collections and Deposits (eRCD)',
  PROOF_OF_DEPOSIT: 'Proof of deposit or fund transfer',
  ORDINANCE: 'Appropriation Ordinance',
  /**
   * The supporting paper behind a journal entry written in Accounting - a
   * memorandum, a bank debit advice, the office's own journal voucher. CFMS
   * has no form of its own to name there.
   *
   * Everywhere else what may be attached is decided by the document being
   * attached to, and this is not offered. It also keeps a name on the screen
   * for anything filed under it before patch 67.
   */
  OTHER: 'Supporting Document',
};

/**
 * The shortest temporary password an administrator may set when creating a
 * user from CFMS.
 *
 * Firebase Authentication accepts six. This account can reach the
 * municipality's financial records, so CFMS asks more.
 *
 * MUST match MIN_PASSWORD_LENGTH in functions/src/admin/users.ts, where it is
 * enforced - this copy only decides when the button lights up. check-rules
 * compares the two, because a screen that accepts what the server refuses is
 * a button that fails when it is pressed.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Patch 156: PDF, Excel (XLS, XLSX), CSV, Word (DOC, DOCX), TXT, JPG and PNG
 * - and nothing else. The same list is in storage.rules.
 */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;

/** The extensions the file picker offers, and the type each is stored as. */
export const ALLOWED_UPLOAD_EXTENSIONS: Record<string, (typeof ALLOWED_UPLOAD_MIME_TYPES)[number]> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

/**
 * The type a file is uploaded as, or null when it is not one CFMS accepts.
 * Judged by the EXTENSION: a browser reports a CSV as text/csv, as
 * application/vnd.ms-excel, or as nothing at all depending on what is
 * installed, so the type it reports cannot be the test.
 */
export function uploadContentType(fileName: string): string | null {
  const ext = String(fileName).toLowerCase().split('.').pop() ?? '';
  return ALLOWED_UPLOAD_EXTENSIONS[ext] ?? null;
}

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
