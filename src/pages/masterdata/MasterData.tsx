import { useMemo, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { orderBy } from 'firebase/firestore';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, Select, Checkbox, AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useCollection } from '@/hooks/useFirestore';
import { useAuth } from '@/auth/AuthProvider';
import { upsertMaster, deactivateMaster, reactivateMaster, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { REVENUE_SOURCES } from '@/types/treasury';
import { FPP_CODES, fppLabel } from '@/lib/fppCodes';
import { formatPeso } from '@/lib/money';
import { liquidatableByDefault, requiresSubsidiaryFor } from '@/lib/chartOfAccounts';
import { employeeMirror, planNameMerge } from '@/lib/names';
import {
  ACCOUNT_CLASSES,
  CASH_FLOW_CLASSES,
  EXPENSE_CLASS_LABELS,
  FS_CLASSIFICATIONS,
  NORMAL_BALANCES,
  PAYEE_TYPES,
} from '@/types/enums';

/**
 * Master data maintenance.
 *
 * One screen, configured per entity, rather than eight near-identical ones.
 * The shape of a master-data screen is genuinely the same every time - list,
 * search, add, edit, deactivate - and writing it eight times would guarantee
 * that the eighth behaves subtly differently from the first.
 *
 * Nothing here is ever hard-deleted. A posted voucher from three years ago
 * still points at the payee and the account it used; deleting either would
 * leave that record referring to nothing, and the register would print blanks.
 * Records are deactivated, which removes them from the pickers while leaving
 * history intact.
 */

interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'select' | 'checkbox' | 'amount' | 'number';
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  hint?: string;
  /** Shown in the table as well as the form. */
  inTable?: boolean;
  mono?: boolean;
  width?: string;
  /**
   * Value given to this field on a NEW record. Only meaningful for checkboxes,
   * where an unticked box is indistinguishable from "not yet considered" - and
   * where the safe-looking default is often the wrong one. A chart of accounts
   * entry that is not postable cannot be selected anywhere, so a new account
   * created with the box unticked simply never appears in a picker, with no
   * error to explain why.
   */
  defaultValue?: boolean;
  /**
   * Patch 133. The value an EXISTING record shows while the field has never
   * been set on it, worked out from the record itself. Without it a checkbox
   * that defaults to ticked for some records would show unticked on the form,
   * and saving the form for any other reason would quietly clear it.
   */
  whenUnset?: (record: Record<string, unknown>) => unknown;
  /**
   * Patch 158: shown on the form - and required, if `required` - only when
   * this says so. Names: the employee details, for a name of type Employee.
   */
  showWhen?: (values: Record<string, unknown>) => boolean;
}

interface EntityConfig {
  slug: string;
  collection: string;
  title: string;
  singular: string;
  description: string;
  /** The field used as the document id, when records have a natural key. */
  idField?: string;
  fields: FieldSpec[];
  defaultSort: string;
  /** Roles beyond the general master-data writers, if any. */
  note?: string;
}

/** Patch 158: the employee details show for a name of type Employee. */
const isEmployeeName = (v: Record<string, unknown>) => v.payeeType === 'EMPLOYEE';

const CONFIGS: Record<string, EntityConfig> = {
  /*
   * The Treasurer's revenue codes, and the COA account each one belongs to.
   *
   * The MTO's collection system codes revenue far more finely than the COA
   * chart does - "Market Fee", "Miscellaneous Income - RPT - BRGY EAST",
   * "Cemetery Usage Fee" - and it is right to. The collecting officer needs to
   * know which window the money came through; the Chart of Accounts exists to
   * produce a financial statement in the form COA requires, and forty-three
   * revenue lines is not that form.
   *
   * So the two are kept apart and joined here. The General Ledger is posted in
   * COA accounts; the Treasurer's own code stays on the collection line, where
   * the subsidiary report reads it. Neither office has to adopt the other's
   * coding, and the mapping is written down where an auditor can see it rather
   * than living in somebody's head.
   */
  'revenue-codes': {
    slug: 'revenue-codes',
    collection: COL.revenueCodes,
    title: 'Revenue Codes',
    singular: 'revenue code',
    description:
      "The collection codes the Treasurer's office uses, and the COA account each one posts to. The Abstract of Collections upload reads this; a code that is not here stops the upload and is named.",
    idField: 'code',
    defaultSort: 'code',
    fields: [
      {
        key: 'code',
        label: 'Treasury revenue code',
        type: 'text',
        required: true,
        inTable: true,
        mono: true,
        width: '10rem',
        hint: 'Exactly as the abstract writes it, including any letters or punctuation - 4020214001, 40601010D/S, 40202160-1.',
      },
      {
        key: 'description',
        label: 'Description',
        type: 'text',
        required: true,
        inTable: true,
        hint: 'As it appears on the abstract, e.g. "Market Fee".',
      },
      {
        key: 'accountCode',
        label: 'COA account code',
        type: 'text',
        required: true,
        inTable: true,
        mono: true,
        width: '9rem',
        hint: 'The account in the Chart of Accounts this revenue is credited to. Several treasury codes may share one COA account - that is the usual case.',
      },
      {
        key: 'revenueSource',
        label: 'Revenue source',
        type: 'select',
        required: true,
        inTable: true,
        options: REVENUE_SOURCES.map((s) => ({ value: s.value, label: s.label })),
        hint: 'The heading this collection appears under on the collections report. Presentation only - the General Ledger follows the COA account above.',
      },
    ],
    note: 'A collection posts to the COA account named here. Changing a mapping does not restate collections already posted; it applies from the next upload.',
  },

  'accountable-forms': {
    slug: 'accountable-forms',
    collection: COL.accountableFormTypes,
    title: 'Accountable Forms',
    singular: 'accountable form',
    description:
      'The kinds of numbered form the office is accountable for. The booklet size matters: the RCD and the RAAF break serial ranges where the paper actually breaks, so a form bound in fifties reports differently from one that is not.',
    idField: 'code',
    defaultSort: 'sortOrder',
    fields: [
      {
        key: 'code',
        label: 'Form code',
        type: 'text',
        required: true,
        inTable: true,
        mono: true,
        width: '7rem',
        hint: 'Short and without spaces, e.g. AF51. Receipts encoded as "AF 51" or "af-51" are matched to this.',
      },
      {
        key: 'name',
        label: 'Name',
        type: 'text',
        required: true,
        inTable: true,
        hint: 'e.g. "Accountable Form No. 51 - Official Receipt".',
      },
      {
        key: 'printedAs',
        label: 'Printed on COA reports as',
        type: 'text',
        inTable: true,
        hint: 'How the form is named on the face of a printed report, e.g. "ACCT. FORM NO. 51".',
      },
      {
        key: 'bookletSize',
        label: 'Serials per booklet',
        type: 'number',
        required: true,
        inTable: true,
        width: '8rem',
        hint: 'Fifty for the Official Receipt. Issuances that cross a booklet boundary are reported as separate lines.',
      },
      {
        key: 'serialLength',
        label: 'Serial length',
        type: 'number',
        width: '7rem',
        hint: 'How many digits the office writes, so computed serials are padded to match, e.g. 10 for 0007705351.',
      },
      {
        key: 'unitValue',
        label: 'Face value',
        type: 'amount',
        hint: 'Only for forms that carry a value of their own, such as a cash ticket, where the officer is accountable for money as well as paper. Leave blank for the Official Receipt.',
      },
      { key: 'sortOrder', label: 'Sort order', type: 'number', width: '7rem' },
    ],
    note: 'Changing the booklet size does not restate reports already certified; it applies to reports prepared from now on.',
  },

  accounts: {
    slug: 'accounts',
    collection: COL.accounts,
    title: 'Chart of Accounts',
    singular: 'account',
    description:
      'The backbone of every report. An account’s classification decides where it appears on the financial statements, so changing one silently restates prior periods - only the Municipal Accountant and administrators may edit these.',
    idField: 'code',
    defaultSort: 'code',
    fields: [
      { key: 'code', label: 'Account code', type: 'text', required: true, inTable: true, mono: true, width: '9rem', hint: 'UACS code from the COA Revised Chart of Accounts for LGUs.' },
      { key: 'name', label: 'Account title', type: 'text', required: true, inTable: true },
      {
        key: 'accountClass',
        label: 'Account class',
        type: 'select',
        required: true,
        inTable: true,
        width: '8rem',
        options: ACCOUNT_CLASSES.map((c) => ({ value: c, label: c })),
      },
      {
        key: 'normalBalance',
        label: 'Normal balance',
        type: 'select',
        required: true,
        width: '7rem',
        options: NORMAL_BALANCES.map((b) => ({ value: b, label: b })),
      },
      {
        key: 'fsClassification',
        label: 'Financial statement classification',
        type: 'select',
        required: true,
        inTable: true,
        options: FS_CLASSIFICATIONS.map((c) => ({ value: c, label: c.replace(/_/g, ' ') })),
        hint: 'Decides where this account appears on the Statement of Financial Position or Performance.',
      },
      {
        key: 'cashFlowClass',
        label: 'Cash flow classification',
        type: 'select',
        options: CASH_FLOW_CLASSES.map((c) => ({ value: c, label: c })),
      },
      {
        key: 'expenseClass',
        label: 'Expense classification',
        type: 'select',
        options: Object.entries(EXPENSE_CLASS_LABELS).map(([value, label]) => ({ value, label: `${value} - ${label}` })),
        hint: 'Personnel Services, MOOE, Financial Expenses or Capital Outlay. Expense accounts only.',
      },
      {
        key: 'postable',
        label: 'Postable',
        type: 'checkbox',
        defaultValue: true,
        hint: 'Leave this ticked for a normal account. Clear it only for grouping headers that exist in reports but are never posted to.',
      },
      { key: 'isControl', label: 'Control account', type: 'checkbox', hint: 'Posts through a subsidiary ledger, e.g. Accounts Payable.' },
      {
        key: 'requiresSubsidiary',
        label: 'Has a subsidiary ledger',
        type: 'checkbox',
        inTable: true,
        width: '7rem',
        hint: 'Kept per party: every line on this account names its subsidiary ledger account (payee, employee, office...). Patch 158: on a receipt, a non-revenue line (a receivable or a payable) always asks for one; tick this on a REVENUE account that is kept per party too, and its receipts will ask as well.',
        whenUnset: (r) => requiresSubsidiaryFor(String(r.code ?? '')),
      },
      {
        key: 'liquidatable',
        label: 'Advance subject to liquidation',
        type: 'checkbox',
        inTable: true,
        width: '8rem',
        hint: 'Advance subject to liquidation. Money posted to this account is owed back by the officer named as its subsidiary, and is offered on the liquidation report. Ticked by default for Advances for Operating Expenses, Advances to Special Disbursing Officer, Advances to Officers and Employees and Other Receivables.',
        whenUnset: (r) => liquidatableByDefault(String(r.code ?? ''), String(r.name ?? '')),
      },
    ],
  },

  /*
   * Patch 158: Payees and Employees are one list - Names. A name of type
   * Employee carries the employee details as well, and they are mirrored to
   * the employee record the officer pickers and the EMPLOYEE subsidiary
   * ledgers read (see lib/names.ts).
   */
  names: {
    slug: 'names',
    collection: COL.payees,
    title: 'Names',
    singular: 'name',
    description:
      'Everyone the municipality deals with: suppliers, contractors, barangays, agencies - and its own officials and employees, whose employee details are kept here too. The TIN and bank details flow onto every voucher.',
    defaultSort: 'name',
    fields: [
      { key: 'code', label: 'Code', type: 'text', inTable: true, mono: true, width: '8rem' },
      {
        key: 'name',
        label: 'Name',
        type: 'text',
        required: true,
        inTable: true,
        hint: 'For an employee, as it should print on a payroll register, e.g. "DELA CRUZ, Juan M."',
      },
      {
        key: 'payeeType',
        label: 'Type',
        type: 'select',
        required: true,
        inTable: true,
        width: '10rem',
        options: PAYEE_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })),
      },
      { key: 'tin', label: 'TIN', type: 'text', inTable: true, mono: true, width: '10rem' },
      { key: 'address', label: 'Address', type: 'text', hint: 'The registered address, as on BIR Form 2307.' },
      { key: 'zipCode', label: 'ZIP code', type: 'text', mono: true, hint: 'BIR Form 2307, item 4A.' },
      { key: 'contactNumber', label: 'Contact number', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'bankName', label: 'Bank', type: 'text', hint: 'Used for ADA and LDDAP payments.' },
      { key: 'bankAccountNumber', label: 'Bank account number', type: 'text', mono: true },
      { key: 'bankAccountName', label: 'Bank account name', type: 'text' },
      // ---- the employee details, for a name of type Employee -------------
      {
        key: 'employeeNumber',
        label: 'Employee number',
        type: 'text',
        required: true,
        mono: true,
        showWhen: isEmployeeName,
      },
      { key: 'lastName', label: 'Last name', type: 'text', required: true, showWhen: isEmployeeName },
      { key: 'firstName', label: 'First name', type: 'text', required: true, showWhen: isEmployeeName },
      { key: 'middleName', label: 'Middle name', type: 'text', showWhen: isEmployeeName },
      { key: 'position', label: 'Position', type: 'text', inTable: true, showWhen: isEmployeeName },
      {
        key: 'employmentType',
        label: 'Employment type',
        type: 'select',
        required: true,
        showWhen: isEmployeeName,
        options: [
          { value: 'PERMANENT', label: 'Permanent' },
          { value: 'CASUAL', label: 'Casual' },
          { value: 'JOB_ORDER', label: 'Job Order' },
          { value: 'CONTRACT_OF_SERVICE', label: 'Contract of Service' },
          { value: 'ELECTIVE', label: 'Elective' },
          { value: 'COTERMINOUS', label: 'Coterminous' },
        ],
      },
      { key: 'gsisNumber', label: 'GSIS number', type: 'text', mono: true, showWhen: isEmployeeName },
      {
        key: 'philhealthNumber',
        label: 'PhilHealth number',
        type: 'text',
        mono: true,
        showWhen: isEmployeeName,
      },
      { key: 'pagibigNumber', label: 'Pag-IBIG number', type: 'text', mono: true, showWhen: isEmployeeName },
      { key: 'monthlyRate', label: 'Monthly rate', type: 'amount', showWhen: isEmployeeName },
    ],
  },

  barangays: {
    slug: 'barangays',
    collection: COL.barangays,
    title: 'Barangays',
    singular: 'barangay',
    description:
      'The barangays of Candoni. Used to split the barangay share of the basic real property tax, which follows the property rather than the payor.',
    defaultSort: 'sortOrder',
    fields: [
      { key: 'code', label: 'Barangay code', type: 'text', required: true, inTable: true, mono: true, width: '7rem' },
      { key: 'name', label: 'Barangay name', type: 'text', required: true, inTable: true },
      { key: 'sortOrder', label: 'Sort order', type: 'number', width: '7rem' },
    ],
  },
  offices: {
    slug: 'offices',
    collection: COL.offices,
    title: 'Offices',
    singular: 'office',
    description: 'Departments and offices of the municipality, used throughout the budget and accounting modules.',
    defaultSort: 'sortOrder',
    fields: [
      { key: 'code', label: 'Office code', type: 'text', required: true, inTable: true, mono: true, width: '7rem' },
      { key: 'name', label: 'Office name', type: 'text', required: true, inTable: true },
      { key: 'shortName', label: 'Short name', type: 'text', inTable: true, width: '10rem' },
      { key: 'head', label: 'Office head', type: 'text', inTable: true },
      { key: 'headPosition', label: 'Position', type: 'text' },
      {
        // Optional, and it stays optional. See the note on Office.functionCode:
        // nothing can derive which function of Annex A an office performs, so
        // an empty value here is a question not yet answered, never a fault.
        key: 'functionCode',
        label: 'GAM function code (F.P.P.)',
        type: 'select',
        inTable: true,
        width: '8rem',
        options: [
          { value: '', label: 'Not set' },
          ...FPP_CODES.map((f) => ({ value: f.code, label: fppLabel(f.code) })),
        ],
      },
      { key: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },

  /*
    "ppa" was here: a two-field screen over the programmes collection.

    Budget programmes are kept per fiscal year now and live on a tab beside the
    appropriations, at /budget/appropriations/programmes. A programme is what
    the Sanggunian appropriated to in ONE annual budget - it is not master data
    in the sense the rest of this file means, which is things that are true
    until somebody changes them.

    The old address redirects; see src/App.tsx.
  */

  intermediaries: {
    slug: 'intermediaries',
    collection: COL.intermediaries,
    title: 'Collection Intermediaries',
    singular: 'intermediary',
    description:
      "Who collects money on the municipality's behalf - GCash, Maya, a bank's online portal. COA Circular 2021-014 names one on the face of the e-collection reports, so they are kept here rather than typed on each receipt: the same intermediary spelt three ways is three intermediaries on the report, and a remittance cannot then be reconciled against the collections it covers.",
    defaultSort: 'name',
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, inTable: true, mono: true, width: '8rem' },
      { key: 'name', label: 'Name', type: 'text', required: true, inTable: true },
      {
        key: 'merchantId',
        label: 'Merchant or biller ID',
        type: 'text',
        inTable: true,
        mono: true,
        width: '12rem',
      },
      { key: 'notes', label: 'Notes', type: 'text' },
    ],
  },

  banks: {
    slug: 'banks',
    collection: COL.bankAccounts,
    title: 'Bank Accounts',
    singular: 'bank account',
    description:
      'Every bank account belongs to exactly one fund - CFMS refuses a payment or deposit that would move money between funds through a single account.',
    defaultSort: 'bankName',
    fields: [
      { key: 'bankName', label: 'Bank', type: 'text', required: true, inTable: true },
      { key: 'branch', label: 'Branch', type: 'text', inTable: true },
      { key: 'accountNumber', label: 'Account number', type: 'text', required: true, inTable: true, mono: true },
      { key: 'accountName', label: 'Account name', type: 'text', required: true },
      {
        key: 'fundCode',
        label: 'Fund',
        type: 'select',
        required: true,
        inTable: true,
        width: '6rem',
        options: [
          { value: 'GF', label: 'General Fund' },
          { value: 'SEF', label: 'Special Education Fund' },
          { value: 'TF', label: 'Trust Fund' },
        ],
      },
      {
        key: 'accountType',
        label: 'Account type',
        type: 'select',
        options: [
          { value: 'CURRENT', label: 'Current' },
          { value: 'SAVINGS', label: 'Savings' },
          { value: 'TIME_DEPOSIT', label: 'Time deposit' },
        ],
      },
      {
        key: 'glAccountCode',
        label: 'General Ledger account',
        type: 'text',
        required: true,
        mono: true,
        hint: 'The Cash in Bank account this bank account posts to, e.g. 10102020.',
      },
    ],
  },

  'tax-codes': {
    slug: 'tax-codes',
    collection: COL.taxCodes,
    title: 'Tax Codes',
    singular: 'tax code',
    description:
      'Withholding tax rates and the liability accounts they credit. The base matters: expanded withholding applies to the gross for a non-VAT supplier and to the VAT-exclusive amount for a VAT-registered one, and getting it wrong leaves the municipality liable for the shortfall.',
    defaultSort: 'code',
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, inTable: true, mono: true, width: '7rem' },
      { key: 'description', label: 'Description', type: 'text', required: true, inTable: true },
      {
        key: 'kind',
        label: 'Kind',
        type: 'select',
        required: true,
        inTable: true,
        width: '10rem',
        options: [
          { value: 'EWT', label: 'Expanded withholding tax' },
          { value: 'VAT_WITHHOLDING', label: 'VAT withholding' },
          { value: 'PERCENTAGE_TAX', label: 'Percentage tax' },
          { value: 'OTHER', label: 'Other' },
        ],
      },
      { key: 'rate', label: 'Rate', type: 'number', required: true, inTable: true, width: '6rem', hint: 'As a fraction: 0.02 for 2%.' },
      {
        key: 'base',
        label: 'Applied to',
        type: 'select',
        required: true,
        options: [
          { value: 'GROSS', label: 'Gross amount' },
          { value: 'NET_OF_VAT', label: 'Net of VAT (gross / 1.12)' },
        ],
      },
      { key: 'accountCode', label: 'Liability account', type: 'text', required: true, mono: true },
      { key: 'atc', label: 'BIR ATC', type: 'text', mono: true, hint: 'Alphanumeric tax code printed on BIR Form 2307.' },
    ],
  },

  funds: {
    slug: 'funds',
    collection: COL.funds,
    title: 'Funds',
    singular: 'fund',
    description:
      'Each fund keeps its own complete set of books: chart of accounts, ledgers, trial balance and financial statements. The three statutory funds cannot be deactivated.',
    idField: 'code',
    defaultSort: 'sortOrder',
    fields: [
      { key: 'code', label: 'Fund code', type: 'text', required: true, inTable: true, mono: true, width: '6rem' },
      { key: 'name', label: 'Fund name', type: 'text', required: true, inTable: true },
      { key: 'bookCode', label: 'Book code', type: 'text', required: true, inTable: true, mono: true, width: '7rem', hint: 'Used in document numbers, e.g. 100 for the General Fund.' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },
};

/**
 * The order the tabs run in.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS WRITTEN DOWN RATHER THAN TAKEN FROM CONFIGS
 * ---------------------------------------------------------------------------
 * The strip used to be `Object.values(CONFIGS)`, so the order was whatever
 * order the configurations happened to be declared in - which put Revenue
 * Codes and Accountable Forms, two things a clerk opens a few times a year,
 * in front of the Chart of Accounts and the Payees, which are opened daily.
 *
 * The SIDEBAR had a considered order, and the sidebar is what this strip
 * replaces. So the order moves here rather than being lost with the menu:
 * the records consulted constantly first, then the people and places, then
 * the codes and the controls.
 *
 * Anything not named here is appended rather than dropped. A new entity added
 * without a thought for where it belongs should appear at the end of the
 * strip, not vanish off it - a screen nothing links to is a screen the office
 * stops knowing about.
 */
/**
 * The eleven, in four groups.
 *
 * ---------------------------------------------------------------------------
 * WHY GROUPED, AND WHY THIS ORDER
 * ---------------------------------------------------------------------------
 * Eleven tabs in a row is two wrapped rows, and at that length a strip stops
 * being a map - eleven things all look equally likely, so finding one means
 * reading the lot.
 *
 * The order inside the groups is the one the SIDEBAR had before patch 93 took
 * the menu away: the records consulted constantly first, then the people and
 * places, then the banking, then the codes. The chip strip before that ran in
 * whatever order the eleven happened to be declared in, which put two screens
 * opened a few times a year ahead of the two opened daily.
 */
const TAB_GROUPS: Array<{ group: string; slugs: string[] }> = [
  { group: 'Ledger', slugs: ['accounts', 'funds'] },
  { group: 'People and places', slugs: ['names', 'offices', 'barangays'] },
  // GCash, Maya, a bank's online portal - beside the banks, because that is
  // what an officer is thinking of when they go looking for one.
  { group: 'Banking', slugs: ['banks', 'intermediaries'] },
  { group: 'Codes and forms', slugs: ['tax-codes', 'revenue-codes', 'accountable-forms'] },
];

const bySlug = (slug: string) => Object.values(CONFIGS).find((c) => c.slug === slug);

export const MASTER_DATA_TAB_GROUPS = [
  ...TAB_GROUPS.map((g) => ({
    group: g.group,
    tabs: g.slugs
      .map(bySlug)
      .filter((c): c is EntityConfig => !!c)
      .map((c) => ({ label: c.title, to: `/master-data/${c.slug}` })),
  })),
  /*
   * Anything not placed above is appended under its own heading rather than
   * dropped. A new entity added without a thought for where it belongs should
   * appear at the end of the strip, not vanish off it - a screen nothing links
   * to is a screen the office stops knowing about.
   */
  ...(() => {
    const placed = new Set(TAB_GROUPS.flatMap((g) => g.slugs));
    const rest = Object.values(CONFIGS).filter((c) => !placed.has(c.slug));
    return rest.length
      ? [
          {
            group: 'Other',
            tabs: rest.map((c) => ({ label: c.title, to: `/master-data/${c.slug}` })),
          },
        ]
      : [];
  })(),
];

export const MASTER_DATA_TABS = MASTER_DATA_TAB_GROUPS.flatMap((g) => g.tabs);

export default function MasterData() {
  const { entity } = useParams<{ entity: string }>();
  // Patch 158: Payees and Employees are Names now.
  if (entity === 'payees' || entity === 'employees') {
    return <Navigate to="/master-data/names" replace />;
  }
  const config = entity ? CONFIGS[entity] : undefined;

  if (!config) return <Navigate to="/master-data/accounts" replace />;

  return <MasterDataScreen key={config.slug} config={config} />;
}

function MasterDataScreen({ config }: { config: EntityConfig }) {
  const { can, user, profile } = useAuth();
  const toast = useToast();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [deactivating, setDeactivating] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useCollection<Record<string, unknown> & { id: string; active?: boolean }>(
    config.collection,
    [orderBy(config.defaultSort)],
    [config.collection, config.defaultSort],
  );

  const rows = useMemo(
    () => data.filter((r) => showInactive || r.active !== false),
    [data, showInactive],
  );

  const actor = user
    ? actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      })
    : null;

  const columns: Column<Record<string, unknown> & { id: string; active?: boolean }>[] = [
    ...config.fields
      .filter((f) => f.inTable)
      .map<Column<Record<string, unknown> & { id: string }>>((f) => ({
        key: f.key,
        header: f.label,
        width: f.width,
        value: (r) => {
          const v = r[f.key];
          return typeof v === 'number' || typeof v === 'string' ? v : '';
        },
        cell: (r) => {
          const v = r[f.key] === undefined && f.whenUnset ? f.whenUnset(r) : r[f.key];
          if (f.type === 'checkbox')
            return v ? <Badge tone="emerald">Yes</Badge> : <span className="text-slate-400">-</span>;
          if (v === undefined || v === null || v === '') return <span className="text-slate-400">-</span>;
          if (f.type === 'amount') return <span className="cbo-amount block">{formatPeso(Number(v))}</span>;
          if (f.key === 'rate') return <span className="font-mono text-sm">{(Number(v) * 100).toFixed(2)}%</span>;
          return (
            <span className={f.mono ? 'font-mono text-xs text-navy-800' : 'text-sm'}>
              {String(v).replace(/_/g, ' ')}
            </span>
          );
        },
      })),
    {
      key: 'status',
      header: '',
      width: '12rem',
      sortable: false,
      fixed: true,
      value: (r) => (r.active === false ? 'Inactive' : 'Active'),
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {r.active === false && <Badge tone="slate">Inactive</Badge>}
          {can('masterData', 'edit') && (
            <>
              <Button size="sm" onClick={() => setEditing(r)}>
                Edit
              </Button>
              {r.active === false ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (!actor) return;
                    void reactivateMaster(config.collection, r.id, actor);
                    // Patch 158: and the employee record behind a Name.
                    if (config.slug === 'names' && r.employeeId)
                      void reactivateMaster(COL.employees, String(r.employeeId), actor);
                  }}
                >
                  Reactivate
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setDeactivating(r)}>
                  Deactivate
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={config.title}
        subtitle={config.description}
        breadcrumbs={[{ label: 'Master Data' }, { label: config.title }]}
        actions={
          can('masterData', 'create') && (
            <>
              {/* Six hundred accounts is not a thing anybody adds one at a
                  time, so the chart gets a loader and the button to reach
                  it sits where somebody looking at an empty chart is. */}
              {config.slug === 'accounts' && (
                <Link to="/master-data/accounts/upload">
                  <Button size="sm">Load from a file</Button>
                </Link>
              )}
              <Button variant="primary" size="sm" onClick={() => setEditing({})}>
                Add {config.singular}
              </Button>
            </>
          )
        }
      />

      <GroupedSectionTabs groups={MASTER_DATA_TAB_GROUPS} />

      {config.slug === 'names' && actor && can('masterData', 'edit') && (
        <BringInEmployees names={data} actor={actor} />
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        searchPlaceholder={`Search ${config.title.toLowerCase()}`}
        emptyTitle={`No ${config.title.toLowerCase()} yet`}
        emptyMessage={`Add the first ${config.singular} to begin.`}
        pageSize={50}
        filters={
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Show deactivated
          </label>
        }
        exportMeta={{ title: config.title }}
      />

      {editing && actor && (
        <EntityForm
          config={config}
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success(`${config.singular.charAt(0).toUpperCase()}${config.singular.slice(1)} saved`);
          }}
          actor={actor}
        />
      )}

      <ConfirmDialog
        open={Boolean(deactivating)}
        onCancel={() => setDeactivating(null)}
        onConfirm={(reason) => {
          if (!deactivating || !actor) return;
          setBusy(true);
          void deactivateMaster(config.collection, deactivating.id as string, actor, reason)
            .then(() =>
              // Patch 158: a Name that is an employee takes its employee record with it.
              config.slug === 'names' && deactivating.employeeId
                ? deactivateMaster(COL.employees, String(deactivating.employeeId), actor, reason)
                : undefined,
            )
            .then(() => {
              toast.success('Deactivated', 'It no longer appears in the pickers. Historical records that use it are unaffected.');
              setDeactivating(null);
            })
            .catch((err) => toast.error('Could not deactivate', err.message))
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title={`Deactivate this ${config.singular}`}
        confirmLabel="Deactivate"
        variant="danger"
        requireReason
        minReasonLength={5}
        reasonHint="Recorded against the record so a future reader knows why it was withdrawn."
        message={
          <p>
            Deactivating removes it from the pickers for new transactions. Nothing is deleted:
            documents already referring to it keep working, and the record can be reactivated.
          </p>
        }
      />
    </div>
  );
}

function EntityForm({
  config,
  record,
  onClose,
  onSaved,
  actor,
}: {
  config: EntityConfig;
  record: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
  actor: ReturnType<typeof actorStamp>;
}) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const seeded: Record<string, unknown> = { ...record };
    if (!record.id) {
      for (const f of config.fields) {
        if (f.defaultValue !== undefined && seeded[f.key] === undefined) seeded[f.key] = f.defaultValue;
      }
    }
    for (const f of config.fields) {
      if (f.whenUnset && seeded[f.key] === undefined && record.id) seeded[f.key] = f.whenUnset(record);
    }
    return seeded;
  });
  const [saving, setSaving] = useState(false);
  const isNew = !record.id;

  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));
  /* Patch 158: a field with showWhen is on the form only when it applies. */
  const shownFields = config.fields.filter((f) => !f.showWhen || f.showWhen(values));

  const save = async () => {
    const missing = shownFields
      .filter((f) => f.required && !values[f.key])
      .map((f) => f.label);
    if (missing.length) {
      toast.error('Incomplete', `Required: ${missing.join(', ')}.`);
      return;
    }

    setSaving(true);
    try {
      const id =
        (record.id as string) ??
        (config.idField ? String(values[config.idField]) : undefined) ??
        crypto.randomUUID();

      /*
       * Patch 158: a Name of type Employee keeps its employee record in step -
       * the one the officer pickers and the EMPLOYEE subsidiary ledgers read.
       */
      const mirror =
        config.slug === 'names' && values.payeeType === 'EMPLOYEE'
          ? employeeMirror({ ...values, active: values.active ?? true }, id)
          : null;

      await upsertMaster(
        config.collection,
        id,
        {
          ...values,
          id,
          active: values.active ?? true,
          ...(mirror ? { employeeId: mirror.id } : {}),
        },
        actor,
      );
      if (mirror) await upsertMaster(COL.employees, mirror.id, mirror.data, actor);
      onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${isNew ? 'Add' : 'Edit'} ${config.singular}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {shownFields.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            required={f.required}
            hint={f.hint}
            htmlFor={`field-${f.key}`}
            className={f.type === 'checkbox' ? 'sm:col-span-2' : undefined}
          >
            {f.type === 'select' ? (
              <Select
                id={`field-${f.key}`}
                value={(values[f.key] as string) ?? ''}
                onChange={(e) => set(f.key, e.target.value)}
              >
                <option value="">Not set</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : f.type === 'checkbox' ? (
              <Checkbox
                checked={Boolean(values[f.key])}
                onChange={(checked) => set(f.key, checked)}
                label={f.hint ?? f.label}
              />
            ) : f.type === 'amount' ? (
              <AmountInput
                id={`field-${f.key}`}
                value={(values[f.key] as number) ?? null}
                onChange={(v) => set(f.key, v ?? 0)}
              />
            ) : f.type === 'number' ? (
              <TextInput
                id={`field-${f.key}`}
                type="number"
                step="any"
                value={(values[f.key] as number) ?? ''}
                onChange={(e) => set(f.key, e.target.value === '' ? null : Number(e.target.value))}
                className="font-mono"
              />
            ) : (
              <TextInput
                id={`field-${f.key}`}
                value={(values[f.key] as string) ?? ''}
                onChange={(e) => set(f.key, e.target.value)}
                className={f.mono ? 'font-mono' : undefined}
                disabled={!isNew && f.key === config.idField}
              />
            )}
          </Field>
        ))}
      </div>

      {!isNew && config.idField && (
        <Alert tone="info" className="mt-4">
          The {config.fields.find((f) => f.key === config.idField)?.label.toLowerCase()} is the
          record&rsquo;s identity and cannot be changed - documents already posted refer to it. To
          correct it, deactivate this record and create a new one.
        </Alert>
      )}
    </Modal>
  );
}

/**
 * Patch 158: the employees on file that are not yet on Names.
 *
 * Before Names, an employee was entered on the Employees screen and, if paid
 * on a voucher, a second time as a payee. This brings each of them in once:
 * tied to the payee of the same name where there is exactly one, otherwise
 * made a Name of their own (same id, so every EMPLOYEE subsidiary already
 * posted still finds them). Nothing is deleted and nothing posted changes.
 */
function BringInEmployees({
  names,
  actor,
}: {
  names: Array<Record<string, unknown> & { id: string }>;
  actor: ReturnType<typeof actorStamp>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const employees = useCollection<Record<string, unknown> & { id: string }>(
    COL.employees,
    [orderBy('displayName')],
    [COL.employees],
  );
  const plan = useMemo(
    () => (employees.loading ? null : planNameMerge(names, employees.data)),
    [names, employees.data, employees.loading],
  );
  const count = plan ? plan.links.length + plan.creates.length : 0;
  if (!plan || count === 0) return null;

  const run = async () => {
    setBusy(true);
    try {
      const byId = new Map(employees.data.map((e) => [e.id, e]));
      for (const l of plan.links) {
        const e = byId.get(l.employeeId) ?? ({} as Record<string, unknown>);
        const details = Object.fromEntries(
          Object.entries(e).filter(([k, v]) =>
            [
              'employeeNumber',
              'lastName',
              'firstName',
              'middleName',
              'position',
              'employmentType',
              'gsisNumber',
              'philhealthNumber',
              'pagibigNumber',
              'monthlyRate',
            ].includes(k) && v !== undefined && v !== null,
          ),
        );
        // The payee's own TIN and bank account stand; the employee's fill a blank.
        const payee = names.find((n) => n.id === l.payeeId) ?? ({} as Record<string, unknown>);
        const fill: Record<string, unknown> = {};
        for (const k of ['tin', 'bankAccountNumber'])
          if (!payee[k] && e[k]) fill[k] = e[k];
        await upsertMaster(
          COL.payees,
          l.payeeId,
          { ...details, ...fill, payeeType: 'EMPLOYEE', employeeId: l.employeeId },
          actor,
        );
        await upsertMaster(COL.employees, l.employeeId, { payeeId: l.payeeId }, actor);
      }
      for (const c of plan.creates) {
        await upsertMaster(COL.payees, c.employeeId, c.name, actor);
        await upsertMaster(COL.employees, c.employeeId, { payeeId: c.employeeId }, actor);
      }
      toast.success(
        'Employees brought into Names',
        `${plan.links.length} tied to the payee of the same name, ${plan.creates.length} added as new names.`,
      );
    } catch (err) {
      toast.error('Could not finish', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert
      tone="info"
      className="mb-4"
      title={`${count} employee${count === 1 ? '' : 's'} not yet on Names`}
    >
      <p>
        Payees and Employees are one list now. {plan.links.length} of these match a payee by name
        and will be tied to it; {plan.creates.length} will be added as names of type Employee.
        Nothing is deleted, and entries already posted are not touched.
      </p>
      <Button size="sm" variant="primary" className="mt-2" loading={busy} onClick={() => void run()}>
        Bring them in
      </Button>
    </Alert>
  );
}
