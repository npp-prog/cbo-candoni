import { PageHeader, Card, Alert, DetailField } from '@/components/ui/Layout';
import { BackButton } from '@/components/ui/BackButton';
import { StatusBadge } from '@/components/ui/Badge';
import { JevLink } from '@/components/JevLink';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { DisbursementVoucher } from '@/types/accounting';

/**
 * Patch 152. A voucher carried forward from the opening balances.
 *
 * It is an Accounts Payable the old system approved and nobody has paid yet,
 * put in Treasury's payment queue by the engine when the opening balances
 * were posted (functions/src/lib/openingPayables.ts). There is nothing to
 * edit on it: its expense, its obligation and its approval belong to the year
 * it was approved, and the payable is already in the books by the opening
 * entry. What remains is to pay it - by check or ADA, in Treasury - and that
 * payment books Dr Accounts Payable / Cr Cash in Bank only.
 */
export function OpeningPayableVoucher({ dv }: { dv: DisbursementVoucher }) {
  const paidBy = dv.checkNo ? `Check ${dv.checkNo}` : dv.adaNo ? `ADA ${dv.adaNo}` : null;
  /* Patch 153: Accounts Payable is an outstanding unpaid voucher; any other payable is not tagged so. */
  const isAp =
    dv.outstandingUnpaid === true || !dv.payableAccountCode || dv.payableAccountCode === '20101010';
  const liability = isAp
    ? 'Accounts Payable'
    : (dv.payableAccountName ?? dv.payableAccountCode ?? 'the payable');
  return (
    <div>
      <PageHeader
        title={`DV ${dv.dvNo}`}
        subtitle={
          isAp
            ? 'Outstanding unpaid voucher - carried forward from the opening balances'
            : `${liability} - carried forward from the opening balances`
        }
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Disbursements', to: '/accounting/disbursements' },
          { label: dv.dvNo },
        ]}
        actions={
          <>
            <BackButton list={{ to: '/accounting/disbursements', label: 'Disbursements' }} />
            <StatusBadge status={dv.status} />
          </>
        }
      />

      <Alert
        tone="info"
        title={
          isAp
            ? 'Outstanding unpaid voucher - to be paid in CFMS'
            : 'Carried forward - to be paid in CFMS'
        }
        className="mb-4"
      >
        {isAp
          ? 'This voucher was approved in the previous system and is still unpaid.'
          : `This ${liability} was owed when the books were converted and is still unpaid.`}{' '}
        It came in with the opening balances
        {dv.jevNo ? (
          <>
            {' '}
            (
            <JevLink jevId={dv.jevId} jevNo={dv.jevNo}>
              JEV {dv.jevNo}
            </JevLink>
            )
          </>
        ) : null}
        , which already carry the payable. Treasury pays it by check or ADA from Disbursements for
        Payment; the payment books Dr {liability} / Cr Cash in Bank. No expense, no obligation and
        no budget line is charged again.
      </Alert>

      <Card>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DetailField label="DV number" mono>
            {dv.dvNo}
          </DetailField>
          <DetailField label="Outstanding since">{formatShortDate(dv.dvDate)}</DetailField>
          <DetailField label="Liability">{liability}</DetailField>
          <DetailField label="Payee">{dv.payeeName}</DetailField>
          <DetailField label="Amount">
            <span className="cbo-amount font-semibold">{formatPeso(dv.netAmount)}</span>
          </DetailField>
          <DetailField label="Particulars" className="sm:col-span-2 lg:col-span-3">
            {dv.particulars}
          </DetailField>
          <DetailField label="Paid by">{paidBy ?? 'Not yet paid'}</DetailField>
        </dl>
      </Card>
    </div>
  );
}
