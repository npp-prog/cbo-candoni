import { useState } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { engine, type RepairDrift } from '@/lib/engine';
import { formatPeso } from '@/lib/money';

type Report = Awaited<ReturnType<typeof engine.repairBudgetDisbursed>>;

/**
 * Administration > Settings > Budget figures. Patch 120, redrawn in 121.
 *
 * The one place a budget figure is written from a rebuild rather than from
 * a transaction. It is here, under the Super Administrator, for two reasons:
 * the balances that drifted before patch 120 (a cancelled voucher gave the
 * money back to the obligation and not to the budget line), and the change
 * of definition in patch 121 (a disbursement is a check or an ADA, so every
 * figure that moved at voucher approval has to be put back to what the
 * instruments say). After that first run the nightly check compares the
 * figure, and this should report nothing.
 *
 * Report first, then apply. Nothing is written by the report.
 */
export function BudgetRepairCard() {
  const { fiscalYear } = useFilters();
  const toast = useToast();
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const count = (r: Report | null) =>
    r ? r.obligations.length + r.lines.length + r.summaries.length + r.programmes.length : 0;

  const check = async () => {
    setBusy(true);
    try {
      const res = await engine.repairBudgetDisbursed({ fiscalYear, apply: false });
      setReport(res);
      if (count(res) === 0) {
        toast.success(
          'Nothing to repair',
          `Every disbursed figure of ${fiscalYear} agrees with the checks and ADAs.`,
        );
      }
    } catch (err) {
      toast.error('Could not check the figures', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const res = await engine.repairBudgetDisbursed({ fiscalYear, apply: true });
      toast.success(
        `${res.repaired ?? 0} figure${res.repaired === 1 ? '' : 's'} repaired`,
        'Each one is in the audit trail with the figure before and after.',
      );
      setReport({ ...res, obligations: [], lines: [], summaries: [], programmes: [] });
      setConfirm(false);
    } catch (err) {
      toast.error('Nothing was repaired', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const n = count(report);

  return (
    <Card
      title="Budget figures"
      subtitle="A disbursement is a check or an ADA. This checks every obligation's paid amount, every budget line's disbursed figure, each fund summary and each trust programme against the checks and ADAs drawn, and puts back any that differ."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" loading={busy && !confirm} onClick={() => void check()}>
          Check fiscal year {fiscalYear}
        </Button>
        {n > 0 && (
          <Button variant="primary" onClick={() => setConfirm(true)}>
            Repair {n} figure{n === 1 ? '' : 's'}
          </Button>
        )}
        <p className="text-xs text-slate-500">
          Checking writes nothing. Repairing is recorded in the audit trail.
        </p>
      </div>

      {report && n > 0 && (
        <div className="mt-4 space-y-4">
          <DriftTable title="Obligations - paid amount" rows={report.obligations} showObligated />
          <DriftTable title="Budget lines - disbursed" rows={report.lines} />
          <DriftTable title="Fund summaries - disbursed" rows={report.summaries} />
          <DriftTable title="Trust programmes - disbursed" rows={report.programmes} />
        </div>
      )}

      {report && n === 0 && (
        <Alert tone="success" className="mt-4">
          Every disbursed figure of {fiscalYear} agrees with the checks and ADAs.
        </Alert>
      )}

      <ConfirmDialog
        open={confirm}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void apply()}
        loading={busy}
        title={`Repair ${n} figure${n === 1 ? '' : 's'}`}
        confirmLabel="Repair"
        variant="primary"
        message={
          <p>
            Each figure is set to what the checks and ADAs drawn say, and an obligation's status and
            a budget line's unpaid figure follow. Nothing else moves. Every change is written to the
            audit trail with the figure before and after. If a payment is made while this runs, the
            repair stops and asks you to check again.
          </p>
        }
      />
    </Card>
  );
}

function DriftTable({
  title,
  rows,
  showObligated,
}: {
  title: string;
  rows: RepairDrift[];
  showObligated?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title} ({rows.length})
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Fund</th>
              <th className="px-3 py-2 font-medium">Document</th>
              {showObligated && <th className="px-3 py-2 text-right font-medium">Obligated</th>}
              <th className="px-3 py-2 text-right font-medium">Stored now</th>
              <th className="px-3 py-2 text-right font-medium">Per the instruments</th>
              <th className="px-3 py-2 text-right font-medium">Difference</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="px-3 py-2">{d.fundCode}</td>
                <td className="px-3 py-2">{d.label}</td>
                {showObligated && (
                  <td className="px-3 py-2 text-right font-mono">
                    {formatPeso(d.obligated ?? 0, { symbol: false })}
                  </td>
                )}
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
    </div>
  );
}
