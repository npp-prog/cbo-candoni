import { useMemo, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { orderBy } from 'firebase/firestore';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
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
import { formatPeso } from '@/lib/money';
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
      { key: 'requiresSubsidiary', label: 'Requires a subsidiary on every line', type: 'checkbox' },
    ],
  },

  payees: {
    slug: 'payees',
    collection: COL.payees,
    title: 'Payees',
    singular: 'payee',
    description:
      'Suppliers, contractors, employees, barangays and agencies the municipality pays. The TIN and the default withholding treatment recorded here flow onto every voucher.',
    defaultSort: 'name',
    fields: [
      { key: 'code', label: 'Payee code', type: 'text', inTable: true, mono: true, width: '8rem' },
      { key: 'name', label: 'Name', type: 'text', required: true, inTable: true },
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
      { key: 'address', label: 'Address', type: 'text' },
      { key: 'contactNumber', label: 'Contact number', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'bankName', label: 'Bank', type: 'text', hint: 'Used for ADA and LDDAP payments.' },
      { key: 'bankAccountNumber', label: 'Bank account number', type: 'text', mono: true },
      { key: 'bankAccountName', label: 'Bank account name', type: 'text' },
    ],
  },

  employees: {
    slug: 'employees',
    collection: COL.employees,
    title: 'Employees',
    singular: 'employee',
    description:
      'Officials and employees, used by payroll, cash advances and collecting-officer accountability.',
    defaultSort: 'displayName',
    fields: [
      { key: 'employeeNumber', label: 'Employee number', type: 'text', required: true, inTable: true, mono: true, width: '9rem' },
      { key: 'displayName', label: 'Name', type: 'text', required: true, inTable: true, hint: 'As it should print on a payroll register, e.g. "DELA CRUZ, Juan M."' },
      { key: 'lastName', label: 'Last name', type: 'text', required: true },
      { key: 'firstName', label: 'First name', type: 'text', required: true },
      { key: 'middleName', label: 'Middle name', type: 'text' },
      { key: 'position', label: 'Position', type: 'text', inTable: true },
      {
        key: 'employmentType',
        label: 'Employment type',
        type: 'select',
        required: true,
        inTable: true,
        width: '11rem',
        options: [
          { value: 'PERMANENT', label: 'Permanent' },
          { value: 'CASUAL', label: 'Casual' },
          { value: 'JOB_ORDER', label: 'Job Order' },
          { value: 'CONTRACT_OF_SERVICE', label: 'Contract of Service' },
          { value: 'ELECTIVE', label: 'Elective' },
          { value: 'COTERMINOUS', label: 'Coterminous' },
        ],
      },
      { key: 'tin', label: 'TIN', type: 'text', mono: true },
      { key: 'gsisNumber', label: 'GSIS number', type: 'text', mono: true },
      { key: 'philhealthNumber', label: 'PhilHealth number', type: 'text', mono: true },
      { key: 'pagibigNumber', label: 'Pag-IBIG number', type: 'text', mono: true },
      { key: 'monthlyRate', label: 'Monthly rate', type: 'amount' },
      { key: 'bankAccountNumber', label: 'Bank account number', type: 'text', mono: true },
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
      { key: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },

  ppa: {
    slug: 'ppa',
    collection: COL.programs,
    title: 'Programmes',
    singular: 'programme',
    description:
      'The programme, project and activity structure that budget lines are charged against. Projects and activities are maintained under their own collections and link back to a programme.',
    defaultSort: 'code',
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, inTable: true, mono: true, width: '8rem' },
      { key: 'name', label: 'Programme name', type: 'text', required: true, inTable: true },
    ],
  },

  banks: {
    slug: 'banks',
    collection: COL.bankAccounts,
    title: 'Bank Accounts',
    singular: 'bank account',
    description:
      'Every bank account belongs to exactly one fund - CBO refuses a payment or deposit that would move money between funds through a single account.',
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

export default function MasterData() {
  const { entity } = useParams<{ entity: string }>();
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
          const v = r[f.key];
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
                  onClick={() => actor && void reactivateMaster(config.collection, r.id, actor)}
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

      <nav className="mb-4 flex flex-wrap gap-1.5 no-print">
        {Object.values(CONFIGS).map((c) => (
          <Link
            key={c.slug}
            to={`/master-data/${c.slug}`}
            className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
              c.slug === config.slug
                ? 'bg-brand-600 text-white'
                : 'bg-white text-navy-700 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {c.title}
          </Link>
        ))}
      </nav>

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
    return seeded;
  });
  const [saving, setSaving] = useState(false);
  const isNew = !record.id;

  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const save = async () => {
    const missing = config.fields.filter((f) => f.required && !values[f.key]).map((f) => f.label);
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

      await upsertMaster(
        config.collection,
        id,
        {
          ...values,
          id,
          active: values.active ?? true,
        },
        actor,
      );
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
        {config.fields.map((f) => (
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
