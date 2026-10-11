import { todayPh } from '@/lib/dates';
import type { ReconReport } from '@/lib/cashReconciliation';
import type { TreasuryReport } from '@/types/treasury';

/** A treasury report as the reconciliation reads it. */
export function toReconReport(r: TreasuryReport): ReconReport {
  return {
    id: r.id,
    reportType: r.reportType,
    reportNo: r.reportNo ?? null,
    reportDate: r.reportDate,
    status: r.status,
    forwardedAt: r.forwardedAt,
    jevId: r.jevId ?? null,
    jevNo: r.jevNo ?? null,
    accountableOfficerName: r.accountableOfficerName ?? null,
    cancelledReason: r.cancelledReason ?? (r as { cancelReason?: string }).cancelReason ?? null,
    lines: (r.lines ?? []).map((l) => ({
      sourceId: l.sourceId,
      sourceNo: l.sourceNo,
      amount: l.amount,
      excluded: l.excluded,
    })),
    deposits: (r.deposits ?? []).map((d) => ({
      sourceId: d.sourceId,
      depositSlipNo: d.depositSlipNo ?? null,
      amount: d.amount,
    })),
  };
}

export function defaultAsOf(fiscalYear: number): string {
  const today = todayPh();
  return today.slice(0, 4) === String(fiscalYear) ? today : `${fiscalYear}-12-31`;
}
