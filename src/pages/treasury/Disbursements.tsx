import { useMemo, useState } from 'react';
import { ReturnLink } from '@/components/ui/BackButton';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { IssueCheckDialog, PrepareAdaDialog } from '@/components/payments/PaymentDialogs';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDisbursementVouchers } from '@/data/queries';
import { awaitingPayment, totalAwaiting, daysWaiting } from '@/lib/paymentQueue';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import type { DisbursementVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { PAYMENT_TAB_GROUPS } from './sections';

/**
 * Vouchers approved by the Accountant and waiting for the Treasurer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 * The Accountant approves a voucher. The Treasurer pays it. Those are two
 * officers and two acts, and the second is the one that moves money out of the
 * municipality.
 *
 * CFMS used to put Issue check and Prepare ADA on the Accounting voucher
 * screen, so that drawing a check was something done by whoever had the
 * voucher open. That is not an interface convenience - it is the point in the
 * chain where the separation between approving a payment and making one stops
 * being visible on the screen. Those buttons are gone from Accounting, and the
 * approved voucher arrives here instead.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * Nothing that belongs to Accounting. The voucher cannot be edited from this
 * screen and its journal entry cannot be touched. The number is a link, for
 * reading it; everything else on this page is about paying it.
 */
export default function TreasuryDisbursements() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const { data, loading, error } = useDisbursementVouchers(fiscalYear, fundCode);

  const [paying, setPaying] = useState<{ dv: DisbursementVoucher; how: 'CHECK' | 'ADA' } | null>(
    null,
  );

  const rows = useMemo(() => awaitingPayment(data), [data]);
  const total = useMemo(() => totalAwaiting(rows), [rows]);
  const today = todayPh();

  const canPay = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF');

  const columns: Column<DisbursementVoucher>[] = [
    {
      key: 'dvNo',
      header: 'DV number',
      width: '11rem',
      value: (dv) => dv.dvNo,
      cell: (dv) => (
        <span className="flex flex-col items-start gap-0.5">
          <ReturnLink
            to={`/accounting/disbursements/${dv.id}`}
            className="font-mono text-xs font-medium underline"
          >
            {dv.dvNo}
          </ReturnLink>
          {/* Patch 153: carried forward from the opening balances. */}
          {dv.openingPayable && (
            <span className="text-2xs text-amber-700">
              {dv.outstandingUnpaid === true ||
              !dv.payableAccountCode ||
              dv.payableAccountCode === '20101010'
                ? 'Outstanding unpaid voucher'
                : `Carried forward - ${dv.payableAccountName ?? dv.payableAccountCode}`}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'dvDate',
      header: 'DV date',
      kind: 'date',
      width: '8rem',
      value: (dv) => dv.dvDate,
      cell: (dv) => <span className="text-xs">{formatShortDate(dv.dvDate)}</span>,
    },
    {
      key: 'waiting',
      header: 'Waiting',
      width: '6rem',
      align: 'right',
      value: (dv) => daysWaiting(dv.dvDate, today),
      cell: (dv) => {
        const days = daysWaiting(dv.dvDate, today);
        return (
          <span className={days >= 30 ? 'text-xs font-medium text-amber-700' : 'text-xs'}>
            {days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}
          </span>
        );
      },
    },
    {
      key: 'payeeName',
      header: 'Payee',
      value: (dv) => dv.payeeName,
      cell: (dv) => <span className="text-sm">{dv.payeeName}</span>,
    },
    {
      key: 'particulars',
      header: 'Particulars',
      value: (dv) => dv.particulars,
      cell: (dv) => <span className="text-xs text-slate-600">{dv.particulars}</span>,
    },
    {
      key: 'obrNo',
      header: 'OBR',
      width: '10rem',
      optional: true,
      value: (dv) => dv.obrNo ?? '',
      cell: (dv) => <span className="font-mono text-2xs text-slate-500">{dv.obrNo ?? '-'}</span>,
    },
    {
      key: 'netAmount',
      header: 'Net payable',
      kind: 'amount',
      value: (dv) => dv.netAmount,
      cell: (dv) => <span className="cbo-amount">{formatPeso(dv.netAmount, { symbol: false })}</span>,
    },
    {
      key: 'pay',
      header: '',
      width: '15rem',
      fixed: true,
      cell: (dv) =>
        canPay ? (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="success" onClick={() => setPaying({ dv, how: 'CHECK' })}>
              Issue check
            </Button>
            <Button size="sm" onClick={() => setPaying({ dv, how: 'ADA' })}>
              Prepare ADA
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Disbursements for payment"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear} - ${rows.length} voucher${
          rows.length === 1 ? '' : 's'
        }, ${formatPeso(total)} payable`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'Checks and ADA' }]}
      />

      <GroupedSectionTabs groups={PAYMENT_TAB_GROUPS} />

      {!canPay && (
        <Alert tone="warning" className="mb-4">
          Only the Municipal Treasurer and treasury staff may draw a check or prepare an advice.
          You can see what is waiting.
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(dv) => dv.id}
        loading={loading}
        error={error}
        searchPlaceholder="DV number, payee or particulars"
        emptyTitle="Nothing waiting to be paid"
        emptyMessage="A voucher appears here once the Municipal Accountant approves it. One that already carries a check or an advice has been paid and is in the registers."
        exportMeta={{ title: 'CFMS Disbursements for Payment' }}
        totals={
          rows.length > 0
            ? { label: 'Total payable', values: { netAmount: formatPeso(total, { symbol: false }) } }
            : null
        }
      />

      {paying?.how === 'CHECK' && (
        <IssueCheckDialog
          dvId={paying.dv.id}
          fundCode={fundCode}
          netAmount={paying.dv.netAmount}
          payeeName={paying.dv.payeeName}
          defaultBankAccountId={paying.dv.bankAccountId ?? null}
          onClose={() => setPaying(null)}
          onIssued={(checkNo) => {
            setPaying(null);
            toast.success(
              `Check ${checkNo} issued`,
              'It is now in the check register, ready for signature.',
            );
          }}
        />
      )}

      {paying?.how === 'ADA' && (
        <PrepareAdaDialog
          dvId={paying.dv.id}
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          netAmount={paying.dv.netAmount}
          payeeName={paying.dv.payeeName}
          defaultBankAccountId={paying.dv.bankAccountId ?? null}
          onClose={() => setPaying(null)}
          onPrepared={(adaNo) => {
            setPaying(null);
            toast.success(
              `ADA ${adaNo} prepared`,
              'Submit it to the bank to have the account debited.',
            );
          }}
        />
      )}
    </div>
  );
}
