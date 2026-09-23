import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput, TextArea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAllotments, useBudgetBalances } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { checkAllotmentAgainstAppropriation } from '@/lib/accounting-rules';
import { budgetKeyId, type Allotment } from '@/types/budget';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import { fundLabel } from './Obligations';

/**
 * Allotment releases.
 *
 * The first budget control gate: cumulative allotments may not exceed the
 * revised appropriation for the same line. As on the obligation form, the
 * available figure shown while typing is a preview read from the budget
 * registry; `releaseAllotment` re-reads and re-checks it server-side before
 * committing.
 */
export default function Allotments() {
  const { fiscalYear, fundCode } = useFilters();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error } = useAllotments(fiscalYear, fundCode);

  const [showForm, setShowForm] = useState(false);
  const [releasing, setReleasing] = useState<Allotment | null>(null);
  const [busy, setBusy] = useState(false);

  const totalReleased = useMemo(
    () => data.filter((a) => a.status === 'APPROVED').reduce((s, a) => s + a.amount, 0),
    [data],
  );

  const release = async (allotment: Allotment) => {
    setBusy(true);
    try {
      const result = await engine.releaseAllotment({ allotmentId: allotment.id });
      toast.success(
        `Allotment ${result.allotmentNo} released`,
        `${formatPeso(allotment.amount)} is now available to obligate. Remaining appropriation on this line: ${formatPeso(result.availableAppropriation)}.`,
      );
      setReleasing(null);
    } catch (err) {
      toast.error('The allotment was not released', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Allotment>[] = [
    {
      key: 'allotmentNo',
      header: 'Reference',
      width: '10rem',
      value: (a) => a.allotmentNo ?? '',
      cell: (a) =>
        a.allotmentNo ? (
          <span className="font-mono text-xs">{a.allotmentNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Draft</span>
        ),
    },
    {
      key: 'allotmentDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (a) => a.allotmentDate,
      cell: (a) => <span className="text-xs">{formatShortDate(a.allotmentDate)}</span>,
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
      header: 'Released',
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
      width: '10rem',
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
                setReleasing(a);
              }}
            >
              Release
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
        title="Allotments"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - ${formatPeso(totalReleased)} released`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Allotments' }]}
        actions={
          can('budget', 'create') && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => navigate('/budget/allotments/upload')}>
                Upload releases
              </Button>
              (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              Release allotment
            </Button>
            </div>
          )
        }
      />

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(a) => a.id}
        loading={loading}
        error={error}
        searchPlaceholder="Reference, office or account"
        emptyTitle="No allotments released"
        emptyMessage="Offices cannot obligate until allotments are released against the approved appropriations."
        exportMeta={{
          title: 'Allotment Ledger',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <AllotmentForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Allotment saved as a draft', 'Release it to make it available to obligate.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(releasing)}
        onCancel={() => setReleasing(null)}
        onConfirm={() => {
          if (releasing) void release(releasing);
        }}
        loading={busy}
        title="Release allotment"
        confirmLabel="Release"
        variant="primary"
        message={
          releasing && (
            <p>
              Releasing makes <strong>{formatPeso(releasing.amount)}</strong> available to obligate
              against {releasing.accountCode} {releasing.accountName} for {releasing.officeName}.
              The available appropriation will be re-checked on the server before the release is
              committed.
            </p>
          )
        }
      />
    </div>
  );
}

function AllotmentForm({
  fiscalYear,
  fundCode,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();
  const balances = useBudgetBalances(fiscalYear, fundCode);

  const [allotmentDate, setAllotmentDate] = useState(todayPh());
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [accountCode, setAccountCode] = useState<string | null>(null);
  const [accountName, setAccountName] = useState('');
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>('MOOE');
  const [amount, setAmount] = useState<number | null>(null);
  const [particulars, setParticulars] = useState('');
  const [saving, setSaving] = useState(false);

  const balance = useMemo(() => {
    if (!officeId || !accountCode) return null;
    const key = budgetKeyId({ fiscalYear, fundCode, officeId, accountCode });
    return balances.data.find((b) => b.id === key) ?? null;
  }, [officeId, accountCode, balances.data, fiscalYear, fundCode]);

  const check = useMemo(() => {
    if (!balance || !amount || amount <= 0) return null;
    return checkAllotmentAgainstAppropriation({
      appropriationRevised: balance.appropriationRevised,
      allotmentAlreadyReleased: balance.allotmentReleased,
      requestedRelease: amount,
    });
  }, [balance, amount]);

  const save = async () => {
    if (!officeId || !accountCode || !amount || !user) {
      toast.error('Incomplete', 'Office, account and amount are all required.');
      return;
    }
    setSaving(true);
    try {
      await createDraft(
        COL.allotments,
        {
          fiscalYear,
          fundCode,
          allotmentDate,
          officeId,
          officeName,
          accountCode,
          accountName,
          expenseClass,
          amount,
          particulars: particulars.trim() || null,
          status: 'DRAFT',
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
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
      title="Release an allotment"
      description="Saved as a draft. Releasing it commits appropriation authority to the office."
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
        <Field label="Date" required htmlFor="allotmentDate">
          <DateInput id="allotmentDate" value={allotmentDate} onChange={setAllotmentDate} />
        </Field>

        <Field label="Expense classification" htmlFor="ec">
          <Select id="ec" value={expenseClass} onChange={(e) => setExpenseClass(e.target.value as ExpenseClass)}>
            {(Object.keys(EXPENSE_CLASS_LABELS) as ExpenseClass[]).map((c) => (
              <option key={c} value={c}>
                {c} - {EXPENSE_CLASS_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>

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

        <Field
          label="Amount to release"
          required
          htmlFor="amount"
          hint="Enter a negative amount to withdraw allotment."
        >
          <AmountInput
            id="amount"
            value={amount}
            onChange={setAmount}
            allowNegative
            invalid={check ? !check.ok : false}
          />
        </Field>

        <Field label="Particulars" htmlFor="particulars">
          <TextArea id="particulars" rows={2} value={particulars} onChange={(e) => setParticulars(e.target.value)} />
        </Field>
      </div>

      {balance && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Budget line position
          </p>
          <dl className="grid gap-3 sm:grid-cols-4">
            <Figure label="Revised appropriation" value={balance.appropriationRevised} />
            <Figure label="Already released" value={balance.allotmentReleased} />
            <Figure label="Available to release" value={balance.availableAppropriation} />
            <Figure
              label="After this release"
              value={balance.availableAppropriation - (amount ?? 0)}
              tone={check && !check.ok ? 'negative' : 'default'}
            />
          </dl>
        </div>
      )}

      {officeId && accountCode && !balance && (
        <Alert tone="warning" className="mt-4">
          No approved appropriation exists for this office and account. Record and approve the
          appropriation before releasing an allotment against it - the release will be refused
          otherwise.
        </Alert>
      )}

      {check && !check.ok && (
        <Alert tone="error" className="mt-4" title="Insufficient appropriation">
          {check.violations[0].message} A supplemental appropriation or a realignment is needed
          before this allotment can be released.
        </Alert>
      )}
    </Modal>
  );
}

function Figure({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'negative';
}) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 font-mono text-sm tabular ${tone === 'negative' ? 'text-rose-700' : 'text-navy-900'}`}
      >
        {formatPeso(value)}
      </dd>
    </div>
  );
}
