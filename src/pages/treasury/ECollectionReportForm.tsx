import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useCollections, useDeposits } from '@/data/queries';
import { useEntity } from '@/data/useEntity';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import { Letterhead, blankRows } from '@/components/print/formParts';
import { TREASURY_REPORT_SHORT } from '@/types/enums';
import type { ECollectionReportType } from '@/types/enums';
import type { Collection, TreasuryReport } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';

/**
 * Annexes E, F and G of COA Circular 2021-014, as the circular prints them.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THREE ARE NOT ON THE APPENDIX 37/38/39 PAGE
 * ---------------------------------------------------------------------------
 * That page carries three forms that differ by a column and a sentence, and
 * keeping them together is what stops the certification wording drifting apart.
 *
 * These three do not fit it. They have a different header block (Entity Name,
 * Fund Cluster and an intermediary or a bank account, against Report No.,
 * Sheet No. and Date), an Amount column that is a GROUP rather than a column,
 * a summary of undeposited collections that the Treasurer's reports have no
 * equivalent of, and - on two of the three - a certification about somebody
 * else's list rather than about the officer's own acts. Forcing them in would
 * have meant a column list with three different shapes in it.
 *
 * So they share a page with each other, for the same reason the other three
 * share one: what differs between E, F and G is a column, a sentence and a
 * signature block.
 *
 * ---------------------------------------------------------------------------
 * THE BREAKDOWN COLUMNS ARE THE REVENUE ACCOUNTS
 * ---------------------------------------------------------------------------
 * All three forms print "Breakdown of Collections" with specimen columns
 * headed Taxes, Fees and a blank, each with "(account code)" beneath, and the
 * instructions say the unit "may insert additional columns for each nature of
 * collections". So the columns are not a fixed three - they are whatever the
 * report actually collected, which CFMS knows from the receipts.
 *
 * Generating them from the receipts is also the only way the breakdown is
 * guaranteed to foot to the Total column. A fixed Taxes/Fees pair would have
 * needed a rule deciding which account is a tax, and anything that fell
 * outside it would have vanished from the breakdown while staying in the
 * total.
 */

interface AnnexSpec {
  annex: string;
  title: string;
  /** The sub-heading under the title, where the form has one. */
  subtitle?: (p: { intermediary: string }) => string;
  /** How the receipt column pair is headed. */
  receiptGroup: string;
  receiptNumberLabel: string;
  /** Annexes E and F carry these two; Annex G does not. */
  withResponsibilityCentre: boolean;
  /** Annexes E and F name the intermediary in the header; G names the bank. */
  headerThirdLine: 'INTERMEDIARY' | 'BANK' | 'NONE';
  /** What the Total-per-receipt column is headed. */
  totalColumn: string;
  /** Annexes E and F carry the undeposited-collections summary. */
  withSummary: boolean;
  /** The series the summary and the certification name. */
  seriesLabel: string;
  certification: 'E' | 'F' | 'G';
  signerLabel: string;
}

const ANNEXES: Record<ECollectionReportType, AnnexSpec> = {
  ERCD_AR: {
    annex: 'Annex E',
    title: 'Report of e-Collections and Deposits',
    subtitle: ({ intermediary }) => `By: ${intermediary || '(Name of Intermediary)'}`,
    receiptGroup: 'Electronic Acknowledgement Receipt',
    receiptNumberLabel: 'Number',
    withResponsibilityCentre: true,
    headerThirdLine: 'NONE',
    totalColumn: 'Total per AR',
    withSummary: true,
    seriesLabel: 'AR',
    certification: 'E',
    signerLabel: 'Name and Signature of the Designated Officer',
  },
  ERCD_EOR: {
    annex: 'Annex F',
    title: 'Report of e-Collections and Deposits',
    receiptGroup: 'Electronic Official Receipt (eOR)',
    receiptNumberLabel: 'Number',
    withResponsibilityCentre: true,
    headerThirdLine: 'INTERMEDIARY',
    totalColumn: 'Total per eOR',
    withSummary: true,
    seriesLabel: 'eOR',
    certification: 'F',
    signerLabel: 'Name and Signature of the Designated Officer',
  },
  ERCD_DIRECT: {
    annex: 'Annex G',
    title: "Report of Daily Collection Directly Deposited to the Agency's Bank Account",
    receiptGroup: 'Deposit',
    receiptNumberLabel: 'eOR / transaction confirmation number',
    withResponsibilityCentre: false,
    headerThirdLine: 'BANK',
    totalColumn: 'Total',
    withSummary: false,
    seriesLabel: 'eOR',
    certification: 'G',
    signerLabel: 'Name and Signature',
  },
};

const BLANK_ROWS = 12;

export default function ECollectionReportForm({ report }: { report: TreasuryReport }) {
  const entity = useEntity();
  const spec = ANNEXES[report.reportType as ECollectionReportType];

  /*
   * The receipts themselves, for everything the report line does not carry:
   * the responsibility centre, the PREXC/PAP, the intermediary, and the split
   * of each receipt across revenue accounts that becomes the breakdown.
   *
   * Joined through the collection id the line already holds, rather than
   * copied onto the line when the report was prepared. A report certified
   * before a later patch added a field would otherwise print blanks for it
   * forever - which is exactly how the DV number came to be missing from the
   * Treasurer's reports until patch 89.
   */
  const collections = useCollections(report.fiscalYear, report.fundCode);
  const deposits = useDeposits();

  const byId = useMemo(
    () => new Map(collections.data.map((c) => [c.id, c])),
    [collections.data],
  );

  const rows = useMemo(
    () =>
      (report.lines ?? []).map((line) => ({
        line,
        collection: byId.get(line.sourceId) ?? null,
      })),
    [report.lines, byId],
  );

  /**
   * The breakdown columns: every revenue account this report collected, in
   * account-code order so two reports of the same kind read alike.
   */
  const breakdown = useMemo(() => {
    const seen = new Map<string, string>();
    for (const { collection } of rows) {
      for (const l of collection?.lines ?? []) {
        if (l.accountCode) seen.set(l.accountCode, l.accountName || l.accountCode);
      }
    }
    return [...seen.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [rows]);

  const amountFor = (collection: Collection | null, accountCode: string) =>
    (collection?.lines ?? [])
      .filter((l) => l.accountCode === accountCode)
      .reduce((s, l) => s + l.amount, 0);

  const total = useMemo(
    () => (report.lines ?? []).filter((l) => !l.excluded).reduce((s, l) => s + l.amount, 0),
    [report.lines],
  );

  const breakdownTotals = useMemo(
    () =>
      breakdown.map((b) =>
        rows
          .filter(({ line }) => !line.excluded)
          .reduce((s, { collection }) => s + amountFor(collection, b.code), 0),
      ),
    [breakdown, rows],
  );

  /**
   * The summary of undeposited collections, on Annexes E and F.
   *
   * CFMS works all three figures out from the register rather than asking the
   * officer to carry them forward by hand, because a figure carried forward by
   * hand is a figure that stops agreeing with the collections the day somebody
   * mistypes it.
   *
   *   PER LAST REPORT   e-collections of this kind that were certified on an
   *                     EARLIER report and still have no deposit against them.
   *   DEPOSITS          the deposits recorded against the receipts on THIS
   *                     report.
   *   THIS REPORT       what is left of this report's collections.
   */
  const summary = useMemo(() => {
    if (!spec.withSummary) return null;

    const kind = report.reportType === 'ERCD_AR' ? 'AR' : 'EOR';
    const onThisReport = new Set((report.lines ?? []).map((l) => l.sourceId));

    const broughtForward = collections.data
      .filter((c) => c.eCollectionKind === kind)
      .filter((c) => c.status !== 'CANCELLED')
      .filter((c) => !onThisReport.has(c.id))
      // Certified on an earlier report: an uncertified one is nobody's
      // outstanding balance yet.
      .filter((c) => !!c.treasuryReportId)
      .filter((c) => (c.treasuryReportNo ?? '') < (report.reportNo ?? '￿'))
      .filter((c) => !c.depositId)
      .reduce((s, c) => s + c.totalAmount, 0);

    const depositIds = new Set(
      rows
        .map(({ collection }) => collection?.depositId)
        .filter((d): d is string => !!d),
    );
    const theDeposits = deposits.data.filter((d) => depositIds.has(d.id));
    const deposited = rows
      .filter(({ line }) => !line.excluded)
      .filter(({ collection }) => !!collection?.depositId)
      .reduce((s, { line }) => s + line.amount, 0);

    return {
      broughtForward,
      collected: total,
      deposits: theDeposits,
      deposited,
      carriedForward: broughtForward + total - deposited,
    };
  }, [spec.withSummary, report, collections.data, deposits.data, rows, total]);

  const intermediaryName =
    rows.find(({ collection }) => collection?.intermediaryName)?.collection?.intermediaryName ?? '';

  const short = TREASURY_REPORT_SHORT[report.reportType];
  /** Receipt date, receipt number, [RCC], payor, particulars, [PREXC], total. */
  const leadingColumns = spec.withResponsibilityCentre ? 6 : 4;
  const columns = leadingColumns + 1 + breakdown.length;

  const from = report.serialFrom ?? '________';
  const to = report.serialTo ?? '________';
  const transactions = (report.lines ?? []).filter((l) => !l.excluded).length;

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title={hasDocumentNumber(report.reportNo) ? `${short} ${report.reportNo}` : `${short} (draft)`}
          subtitle={`${spec.annex} - the form as COA Circular 2021-014 prints it`}
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
            form that says an officer certified something they have not.
          </Alert>
        )}

        {report.status === 'CANCELLED' && (
          <Alert tone="error" title="This report was withdrawn" className="mb-4">
            {report.cancelledReason ?? 'See the approval history for the reason.'}
          </Alert>
        )}

        {breakdown.length > 6 && (
          <Alert tone="warning" title="This report has a wide breakdown" className="mb-4">
            It collected {breakdown.length} different revenue accounts, so the Breakdown of
            Collections has {breakdown.length} columns and will not fit A4 portrait. Print it
            landscape, or prepare a report per nature of collection.
          </Alert>
        )}
      </div>

      {/* --- the form ------------------------------------------------------- */}
      <div className="cbo-card px-6 py-6 text-xs print:border-0 print:px-0 print:py-0">
        <Letterhead
          appendix={spec.annex}
          title={spec.title}
          lines={entity.headingLines}
          subtitle={
            spec.subtitle
              ? spec.subtitle({ intermediary: intermediaryName })
              : report.reportType === 'ERCD_DIRECT'
                ? `Date: ${formatShortDate(report.reportDate)}`
                : undefined
          }
        />

        <table className="mb-2 w-full text-2xs">
          <tbody>
            <tr>
              <td className="w-3/5 py-0.5">
                <span className="text-slate-500">Entity Name :</span>{' '}
                <span className="font-semibold">{entity.headingLines[1] ?? ''}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Report No. :</span>{' '}
                <span className="font-mono font-semibold">
                  {hasDocumentNumber(report.reportNo) ? report.reportNo : ''}
                </span>
              </td>
            </tr>
            <tr>
              <td className="py-0.5">
                <span className="text-slate-500">Fund Cluster :</span>{' '}
                <span className="font-semibold">{fundLabel(report.fundCode)}</span>
              </td>
              <td className="py-0.5">
                {/*
                  One sheet, for the reason given on the Treasurer's reports:
                  CFMS prints the report as one continuous page and lets the
                  browser break it, so a sheet number counted from a break the
                  printer decides would be wrong as often as it was right.
                */}
                <span className="text-slate-500">Sheet No. :</span>{' '}
                <span className="font-semibold">1 of 1</span>
              </td>
            </tr>
            <tr>
              <td className="py-0.5">
                {spec.headerThirdLine === 'INTERMEDIARY' && (
                  <>
                    <span className="text-slate-500">Intermediary :</span>{' '}
                    <span className="font-semibold">{intermediaryName}</span>
                  </>
                )}
                {spec.headerThirdLine === 'BANK' && (
                  <>
                    <span className="text-slate-500">Bank / Account number :</span>{' '}
                    <span className="font-semibold">{report.bankName ?? ''}</span>{' '}
                    <span className="font-mono">{report.bankAccountNumber ?? ''}</span>
                  </>
                )}
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Date :</span>{' '}
                <span className="font-semibold">{formatShortDate(report.reportDate)}</span>
              </td>
            </tr>
          </tbody>
        </table>

        <table className="w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-center" colSpan={2}>
                {spec.receiptGroup}
              </th>
              {spec.withResponsibilityCentre && (
                <th className="border border-slate-400 px-1.5 py-1 text-center" rowSpan={2} style={{ width: '6rem' }}>
                  Responsibility Center Code
                </th>
              )}
              <th className="border border-slate-400 px-1.5 py-1 text-center" rowSpan={2}>
                Payor
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-center" rowSpan={2}>
                Particulars
              </th>
              {spec.withResponsibilityCentre && (
                <th className="border border-slate-400 px-1.5 py-1 text-center" rowSpan={2} style={{ width: '5rem' }}>
                  PREXC/PAP
                </th>
              )}
              <th
                className="border border-slate-400 px-1.5 py-1 text-center"
                colSpan={1 + breakdown.length}
              >
                Amount
              </th>
            </tr>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '5rem' }}>
                Date
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '8rem' }}>
                {spec.receiptNumberLabel}
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '6rem' }}>
                {spec.totalColumn}
              </th>
              {breakdown.length === 0 ? (
                <th className="border border-slate-400 px-1.5 py-1 text-center" style={{ width: '6rem' }}>
                  Breakdown of Collections
                </th>
              ) : (
                breakdown.map((b) => (
                  <th
                    key={b.code}
                    className="border border-slate-400 px-1.5 py-1 text-right align-bottom"
                    style={{ width: '6rem' }}
                  >
                    <span className="block leading-tight">{b.name}</span>
                    <span className="block font-mono font-normal text-slate-500">({b.code})</span>
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ line, collection }, i) => (
              <tr
                key={`${line.sourceId}-${i}`}
                className={line.excluded ? 'text-slate-500' : undefined}
              >
                <td className="border border-slate-400 px-1.5 py-1">{formatShortDate(line.date)}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{line.sourceNo}</td>
                {spec.withResponsibilityCentre && (
                  <td className="border border-slate-400 px-1.5 py-1 font-mono">
                    {collection?.responsibilityCenterCode ?? ''}
                  </td>
                )}
                <td className="border border-slate-400 px-1.5 py-1">{line.payeeName ?? ''}</td>
                <td className="border border-slate-400 px-1.5 py-1">
                  {/*
                    A cancelled receipt stays ON the report: its number is in
                    the range the report covers, and the instructions for
                    Annex E say the cancelled ARs are listed in numerical
                    sequence. It is marked, and it is not in the total.
                  */}
                  {line.excluded ? <span className="font-semibold">CANCELLED. </span> : null}
                  {line.particulars ?? ''}
                </td>
                {spec.withResponsibilityCentre && (
                  <td className="border border-slate-400 px-1.5 py-1 font-mono">
                    {collection?.prexcPap ?? ''}
                  </td>
                )}
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {line.excluded ? '' : formatAmount(line.amount, false)}
                </td>
                {breakdown.length === 0 ? (
                  <td className="border border-slate-400 px-1.5 py-1" />
                ) : (
                  breakdown.map((b) => {
                    const amount = line.excluded ? 0 : amountFor(collection, b.code);
                    return (
                      <td
                        key={b.code}
                        className="border border-slate-400 px-1.5 py-1 text-right tabular-nums"
                      >
                        {amount ? formatAmount(amount, false) : ''}
                      </td>
                    );
                  })
                )}
              </tr>
            ))}

            {blankRows(BLANK_ROWS - rows.length, columns, 'ercd')}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-bold">
              <td
                className="border border-slate-400 px-1.5 py-1 text-right"
                colSpan={leadingColumns}
              >
                Total
              </td>
              <td className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(total, false)}
              </td>
              {breakdown.length === 0 ? (
                <td className="border border-slate-400 px-1.5 py-1" />
              ) : (
                breakdownTotals.map((amount, i) => (
                  <td
                    key={breakdown[i].code}
                    className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums"
                  >
                    {formatAmount(amount, false)}
                  </td>
                ))
              )}
            </tr>
          </tfoot>
        </table>

        {summary && (
          <div className="mt-3 border border-slate-400 px-3 py-2">
            <p className="text-2xs font-semibold">Summary:</p>
            <table className="mt-1 w-full text-2xs">
              <tbody>
                <tr>
                  <td className="py-0.5">Undeposited Collections per last Report</td>
                  <td className="py-0.5 text-right tabular-nums" style={{ width: '8rem' }}>
                    {formatAmount(summary.broughtForward, false)}
                  </td>
                </tr>
                <tr>
                  <td className="py-0.5">
                    Collections per {spec.seriesLabel} Nos.{' '}
                    <span className="font-mono">{from}</span> to <span className="font-mono">{to}</span>
                  </td>
                  <td className="py-0.5 text-right tabular-nums">
                    {formatAmount(summary.collected, false)}
                  </td>
                </tr>
                <tr>
                  <td className="pt-1">Deposits</td>
                  <td />
                </tr>
                {summary.deposits.length === 0 ? (
                  <tr>
                    <td className="py-0.5 pl-6 text-slate-500">
                      Date: ____________ Ref # ____________
                      {report.reportType === 'ERCD_EOR' && ' Bank Account Number: ____________'}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">{formatAmount(0, false)}</td>
                  </tr>
                ) : (
                  summary.deposits.map((d) => (
                    <tr key={d.id}>
                      <td className="py-0.5 pl-6">
                        Date: {formatShortDate(d.depositDate)} Ref #{' '}
                        <span className="font-mono">{d.referenceNo || d.depositSlipNo}</span>
                        {report.reportType === 'ERCD_EOR' && (
                          <>
                            {' '}
                            Bank Account Number:{' '}
                            <span className="font-mono">{d.bankAccountNumber}</span>
                          </>
                        )}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">
                        {formatAmount(d.amount, false)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="font-semibold">
                  <td className="border-t border-slate-400 py-0.5">
                    Undeposited Collections, this Report
                  </td>
                  <td className="border-t border-slate-400 py-0.5 text-right tabular-nums">
                    {formatAmount(summary.carriedForward, false)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-1 text-[9px] italic text-slate-500">
              Worked out from the receipts and the deposits recorded against them, not carried
              forward by hand.
            </p>
          </div>
        )}

        <div className="mt-3 border border-slate-400 px-3 py-3">
          <p className="text-center text-2xs font-bold uppercase tracking-wide">
            {spec.certification === 'G' ? 'Certified Correct:' : 'Certification'}
          </p>

          {spec.certification === 'E' && (
            <p className="mt-2 text-2xs leading-relaxed">
              I hereby certify on my official oath that I have reviewed and found in order the above
              statement of all collections based on the list provided by{' '}
              <span className="font-semibold">{intermediaryName || '(Intermediary)'}</span>{' '}
              corresponding the period stated above for which electronic AR Nos.{' '}
              <span className="font-mono">{from}</span> to <span className="font-mono">{to}</span>{' '}
              inclusive consisting of <span className="font-semibold">{transactions}</span>{' '}
              transactions, were actually issued by them in the amounts shown thereon. I also
              certify that I have verified and confirmed that the amount of{' '}
              <span className="font-semibold tabular-nums">{formatAmount(total, false)}</span> was
              deposited and credited to appropriate bank account of this agency.
            </p>
          )}

          {spec.certification === 'F' && (
            <p className="mt-2 text-2xs leading-relaxed">
              I hereby certify on my official oath that the above is a true statement of all
              collections of digital representation of legal tender during the period stated above
              for which eOR Nos. <span className="font-mono">{from}</span> to{' '}
              <span className="font-mono">{to}</span> inclusive, were actually issued to acknowledge
              receipt of the amounts shown thereon. I also certify that I have verified and
              confirmed that the amount of{' '}
              <span className="font-semibold tabular-nums">{formatAmount(total, false)}</span> was
              actually credited to the account of this agency.
            </p>
          )}

          <div className={spec.certification === 'G' ? 'mt-10' : 'mt-10'}>
            <p className="mx-auto w-80 border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
              {report.accountableOfficerName || ' '}
            </p>
            <p className="text-center text-[9px] text-slate-500">{spec.signerLabel}</p>
            <div className="mx-auto mt-4 flex w-96 justify-between">
              <p className="text-[9px] text-slate-500">Official Designation ____________</p>
              {spec.certification !== 'G' && (
                <p className="text-[9px] text-slate-500">Date ____________</p>
              )}
            </div>
          </div>
        </div>

        {report.jevNo && (
          <p className="mt-2 text-[9px] text-slate-500">
            Taken up in the books as JV <span className="font-mono">{report.jevNo}</span>.
          </p>
        )}
      </div>
    </div>
  );
}
