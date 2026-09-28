import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useLiquidations, useCashAdvances } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { checkLiquidation } from '@/lib/accounting-rules';
import type { Liquidation as LiquidationRecord, LiquidationLine, CashAdvance } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/**
 * Liquidation reports.
 *
 * The control here is specific and easy to get wrong: the total liquidated
 * plus refunded may not exceed the advance, unless the excess is explicitly
 * claimed as a reimbursement - which is a separate payable to the officer,
 * not a liquidation of the advance. Without that distinction an
 * over-liquidation quietly creates a credit balance in the advances account
 * that nobody notices until year end.
 */
export default function Liquidation() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data, loading, error } = useLiquidations(fiscalYear);
  const advances = useCashAdvances(fiscalYear, true);

  const [showForm, setShowForm] = useState(false);
  const [posting, setPosting] = useState<LiquidationRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => data.filter((l) => l.fundCode === fundCode), [data, fundCode]);
  const canPost = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const columns: Column<LiquidationRecord>[] = [
    {
      key: 'no',
      header: 'Report No.',
      width: '10rem',
      value: (l) => l.liquidationNo ?? '',
      cell: (l) =>
        l.liquidationNo && l.liquidationNo !== '(unnumbered)' ? (
          <span className="font-mono text-xs">{l.liquidationNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Draft</span>
        ),
    },
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (l) => l.liquidationDate,
      cell: (l) => <span className="text-xs">{formatShortDate(l.liquidationDate)}</span>,
    },
    {
      key: 'officer',
      header: 'Accountable officer',
      value: (l) => l.accountableOfficerName,
      cell: (l) => (
        <div>
          <span className="text-sm">{l.accountableOfficerName}</span>
          <span className="block text-2xs text-slate-500">{l.officeName}</span>
        </div>
      ),
    },
    {
      key: 'dvNo',
      header: 'Cash advance',
      width: '10rem',
      value: (l) => l.dvNo,
      cell: (l) => <span className="font-mono text-xs text-slate-500">{l.dvNo}</span>,
    },
    {
      key: 'granted',
      header: 'Granted',
      kind: 'amount',
      value: (l) => l.amountGranted,
      cell: (l) => formatPeso(l.amountGranted, { symbol: false }),
    },
    {
      key: 'liquidated',
      header: 'Liquidated',
      kind: 'amount',
      value: (l) => l.amountLiquidated,
      cell: (l) => formatPeso(l.amountLiquidated, { symbol: false }),
    },
    {
      key: 'refund',
      header: 'Refund',
      kind: 'amount',
      value: (l) => l.refundAmount,
      cell: (l) => formatPeso(l.refundAmount, { symbol: false, dash: true }),
    },
    {
      key: 'reimbursement',
      header: 'Reimbursement',
      kind: 'amount',
      value: (l) => l.reimbursementAmount,
      cell: (l) => formatPeso(l.reimbursementAmount, { symbol: false, dash: true }),
      optional: true,
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      kind: 'amount',
      value: (l) => l.outstandingBalance,
      cell: (l) => formatPeso(l.outstandingBalance, { symbol: false, dash: true }),
    },
    {
      key: 'status',
      header: 'Status',
      width: '10rem',
      value: (l) => l.status,
      fixed: true,
      sortable: false,
      cell: (l) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={l.status} />
          {canPost && ['DRAFT', 'SUBMITTED', 'REVIEWED'].includes(l.status) && (
            <Button size="sm" variant="primary" onClick={() => setPosting(l)}>
              Post
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Liquidation Report"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Liquidation Report' }]}
        actions={
          can('accounting', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              New liquidation report
            </Button>
          )
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(l) => l.id}
        loading={loading}
        error={error}
        searchPlaceholder="Officer, report number or cash advance"
        emptyTitle="No liquidation reports"
        emptyMessage="A liquidation report settles a cash advance against the expenses actually incurred."
        exportMeta={{
          title: 'Liquidation Monitoring Report',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <LiquidationForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          advances={advances.data.filter((a) => a.fundCode === fundCode)}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Liquidation saved as a draft', 'Post it to settle the advance in the books.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(posting)}
        onCancel={() => setPosting(null)}
        onConfirm={() => {
          if (!posting) return;
          setBusy(true);
          void engine
            .postLiquidation({ liquidationId: posting.id })
            .then((result) => {
              toast.success(
                'Liquidation posted',
                `Outstanding balance on the advance is now ${formatPeso(result.outstandingBalance)}.`,
              );
              setPosting(null);
            })
            .catch((err) => toast.error('The liquidation was not posted', err.message))
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title="Post liquidation"
        confirmLabel="Post"
        variant="primary"
        message={
          posting && (
            <p>
              Recognises {formatPeso(posting.amountLiquidated)} of expenses
              {posting.refundAmount > 0 && `, a refund of ${formatPeso(posting.refundAmount)}`}
              {posting.reimbursementAmount > 0 &&
                `, and a reimbursement of ${formatPeso(posting.reimbursementAmount)} due to the officer`}
              , and credits the cash advance account.
            </p>
          )
        }
      />
    </div>
  );
}

function LiquidationForm({
  fiscalYear,
  fundCode,
  advances,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  advances: CashAdvance[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const [cashAdvanceId, setCashAdvanceId] = useState('');
  const [liquidationDate, setLiquidationDate] = useState(todayPh());
  const [lines, setLines] = useState<Array<Partial<LiquidationLine>>>([{ lineNo: 1, date: todayPh() }]);
  const [refundAmount, setRefundAmount] = useState<number | null>(null);
  const [reimbursementAmount, setReimbursementAmount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const advance = advances.find((a) => a.id === cashAdvanceId) ?? null;
  const amountLiquidated = useMemo(() => lines.reduce((s, l) => s + (l.amount ?? 0), 0), [lines]);

  const check = useMemo(() => {
    if (!advance) return null;
    return checkLiquidation({
      amountGranted: advance.amountGranted,
      previouslyLiquidated: advance.amountLiquidated ?? 0,
      previouslyRefunded: advance.amountRefunded ?? 0,
      amountLiquidated,
      refundAmount: refundAmount ?? 0,
      reimbursementAmount: reimbursementAmount ?? 0,
    });
  }, [advance, amountLiquidated, refundAmount, reimbursementAmount]);

  const outstanding = advance
    ? advance.amountGranted -
      (advance.amountLiquidated ?? 0) -
      (advance.amountRefunded ?? 0) -
      amountLiquidated -
      (refundAmount ?? 0)
    : 0;

  const save = async () => {
    if (!advance || amountLiquidated <= 0 || !user) {
      toast.error('Incomplete', 'Choose a cash advance and enter at least one expense line.');
      return;
    }
    if (check && !check.ok) {
      toast.error('The liquidation does not balance against the advance', check.violations[0].message);
      return;
    }

    setSaving(true);
    try {
      await createDraft(
        COL.liquidations,
        {
          liquidationNo: '(unnumbered)',
          liquidationDate,
          fiscalYear,
          period: Number(liquidationDate.slice(5, 7)),
          fundCode,
          cashAdvanceId: advance.id,
          dvNo: advance.dvNo,
          accountableOfficerId: advance.accountableOfficerId,
          accountableOfficerName: advance.accountableOfficerName,
          officeId: advance.officeId,
          officeName: advance.officeName,
          dateGranted: advance.dateGranted,
          amountGranted: advance.amountGranted,
          purpose: advance.purpose,
          lines: lines.map((l, i) => ({
            lineNo: i + 1,
            date: l.date ?? liquidationDate,
            particulars: l.particulars ?? '',
            accountCode: l.accountCode ?? '',
            accountName: l.accountName ?? '',
            amount: l.amount ?? 0,
            orNumber: l.orNumber ?? null,
            supplierName: l.supplierName ?? null,
          })),
          amountLiquidated,
          refundAmount: refundAmount ?? 0,
          reimbursementAmount: reimbursementAmount ?? 0,
          outstandingBalance: Math.max(outstanding, 0),
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
      title="Liquidation report"
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Cash advance" required htmlFor="ca" className="sm:col-span-2">
          <Select id="ca" value={cashAdvanceId} onChange={(e) => setCashAdvanceId(e.target.value)}>
            <option value="">Select the advance being liquidated</option>
            {advances.map((a) => (
              <option key={a.id} value={a.id}>
                {a.dvNo} - {a.accountableOfficerName} - {formatPeso(a.outstandingBalance)} outstanding
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Liquidation date" required htmlFor="ldate">
          <DateInput id="ldate" value={liquidationDate} onChange={setLiquidationDate} />
        </Field>
      </div>

      {advance && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <dl className="grid gap-3 sm:grid-cols-4">
            <Fig label="Granted" value={advance.amountGranted} />
            <Fig label="Previously liquidated" value={advance.amountLiquidated ?? 0} />
            <Fig label="Previously refunded" value={advance.amountRefunded ?? 0} />
            <Fig label="Still to account for" value={advance.outstandingBalance} />
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            {advance.purpose} - granted {formatShortDate(advance.dateGranted)}, due{' '}
            {formatShortDate(advance.dueDate)}
          </p>
        </div>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="cbo-th w-32">Date</th>
              <th className="cbo-th min-w-[14rem]">Particulars</th>
              <th className="cbo-th min-w-[14rem]">Account</th>
              <th className="cbo-th w-28">OR number</th>
              <th className="cbo-th w-32 text-right">Amount</th>
              <th className="cbo-th w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="cbo-td">
                  <DateInput
                    value={line.date ?? liquidationDate}
                    onChange={(v) => setLines((ls) => ls.map((l, i) => (i === index ? { ...l, date: v } : l)))}
                    className="py-1.5 text-xs"
                  />
                </td>
                <td className="cbo-td">
                  <TextInput
                    value={line.particulars ?? ''}
                    onChange={(e) =>
                      setLines((ls) => ls.map((l, i) => (i === index ? { ...l, particulars: e.target.value } : l)))
                    }
                    className="py-1.5 text-xs"
                    placeholder="What was paid for"
                  />
                </td>
                <td className="cbo-td">
                  <AccountPicker
                    value={line.accountCode ?? null}
                    expenseOnly
                    onChange={(code, account) =>
                      setLines((ls) =>
                        ls.map((l, i) =>
                          i === index ? { ...l, accountCode: code ?? undefined, accountName: account?.name } : l,
                        ),
                      )
                    }
                  />
                </td>
                <td className="cbo-td">
                  <TextInput
                    value={line.orNumber ?? ''}
                    onChange={(e) =>
                      setLines((ls) => ls.map((l, i) => (i === index ? { ...l, orNumber: e.target.value } : l)))
                    }
                    className="py-1.5 text-xs font-mono"
                  />
                </td>
                <td className="cbo-td">
                  <AmountInput
                    value={line.amount ?? null}
                    onChange={(v) => setLines((ls) => ls.map((l, i) => (i === index ? { ...l, amount: v ?? 0 } : l)))}
                    className="py-1.5"
                  />
                </td>
                <td className="cbo-td text-center">
                  <button
                    onClick={() => setLines((ls) => ls.filter((_, i) => i !== index))}
                    disabled={lines.length <= 1}
                    className="rounded p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                    aria-label="Remove line"
                  >
                    &times;
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-medium">
              <td className="cbo-td" colSpan={4}>
                Total liquidated
              </td>
              <td className="cbo-td cbo-amount font-semibold">{formatPeso(amountLiquidated, { symbol: false })}</td>
              <td className="cbo-td" />
            </tr>
          </tfoot>
        </table>
      </div>

      <Button
        size="sm"
        className="mt-3"
        onClick={() => setLines((ls) => [...ls, { lineNo: ls.length + 1, date: liquidationDate }])}
      >
        Add expense line
      </Button>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Field label="Refund returned" htmlFor="refund" hint="Cash the officer handed back.">
          <AmountInput id="refund" value={refundAmount} onChange={setRefundAmount} />
        </Field>

        <Field
          label="Reimbursement claimed"
          htmlFor="reimb"
          hint="Only where the officer spent beyond the advance and is owed the difference."
        >
          <AmountInput id="reimb" value={reimbursementAmount} onChange={setReimbursementAmount} />
        </Field>

        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-xs text-slate-600">Outstanding after this report</p>
          <p className="mt-1 font-mono text-lg font-semibold tabular text-navy-900">
            {formatPeso(Math.max(outstanding, 0))}
          </p>
        </div>
      </div>

      {check && !check.ok && (
        <Alert tone="error" className="mt-4" title="This does not settle against the advance">
          <ul className="list-inside list-disc space-y-0.5">
            {check.violations.map((v, i) => (
              <li key={i}>{v.message}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Modal>
  );
}

function Fig({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular text-navy-900">{formatPeso(value)}</dd>
    </div>
  );
}
