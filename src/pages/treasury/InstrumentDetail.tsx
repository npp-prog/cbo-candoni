import { Link } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { DetailField } from '@/components/ui/Layout';
import { StatusBadge } from '@/components/ui/Badge';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import type { Ada, Check } from '@/types/accounting';

/**
 * One check or one advice, opened from its row in the register.
 *
 * ---------------------------------------------------------------------------
 * WHY A ROW HAD TO BECOME CLICKABLE
 * ---------------------------------------------------------------------------
 * The register showed six columns of a record that has twenty fields. Everything
 * the office actually asks about a check once it is drawn - what it paid for,
 * who released it and when, whether the bank has paid it, which report took it
 * to Accounting - was recorded and shown nowhere. The answer was to open the
 * voucher and work backwards, which only works if you already know which
 * voucher it was.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT IS A ROUTE RATHER THAN LOCAL STATE
 * ---------------------------------------------------------------------------
 * /treasury/checks/:id and /treasury/ada/:id have existed since the registers
 * were built and did nothing - the register rendered and ignored the id. They
 * do something now, which means a check can be linked to: from a notification,
 * from a report, from a message to a colleague. A detail held in local state
 * would have been reachable only by whoever was already looking at the
 * register.
 */

export type Instrument =
  | ({ kind: 'CHECK' } & Check)
  | ({ kind: 'ADA' } & Ada);

export function InstrumentDetail({
  instrument,
  onClose,
}: {
  instrument: Instrument;
  onClose: () => void;
}) {
  const isCheck = instrument.kind === 'CHECK';

  const serial = isCheck ? instrument.checkNo : instrument.adaNo;
  const date = isCheck ? instrument.checkDate : instrument.adaDate;
  /*
   * A check carries gross, deductions and the net that was actually drawn; an
   * advice carries one amount. Reading `netAmount` off an advice would print
   * nothing and look like a zero.
   */
  const amount = isCheck ? instrument.netAmount : instrument.amount;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${isCheck ? 'Check' : 'ADA'} ${serial}`}
      description={`${formatPeso(amount)} to ${instrument.payeeName}`}
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <DetailField label="Date">{formatShortDate(date)}</DetailField>
        <DetailField label="Status">
          <StatusBadge status={instrument.status} />
        </DetailField>
        <DetailField label="Fund">{instrument.fundCode}</DetailField>

        <DetailField label="Bank" className="sm:col-span-2">
          {instrument.bankName}{' '}
          <span className="font-mono text-xs text-slate-500">
            {instrument.bankAccountNumber}
          </span>
        </DetailField>
        <DetailField label="Payee">{instrument.payeeName}</DetailField>

        <DetailField label="Particulars" className="sm:col-span-3">
          {instrument.particulars || <span className="text-slate-400">Not stated</span>}
        </DetailField>
      </div>

      {isCheck && (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <DetailField label="Gross">{formatPeso(instrument.grossAmount)}</DetailField>
          <DetailField label="Deductions">{formatPeso(instrument.totalDeductions)}</DetailField>
          <DetailField label="Net drawn">
            <span className="font-semibold">{formatPeso(instrument.netAmount)}</span>
          </DetailField>
        </div>
      )}

      {/* ---- what it paid, and what took it to Accounting ------------------ */}
      <div className="mt-5 border-t border-slate-200 pt-4">
        <p className="cbo-label mb-2">The paper either side of it</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <DetailField label="Disbursement voucher">
            {instrument.dvId ? (
              <Link
                to={`/accounting/disbursements/${instrument.dvId}`}
                className="font-mono text-brand-700 underline"
              >
                {instrument.dvNo}
              </Link>
            ) : (
              <span className="text-slate-400">Not recorded</span>
            )}
          </DetailField>

          <DetailField label="Reported on">
            {/*
              A check reaches the General Ledger through its REPORT, not on its
              own. Until the Treasurer certifies one, the honest answer is that
              it has not been reported - not a blank, which reads as a field
              nobody filled in.
            */}
            {instrument.treasuryReportId ? (
              <Link
                to={`/treasury/reports/${instrument.treasuryReportId}`}
                className="font-mono text-brand-700 underline"
              >
                {hasDocumentNumber(instrument.treasuryReportNo)
                  ? instrument.treasuryReportNo
                  : 'the report'}
              </Link>
            ) : (
              <span className="text-slate-500">Not yet on a certified report</span>
            )}
          </DetailField>
        </div>
      </div>

      {/* ---- what happened to it after it was drawn ------------------------ */}
      <div className="mt-5 border-t border-slate-200 pt-4">
        <p className="cbo-label mb-2">What happened to it</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {isCheck ? (
            <>
              <DetailField label="Released">
                {instrument.dateReleased ? (
                  formatShortDate(instrument.dateReleased)
                ) : (
                  <span className="text-slate-500">Not yet released</span>
                )}
              </DetailField>
              <DetailField label="Released to" className="sm:col-span-2">
                {instrument.releasedToName ? (
                  <>
                    {instrument.releasedToName}
                    {instrument.releasedToPosition ? (
                      <span className="text-slate-500"> &middot; {instrument.releasedToPosition}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-slate-400">&mdash;</span>
                )}
              </DetailField>
              <DetailField label="Cleared by the bank">
                {instrument.clearedDate ? (
                  formatShortDate(instrument.clearedDate)
                ) : (
                  <span className="text-slate-500">Not yet cleared</span>
                )}
              </DetailField>
            </>
          ) : (
            <>
              <DetailField label="Sent to the bank">
                {instrument.dateSubmittedToBank ? (
                  formatShortDate(instrument.dateSubmittedToBank)
                ) : (
                  <span className="text-slate-500">Not yet sent</span>
                )}
              </DetailField>
              <DetailField label="Debited">
                {instrument.dateDebited ? (
                  formatShortDate(instrument.dateDebited)
                ) : (
                  <span className="text-slate-500">Not yet debited</span>
                )}
              </DetailField>
              <DetailField label="Bank reference">
                {instrument.bankReferenceNo ?? <span className="text-slate-400">&mdash;</span>}
              </DetailField>
              {instrument.rejectedReason && (
                <DetailField label="Rejected by the bank" className="sm:col-span-3">
                  <span className="text-rose-800">{instrument.rejectedReason}</span>
                </DetailField>
              )}
            </>
          )}
        </div>

        {instrument.cancelledReason && (
          <p className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
            <span className="font-semibold">Cancelled.</span> {instrument.cancelledReason}
          </p>
        )}

        {isCheck && instrument.clearingObjection && (
          <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-semibold">Drawn over a clearing objection.</span>{' '}
            {instrument.clearingObjection}
            {instrument.clearingAcknowledgement ? ` - ${instrument.clearingAcknowledgement}` : ''}
          </p>
        )}
      </div>
    </Modal>
  );
}
