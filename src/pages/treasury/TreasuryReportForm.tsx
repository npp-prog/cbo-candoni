import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useDocument } from '@/hooks/useFirestore';
import { useChecks, useAda, useDisbursementVouchers } from '@/data/queries';
import { useEntity } from '@/data/useEntity';
import { COL } from '@/lib/collections';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import { Letterhead, blankRows } from '@/components/print/formParts';
import { FormPrintStyle, DraftBand, printableHeightMm } from '@/components/print/FormPrintStyle';
import { useFitRows } from '@/components/print/fitRows';
import { FormBackButton } from './FormBackButton';
import {
  TREASURY_REPORT_LABELS,
  TREASURY_REPORT_SHORT,
  isECollectionReport,
  type TreasuryReportType,
} from '@/types/enums';
import type { TreasuryReport } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import ECollectionReportForm from './ECollectionReportForm';
import RcdAppendix34 from './RcdAppendix34';

/**
 * The Treasurer's reports as COA prints them - Appendices 37, 38 and 39.
 *
 * ---------------------------------------------------------------------------
 * REBUILT AGAINST THE REAL FORMS
 * ---------------------------------------------------------------------------
 * Patch 86 built these from the field set each report must carry, because I
 * had no copy of the prescribed layouts. Patch 89 has them: sheets A37-RADAI,
 * A38-RCI and A39-RCDisb of `Appendix_Forms.xlsx`, the workbook already
 * carrying Candoni's name.
 *
 * Four things were wrong, and they were not cosmetic:
 *
 *   THE DV/PAYROLL NUMBER was not on the form at all. It is the second column
 *   of all three, and it is the column that connects the Treasurer's report to
 *   the voucher the Accountant has - which is the whole point of the report.
 *
 *   THE CAFOA NUMBER likewise. See the note on CAFOA_NOTE below.
 *
 *   "PARTICULARS" is "Nature of Payment" on every one of the three.
 *
 *   THE RCDisb HAD GROSS AND DEDUCTIONS COLUMNS, which I invented. Appendix 39
 *   has one amount column. A payroll's gross and deductions are on the payroll,
 *   which is Appendix 32, and reporting them again here would be reporting them
 *   twice from two different records.
 *
 * The RCI is also richer than the other two - it alone carries a Responsibility
 * Center Code and an Account Code - so the three forms are no longer quite as
 * alike as patch 86 assumed. They still share one page, because what differs is
 * a column list and a sentence, and three pages would be three places for the
 * certification wording to drift apart.
 *
 * ---------------------------------------------------------------------------
 * THE RCD IS NOT HERE
 * ---------------------------------------------------------------------------
 * Appendix 34 already exists, built from the collections register, and it is a
 * far fuller form. A second one would be a second answer to the same question.
 */

/**
 * The CAFOA column, on all three forms, with no CAFOA behind it.
 *
 * Appendix 28 is SUSPENDED and Candoni does not raise one - that was settled
 * when the GAM forms were first mapped. What sits in the column is the
 * Obligation Request number, which is the document that did the CAFOA's job.
 *
 * Said on the face of the form rather than only in code: an auditor reading a
 * column headed for one document and finding an entry from another will ask,
 * and the answer has to be visible from the page. The same footnote is on the
 * Registry of Appropriations, Allotments and Obligations for the same reason.
 */
const CAFOA_NOTE =
  'CAFOA (Appendix 28) is suspended. The column carries the Obligation Request number.';

interface FormSpec {
  appendix: string;
  title: string;
  /** What the instrument's own number column is headed. */
  instrument: string;
  /** The RCI alone carries the responsibility centre and the account code. */
  wide?: boolean;
  /** The certification sentence, as the form words it. */
  certification: (p: { sheets: number; from: string; to: string }) => string;
  signerLabel: string;
  /** The RCI has a Received by block beside the certification. */
  receivedBy?: boolean;
}

const FORMS: Partial<Record<TreasuryReportType, FormSpec>> = {
  RCI: {
    appendix: 'Appendix 38',
    title: 'Report of Checks Issued',
    instrument: 'Check',
    wide: true,
    certification: ({ sheets, from, to }) =>
      `I hereby certify on my official oath that this Report of Checks Issued in ${sheets} sheet(s) is a full, true and correct statement of all checks issued by me during the period stated above for which Check Nos. ${from} to ${to} inclusive, were actually issued by me in payment for obligations shown in the attached disbursement vouchers/payroll.`,
    signerLabel: 'Name and Signature of the Treasurer/Cashier/Disbursing Officer',
    receivedBy: true,
  },
  RADAI: {
    appendix: 'Appendix 37',
    title: 'Report of Authority to Debit Account Issued',
    instrument: 'ADA',
    certification: ({ from, to }) =>
      `I hereby certify on my official oath that the above is a true statement of all ADAs issued by me during the period stated above for which ADA Nos. ${from} to ${to} inclusive, were actually issued by me in the amounts shown thereon.`,
    signerLabel: 'Name and Signature of Local Treasurer',
  },
  RCDISB: {
    appendix: 'Appendix 39',
    title: 'Report of Cash Disbursements',
    instrument: 'Date',
    certification: ({ sheets }) =>
      `I hereby certify on my official oath that this Report of Cash Disbursements in ${sheets} sheet(s) is a full, true and correct statement of all cash disbursements during the period stated above actually made by me in payment for obligations shown in pertinent disbursement vouchers/payroll.`,
    signerLabel: 'Name and Signature of the Disbursing Officer/Cashier',
  },
};

/*
 * Patch 141: no fixed number of ruled rows. As many as fill ONE sheet, and
 * none on a report that already fills it - see useFitRows.
 */

export default function TreasuryReportForm() {
  const { id } = useParams<{ id: string }>();
  const { data: report, loading } = useDocument<TreasuryReport>(COL.treasuryReports, id);
  const entity = useEntity();

  const isCheckReport = report?.reportType === 'RCI';
  const isAdaReport = report?.reportType === 'RADAI';

  /*
   * The instruments this report covers, and the vouchers behind them.
   *
   * The report line does not carry the DV number - it never has - and the form
   * has a column for it. The CHECK and the ADVICE have carried `dvNo` since
   * they were first issued, so the number is a join away rather than a data
   * migration, and a report prepared years ago prints correctly.
   *
   * The voucher behind it carries the office and the obligation, which is what
   * the Responsibility Center and CAFOA columns want.
   */
  const checks = useChecks(isCheckReport ? (report?.bankAccountId ?? undefined) : undefined);
  const ada = useAda(isAdaReport ? (report?.bankAccountId ?? undefined) : undefined);
  const vouchers = useDisbursementVouchers(report?.fiscalYear ?? 0, report?.fundCode ?? '');

  const rows = useMemo(() => {
    if (!report) return [];
    const instrumentById = new Map<string, { dvId?: string; dvNo?: string }>([
      ...checks.data.map((c) => [c.id, { dvId: c.dvId, dvNo: c.dvNo }] as const),
      ...ada.data.map((a) => [a.id, { dvId: a.dvId, dvNo: a.dvNo }] as const),
    ]);
    const voucherById = new Map(vouchers.data.map((v) => [v.id, v]));

    return report.lines.map((line) => {
      const instrument = instrumentById.get(line.sourceId);
      /*
       * On an RCDisb the covered document IS the payroll, so its own number is
       * the DV/Payroll No. and there is no instrument to join through.
       */
      const dvNo = instrument?.dvNo ?? (report.reportType === 'RCDISB' ? line.sourceNo : '');
      const voucher = instrument?.dvId ? voucherById.get(instrument.dvId) : undefined;
      return {
        line,
        dvNo,
        obrNo: voucher?.obrNo ?? '',
        officeName: voucher?.officeName ?? '',
      };
    });
  }, [report, checks.data, ada.data, vouchers.data]);

  const total = useMemo(
    () =>
      (report?.lines ?? [])
        .filter((l) => !l.excluded)
        .reduce((sum, l) => sum + l.amount, 0),
    [report],
  );

  // Patch 141: the ruled rows that fill one landscape A4 sheet, measured.
  const fitKey = useMemo(() => ({}), [rows, report?.status, report?.jevNo]);
  const fit = useFitRows(printableHeightMm('landscape'), fitKey);

  if (loading) return <Spinner label="Loading the report" />;

  if (!report) {
    return (
      <Alert tone="error" title="Report not found">
        That report does not exist, or it has been deleted.
      </Alert>
    );
  }

  /*
   * The three COA Circular 2021-014 reports have a page of their own, for the
   * reasons set out at the top of it. One print address still reaches all
   * seven reports, so nothing that links to a printed report has to know which
   * kind it is.
   */
  if (isECollectionReport(report.reportType)) {
    return <ECollectionReportForm report={report} />;
  }

  /*
   * The RCD's form is Appendix 34, which is a screen of its own because it has
   * five lettered sections nothing else has. It is rendered HERE rather than
   * linked to, for the same reason the eRCD is: one print address reaches every
   * report, so nothing that links to a printed report has to know which kind it
   * is - which is exactly the knowledge that went stale and left the RCD with
   * no printable form at all. See the note at the top of RcdAppendix34.
   */
  if (report.reportType === 'RCD') {
    return <RcdAppendix34 report={report} />;
  }

  const form = FORMS[report.reportType];
  if (!form) {
    return (
      <Alert tone="error" title="No prescribed form for this report">
        CFMS has no Appendix form for a {TREASURY_REPORT_LABELS[report.reportType]}.
      </Alert>
    );
  }

  const short = TREASURY_REPORT_SHORT[report.reportType];
  const dated = report.reportType === 'RCDISB';
  /** Date, DV, CAFOA, Payee, Nature, Amount - plus two on the RCI, one on a serial. */
  const columns = (dated ? 6 : 7) + (form.wide ? 2 : 0);

  /*
   * The form, as a function of how many ruled rows it gets. Drawn twice: once
   * to be seen and printed, and once out of sight, laid out as the paper is,
   * to measure how many ruled rows fill one sheet (patch 141, useFitRows).
   */
  const renderSheet = (blank: number, probe: boolean) => (
      <div className="cbo-form-sheet cbo-card px-6 py-6 text-xs print:border-0 print:px-0 print:py-0">
        <DraftBand status={report.status} />

        <Letterhead appendix={form.appendix} title={form.title} lines={entity.headingLines} />

        <p className="mb-2 text-center text-2xs">
          Period Covered: <span className="font-semibold">{formatShortDate(report.reportDate)}</span>
        </p>

        <table className="mb-2 w-full">
          <tbody>
            <tr>
              <td className="w-1/2 py-0.5">
                <span className="text-slate-500">Fund :</span>{' '}
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
                {!dated && (
                  <>
                    <span className="text-slate-500">Bank Name/Account No. :</span>{' '}
                    <span className="font-semibold">{report.bankName ?? ''}</span>{' '}
                    <span className="font-mono">{report.bankAccountNumber ?? ''}</span>
                  </>
                )}
              </td>
              <td className="py-0.5">
                {/*
                  One sheet. CFMS prints the whole report on one continuous
                  page and lets the browser break it; a sheet number counted
                  from a page break the printer decides would be wrong as often
                  as it was right.
                */}
                <span className="text-slate-500">Sheet No. :</span>{' '}
                <span className="font-semibold">1 of 1</span>
              </td>
            </tr>
          </tbody>
        </table>

        <table className="w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              {dated ? (
                <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '6rem' }}>
                  Date
                </th>
              ) : (
                <th className="border border-slate-400 px-1.5 py-1 text-center" colSpan={2}>
                  {form.instrument}
                </th>
              )}
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '8rem' }}>
                DV/Payroll No.
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '8rem' }}>
                CAFOA No.
              </th>
              {form.wide && (
                <th
                  className="border border-slate-400 px-1.5 py-1 text-left"
                  style={{ width: '8rem' }}
                >
                  Responsibility Center Code
                </th>
              )}
              <th className="border border-slate-400 px-1.5 py-1 text-left">Payee</th>
              {form.wide && (
                <th
                  className="border border-slate-400 px-1.5 py-1 text-left"
                  style={{ width: '6rem' }}
                >
                  Account Code
                </th>
              )}
              <th className="border border-slate-400 px-1.5 py-1 text-left">Nature of Payment</th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '7rem' }}>
                Amount
              </th>
            </tr>
            {!dated && (
              <tr className="bg-slate-100">
                <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '5rem' }}>
                  Date
                </th>
                <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '7rem' }}>
                  Serial No.
                </th>
                <th className="border border-slate-400 px-1.5 py-1" colSpan={columns - 2} />
              </tr>
            )}
          </thead>
          <tbody>
            {rows.map(({ line, dvNo, obrNo, officeName }, i) => (
              <tr
                key={`${line.sourceId}-${i}`}
                className={line.excluded ? 'text-slate-500' : undefined}
              >
                <td className="border border-slate-400 px-1.5 py-1">{formatShortDate(line.date)}</td>
                {!dated && (
                  <td className="border border-slate-400 px-1.5 py-1 font-mono">{line.sourceNo}</td>
                )}
                <td className="border border-slate-400 px-1.5 py-1 font-mono">
                  {dated ? line.sourceNo : dvNo}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{obrNo}</td>
                {form.wide && (
                  <td className="border border-slate-400 px-1.5 py-1">{officeName}</td>
                )}
                <td className="border border-slate-400 px-1.5 py-1">{line.payeeName ?? ''}</td>
                {form.wide && <td className="border border-slate-400 px-1.5 py-1" />}
                <td className="border border-slate-400 px-1.5 py-1">
                  {/*
                    A cancelled instrument is ON the report - its serial is in
                    the range the report covers, and a serial missing from a
                    numbered range is the first thing an auditor asks about.
                    It is marked, and it is not in the total.
                  */}
                  {line.excluded ? <span className="font-semibold">CANCELLED. </span> : null}
                  {line.particulars ?? ''}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {line.excluded ? '' : formatAmount(line.amount, false)}
                </td>
              </tr>
            ))}

            {probe ? (
              <tr data-fit-probe="">
                {Array.from({ length: columns }, (_, j) => (
                  <td key={j} className="border border-slate-400 px-1.5 py-[7px]">
                    &nbsp;
                  </td>
                ))}
              </tr>
            ) : (
              blankRows(blank, columns, 'rep')
            )}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-bold">
              <td
                className="border border-slate-400 px-1.5 py-1 text-right"
                colSpan={columns - 1}
              >
                Total
              </td>
              <td className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(total, false)}
              </td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-1 text-[9px] italic text-slate-500">{CAFOA_NOTE}</p>

        <div className={`cbo-form-signatures mt-4 grid gap-0 ${form.receivedBy ? 'sm:grid-cols-2' : ''}`}>
          <div className="border border-slate-400 px-3 py-2">
            <p className="text-center text-2xs font-bold uppercase tracking-wide">Certification</p>
            <p className="mt-2 text-2xs leading-relaxed">
              {form.certification({
                sheets: 1,
                from: report.serialFrom ?? '________',
                to: report.serialTo ?? '________',
              })}
            </p>
            <div className="mt-8">
              <p className="border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
                {report.accountableOfficerName || entity.localTreasurer.name || ' '}
              </p>
              <p className="text-center text-[9px] text-slate-500">{form.signerLabel}</p>
              <p className="mt-3 text-[9px] text-slate-500">Official Designation ____________</p>
              <p className="mt-2 text-[9px] text-slate-500">Date ____________</p>
            </div>
          </div>

          {form.receivedBy && (
            <div className="border border-l-0 border-slate-400 px-3 py-2">
              <p className="text-center text-2xs font-bold uppercase tracking-wide">Received by:</p>
              <div className="mt-16">
                <p className="border-t border-slate-500 pt-1 text-center text-2xs">&nbsp;</p>
                <p className="text-center text-[9px] text-slate-500">Signature over Printed Name</p>
                <p className="mt-3 text-[9px] text-slate-500">Date ____________</p>
              </div>
            </div>
          )}
        </div>

        {report.jevNo && (
          <p className="mt-2 text-[9px] text-slate-500">
            Taken up in the books as JV <span className="font-mono">{report.jevNo}</span>.
          </p>
        )}
      </div>
  );

  return (
    <div>
      <FormPrintStyle />

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
              <FormBackButton reportId={report.id} reportType={report.reportType} />
              <Button variant="primary" onClick={() => window.print()}>
                Print
              </Button>
            </>
          }
        />

        {report.status === 'DRAFT' && (
          <Alert tone="info" title="This copy is marked as a draft" className="mb-4">
            Print it and check the figures against the vouchers before the Treasurer signs
            anything - that is what it is for. It has no number yet and the figures can still
            change, so every page carries a band saying it is not certified. A checking copy
            cannot be signed by mistake or filed as the real one.
          </Alert>
        )}

        {report.status === 'CANCELLED' && (
          <Alert tone="error" title="This report was withdrawn" className="mb-4">
            {report.cancelledReason ?? 'See the approval history for the reason.'}
          </Alert>
        )}
      </div>

      {/* --- the form ------------------------------------------------------- */}
      {renderSheet(fit.blank, false)}
      <div ref={fit.ref} className="cbo-form-measure no-print" aria-hidden="true">
        {renderSheet(0, true)}
      </div>
    </div>
  );
}
