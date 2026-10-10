import { Link, useParams } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { Letterhead, SignatureLine } from '@/components/print/formParts';
import { useEntity } from '@/data/useEntity';
import {
  buildBankFile,
  downloadBankCsv,
  type BankFilePayee,
} from '@/lib/bankFile';
import type { DisbursementVoucher } from '@/types/accounting';
import { usePrintTitle, printFileName } from '@/lib/printTitle';

/**
 * The List of Payees of a group ("Payee, et al.") voucher, and the bank's
 * upload file. Patch 140.
 *
 * The list is the annex the bank and the auditor read with the DV and the
 * ADA: every payee, their ATM / account number and their share, totalling the
 * net. It prints on its own page (from the voucher) or after the ADA form
 * (Appendix 36), and is read from the document - nothing on it is typed.
 */

export interface Signatory {
  label: string;
  name?: string;
  role?: string;
}

export function PayeeListSheet({
  payees,
  reference,
  date,
  particulars,
  signatories,
}: {
  payees: BankFilePayee[];
  /** "DV 2026-10-2222", "ADA 0001-2026" ... */
  reference: string[];
  date?: string;
  particulars?: string;
  signatories: Signatory[];
}) {
  const entity = useEntity();
  const total = payees.reduce((t, p) => t + (p.amount ?? 0), 0);
  return (
    <div className="text-xs">
      <Letterhead title="List of Payees" lines={entity.headingLines} />
      <table className="mb-3 w-full">
        <tbody>
          <tr>
            <td className="py-0.5 align-top">
              {reference.map((r) => (
                <p key={r} className="font-mono font-semibold">
                  {r}
                </p>
              ))}
            </td>
            <td className="py-0.5 text-right align-top">
              {date && (
                <p>
                  <span className="text-slate-500">Date:</span>{' '}
                  <span className="font-semibold">{formatLongDate(date)}</span>
                </p>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {particulars && <p className="mb-3">{particulars}</p>}

      <table className="w-full border-collapse text-2xs">
        <thead>
          <tr className="bg-slate-100">
            <th
              className="border border-slate-400 px-1.5 py-1 text-right"
              style={{ width: '2.5rem' }}
            >
              No.
            </th>
            <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '9rem' }}>
              ATM / Account No.
            </th>
            <th className="border border-slate-400 px-1.5 py-1 text-left">Name of Payee</th>
            <th
              className="border border-slate-400 px-1.5 py-1 text-right"
              style={{ width: '8rem' }}
            >
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {payees.map((p, i) => (
            <tr key={i} style={{ breakInside: 'avoid' }}>
              <td className="border border-slate-400 px-1.5 py-1 text-right">{i + 1}</td>
              <td className="border border-slate-400 px-1.5 py-1 font-mono">{p.accountNumber}</td>
              <td className="border border-slate-400 px-1.5 py-1">{p.payeeName}</td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(p.amount, false)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 font-bold">
            <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={3}>
              TOTAL - {payees.length} payee{payees.length === 1 ? '' : 's'}
            </td>
            <td className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums">
              {formatAmount(total, false)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-2 text-2xs italic">{amountInWords(total)}</p>

      <div className="cbo-form-signatures mt-8 grid gap-10 sm:grid-cols-2">
        {signatories.map((s) => (
          <SignatureLine key={s.label} label={s.label} name={s.name || ' '} role={s.role} />
        ))}
      </div>
    </div>
  );
}

/**
 * "Bank file (CSV)" - the bank takes CSV (patch 141). Refuses to download a file the bank would
 * reject - an account that is not 10 digits, a line with no name or amount -
 * and says which line.
 */
export function BankFileButtons({
  payees,
  reference,
  size = 'sm',
}: {
  payees: BankFilePayee[];
  /** For the file name: the ADA or DV number. */
  reference: string;
  size?: 'sm' | 'md';
}) {
  const toast = useToast();
  const go = () => {
    const { rows, problems } = buildBankFile(payees);
    if (problems.length) {
      toast.error('The bank file was not made', problems.slice(0, 4).join(' '));
      return;
    }
    downloadBankCsv(rows, reference);
  };
  return (
    <>
      <Button size={size} onClick={go}>
        Bank file (CSV)
      </Button>
    </>
  );
}

/** /accounting/disbursements/:id/payees - the List of Payees of a voucher. */
export default function DvPayeeListPrint() {
  const { id } = useParams<{ id: string }>();
  const { data: dv, loading } = useDocument<DisbursementVoucher>(COL.disbursementVouchers, id);
  const entity = useEntity();
  usePrintTitle(dv ? printFileName('List of Payees', dv.dvNo ? `DV ${dv.dvNo}` : '') : null);

  if (loading) return <Spinner label="Loading the voucher" />;
  if (!dv) {
    return (
      <Alert tone="error" title="Voucher not found">
        <Link to="/accounting/disbursements" className="underline">
          Back to the vouchers
        </Link>
      </Alert>
    );
  }
  const payees = dv.payees ?? [];
  const ref = dv.dvNo ? `DV ${dv.dvNo}` : 'DV (not yet numbered)';

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title={`List of Payees - ${ref}`}
          subtitle={dv.payeeName}
          breadcrumbs={[
            { label: 'Accounting' },
            { label: 'Disbursement', to: '/accounting/disbursements' },
            { label: ref, to: `/accounting/disbursements/${dv.id}` },
            { label: 'List of Payees' },
          ]}
          actions={
            <>
              <Link to={`/accounting/disbursements/${dv.id}`}>
                <Button variant="secondary">Back to the voucher</Button>
              </Link>
              {payees.length > 0 && (
                <BankFileButtons payees={payees} reference={dv.dvNo || dv.id} size="md" />
              )}
              <Button variant="primary" onClick={() => window.print()}>
                Print
              </Button>
            </>
          }
        />
        {payees.length === 0 && (
          <Alert tone="warning" title="No payees listed" className="mb-4">
            This voucher has no list of payees. It is kept on a voucher with &quot;Several payees
            (et al.)&quot; ticked.
          </Alert>
        )}
      </div>
      {payees.length > 0 && (
        <div className="cbo-card px-6 py-6 print:border-0 print:px-0 print:py-0">
          <PayeeListSheet
            payees={payees}
            reference={[ref]}
            date={dv.dvDate}
            particulars={dv.particulars}
            signatories={[
              {
                label: 'Certified correct',
                name: entity.municipalAccountant.name,
                role: entity.municipalAccountant.position,
              },
              {
                label: 'Approved for payment',
                name: entity.municipalMayor.name,
                role: entity.municipalMayor.position,
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
