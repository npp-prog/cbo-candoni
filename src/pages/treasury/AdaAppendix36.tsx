import { Link, useParams } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { Letterhead, blankRows } from '@/components/print/formParts';
import type { Ada } from '@/types/accounting';
import { useEntity } from '@/data/useEntity';

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
  const entity = useEntity();

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
        <Letterhead
          appendix="Appendix 36"
          title="Authority to Debit Account (ADA)"
          lines={entity.headingLines}
        />

        {/*
          ------------------------------------------------------------------
          THE FORM AS THE MUNICIPALITY'S OWN APPENDIX 36 PRINTS IT
          ------------------------------------------------------------------
          Rebuilt in patch 89 against sheet A36-ADA of `Appendix_Forms.xlsx`.
          Patch 86 built it from the field set, and got the SHAPE right - it is
          a letter to the bank, not a schedule - but three details wrong:

            * the body is a prescribed sentence, "Please debit the agency
              Account No. ___ in the amount of ___ (Php___)", followed by
              "Please credit the accounts of the listed creditors to cover
              payment of payables". I had written my own wording.
            * the columns are Office/Department/Payee, Reference and Amount.
              I had Creditor, Particulars and Amount.
            * the signatures are two AGENCY AUTHORIZED SIGNATORIES, numbered
              1 and 2 under one heading - the Local Treasurer and the Municipal
              Mayor. I had two separate blocks with invented labels.

          I also invented a block recording what the bank had done with the
          advice - submitted, reference number, debited. It is not on the form
          and it is gone. Those dates are on the ADA register, which is where
          somebody asking "has it been debited" is actually looking.
        */}
        <table className="mb-4 w-full">
          <tbody>
            <tr>
              <td className="w-1/2 py-0.5 align-top">
                <p className="font-semibold">THE MANAGER</p>
                <p>{ada.bankName}</p>
              </td>
              <td className="py-0.5 align-top">
                <p>
                  <span className="text-slate-500">ADA No.</span>{' '}
                  <span className="font-mono font-semibold">{ada.adaNo}</span>
                </p>
                <p>
                  <span className="text-slate-500">Date:</span>{' '}
                  <span className="font-semibold">{formatLongDate(ada.adaDate)}</span>
                </p>
              </td>
            </tr>
          </tbody>
        </table>

        <p className="mb-3">Sir/Madam:</p>

        <p className="leading-relaxed">
          Please debit the agency Account No.{' '}
          <span className="font-mono font-semibold underline">{ada.bankAccountNumber}</span> in the
          amount of <span className="font-semibold underline">{amountInWords(ada.amount)}</span> (
          <span className="font-mono font-semibold">Php {formatAmount(ada.amount, false)}</span>).
        </p>
        <p className="mt-2 leading-relaxed">
          Please credit the accounts of the listed creditors to cover payment of payables.
        </p>

        <table className="mt-4 w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left">
                Office/Department/Payee
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '12rem' }}>
                Reference
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '9rem' }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {/*
              One creditor. The form is drawn for a list - an office may issue
              one advice covering several payables - but CFMS issues one ADA per
              disbursement voucher, so there is one line and one reference. The
              ruled blanks below say the sheet was considered and found to have
              one row, rather than stopping short.
            */}
            <tr>
              <td className="border border-slate-400 px-1.5 py-1">{ada.payeeName}</td>
              <td className="border border-slate-400 px-1.5 py-1 font-mono">DV {ada.dvNo}</td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(ada.amount, false)}
              </td>
            </tr>
            {blankRows(5, 3, 'ada')}
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

        <p className="mt-6 text-2xs font-semibold">Agency Authorized Signatories</p>
        <div className="mt-2 grid gap-10 sm:grid-cols-2">
          <div>
            <p className="text-2xs">1.</p>
            <p className="mt-10 border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
              {entity.localTreasurer.name || ' '}
            </p>
            <p className="text-center text-[9px] text-slate-500">
              {entity.localTreasurer.position}
            </p>
          </div>
          <div>
            <p className="text-2xs">2.</p>
            <p className="mt-10 border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
              {entity.municipalMayor.name || ' '}
            </p>
            <p className="text-center text-[9px] text-slate-500">
              {entity.municipalMayor.position}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
