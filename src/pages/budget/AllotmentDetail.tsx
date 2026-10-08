import type { ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { formatPeso, formatAmount } from '@/lib/money';
import { formatShortDate, formatLongDate } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import type { Allotment } from '@/types/budget';
import { formOf } from './AroPrint';
import { budgetLineText, type RegisterKind, type RegisterRow } from './allotmentRegister';

/**
 * One row of the allotment register, opened. Patch 113.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW HAS NO ROOM FOR
 * ---------------------------------------------------------------------------
 * The register shows what an officer scans for: the number, the date, the
 * office, the amount, the status. Clicking a row opens the rest - every line
 * with its programme and object side by side, what each held back and what
 * it holds now, who prepared the order and who approved it, and for an order
 * whose hold has since been released, the releases themselves. For a later
 * release, the collections and estimate CFMS recorded when it was decided -
 * the figures the decision rested on.
 *
 * Every act on the row is here as well, so that opening a row is never a
 * dead end: print, edit, approve, discard, release what is held.
 */

export const KIND_NOTE: Record<RegisterKind, string> = {
  PREPARED: 'Prepared release order',
  ORDER: 'Release order',
  LATER_RELEASE: 'Release of amount held',
  WITHDRAWAL: 'Withdrawal',
  NO_ORDER: 'No order',
};

export interface DetailActions {
  print?: () => void;
  edit?: () => void;
  approve?: () => void;
  discard?: () => void;
  /** Releasing what a released line still holds. */
  releaseHeld?: (line: Allotment) => void;
}

export function AllotmentDetail({
  row,
  laterReleases,
  actions,
  onClose,
}: {
  row: RegisterRow | null;
  /** For an order: the releases made since from what it held back. */
  laterReleases: RegisterRow[];
  actions: DetailActions;
  onClose: () => void;
}) {
  if (!row) return null;

  const first = row.allotments[0];
  const preparedBy = row.draft?.createdBy?.name ?? first?.createdBy?.name;
  const approvedBy = first?.approvedBy;
  const fromHeld = row.kind === 'LATER_RELEASE' ? first?.releasedFromHeld : undefined;
  const isOrder = row.kind === 'ORDER' || row.kind === 'PREPARED';

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={row.reference || 'Prepared release order - no ARO number yet'}
      description={`${KIND_NOTE[row.kind]}${isOrder ? ` - ${formOf(row.expenseClass)}` : ''}`}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions.print && (
            <Button variant="secondary" onClick={actions.print}>
              Print
            </Button>
          )}
          {actions.edit && (
            <Button variant="secondary" onClick={actions.edit}>
              Edit
            </Button>
          )}
          {actions.discard && (
            <Button variant="ghost" onClick={actions.discard}>
              Discard
            </Button>
          )}
          {actions.approve && (
            <Button variant="primary" onClick={actions.approve}>
              {row.kind === 'PREPARED' ? 'Approve and release' : 'Approve'}
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </div>
      }
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Fact label="Status">
          <StatusBadge status={row.status} />
        </Fact>
        <Fact label="Date">{formatLongDate(row.date)}</Fact>
        <Fact label="Expense class">
          {EXPENSE_CLASS_LABELS[row.expenseClass as ExpenseClass] ?? row.expenseClass}
        </Fact>
        <Fact label={row.kind === 'LATER_RELEASE' ? 'Reason' : 'Purpose'} wide>
          {row.purpose || <span className="text-slate-400">-</span>}
        </Fact>
        {preparedBy && <Fact label={row.kind === 'PREPARED' ? 'Prepared by' : 'Recorded by'}>{preparedBy}</Fact>}
        {approvedBy && (
          <Fact label="Approved by">
            {approvedBy.name}
            {approvedBy.at && (
              <span className="block text-2xs text-slate-500">{formatShortDate(approvedBy.at.slice(0, 10))}</span>
            )}
          </Fact>
        )}
        {row.draft?.source === 'UPLOAD' && (
          <Fact label="From an uploaded file">
            {row.draft.importFileName || row.draft.reference || 'Bulk upload'}
          </Fact>
        )}
        {fromHeld && (
          <Fact label="When it was decided" wide>
            {formatPeso(fromHeld.collections ?? 0)} collected against{' '}
            {formatPeso(fromHeld.estimate ?? 0)} of Estimated Receipts
          </Fact>
        )}
      </dl>

      {row.kind === 'PREPARED' && (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Nothing has been released. Approving the order releases it, issues its ARO number, and
          checks every line against the appropriation as it stands at that moment.
        </p>
      )}

      <div className="mt-4 overflow-x-auto rounded border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-2 py-1.5 font-medium">Office</th>
              <th className="px-2 py-1.5 font-medium">Programme / FPP</th>
              <th className="px-2 py-1.5 font-medium">Object</th>
              <th className="px-2 py-1.5 text-right font-medium">
                {row.kind === 'PREPARED' ? 'To release' : 'Released'}
              </th>
              {isOrder && (
                <>
                  <th className="px-2 py-1.5 text-right font-medium">Held back</th>
                  <th className="px-2 py-1.5 text-right font-medium">Still held</th>
                </>
              )}
              <th className="w-px px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {row.lines.map((l) => {
              const object = budgetLineText(l);
              return (
                <tr key={l.key} className="align-top">
                  <td className="px-2 py-1.5">{l.officeName}</td>
                  <td className="px-2 py-1.5">
                    <span className="font-mono text-2xs text-slate-500">{l.fppCode}</span>
                    {l.fppName && l.fppName !== l.fppCode && <span className="block">{l.fppName}</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {l.accountCode ? (
                      <>
                        <span className="font-mono text-2xs text-slate-500">{object.code}</span>{' '}
                        {object.name}
                      </>
                    ) : (
                      <span className="text-slate-500">By programme - none named</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatAmount(l.amount, false)}</td>
                  {isOrder && (
                    <>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {l.heldAtIssue ? formatAmount(l.heldAtIssue, false) : '-'}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {l.stillHeld ? formatAmount(l.stillHeld, false) : '-'}
                      </td>
                    </>
                  )}
                  <td className="px-2 py-1.5 text-right">
                    {l.allotment &&
                      l.stillHeld > 0 &&
                      l.allotment.status === 'APPROVED' &&
                      actions.releaseHeld && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => actions.releaseHeld?.(l.allotment as Allotment)}
                        >
                          Release held
                        </Button>
                      )}
                  </td>
                </tr>
              );
            })}
            <tr className="bg-slate-50 font-semibold">
              <td className="px-2 py-1.5" colSpan={3}>
                Total
              </td>
              <td className="px-2 py-1.5 text-right font-mono">{formatAmount(row.released, false)}</td>
              {isOrder && (
                <>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {row.heldAtIssue ? formatAmount(row.heldAtIssue, false) : '-'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {row.stillHeld ? formatAmount(row.stillHeld, false) : '-'}
                  </td>
                </>
              )}
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      {laterReleases.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Released since, from what this order held back
          </p>
          <ul className="mt-1 divide-y divide-slate-100 text-xs">
            {laterReleases.map((r) => (
              <li key={r.key} className="flex items-baseline justify-between gap-4 py-1.5">
                <span>
                  {formatShortDate(r.date)} - {r.purpose || 'no reason recorded'}
                </span>
                <span className="font-mono">{formatAmount(r.released, false)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-3' : undefined}>
      <dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-navy-900">{children}</dd>
    </div>
  );
}
