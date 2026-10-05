import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatShortDate, formatLongDate } from '@/lib/dates';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import { Letterhead, SectionTitle, SignatureLine, blankRows } from '@/components/print/formParts';
import {
  TREASURY_REPORT_LABELS,
  TREASURY_REPORT_SHORT,
  type TreasuryReportType,
} from '@/types/enums';
import type { TreasuryReport } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';

/**
 * The Treasurer's reports as COA prints them - Appendices 37, 38 and 39.
 *
 * ---------------------------------------------------------------------------
 * ONE PAGE FOR THREE FORMS
 * ---------------------------------------------------------------------------
 * The Report of Checks Issued, the Report of ADA Issued and the Report of Cash
 * Disbursements are the same sheet of paper with a different instrument named
 * on it. They are one record type in CFMS, they are prepared on one screen and
 * certified by one button, and three separate printed pages would be three
 * places for the certification wording to drift apart.
 *
 * What genuinely differs is in FORMS below: the appendix number, what the
 * instrument is called, whose office signs, and - for the RCDisb alone - the
 * gross and deductions columns, because a payroll report accounts for what was
 * withheld as well as what was handed over.
 *
 * ---------------------------------------------------------------------------
 * THE RCD IS NOT HERE
 * ---------------------------------------------------------------------------
 * Appendix 34 already exists, built from the collections register, and it is a
 * much fuller form than this - five lettered sections, the accountable forms
 * accountability, the breakdown by how the money was tendered. A second
 * Appendix 34 built from the treasury report would be a second answer to the
 * same question, and the two would disagree the first time either changed.
 *
 * So a report of type RCD sends the reader to the one that exists.
 *
 * ---------------------------------------------------------------------------
 * NOTHING ON IT CAN BE TYPED
 * ---------------------------------------------------------------------------
 * Every figure is read from the certified report. A printed form and the
 * register cannot disagree, which is the only thing that makes a printout
 * worth anything to an auditor - and the totals are the ones the journal entry
 * had to foot to, so the paper and the books agree as well.
 */

interface FormSpec {
  appendix: string;
  title: string;
  /** What the column of numbers is called on this form. */
  instrument: string;
  office: string;
  /** A payroll report accounts for the gross and the deductions as well. */
  payroll?: boolean;
  /** Who signs the certification, as the form words it. */
  certifier: string;
}

/**
 * Appendix numbers and titles from the municipality's own GAM index
 * (`data/gam-appendix-index.csv`), not from memory.
 *
 * The RCDisb title is the index's spelling - "Report of Cash Disbursements",
 * plural - which differs by one letter from the label CFMS uses on screen. The
 * printed form follows the index, because the printed form is the one COA
 * reads.
 */
const FORMS: Partial<Record<TreasuryReportType, FormSpec>> = {
  RCI: {
    appendix: 'Appendix 38',
    title: 'Report of Checks Issued',
    instrument: 'Check No.',
    office: 'Office of the Municipal Treasurer',
    certifier: 'Municipal Treasurer',
  },
  RADAI: {
    appendix: 'Appendix 37',
    title: 'Report of Authority to Debit Account Issued',
    instrument: 'ADA No.',
    office: 'Office of the Municipal Treasurer',
    certifier: 'Municipal Treasurer',
  },
  RCDISB: {
    appendix: 'Appendix 39',
    title: 'Report of Cash Disbursements',
    instrument: 'Payroll / Voucher No.',
    office: 'Office of the Disbursing Officer',
    payroll: true,
    certifier: 'Disbursing Officer',
  },
};

/** Minimum ruled rows, so a two-line report still fills the sheet. */
const BLANK_ROWS = 14;

export default function TreasuryReportForm() {
  const { id } = useParams<{ id: string }>();
  const { data: report, loading } = useDocument<TreasuryReport>(COL.treasuryReports, id);

  const lines = useMemo(() => report?.lines ?? [], [report]);

  const totals = useMemo(
    () =>
      lines
        .filter((l) => !l.excluded)
        .reduce(
          (acc, l) => ({
            gross: acc.gross + (l.gross ?? l.amount),
            deductions: acc.deductions + (l.deductions ?? 0),
            net: acc.net + l.amount,
          }),
          { gross: 0, deductions: 0, net: 0 },
        ),
    [lines],
  );

  if (loading) return <Spinner label="Loading the report" />;

  if (!report) {
    return (
      <Alert tone="error" title="Report not found">
        That report does not exist, or it has been deleted.
      </Alert>
    );
  }

  if (report.reportType === 'RCD') {
    return (
      <Alert tone="info" title="The Report of Collections and Deposits has its own form">
        <p>
          Appendix 34 is built from the collections register, where the accountable forms and the
          breakdown by how each peso was tendered live. It is a much fuller form than this one, and
          a second version of it would be a second answer to the same question.
        </p>
        <p className="mt-2">
          <Link to="/treasury/rcd" className="font-medium underline">
            Open it from Treasury &gt; Collections and Deposits &gt; RCD
          </Link>
          .
        </p>
      </Alert>
    );
  }

  const form = FORMS[report.reportType];
  if (!form) {
    return (
      <Alert tone="error" title="No prescribed form for this report">
        CFMS has no Appendix form for a {TREASURY_REPORT_LABELS[report.reportType]}.
      </Alert>
    );
  }

  const columns = form.payroll ? 6 : 5;
  const short = TREASURY_REPORT_SHORT[report.reportType];

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title={hasDocumentNumber(report.reportNo) ? `${short} ${report.reportNo}` : `${short} (draft)`}
          subtitle={`${form.appendix} - the form as COA prints it`}
          breadcrumbs={[
            { label: 'Treasury' },
            { label: short, to: `/treasury/reports/${report.id}` },
            { label: 'Print' },
          ]}
          actions={
            <>
              <Link to={`/treasury/reports/${report.id}`}>
                <Button variant="secondary">Back to the report</Button>
              </Link>
              <Button variant="primary" onClick={() => window.print()}>
                Print
              </Button>
            </>
          }
        />

        {report.status === 'DRAFT' && (
          <Alert tone="warning" title="This report has not been certified" className="mb-4">
            It has no number yet, and the figures can still change. A printed copy of a draft is a
            form that says the Treasurer certified something they have not.
          </Alert>
        )}

        {report.status === 'CANCELLED' && (
          <Alert tone="error" title="This report was withdrawn" className="mb-4">
            {report.cancelledReason ?? 'See the approval history for the reason.'}
          </Alert>
        )}
      </div>

      {/* --- the form ------------------------------------------------------- */}
      <div className="cbo-card px-6 py-6 text-xs print:border-0 print:px-0 print:py-0">
        <Letterhead appendix={form.appendix} title={form.title} office={form.office} />

        <table className="mb-3 w-full border-collapse">
          <tbody>
            <tr>
              <td className="w-1/2 py-0.5">
                <span className="text-slate-500">Fund:</span>{' '}
                <span className="font-semibold">{fundLabel(report.fundCode)}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Report No.:</span>{' '}
                <span className="font-mono font-semibold">
                  {hasDocumentNumber(report.reportNo) ? report.reportNo : ''}
                </span>
              </td>
            </tr>
            <tr>
              <td className="py-0.5">
                <span className="text-slate-500">Accountable Officer:</span>{' '}
                <span className="font-semibold">{report.accountableOfficerName ?? ''}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Date:</span>{' '}
                <span className="font-semibold">{formatLongDate(report.reportDate)}</span>
              </td>
            </tr>
            {report.bankName && (
              <tr>
                <td className="py-0.5" colSpan={2}>
                  <span className="text-slate-500">Bank / Account No.:</span>{' '}
                  <span className="font-semibold">{report.bankName}</span>{' '}
                  <span className="font-mono">{report.bankAccountNumber}</span>
                </td>
              </tr>
            )}
            {(report.serialFrom || report.serialTo) && (
              <tr>
                <td className="py-0.5" colSpan={2}>
                  <span className="text-slate-500">Serial numbers covered:</span>{' '}
                  <span className="font-mono font-semibold">
                    {report.serialFrom} to {report.serialTo}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <SectionTitle>{form.payroll ? 'Disbursements' : 'Payments'}</SectionTitle>

        <table className="w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '6rem' }}>
                Date
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '8rem' }}>
                {form.instrument}
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-left">Payee</th>
              <th className="border border-slate-400 px-1.5 py-1 text-left">
                {form.payroll ? 'Nature of payment' : 'Particulars'}
              </th>
              {form.payroll && (
                <>
                  <th
                    className="border border-slate-400 px-1.5 py-1 text-right"
                    style={{ width: '7rem' }}
                  >
                    Gross
                  </th>
                  <th
                    className="border border-slate-400 px-1.5 py-1 text-right"
                    style={{ width: '7rem' }}
                  >
                    Deductions
                  </th>
                </>
              )}
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '7rem' }}>
                {form.payroll ? 'Net paid' : 'Amount'}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={`${line.sourceId}-${i}`} className={line.excluded ? 'text-slate-500' : undefined}>
                <td className="border border-slate-400 px-1.5 py-1">{formatShortDate(line.date)}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{line.sourceNo}</td>
                <td className="border border-slate-400 px-1.5 py-1">{line.payeeName ?? ''}</td>
                <td className="border border-slate-400 px-1.5 py-1">
                  {/*
                    A cancelled instrument is ON the report - its serial is in
                    the range the report covers, and a serial missing from a
                    numbered range is the first thing an auditor asks about.
                    It is marked, and it is not in the totals.
                  */}
                  {line.excluded ? <span className="font-semibold">CANCELLED. </span> : null}
                  {line.particulars ?? ''}
                </td>
                {form.payroll && (
                  <>
                    <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                      {line.excluded ? '' : formatAmount(line.gross ?? line.amount, false)}
                    </td>
                    <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                      {line.excluded ? '' : formatAmount(line.deductions ?? 0, false)}
                    </td>
                  </>
                )}
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {line.excluded ? '' : formatAmount(line.amount, false)}
                </td>
              </tr>
            ))}

            {blankRows(BLANK_ROWS - lines.length, columns, 'rep')}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={4}>
                TOTAL
              </td>
              {form.payroll && (
                <>
                  <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                    {formatAmount(totals.gross, false)}
                  </td>
                  <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                    {formatAmount(totals.deductions, false)}
                  </td>
                </>
              )}
              <td className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(report.totalAmount, false)}
              </td>
            </tr>
          </tfoot>
        </table>

        <div className="mt-4 border border-slate-400 px-3 py-2">
          <p className="text-2xs">
            I hereby certify that the above report is a true and correct statement of the{' '}
            {form.payroll ? 'cash disbursements' : 'payments'} made under my accountability for the
            period stated, totalling{' '}
            <strong>{amountInWords(report.totalAmount)}</strong> (
            <span className="font-mono">{formatAmount(report.totalAmount, false)}</span>).
          </p>
        </div>

        {report.jevNo && (
          <p className="mt-2 text-2xs text-slate-500">
            Taken up in the books as JEV <span className="font-mono">{report.jevNo}</span>.
          </p>
        )}

        <div className="mt-8 grid gap-8 sm:grid-cols-3">
          <SignatureLine
            label="Certified Correct"
            name={report.accountableOfficerName}
            role={form.certifier}
          />
          <SignatureLine label="Received by" role="Municipal Accountant" />
          <SignatureLine label="Posted by" role="Accounting Staff" />
        </div>
      </div>
    </div>
  );
}
