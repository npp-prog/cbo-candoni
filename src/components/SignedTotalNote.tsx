import { Alert } from '@/components/ui/Layout';
import { formatPeso } from '@/lib/money';
import type { JournalEntryVoucher } from '@/types/accounting';

/**
 * The standing note on an entry that no longer agrees with its document.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The total on a journal entry raised by a disbursement voucher or a certified
 * treasury report is a figure another officer signed. CFMS used to refuse a
 * correction that changed it. From patch 84 it does not - the Municipal
 * Accountant asked for the amount to be correctable like the date, the
 * particulars and the accounts - and the whole case for allowing it rests on
 * the disagreement being impossible to miss afterwards.
 *
 * So this is not decoration. It is the control that replaced the refusal.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE COMPONENT AND NOT THREE BANNERS
 * ---------------------------------------------------------------------------
 * It has to appear in three places that are otherwise unrelated - the entry
 * itself, the voucher, and the treasury report - because a reader who only
 * ever opens one of them must still be told. Three copies of the same sentence
 * drift, and the one that drifts is the one nobody is reading when it matters.
 *
 * The engine writes `signedTotal` only while the two differ, and clears it when
 * a later correction brings the entry back. So the single test for "say
 * something" is whether that field is set: no screen computes the condition for
 * itself, and no screen can get it wrong.
 */
export function SignedTotalNote({
  jev,
  /** How the reader got here, so the note names the OTHER document. */
  from = 'entry',
  className,
}: {
  jev:
    | Pick<
        JournalEntryVoucher,
        'jevNo' | 'signedTotal' | 'totalDebit' | 'sourceType' | 'referenceNo'
      >
    | null
    | undefined;
  from?: 'entry' | 'document';
  className?: string;
}) {
  const signed = jev?.signedTotal ?? null;
  if (!jev || signed === null) return null;

  const document = jev.referenceNo
    ? `${jev.sourceType} ${jev.referenceNo}`
    : 'the document behind it';
  const entry = jev.jevNo ? `JEV ${jev.jevNo}` : 'the journal entry';

  return (
    <Alert
      tone="error"
      title="The entry and the document do not agree"
      className={className ?? 'mb-4'}
    >
      <p>
        {from === 'document' ? 'This document' : document} was signed for{' '}
        <strong>{formatPeso(signed)}</strong>. The General Ledger carries{' '}
        <strong>{formatPeso(jev.totalDebit)}</strong> for{' '}
        {from === 'document' ? entry : 'this entry'}.
      </p>
      <p className="mt-2">
        The Municipal Accountant corrected the entry in an open month and recorded why; the
        reason is on the entry and in the audit trail, as a critical event. This note stays until
        the two figures match again - correct the entry back, or correct the document and let its
        entry follow.
      </p>
    </Alert>
  );
}
