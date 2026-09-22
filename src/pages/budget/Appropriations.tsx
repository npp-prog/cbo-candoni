import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, Select, DateInput, AmountInput, TextArea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAppropriations } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { Appropriation, AppropriationKind } from '@/types/budget';
import { fundLabel } from './Obligations';

/**
 * Appropriations.
 *
 * The appropriation is the only figure in the budget chain with no upstream
 * control - it comes from an ordinance of the Sangguniang Bayan and the system
 * records it. What the system does insist on is the authority reference, so
 * that every peso of spending authority can be traced back to the ordinance
 * that created it.
 */

const KINDS: Array<{ value: AppropriationKind; label: string; hint: string }> = [
  { value: 'ORIGINAL', label: 'Original', hint: 'The annual budget as enacted.' },
  { value: 'SUPPLEMENTAL', label: 'Supplemental', hint: 'Additional authority enacted during the year.' },
  { value: 'CONTINUING', label: 'Continuing', hint: 'Prior-year authority carried forward.' },
  { value: 'REALIGNMENT', label: 'Realignment', hint: 'Moves authority between lines. Enter as a pair: negative on the source, positive on the destination.' },
  { value: 'TRANSFER', label: 'Transfer', hint: 'Transfer between offices or funds, also entered as a pair.' },
  { value: 'ADJUSTMENT', label: 'Adjustment', hint: 'A correction. May be negative.' },
];

export default function Appropriations() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, user, profile } = useAuth();
  const toast = useToast();
  const { data, loading, error } = useAppropriations(fiscalYear, fundCode);

  const [showForm, setShowForm] = useState(false);
  const [approving, setApproving] = useState<Appropriation | null>(null);
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => {
    const approved = data.filter((a) => a.status === 'APPROVED');
    return {
      original: approved.filter((a) => a.kind === 'ORIGINAL').reduce((s, a) => s + a.amount, 0),
      supplemental: approved.filter((a) => a.kind === 'SUPPLEMENTAL').reduce((s, a) => s + a.amount, 0),
      continuing: approved.filter((a) => a.kind === 'CONTINUING').reduce((s, a) => s + a.amount, 0),
      adjustments: approved
        .filter((a) => ['REALIGNMENT', 'TRANSFER', 'ADJUSTMENT'].includes(a.kind))
        .reduce((s, a) => s + a.amount, 0),
      revised: approved.reduce((s, a) => s + a.amount, 0),
    };
  }, [data]);

  const approve = async (appropriation: Appropriation) => {
    setBusy(true);
    try {
      await engine.approveAppropriation({ appropriationId: appropriation.id });
      toast.success(
        'Appropriation approved',
        `${formatPeso(appropriation.amount)} of authority is now available for allotment against ${appropriation.accountCode}.`,
      );
      setApproving(null);
    } catch (err) {
      toast.error('Could not approve', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Appropriation>[] = [
    {
      key: 'kind',
      header: 'Type',
      width: '8rem',
      value: (a) => a.kind,
      cell: (a) => <span className="text-xs">{KINDS.find((k) => k.value === a.kind)?.label ?? a.kind}</span>,
    },
    {
      key: 'authority',
      header: 'Authority',
      value: (a) => a.authorityReference ?? '',
      cell: (a) => (
        <div>
          <span className="text-xs text-navy-900">{a.authorityReference ?? '-'}</span>
          {a.authorityDate && (
            <span className="block text-2xs text-slate-500">{formatShortDate(a.authorityDate)}</span>
          )}
        </div>
      ),
    },
    {
      key: 'office',
      header: 'Office',
      value: (a) => a.officeName,
      cell: (a) => <span className="text-xs text-slate-600">{a.officeName}</span>,
    },
    {
      key: 'account',
      header: 'Account',
      value: (a) => `${a.accountCode} ${a.accountName}`,
      cell: (a) => (
        <div>
          <span className="font-mono text-xs text-slate-500">{a.accountCode}</span>{' '}
          <span className="text-sm">{a.accountName}</span>
        </div>
      ),
    },
    {
      key: 'expenseClass',
      header: 'Class',
      width: '5rem',
      value: (a) => a.expenseClass,
      cell: (a) => <span className="text-xs">{a.expenseClass}</span>,
      optional: true,
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (a) => a.amount,
      cell: (a) => (
        <span className={a.amount < 0 ? 'text-rose-700' : undefined}>
          {formatPeso(a.amount, { symbol: false, parens: true })}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '11rem',
      value: (a) => a.status,
      cell: (a) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={a.status} />
          {a.status === 'DRAFT' && can('budget', 'approve') && (
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => {
                e.stopPropagation();
                setApproving(a);
              }}
            >
              Approve
            </Button>
          )}
        </div>
      ),
      fixed: true,
      sortable: false,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Appropriations"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Appropriation' }]}
        actions={
          can('budget', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              Record appropriation
            </Button>
          )
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryTile label="Original" amount={totals.original} />
        <SummaryTile label="Supplemental" amount={totals.supplemental} />
        <SummaryTile label="Continuing" amount={totals.continuing} />
        <SummaryTile label="Realignments and adjustments" amount={totals.adjustments} />
        <SummaryTile label="Revised appropriation" amount={totals.revised} emphasis />
      </div>

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(a) => a.id}
        loading={loading}
        error={error}
        searchPlaceholder="Account, office or authority reference"
        emptyTitle="No appropriations recorded"
        emptyMessage={`Record the enacted budget for the ${fundLabel(fundCode)} before releasing allotments.`}
        exportMeta={{
          title: 'Appropriation Ledger',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <AppropriationForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Appropriation saved as a draft', 'Approve it to make the authority available.');
          }}
          actor={
            user
              ? actorStamp({
                  uid: user.uid,
                  name: profile?.displayName ?? user.email ?? user.uid,
                  position: profile?.position,
                })
              : null
          }
        />
      )}

      <ConfirmDialog
        open={Boolean(approving)}
        onCancel={() => setApproving(null)}
        onConfirm={() => {
          if (approving) void approve(approving);
        }}
        loading={busy}
        title="Approve appropriation"
        confirmLabel="Approve"
        variant="primary"
        message={
          approving && (
            <p>
              This makes <strong>{formatPeso(approving.amount)}</strong> of spending authority
              available against {approving.accountCode} {approving.accountName} for{' '}
              {approving.officeName}. An approved appropriation cannot be edited; a change is made
              by recording a supplemental appropriation or an adjustment.
            </p>
          )
        }
      />
    </div>
  );
}

function SummaryTile({
  label,
  amount,
  emphasis,
}: {
  label: string;
  amount: number;
  emphasis?: boolean;
}) {
  return (
    <div className={`cbo-card px-4 py-3 ${emphasis ? 'border-brand-300 bg-brand-50/40' : ''}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-base font-semibold tabular text-navy-900">
        {formatPeso(amount)}
      </p>
    </div>
  );
}

function AppropriationForm({
  fiscalYear,
  fundCode,
  onClose,
  onSaved,
  actor,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onSaved: () => void;
  actor: ReturnType<typeof actorStamp> | null;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<AppropriationKind>('ORIGINAL');
  const [authorityReference, setAuthorityReference] = useState('');
  const [authorityDate, setAuthorityDate] = useState(todayPh());
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [accountCode, setAccountCode] = useState<string | null>(null);
  const [accountName, setAccountName] = useState('');
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>('MOOE');
  const [amount, setAmount] = useState<number | null>(null);
  const [particulars, setParticulars] = useState('');
  const [saving, setSaving] = useState(false);

  const allowsNegative = ['REALIGNMENT', 'TRANSFER', 'ADJUSTMENT'].includes(kind);
  const selectedKind = KINDS.find((k) => k.value === kind)!;

  const save = async () => {
    if (!officeId || !accountCode || !amount || !actor) {
      toast.error('Incomplete', 'Office, account and amount are all required.');
      return;
    }
    setSaving(true);
    try {
      await createDraft(
        COL.appropriations,
        {
          fiscalYear,
          fundCode,
          officeId,
          officeName,
          accountCode,
          accountName,
          expenseClass,
          kind,
          authorityReference: authorityReference.trim() || null,
          authorityDate,
          amount,
          particulars: particulars.trim() || null,
          status: 'DRAFT',
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
      title="Record an appropriation"
      description="Saved as a draft. Approving it makes the authority available for allotment."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" required htmlFor="kind" hint={selectedKind.hint}>
          <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as AppropriationKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Authority reference" htmlFor="authority" hint="Ordinance or resolution number">
            <TextInput
              id="authority"
              value={authorityReference}
              onChange={(e) => setAuthorityReference(e.target.value)}
              placeholder="Ord. No. 2026-01"
            />
          </Field>
          <Field label="Authority date" htmlFor="authorityDate">
            <DateInput id="authorityDate" value={authorityDate} onChange={setAuthorityDate} />
          </Field>
        </div>

        <Field label="Office" required htmlFor="office">
          <OfficePicker
            id="office"
            value={officeId}
            onChange={(v, o) => {
              setOfficeId(v);
              setOfficeName(o?.name ?? '');
            }}
          />
        </Field>

        <Field label="Account" required htmlFor="account">
          <AccountPicker
            id="account"
            value={accountCode}
            onChange={(code, account) => {
              setAccountCode(code);
              setAccountName(account?.name ?? '');
            }}
          />
        </Field>

        <Field label="Expense classification" htmlFor="expenseClass">
          <Select
            id="expenseClass"
            value={expenseClass}
            onChange={(e) => setExpenseClass(e.target.value as ExpenseClass)}
          >
            {(Object.keys(EXPENSE_CLASS_LABELS) as ExpenseClass[]).map((c) => (
              <option key={c} value={c}>
                {c} - {EXPENSE_CLASS_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Amount"
          required
          htmlFor="amount"
          hint={allowsNegative ? 'May be negative for the source side of a realignment.' : undefined}
        >
          <AmountInput id="amount" value={amount} onChange={setAmount} allowNegative={allowsNegative} />
        </Field>

        <Field label="Particulars" htmlFor="particulars" className="sm:col-span-2">
          <TextArea
            id="particulars"
            rows={2}
            value={particulars}
            onChange={(e) => setParticulars(e.target.value)}
          />
        </Field>
      </div>

      {allowsNegative && (
        <Alert tone="info" className="mt-4">
          A realignment or transfer is recorded as two entries of equal size and opposite sign: a
          negative one against the line the authority comes from, and a positive one against the
          line it goes to. Record both, so the fund total is unchanged.
        </Alert>
      )}
    </Modal>
  );
}
