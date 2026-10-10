import { Link } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { DetailField } from '@/components/ui/Layout';
import { StatusBadge } from '@/components/ui/Badge';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { collectionEditable, whyNotEditable } from '@/lib/collectionEditable';
import { REVENUE_SOURCES } from '@/types/treasury';
import type { Collection } from '@/types/treasury';

/**
 * One receipt, opened from its row.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROW HAD TO OPEN
 * ---------------------------------------------------------------------------
 * The register showed seven columns of a record that has twenty fields. The
 * revenue accounts the money was split across - which is most of what a
 * receipt IS - were visible nowhere, and neither was whether it had been
 * banked or which report had taken it to Accounting. Correcting one meant
 * opening the edit form to find out what it said, which is a poor way to read
 * something you may not want to change.
 *
 * So: the row opens the receipt, and the receipt offers the correction. The
 * Edit button is absent, with the reason in its place, when a certified report
 * has claimed it - see collectionEditable, which `firestore.rules` enforces
 * independently.
 */
export function CollectionDetail({
  collection,
  canEdit,
  onEdit,
  onClose,
}: {
  collection: Collection;
  /** Whether this user may correct receipts at all. */
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const editable = collectionEditable(collection);
  const reason = whyNotEditable(collection);
  const electronic = !!collection.eCollectionKind;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${electronic ? 'e-Receipt' : 'Receipt'} ${collection.orNumber}`}
      description={`${formatPeso(collection.totalAmount)} from ${collection.payorName}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {canEdit && editable && (
            <Button variant="primary" onClick={onEdit}>
              Correct this receipt
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <DetailField label="Date">{formatShortDate(collection.orDate)}</DetailField>
        <DetailField label="Status">
          <StatusBadge status={collection.status} />
        </DetailField>
        <DetailField label="Form of payment">{collection.paymentForm}</DetailField>

        <DetailField label="Payor" className="sm:col-span-2">
          {collection.payorName}
          {collection.payorTin ? (
            <span className="text-slate-500"> &middot; TIN {collection.payorTin}</span>
          ) : null}
        </DetailField>
        <DetailField label="Collecting officer">{collection.collectingOfficerName}</DetailField>

        <DetailField label="Revenue source">
          {REVENUE_SOURCES.find((s) => s.value === collection.revenueSource)?.label ??
            collection.revenueSource}
        </DetailField>
        <DetailField label="Particulars" className="sm:col-span-2">
          {collection.remarks ?? collection.lines?.[0]?.particulars ?? (
            <span className="text-slate-400">Not stated</span>
          )}
        </DetailField>

        {electronic && (
          <>
            <DetailField label="Kind">{collection.eCollectionKind}</DetailField>
            <DetailField label="Intermediary" className="sm:col-span-2">
              {collection.intermediaryName ?? <span className="text-slate-400">&mdash;</span>}
            </DetailField>
          </>
        )}
      </div>

      {/* ---- what the money was credited to ----------------------------- */}
      <div className="mt-5">
        <p className="cbo-label mb-2">Accounts</p>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="cbo-th">Account</th>
              <th className="cbo-th">Particulars</th>
              <th className="cbo-th cbo-amount-col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(collection.lines ?? []).map((line) => (
              <tr key={line.lineNo}>
                <td className="cbo-td">
                  <span className="font-mono text-xs text-slate-500">{line.accountCode}</span>{' '}
                  {line.accountName}
                  {line.barangayName ? (
                    <span className="text-xs text-slate-500"> &middot; {line.barangayName}</span>
                  ) : null}
                  {line.trustProgramName ? (
                    <span className="text-xs text-slate-500"> &middot; {line.trustProgramName}</span>
                  ) : null}
                  {/* Patch 158: the subsidiary ledger account. */}
                  {line.subsidiaryName ? (
                    <span className="block text-xs text-slate-500">
                      Subsidiary: {line.subsidiaryName}
                    </span>
                  ) : null}
                </td>
                <td className="cbo-td text-sm text-slate-600">{line.particulars ?? ''}</td>
                <td className="cbo-td cbo-amount">{formatPeso(line.amount, { symbol: false })}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-medium">
              <td className="cbo-td" colSpan={2}>
                Total collected
              </td>
              <td className="cbo-td cbo-amount font-semibold">
                {formatPeso(collection.totalAmount, { symbol: false })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ---- where it has got to ---------------------------------------- */}
      <div className="mt-5 border-t border-slate-200 pt-4">
        <p className="cbo-label mb-2">Where it has got to</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <DetailField label="Reported on">
            {collection.treasuryReportId ? (
              <Link
                to={`/treasury/reports/${collection.treasuryReportId}`}
                className="font-mono text-brand-700 underline"
              >
                {collection.treasuryReportNo ?? 'the report'}
              </Link>
            ) : (
              <span className="text-slate-500">Not yet on a certified report</span>
            )}
          </DetailField>
          <DetailField label="Banked">
            {collection.depositId ? (
              <Link to="/treasury/collections/deposits" className="text-brand-700 underline">
                Deposited
              </Link>
            ) : (
              <span className="text-slate-500">Not yet deposited</span>
            )}
          </DetailField>
        </div>

        {reason && (
          <p className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            <span className="font-semibold">This receipt can no longer be corrected.</span>{' '}
            {reason}
          </p>
        )}
      </div>
    </Modal>
  );
}
