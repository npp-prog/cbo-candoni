import { Link, useParams } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { Letterhead, SignatureLine } from '@/components/print/formParts';
import type { Ada } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/**
 * The Authority to Debit Account - Appendix 36.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT SHAPED LIKE THE REPORTS
 * ---------------------------------------------------------------------------
 * The RCI, the RADAI and the RCDisb are REPORTS: a list of what happened, with
 * a total, certified after the fact. This is an INSTRUMENT. It is addressed to
 * the bank, it is the municipality instructing them to take money out of its
 * account, and it is signed before anything happens rather than after.
 *
 * The municipality's own appendix index reflects that: every report row carries
 * a copy distribution - COA, Accounting, Treasury - and the ADA row carries
 * none at all, because there is nobody to distribute a report to. It goes to
 * the bank.
 *
 * So the page is a letter, not a schedule: who it is addressed to, which
 * account to debit, how much, in whose favour, and two signatures. The amount
 * is written out in words for the same reason every instrument does it - a
 * figure can be altered by one stroke and a sentence cannot.
 *
 * Nothing on it can be typed. Every figure is read from the advice CFMS
 * issued, so the paper handed to the bank and the ADA register cannot
 * disagree.
 */
export default function AdaAppendix36() {
  const { id } = useParams<{ id: string }>();
  const { data: ada, loading } = useDocument<Ada>(COL.ada, id);

  if (loading) return <Spinner label="Loading the advice" />;

  if (!ada) {
    return (
      <Alert tone="error" title="Advice not found">
        <Link to="/treasury/ada" className="underline">
          Back to the ADA register
        </Link>
      </Alert>
    );
  }

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title={`ADA ${ada.adaNo}`}
          subtitle="Appendix 36 - the form as COA prints it"
          breadcrumbs={[
            { label: 'Treasury' },
            { label: 'ADA', to: '/treasury/ada' },
            { label: 'Print' },
          ]}
          actions={
            <>
              <Link to="/treasury/ada">
                <Button variant="secondary">Back to the register</Button>
              </Link>
              <Button variant="primary" onClick={() => window.print()}>
                Print
              </Button>
            </>
          }
        />

        {ada.status === 'CANCELLED' && (
          <Alert tone="error" title="This advice was cancelled" className="mb-4">
            {ada.cancelledReason ?? 'See the audit trail for the reason.'} Printing it does not
            make it live again, and the bank should not be given a copy.
          </Alert>
        )}
      </div>

      {/* --- the form ------------------------------------------------------- */}
      <div className="cbo-card px-6 py-6 text-xs print:border-0 print:px-0 print:py-0">
        <Letterhead appendix="Appendix 36" title="Authority to Debit Account" />

        <table className="mb-4 w-full border-collapse">
          <tbody>
            <tr>
              <td className="w-1/2 py-0.5">
                <span className="text-slate-500">Fund:</span>{' '}
                <span className="font-semibold">{fundLabel(ada.fundCode)}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">ADA No.:</span>{' '}
                <span className="font-mono font-semibold">{ada.adaNo}</span>
              </td>
            </tr>
            <tr>
              <td className="py-0.5">
                <span className="text-slate-500">DV No.:</span>{' '}
                <span className="font-mono font-semibold">{ada.dvNo}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Date:</span>{' '}
                <span className="font-semibold">{formatLongDate(ada.adaDate)}</span>
              </td>
            </tr>
          </tbody>
        </table>

        <div className="mb-4">
          <p className="text-2xs text-slate-500">To:</p>
          <p className="font-semibold">{ada.bankName}</p>
          <p>
            Account No. <span className="font-mono">{ada.bankAccountNumber}</span>
          </p>
        </div>

        <p className="leading-relaxed">
          You are hereby authorised to debit the account of the{' '}
          <strong>Municipality of Candoni</strong> stated above in the sum of{' '}
          <strong>{amountInWords(ada.amount)}</strong> (
          <span className="font-mono">{formatAmount(ada.amount, false)}</span>) and to credit the
          same to the account of the creditor named below, in settlement of the obligation
          described.
        </p>

        <table className="mt-4 w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left">Creditor</th>
              <th className="border border-slate-400 px-1.5 py-1 text-left">Particulars</th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '9rem' }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-slate-400 px-1.5 py-2 align-top font-semibold">
                {ada.payeeName}
              </td>
              <td className="border border-slate-400 px-1.5 py-2 align-top">{ada.particulars}</td>
              <td className="border border-slate-400 px-1.5 py-2 text-right align-top tabular-nums">
                {formatAmount(ada.amount, false)}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                TOTAL
              </td>
              <td className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(ada.amount, false)}
              </td>
            </tr>
          </tfoot>
        </table>

        {/*
          What the bank has done with it, where CFMS knows. Printed because a
          filed copy of an advice is read later to answer exactly this - and
          because a blank line is the honest answer while it is still out.
        */}
        <table className="mt-4 w-full border-collapse text-2xs">
          <tbody>
            <tr>
              <td className="w-1/3 border border-slate-400 px-1.5 py-1 text-slate-500">
                Submitted to the bank
              </td>
              <td className="border border-slate-400 px-1.5 py-1">
                {ada.dateSubmittedToBank ? formatLongDate(ada.dateSubmittedToBank) : ' '}
              </td>
            </tr>
            <tr>
              <td className="border border-slate-400 px-1.5 py-1 text-slate-500">
                Bank reference no.
              </td>
              <td className="border border-slate-400 px-1.5 py-1 font-mono">
                {ada.bankReferenceNo ?? ' '}
              </td>
            </tr>
            <tr>
              <td className="border border-slate-400 px-1.5 py-1 text-slate-500">Date debited</td>
              <td className="border border-slate-400 px-1.5 py-1">
                {ada.dateDebited ? formatLongDate(ada.dateDebited) : ' '}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="mt-8 grid gap-8 sm:grid-cols-2">
          <SignatureLine label="Certified Correct" role="Municipal Treasurer" />
          <SignatureLine label="Approved for payment" role="Local Chief Executive" />
        </div>
      </div>
    </div>
  );
}
