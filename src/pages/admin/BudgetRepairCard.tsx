import { useState } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';

type Drift = Awaited<ReturnType<typeof engine.repairBudgetDisbursed>>['drifts'][number];

/**
 * Administration > Settings > Budget figures. Patch 120.
 *
 * The one place a budget figure is written from a rebuild rather than from a
 * transaction. It is here, under the Super Administrator, for the balances
 * that drifted BEFORE patch 120 - a cancelled or un-approved voucher gave the
 * money back to the obligation and not to the budget line, so the registry
 * showed more disbursed than obligated. From patch 120 on the cancellation
 * gives it back to the line as well, and the nightly check compares the
 * figure, so this should report nothing after the first run.
 *
 * Report first, then apply. Nothing is written by the report.
 */
export function BudgetRepairCard() {
  const { fiscalYear } = useFilters();
  const toast = useToast();
  const [drifts, setDrifts] = useState<Drift[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const report = async () => {
    setBusy(true);
    try {
      const res = await engine.repairBudgetDisbursed({ fiscalYear, apply: false });
      setDrifts(res.drifts);
      if (res.drifts.length === 0) {
        toast.success(
          'Nothing to repair',
          `Every budget line of ${fiscalYear} agrees with its obligations.`,
        );
      }
    } catch (err) {
      toast.error(
        'Could not check the budget lines',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const res = await engine.repairBudgetDisbursed({ fiscalYear, apply: true });
      toast.success(
        `${res.repaired ?? 0} budget line${res.repaired === 1 ? '' : 's'} repaired`,
        'Each one is in the audit trail with the figure before and after.',
      );
      setDrifts([]);
      setConfirm(false);
    } catch (err) {
      toast.error('Nothing was repaired', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Budget figures"
      subtitle="Disbursements on the registry are kept per budget line as vouchers are approved. If a line shows more disbursed than obligated, a cancelled voucher left its share behind before patch 120. This puts the line back to what its obligations say."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" loading={busy && drifts === null} onClick={() => void report()}>
          Check fiscal year {fiscalYear}
        </Button>
        {drifts && drifts.length > 0 && (
          <Button variant="primary" onClick={() => setConfirm(true)}>
            Repair {drifts.length} line{drifts.length === 1 ? '' : 's'}
          </Button>
        )}
        <p className="text-xs text-slate-500">
          Checking writes nothing. Repairing is recorded in the audit trail.
        </p>
      </div>

      {drifts && drifts.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Fund</th>
                <th className="px-3 py-2 font-medium">Office</th>
                <th className="px-3 py-2 font-medium">Budget line</th>
                <th className="px-3 py-2 text-right font-medium">Obligated</th>
                <th className="px-3 py-2 text-right font-medium">Disbursed now</th>
                <th className="px-3 py-2 text-right font-medium">Per obligations</th>
                <th className="px-3 py-2 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {drifts.map((d) => (
                <tr key={d.budgetKey}>
                  <td className="px-3 py-2">{d.fundCode}</td>
                  <td className="px-3 py-2">{d.officeName}</td>
                  <td className="px-3 py-2">
                    <span className="font-mono">{d.accountCode || d.fppCode}</span> {d.accountName}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatPeso(d.obligated, { symbol: false })}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-rose-700">
                    {formatPeso(d.stored, { symbol: false })}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatPeso(d.rebuilt, { symbol: false })}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatPeso(d.stored - d.rebuilt, { symbol: false, parens: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drifts && drifts.length === 0 && (
        <Alert tone="success" className="mt-4">
          Every budget line of {fiscalYear} agrees with its obligations.
        </Alert>
      )}

      <ConfirmDialog
        open={confirm}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void apply()}
        loading={busy}
        title={`Repair ${drifts?.length ?? 0} budget line${drifts?.length === 1 ? '' : 's'}`}
        confirmLabel="Repair"
        variant="primary"
        message={
          <p>
            Each line's disbursed figure is set to the sum of what its obligations have drawn, and
            its unpaid figure follows. Nothing else on the line moves. Every change is written to
            the audit trail with the figure before and after. If a voucher is approved while this
            runs, the repair stops and asks you to check again.
          </p>
        }
      />
    </Card>
  );
}
