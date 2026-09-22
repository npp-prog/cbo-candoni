import type { AuditStamps, Centavos, FiscalYear, Id, IsoDate, SoftDeletable } from './common';
import type {
  AccountClass,
  CashFlowClass,
  ExpenseClass,
  FsClassification,
  NormalBalance,
  PayeeType,
} from './enums';

/**
 * Master data. These documents change rarely and are read constantly, so every
 * transaction denormalises the few fields it needs to display (account code and
 * name, payee name, office name). The master record remains the authority for
 * *classification*; the denormalised copy exists so that a posted document
 * still prints exactly as it was approved, even if the master is later renamed.
 */

// ---------------------------------------------------------------------------
// funds/{fundCode}
// ---------------------------------------------------------------------------

export interface Fund extends SoftDeletable {
  id: Id;
  /** Short code used in document numbers and storage paths, e.g. "GF". */
  code: string;
  name: string;
  /** Numeric book code used in the numbering scheme, e.g. "100" for GF. */
  bookCode: string;
  description?: string;
  /** Statutory funds cannot be deactivated by an administrator. */
  statutory: boolean;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// accounts/{accountId}   (Chart of Accounts - one shared chart, used per fund)
// ---------------------------------------------------------------------------

export interface Account extends SoftDeletable {
  id: Id;
  /** UACS-style account code from the COA Revised Chart of Accounts for LGUs. */
  code: string;
  name: string;
  accountClass: AccountClass;
  normalBalance: NormalBalance;
  fsClassification: FsClassification;
  cashFlowClass: CashFlowClass;
  /** Only meaningful for expense accounts; drives budget classification. */
  expenseClass?: ExpenseClass;
  /**
   * A control account is posted to only through its subsidiary ledger
   * (e.g. Accounts Payable). Direct JEV lines against it are warned on.
   */
  isControl: boolean;
  /** Whether a subsidiary ledger must be selected on every line. */
  requiresSubsidiary: boolean;
  /** Postable leaf account, or a grouping header used only in reports. */
  postable: boolean;
  parentCode?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// offices/{officeId}, responsibilityCenters/{rcId}
// ---------------------------------------------------------------------------

export interface Office extends SoftDeletable {
  id: Id;
  code: string;
  name: string;
  /** e.g. "Office of the Municipal Accountant" short form used in reports. */
  shortName?: string;
  head?: string;
  headPosition?: string;
  sortOrder: number;
}

export interface ResponsibilityCenter extends SoftDeletable {
  id: Id;
  /** UACS responsibility centre code. */
  code: string;
  name: string;
  officeId: Id;
  officeName: string;
}

// ---------------------------------------------------------------------------
// programs/{id}, projects/{id}, activities/{id}  (PPA structure)
// ---------------------------------------------------------------------------

export interface Program extends SoftDeletable {
  id: Id;
  code: string;
  name: string;
  officeId?: Id;
}

export interface Project extends SoftDeletable {
  id: Id;
  code: string;
  name: string;
  programId?: Id;
  officeId?: Id;
  /** Multi-year projects carry their total cost for monitoring. */
  totalProjectCost?: Centavos;
}

export interface Activity extends SoftDeletable {
  id: Id;
  code: string;
  name: string;
  programId?: Id;
  projectId?: Id;
  officeId?: Id;
}

// ---------------------------------------------------------------------------
// payees/{payeeId}
// ---------------------------------------------------------------------------

export interface Payee extends SoftDeletable {
  id: Id;
  /** System-assigned payee code, stable across renames. */
  code: string;
  name: string;
  payeeType: PayeeType;
  tin?: string;
  address?: string;
  contactNumber?: string;
  email?: string;
  /** Default withholding treatment; can be overridden per voucher. */
  defaultEwtCode?: string;
  defaultVatWithholdingCode?: string;
  /** For employees, the link to the employee record. */
  employeeId?: Id;
  /** Bank details used for ADA/LDDAP payments. */
  bankName?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// employees/{employeeId}
// ---------------------------------------------------------------------------

export interface Employee extends SoftDeletable {
  id: Id;
  employeeNumber: string;
  lastName: string;
  firstName: string;
  middleName?: string;
  suffix?: string;
  /** Cached "LASTNAME, Firstname M." used for payroll registers. */
  displayName: string;
  position?: string;
  officeId?: Id;
  officeName?: string;
  employmentType: 'PERMANENT' | 'CASUAL' | 'JOB_ORDER' | 'CONTRACT_OF_SERVICE' | 'ELECTIVE' | 'COTERMINOUS';
  tin?: string;
  gsisNumber?: string;
  philhealthNumber?: string;
  pagibigNumber?: string;
  bankAccountNumber?: string;
  /** Monthly basic salary used to seed payroll lines. */
  monthlyRate?: Centavos;
  dateHired?: IsoDate;
  dateSeparated?: IsoDate;
}

// ---------------------------------------------------------------------------
// banks/{bankId}, bankAccounts/{bankAccountId}
// ---------------------------------------------------------------------------

export interface Bank extends SoftDeletable {
  id: Id;
  name: string;
  shortName: string;
}

export interface BankAccount extends SoftDeletable {
  id: Id;
  bankId: Id;
  bankName: string;
  branch?: string;
  /** Stored in full; masked in the UI except for authorised treasury roles. */
  accountNumber: string;
  accountName: string;
  /** A bank account belongs to exactly one fund. */
  fundCode: string;
  accountType: 'CURRENT' | 'SAVINGS' | 'TIME_DEPOSIT';
  /** GL account this bank account maps to (e.g. Cash in Bank - Local Currency). */
  glAccountCode: string;
  /** Used by the check module to enforce unique check numbers per account. */
  checkSeriesPrefix?: string;
  openedOn?: IsoDate;
  notes?: string;
}

// ---------------------------------------------------------------------------
// taxCodes/{taxCodeId}
// ---------------------------------------------------------------------------

export interface TaxCode extends SoftDeletable {
  id: Id;
  code: string;
  description: string;
  kind: 'EWT' | 'VAT_WITHHOLDING' | 'PERCENTAGE_TAX' | 'OTHER';
  /** Rate as a fraction, e.g. 0.02 for 2%. Stored as a number, applied to a
   *  base that is itself computed in centavos and rounded half-up. */
  rate: number;
  /** Whether the rate applies to the gross amount or to the net-of-VAT amount. */
  base: 'GROSS' | 'NET_OF_VAT';
  /** Liability account credited when this tax is withheld. */
  accountCode: string;
  /** BIR alphanumeric tax code, printed on the certificate (BIR Form 2307). */
  atc?: string;
}

// ---------------------------------------------------------------------------
// fiscalYears/{year}
// ---------------------------------------------------------------------------

export interface FiscalYearRecord {
  id: Id;
  year: FiscalYear;
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
  /** Set once the post-closing trial balance has been generated and accepted. */
  closedAt?: string;
  closedByUid?: Id;
  /** Beginning balances are carried in from the prior year's closing. */
  beginningBalancesPostedAt?: string;
}

// ---------------------------------------------------------------------------
// numberingRules/{docType}
// ---------------------------------------------------------------------------

/**
 * Configurable numbering, e.g. `100-26-09-0001`:
 *   {BOOK}-{YY}-{MM}-{SEQ:4}
 * Sequence resets according to `resetOn`. The actual sequence is issued only by
 * a Cloud Function inside a transaction against `counters/`; the client can
 * render a preview but never assigns a real number.
 */
export interface NumberingRule {
  id: Id;
  docType: string;
  pattern: string;
  sequenceLength: number;
  resetOn: 'YEAR' | 'MONTH' | 'NEVER';
  /** Whether the sequence is kept per fund. Almost always true. */
  perFund: boolean;
  active: boolean;
  sample?: string;
}

// ---------------------------------------------------------------------------
// Convenience union used by the master-data screens.
// ---------------------------------------------------------------------------

export type MasterEntity =
  | Fund
  | Account
  | Office
  | ResponsibilityCenter
  | Program
  | Project
  | Activity
  | Payee
  | Employee
  | Bank
  | BankAccount
  | TaxCode;

export type MasterWithAudit<T> = T & Partial<AuditStamps>;
