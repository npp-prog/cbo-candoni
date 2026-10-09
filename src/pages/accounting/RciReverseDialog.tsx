import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Layout';
import { Field, TextArea } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { useDocument } from '@/hooks/useFirestore';
import { useAda, useChecks } from '@/data/queries';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatAmount, formatPeso } from '@/lib/money';
import type { JournalEntryVoucher } from '@/types/accounting';
import type { TreasuryReport } from '@/types/treasury';

const MIN_REASON = 15;

/**
 * Patch 151. Reversing the entry of an RCI: choose the CHECKS.
 *
 * An RCI's entry covers every check on it, and usually only one of them has
 * to be undone - cancelled, or replaced by another check. So the Reverse
 * button on such an entry opens this list instead of reversing everything:
 * tick the checks, give the reason, and only their lines are reversed (see
 * functions/src/lib/rciReversal.ts). Ticking every check reverses the whole
 * entry, the same as before.
 *
 * A check already reversed is shown, ticked off and greyed out, with the JEV
 * that reversed it. A check that has CLEARED the bank cannot be chosen - the
 * payee has been paid.
 *
 * Patch 153: the same for a RADAI, ADA by ADA (an advice already posted
 * online cannot be chosen). And what is still owed to the payee goes to TRUST
 * LIABILITIES, not back to Accounts Payable: the voucher's number cannot be
 * used again, and the payee is repaid by a new Trust liability voucher.
 */
export function RciReverseDialog({
  open,
  onClose,
  jev,
}: {
  open: boolean;
  onClose: () => void;
  jev: JournalEntryVoucher;
}) {
  const toast = useToast();
  const { data: report, loading } = useDocument<TreasuryReport>(
    COL.treasuryReports,
    open ? (jev.sourceId ?? undefined) : undefined,
  );
  const isAda = jev.sourceType === 'RADAI';
  const noun = isAda ? 'ADA' : 'check';
  const nouns = isAda ? 'ADAs' : 'checks';
  const label = isAda ? 'ADA No.' : 'Check No.';
  // Both hooks run; only the one for this report's kind is read.
  const checks = useChecks(!isAda ? (report?.bankAccountId ?? '__none__') : '__none__');
  const adas = useAda(isAda ? (report?.bankAccountId ?? '__none__') : '__none__');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setChosen(new Set());
      setReason('');
    }
  }, [open]);

  const reversedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of jev.checkReversals ?? []) for (const id of r.checkIds) m.set(id, r.jevNo);
    return m;
  }, [jev.checkReversals]);

  const statusOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of isAda ? adas.data : checks.data) m.set(c.id, c.status);
    return m;
  }, [isAda, adas.data, checks.data]);

  const rows = (report?.lines ?? [])
    .filter((l) => !l.excluded)
    .map((l) => {
      const status = statusOf.get(l.sourceId);
      const doneBy = reversedBy.get(l.sourceId);
      const blocked = doneBy
        ? `Reversed by JEV ${doneBy}`
        : !isAda && status === 'CLEARED'
          ? 'Cleared by the bank - paid'
          : isAda && (status === 'SUBMITTED' || status === 'DEBITED')
            ? 'Posted online by the bank - paid'
            : status === 'CANCELLED'
              ? 'Cancelled'
              : null;
      return { ...l, status, blocked };
    });
  const open_ = rows.filter((r) => !r.blocked);
  const chosenTotal = rows.filter((r) => chosen.has(r.sourceId)).reduce((s, r) => s + r.amount, 0);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    try {
      const res = await engine.reverseRciChecks({
        jevId: jev.id,
        documentIds: [...chosen],
        reason: reason.trim(),
      });
      toast.success(
        `${label} ${res.checkNos.join(', ')} reversed by JEV ${res.reversingJevNo}`,
        `${formatPeso(res.amount)} is back in Cash in Bank and held as a trust liability for the payee. The Treasurer can now cancel the ${noun}; the payee is repaid by a new Trust liability voucher.` +
          (res.fullyReversed
            ? ` Every ${noun} of the report is reversed, so the entry is marked Reversed.`
            : ''),
      );
      onClose();
    } catch (err) {
      toast.error(
        `The ${nouns} were not reversed`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const ready = chosen.size > 0 && reason.trim().length >= MIN_REASON && !busy;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Reverse JEV ${jev.jevNo} - choose the ${nouns}`}
      description={
        report?.reportNo
          ? `${isAda ? 'Report of ADA Issued' : 'Report of Checks Issued'} ${report.reportNo}`
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={!ready} loading={busy}>
            Reverse{' '}
            {chosen.size === 0
              ? `the ${nouns}`
              : `${chosen.size} ${chosen.size === 1 ? noun : nouns}`}
            {chosen.size > 0 ? ` (${formatAmount(chosenTotal, false)})` : ''}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Only the lines of the {nouns} you tick are taken out, by a new journal entry posted today:
        Cash in Bank is debited back to its bank account, and what is still owed to each payee is
        credited to <strong>Trust Liabilities</strong> - the voucher&apos;s number cannot be used
        again. The other {nouns} stay paid. Afterwards the Treasurer cancels the {noun}, and the
        payee is repaid by a new voucher of the Trust liability kind.
      </p>

      {loading ? (
        <p className="text-sm text-slate-500">Loading the {isAda ? 'RADAI' : 'RCI'}...</p>
      ) : !report ? (
        <Alert tone="error" title="The report behind this entry was not found" />
      ) : (
        <table className="mb-4 w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-300 px-2 py-1.5" style={{ width: '2.5rem' }}>
                <input
                  type="checkbox"
                  aria-label={`Choose every ${noun}`}
                  disabled={open_.length === 0}
                  checked={open_.length > 0 && open_.every((r) => chosen.has(r.sourceId))}
                  onChange={(e) =>
                    setChosen(e.target.checked ? new Set(open_.map((r) => r.sourceId)) : new Set())
                  }
                />
              </th>
              <th className="border border-slate-300 px-2 py-1.5 text-left">{label}</th>
              <th className="border border-slate-300 px-2 py-1.5 text-left">Payee</th>
              <th className="border border-slate-300 px-2 py-1.5 text-left">Particulars</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right">Amount</th>
              <th className="border border-slate-300 px-2 py-1.5 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.sourceId}
                className={r.blocked ? 'text-slate-400' : 'cursor-pointer hover:bg-brand-50/50'}
                onClick={() => !r.blocked && toggle(r.sourceId)}
              >
                <td className="border border-slate-300 px-2 py-1.5 text-center">
                  <input
                    type="checkbox"
                    aria-label={`${label} ${r.sourceNo}`}
                    disabled={Boolean(r.blocked)}
                    checked={chosen.has(r.sourceId)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(r.sourceId)}
                  />
                </td>
                <td className="border border-slate-300 px-2 py-1.5 font-mono">{r.sourceNo}</td>
                <td className="border border-slate-300 px-2 py-1.5">{r.payeeName}</td>
                <td className="border border-slate-300 px-2 py-1.5">{r.particulars}</td>
                <td className="border border-slate-300 px-2 py-1.5 text-right tabular-nums">
                  {formatAmount(r.amount, false)}
                </td>
                <td className="border border-slate-300 px-2 py-1.5">
                  {r.blocked ? (
                    <span className="text-2xs">{r.blocked}</span>
                  ) : r.status ? (
                    <StatusBadge status={r.status} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Field
        label="Reason for the reversal"
        required
        hint={`Printed on the reversing entry and recorded as a critical audit event - e.g. '${isAda ? 'ADA 2026-10-0003 cancelled, wrong account number' : 'Check 123460 cancelled, spoiled in printing'}; to be repaid by a new voucher'.`}
      >
        <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
        <p className="mt-1 text-2xs text-amber-700">At least {MIN_REASON} characters.</p>
      )}
    </Modal>
  );
}
