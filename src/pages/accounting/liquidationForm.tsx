import { useMemo, useState } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, DateInput, AmountInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker } from '@/components/pickers';
import { useAuth } from '@/auth/AuthProvider';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { checkLiquidation } from '@/lib/accounting-rules';
import type { LiquidationLine, CashAdvance } from '@/types/accounting';

/**
 * The form that raises a liquidation report.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT A POP-UP ANY MORE
 * ---------------------------------------------------------------------------
 * It was a dialog over the register, and a dialog is a dead end: there is
 * nowhere in it to attach the signed report, nowhere to show the entry it will
 * post, and nothing of the document's history. So the officer filled it in,
 * saved, and then had to find the report again to do any of those.
 *
 * It is the first tab of the report's own page now. The other three are there
 * from the start, saying what they are waiting for.
 */
export function LiquidationForm({
  fiscalYear,
  fundCode,
  advances,
  unassignedCount = 0,
  onCancel,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  advances: CashAdvance[];
  /** Advances posted with no officer named - shown, since nobody can liquidate them. */
  unassignedCount?: number;
  onCancel: () => void;
  /** Given the new report's id, so the page can open it properly. */
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const [cashAdvanceId, setCashAdvanceId] = useState('');
  const [liquidationNo, setLiquidationNo] = useState('');
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
    if (!liquidationNo.trim()) {
      toast.error(
        'The liquidation report number is missing',
        'Assign it from the office book before saving.',
      );
      return;
    }

    setSaving(true);
    try {
      const newId = await createDraft(
        COL.liquidations,
        {
          liquidationNo: liquidationNo.trim(),
          liquidationDate,
          fiscalYear,
          period: Number(liquidationDate.slice(5, 7)),
          fundCode,
          cashAdvanceId: advance.id,
          dvNo: advance.dvNo,
          ...(advance.source === 'LEDGER'
            ? {
                advanceSource: 'LEDGER',
                advanceAccountCode: advance.glAccountCode,
                advanceAccountName: advance.glAccountName ?? null,
                advanceSubsidiaryType: advance.subsidiaryType ?? null,
              }
            : {}),
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
      onSaved(newId);
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Liquidation report">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Cash advance" required htmlFor="ca" className="sm:col-span-2">
          <Select id="ca" value={cashAdvanceId} onChange={(e) => setCashAdvanceId(e.target.value)}>
            <option value="">Select the advance being liquidated</option>
            {advances.map((a) => (
              <option key={a.id} value={a.id}>
                {a.dvNo} - {a.accountableOfficerName}
                {a.glAccountName ? ` - ${a.glAccountName}` : ''} - {formatPeso(a.outstandingBalance)}{' '}
                outstanding
              </option>
            ))}
          </Select>
          {advances.length === 0 && (
            <p className="mt-1 text-xs text-amber-700">
              No advance is outstanding in this fund and year. An advance appears here once it is
              posted to an account marked "Advance subject to liquidation" (Master Data &gt; Chart of
              Accounts) with the accountable officer as its subsidiary.
            </p>
          )}
          {unassignedCount > 0 && (
            <p className="mt-1 text-xs text-amber-700">
              {unassignedCount} advance{unassignedCount === 1 ? ' was' : 's were'} posted with no
              accountable officer named and cannot be liquidated until the entry names one.
            </p>
          )}
        </Field>

        <Field
          label="Liquidation report number"
          required
          htmlFor="lno"
          hint="Assigned by Accounting from its own book."
        >
          <TextInput
            id="lno"
            value={liquidationNo}
            onChange={(e) => setLiquidationNo(e.target.value)}
            placeholder="100-26-10-0001"
            className="font-mono"
          />
        </Field>

        <Field label="Liquidation date" required htmlFor="ldate">
          <DateInput id="ldate" value={liquidationDate} onChange={setLiquidationDate} />
        </Field>
      </div>

      {advance && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <dl className="grid gap-3 sm:grid-cols-4">
            <Fig label="Granted" value={advance.amountGranted} />
            {advance.source === 'LEDGER' ? (
              <Fig label="Already settled" value={advance.amountLiquidated ?? 0} />
            ) : (
              <>
                <Fig label="Previously liquidated" value={advance.amountLiquidated ?? 0} />
                <Fig label="Previously refunded" value={advance.amountRefunded ?? 0} />
              </>
            )}
            <Fig label="Still to account for" value={advance.outstandingBalance} />
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            {advance.purpose} - granted {formatShortDate(advance.dateGranted)}
            {advance.jevNo ? `, JEV ${advance.jevNo}` : ''}
            {advance.glAccountCode ? `, ${advance.glAccountCode} ${advance.glAccountName ?? ''}` : ''}
            {advance.dueDate ? `, due ${formatShortDate(advance.dueDate)}` : ''}
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
              <th className="cbo-th cbo-amount-col">Amount</th>
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
                    budgetChargeable
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
      <div className="mt-6 flex gap-2 border-t border-slate-200 pt-4">
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          Save draft
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** One figure from the advance, read-only, above the expense lines. */
function Fig({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular text-navy-900">{formatPeso(value)}</dd>
    </div>
  );
}
