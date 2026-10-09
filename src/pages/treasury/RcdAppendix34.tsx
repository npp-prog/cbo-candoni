import { Fragment, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useFilters } from '@/context/FilterContext';
import { useCollections, useDeposits, useFormMovements, useRcds, useAccountableFormTypes } from '@/data/queries';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import {
  accountability,
  collapse,
  rangeFrom,
  renderSet,
  subtract,
  toNumber,
  type NumericRange,
  type SerialRange,
} from '@/lib/serials';
import {
  Letterhead,
  SectionTitle,
  SignatureLine,
  SummaryLine,
  blankRows,
} from '@/components/print/formParts';
import { CASH_LOCAL_TREASURY } from '@/lib/chartOfAccounts';
import { useEntity } from '@/data/useEntity';
import { FormPrintStyle, isCertifiedCopy } from '@/components/print/FormPrintStyle';
import { FormBackButton } from './FormBackButton';
import type { TreasuryReport } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';

/**
 * The Report of Collections and Deposits as COA prints it - Appendix 34.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE SCREEN FROM THE RCD REGISTER
 * ---------------------------------------------------------------------------
 * The register is how the office works: a list, sortable, with the figures that
 * matter to the person doing the job. This is the document the Treasurer signs
 * and hands to the Accounting Office, and its shape is not ours to choose -
 * five lettered sections, in order, with ruled blank rows where there is
 * nothing to print, because the blanks are what tell a reader the section was
 * considered and found empty rather than skipped.
 *
 * Everything on it is computed. Section A.1 groups the receipts into booklet
 * ranges, Section C derives the officer's accountability from the movement
 * ledger, and Section D splits the collections by how they were tendered. If
 * any of those disagree with the register, the difference is in the data and
 * not in this page - which is the point of not letting anybody type on it.
 * ---------------------------------------------------------------------------
 */

/** Minimum ruled rows per section, as on the printed form. */
const BLANK_ROWS = { a1: 6, a2: 8, b: 3, c: 4, checks: 5 };

const FORM_CODE = (c: { accountableForm?: string; accountableFormId?: string }) =>
  String(c.accountableForm ?? c.accountableFormId ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export default function RcdAppendix34({ report }: { report?: TreasuryReport }) {
  const entity = useEntity();
  const { id } = useParams<{ id: string }>();
  const { fiscalYear, fundCode } = useFilters();

  const { data: rcds, loading } = useRcds(fiscalYear, fundCode);
  const { data: collections } = useCollections(fiscalYear, fundCode);
  const { data: deposits } = useDeposits();
  const { data: movements } = useFormMovements(fiscalYear);
  const { data: formTypes } = useAccountableFormTypes();

  /*
   * ---------------------------------------------------------------------------
   * TWO RECORDS, ONE FORM - AND THE REASON THIS SCREEN HAD GONE DARK
   * ---------------------------------------------------------------------------
   * Appendix 34 was built when an RCD was its own document in `rcds`, and it
   * reads that collection. The RCD then became a TREASURY REPORT like the RCI
   * and the RADAI - one shape for every report the Treasurer certifies - and
   * `rcds` stopped being written to.
   *
   * Nothing failed, which is why it survived. This screen went on working
   * perfectly against a collection that no longer receives anything, reachable
   * only from a register that is now empty, while the RCD the office actually
   * prepares had NO prescribed form at all: its own page deliberately hid the
   * Print button and pointed here, and here had nothing to show.
   *
   * So the form now takes either. Given a treasury report it derives what the
   * old record stored:
   *
   *   THE COLLECTIONS from the report's own lines, which is where the RCD
   *   records what it covers.
   *
   *   THE DEPOSITS by joining through `depositId` on those collections, which
   *   is stamped when a slip banks a receipt. The old record kept a
   *   `depositIds` list; a treasury report does not, and the join answers the
   *   same question from data that is already there rather than asking for a
   *   migration.
   *
   * Everything below this point is unchanged. The five sections, the booklet
   * ranges, the accountability from the movement ledger and the split by how
   * each peso was tendered all read `covered`, and `covered` is now correct for
   * both kinds of record.
   */
  const legacy = rcds.find((r) => r.id === id);

  const covered = useMemo(() => {
    if (report) {
      const wanted = new Set(
        (report.lines ?? [])
          .filter((l: { excluded?: boolean }) => !l.excluded)
          .map((l: { sourceId: string }) => l.sourceId),
      );
      return collections.filter((c) => wanted.has(c.id));
    }
    return legacy ? collections.filter((c) => legacy.collectionIds.includes(c.id)) : [];
  }, [report, legacy, collections]);

  /** The record this form is drawn from, in the shape the sections below read. */
  const rcd = useMemo(() => {
    if (!report) return legacy;
    const totalCollections = covered.reduce((sum, c) => sum + c.totalAmount, 0);
    const bankedIds = new Set(covered.map((c) => c.depositId).filter(Boolean) as string[]);
    const banked = deposits.filter((d) => bankedIds.has(d.id));
    const totalDeposits = banked.reduce((sum, d) => sum + d.amount, 0);
    return {
      id: report.id,
      rcdNo: report.reportNo ?? '(not yet certified)',
      rcdDate: report.reportDate,
      fiscalYear: report.fiscalYear,
      fundCode: report.fundCode,
      collectingOfficerId: report.accountableOfficerId ?? '',
      collectingOfficerName: report.accountableOfficerName ?? '',
      orNumberFrom: report.serialFrom ?? '',
      orNumberTo: report.serialTo ?? '',
      collectionIds: covered.map((c) => c.id),
      depositIds: banked.map((d) => d.id),
      totalCollections,
      totalDeposits,
      undepositedAmount: totalCollections - totalDeposits,
      status: report.status,
    } as unknown as typeof legacy;
  }, [report, legacy, covered, deposits]);

  /** Section A.1 - receipts collapsed into runs, then split at booklet edges. */
  const byForm = useMemo(() => {
    const groups = new Map<string, { ranges: SerialRange[]; amount: number }>();
    const perForm = new Map<string, typeof covered>();
    for (const c of covered) {
      const code = FORM_CODE(c) || '-';
      perForm.set(code, [...(perForm.get(code) ?? []), c]);
    }
    for (const [code, list] of perForm) {
      const size = formTypes.find((t) => t.code === code)?.bookletSize ?? 50;
      groups.set(code, {
        ranges: renderSet(collapse(list.map((c) => c.orNumber)), size),
        amount: list.reduce((s, c) => s + c.totalAmount, 0),
      });
    }
    return groups;
  }, [covered, formTypes]);

  const a1Rows = useMemo(() => {
    const rows: Array<{ form: string; range: SerialRange; amount: number; first: boolean }> = [];
    for (const [code, group] of byForm) {
      const printed = formTypes.find((t) => t.code === code)?.printedAs ?? code;
      group.ranges.forEach((range, i) => {
        // The amount is apportioned to the range by the receipts inside it, so
        // a booklet split does not put one booklet's money on the other's line.
        // The comparison has to be numeric: as text, "100" sorts below "99".
        const lo = toNumber(range.from);
        const hi = toNumber(range.to);
        const amount = covered
          .filter((c) => {
            if (FORM_CODE(c) !== code) return false;
            const n = toNumber(c.orNumber);
            if (n === null || lo === null || hi === null) return false;
            return n >= lo && n <= hi;
          })
          .reduce((s, c) => s + c.totalAmount, 0);
        rows.push({ form: printed, range, amount, first: i === 0 });
      });
    }
    return rows;
  }, [byForm, covered, formTypes]);

  /** Section B - the deposits this report accounts for. */
  const coveredDeposits = useMemo(
    () => (rcd ? deposits.filter((d) => rcd.depositIds?.includes(d.id)) : []),
    [rcd, deposits],
  );

  /** Section C - the officer's accountability, from the movement ledger. */
  const accountabilityLines = useMemo(() => {
    if (!rcd) return [];
    const live = movements.filter((m) => !m.voided);
    const out: Array<{ printed: string; acc: ReturnType<typeof accountability> }> = [];

    for (const [code] of byForm) {
      const type = formTypes.find((t) => t.code === code);
      const size = type?.bookletSize ?? 50;

      // What the officer had been issued, less what they had already used
      // before this report's date.
      const issuedToOfficer = live
        .filter((m) => m.kind === 'ISSUE' && m.formCode === code && m.custodianId === rcd.collectingOfficerId)
        .map((m) => rangeFrom(m.serialFrom, m.serialTo))
        .filter((r): r is NumericRange => r !== null);

      const usedBefore = collapse(
        collections
          .filter(
            (c) =>
              c.collectingOfficerId === rcd.collectingOfficerId &&
              FORM_CODE(c) === code &&
              c.orDate < rcd.rcdDate,
          )
          .map((c) => c.orNumber),
      );

      const receiptedNow = live
        .filter(
          (m) =>
            m.kind === 'ISSUE' &&
            m.formCode === code &&
            m.custodianId === rcd.collectingOfficerId &&
            m.movementDate === rcd.rcdDate,
        )
        .map((m) => rangeFrom(m.serialFrom, m.serialTo))
        .filter((r): r is NumericRange => r !== null);

      // What they held when the day opened: everything ever issued to them,
      // less anything issued today, less every receipt already written.
      const beginning = subtract(subtract(issuedToOfficer, receiptedNow), usedBefore);
      const issuedNow = collapse(covered.filter((c) => FORM_CODE(c) === code).map((c) => c.orNumber));

      out.push({
        printed: type?.printedAs ?? code,
        acc: accountability({ beginning, receipt: receiptedNow, issued: issuedNow }, size),
      });
    }
    return out;
  }, [rcd, movements, byForm, collections, covered, formTypes]);

  /** Section D - how the money came in. */
  const tender = useMemo(() => {
    const split = { cash: 0, check: 0, online: 0 };
    for (const c of covered) {
      if (c.paymentForm === 'CHECK') split.check += c.totalAmount;
      else if (c.paymentForm === 'ONLINE' || c.paymentForm === 'CARD') split.online += c.totalAmount;
      else split.cash += c.totalAmount;
    }
    return split;
  }, [covered]);

  const checks = useMemo(() => covered.filter((c) => c.paymentForm === 'CHECK'), [covered]);

  if (loading) return <Spinner label="Reading the report" />;

  if (!rcd) {
    return (
      <Alert tone="warning" title="That report is not in this fund and year">
        Check the fiscal year and fund in the header, then open the report again from{' '}
        <Link className="underline" to="/treasury/collections/rcd">
          the RCD register
        </Link>
        .
      </Alert>
    );
  }

  const totalCollections = rcd.totalCollections;
  const totalDeposits = rcd.totalDeposits;
  const balance = totalCollections - totalDeposits;

  const status = (rcd as { status?: string }).status;
  const certified = isCertifiedCopy(status);

  return (
    <div>
      <FormPrintStyle />

      {/* The chrome was printing with the form. It is a web page's furniture
          and has no business on a document the Treasurer signs. */}
      <div className="no-print">
        <PageHeader
          title={`RCD ${rcd.rcdNo}`}
          subtitle="The form as COA prints it. A4 landscape."
          breadcrumbs={[
            { label: 'Treasury', to: '/treasury' },
            { label: 'RCD', to: '/treasury/collections/rcd' },
            { label: rcd.rcdNo },
          ]}
          actions={
            <>
              {/* Only for a treasury report: a legacy RCD has no report page
                  to go back to, and its register is where it was opened. */}
              {report && <FormBackButton reportId={report.id} reportType={report.reportType} />}
              <Button variant="primary" onClick={() => window.print()}>
                Print
              </Button>
            </>
          }
        />

        {!certified && (
          <Alert tone="info" title="This report is still a draft" className="mb-4">
            Check the printed copy against the receipts before the Treasurer signs it, and certify
            the report in CFMS when it is signed.
          </Alert>
        )}
      </div>

      <div className="cbo-form-sheet cbo-card px-6 py-6 text-xs print:border-0 print:px-0 print:py-0">

        <Letterhead appendix="Appendix 34" title="Report of Collections and Deposits" lines={entity.headingLines} />

        <table className="mb-4 w-full text-2xs">
          <tbody>
            <tr>
              <td className="py-0.5">
                <span className="text-slate-500">Fund: </span>
                <span className="font-semibold">{fundLabel(fundCode)}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Report No.: </span>
                <span className="font-mono font-semibold">{rcd.rcdNo}</span>
              </td>
            </tr>
            <tr>
              <td className="py-0.5">
                <span className="text-slate-500">Name of Accountable Officer: </span>
                <span className="font-semibold">{rcd.collectingOfficerName}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Date: </span>
                <span className="font-semibold">{formatShortDate(rcd.rcdDate)}</span>
                {rcd.primaryReportNo && (
                  <span className="ml-3 text-slate-500">
                    Gathered into primary{' '}
                    <span className="font-mono font-semibold">{rcd.primaryReportNo}</span>
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>

        {/* --- A. COLLECTIONS -------------------------------------------- */}
        <SectionTitle>A. Collections</SectionTitle>
        <p className="mb-1 text-2xs font-semibold">1. For Collectors</p>
        <table className="mb-4 w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left">Type (Form No.)</th>
              <th className="border border-slate-400 px-1.5 py-1 text-center" colSpan={2}>
                Official Receipt / Serial No.
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '8rem' }}>
                Amount
              </th>
            </tr>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-0.5" />
              <th className="border border-slate-400 px-1.5 py-0.5">From</th>
              <th className="border border-slate-400 px-1.5 py-0.5">To</th>
              <th className="border border-slate-400 px-1.5 py-0.5" />
            </tr>
          </thead>
          <tbody>
            {a1Rows.map((r, i) => (
              <tr key={`${r.form}-${r.range.from}-${i}`}>
                <td className="border border-slate-400 px-1.5 py-1">{r.first ? r.form : ''}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{r.range.from}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{r.range.to}</td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(r.amount, false)}
                </td>
              </tr>
            ))}
            {blankRows(BLANK_ROWS.a1 - a1Rows.length, 4, 'a1')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={3}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(totalCollections, false)}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="mb-1 text-2xs font-semibold">2. For Liquidating Officers / Treasurers</p>
        <table className="mb-4 w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left">
                Name of Accountable Officer
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '9rem' }}>
                Report No.
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '8rem' }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {blankRows(BLANK_ROWS.a2, 3, 'a2')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(0, false)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* --- B. REMITTANCES / DEPOSITS --------------------------------- */}
        <SectionTitle>B. Remittances / Deposits</SectionTitle>
        <table className="mb-4 w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left">
                Accountable Officer / Bank
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '12rem' }}>
                Reference
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '8rem' }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {coveredDeposits.map((d) => (
              <tr key={d.id}>
                <td className="border border-slate-400 px-1.5 py-1">{d.bankName ?? ''}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">
                  {d.depositSlipNo ?? ''}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(d.amount, false)}
                </td>
              </tr>
            ))}
            {blankRows(BLANK_ROWS.b - coveredDeposits.length, 3, 'b')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(totalDeposits, false)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* --- C. ACCOUNTABILITY ----------------------------------------- */}
        <SectionTitle>C. Accountability for Accountable Forms</SectionTitle>
        <table className="mb-4 w-full border-collapse text-[9px]">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1 py-1 text-left" rowSpan={2}>
                Name of Form &amp; No.
              </th>
              {['Beginning Balance', 'Receipt', 'Issued', 'Ending Balance'].map((h) => (
                <th key={h} className="border border-slate-400 px-1 py-1 text-center" colSpan={3}>
                  {h}
                </th>
              ))}
            </tr>
            <tr className="bg-slate-100">
              {[0, 1, 2, 3].map((i) => (
                <Fragment key={i}>
                  <th className="border border-slate-400 px-1 py-0.5">Qty.</th>
                  <th className="border border-slate-400 px-1 py-0.5">From</th>
                  <th className="border border-slate-400 px-1 py-0.5">To</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {accountabilityLines.map((l) => (
              <tr key={l.printed}>
                <td className="border border-slate-400 px-1 py-1">{l.printed}</td>
                {[l.acc.beginning, l.acc.receipt, l.acc.issued, l.acc.ending].map((section, i) => (
                  <Fragment key={i}>
                    <td className="border border-slate-400 px-1 py-1 text-right">
                      {section.qty || ''}
                    </td>
                    <td className="border border-slate-400 px-1 py-1 font-mono">
                      {section.ranges[0]?.from ?? ''}
                    </td>
                    <td className="border border-slate-400 px-1 py-1 font-mono">
                      {section.ranges[section.ranges.length - 1]?.to ?? ''}
                    </td>
                  </Fragment>
                ))}
              </tr>
            ))}
            {blankRows(BLANK_ROWS.c - accountabilityLines.length, 13, 'c')}
          </tbody>
        </table>

        {accountabilityLines.some((l) => l.acc.discrepancy) && (
          <Alert tone="error" title="Section C does not foot" className="mb-4 no-print">
            {accountabilityLines.find((l) => l.acc.discrepancy)?.acc.discrepancy} Record the issue
            under <strong>Treasury &rsaquo; Accountable Forms</strong> before this report is signed.
          </Alert>
        )}

        {/* --- D. SUMMARY ------------------------------------------------ */}
        <SectionTitle>D. Summary of Collections and Remittances / Deposits</SectionTitle>
        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          <table className="w-full border-collapse text-2xs">
            <tbody>
              <SummaryLine label="Beginning Balance" value={0} />
              <tr>
                <td className="border border-slate-400 px-1.5 py-1 font-semibold" colSpan={2}>
                  Add: Collections
                </td>
              </tr>
              <SummaryLine label="Cash" value={tender.cash} indent />
              <SummaryLine label="Online Payment" value={tender.online} indent />
              <SummaryLine label="Check/s" value={tender.check} indent />
              <SummaryLine label="Total" value={totalCollections} bold />
              <SummaryLine label="Less: Remittance / Deposit to Depository Bank" value={totalDeposits} />
              <SummaryLine label="Balance" value={balance} bold double />
            </tbody>
          </table>

          <table className="w-full border-collapse text-2xs">
            <thead>
              <tr className="bg-slate-100">
                <th className="border border-slate-400 px-1.5 py-1 text-left" colSpan={3}>
                  List of Checks
                </th>
              </tr>
              <tr className="bg-slate-100">
                <th className="border border-slate-400 px-1.5 py-0.5 text-left">Check No.</th>
                <th className="border border-slate-400 px-1.5 py-0.5 text-left">Payor</th>
                <th className="border border-slate-400 px-1.5 py-0.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td className="border border-slate-400 px-1.5 py-1 font-mono">{c.checkNo ?? ''}</td>
                  <td className="border border-slate-400 px-1.5 py-1">{c.payorName}</td>
                  <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                    {formatAmount(c.totalAmount, false)}
                  </td>
                </tr>
              ))}
              {blankRows(BLANK_ROWS.checks - checks.length, 3, 'ck')}
              <tr className="font-bold">
                <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                  Total
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(tender.check, false)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mb-4 text-[9px] italic text-slate-500">
          NOTE: Use additional sheet if necessary.
        </p>

        {/* --- Certification --------------------------------------------- */}
        <div className="mb-4 grid gap-6 border border-slate-400 p-3 sm:grid-cols-2">
          <div>
            <p className="text-2xs font-semibold uppercase">Certification</p>
            <p className="mt-1 text-2xs leading-relaxed">
              I hereby certify that the foregoing report of collections and deposits, and
              accountability for accountable forms is true and correct.
            </p>
            <p className="mt-8 border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
              {rcd.collectingOfficerName}
            </p>
            <p className="text-center text-[9px] text-slate-500">Accountable Officer</p>
          </div>
          <div>
            <p className="text-2xs font-semibold uppercase">Verification and Acknowledgment</p>
            <p className="mt-1 text-2xs leading-relaxed">
              I hereby certify that the foregoing report of collections has been verified and
              acknowledge receipt of{' '}
              <span className="font-semibold">{amountInWords(totalCollections)}</span>
            </p>
            <p className="mt-8 border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
              &nbsp;
            </p>
            <p className="text-center text-[9px] text-slate-500">Municipal Treasurer</p>
          </div>
        </div>

        {/* --- E. ACCOUNTING ENTRIES -------------------------------------- */}
        <SectionTitle>E. Accounting Entries</SectionTitle>
        <table className="mb-6 w-full border-collapse text-2xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1.5 py-1 text-left">Particulars</th>
              <th className="border border-slate-400 px-1.5 py-1 text-left" style={{ width: '10rem' }}>
                Account
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '7rem' }}>
                Debit
              </th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '7rem' }}>
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {/*
              Read from the chart, not written out beside a hardcoded code.

              This row used to print "Cash - Collecting Officers" against
              account 10101020. 10101020 is PETTY CASH in Candoni's chart, and
              the entry the RCD actually posts debits 10101010, Cash Local
              Treasury. So the printed form and the books named different
              accounts for the same collection - the printout being display
              only is why nobody caught it, and is no defence: an auditor
              lining the two up would have found a difference that does not
              exist.

              This is the fourth appearance of one mistake. The other three are
              in patches 79 and 81, and the build check that came out of them -
              a code read from a record never carries a written-out title -
              does not reach this one, because here the CODE was written out
              too. Both now come from the same constant, so they cannot
              disagree.
            */}
            <tr>
              <td className="border border-slate-400 px-1.5 py-1">{CASH_LOCAL_TREASURY.name}</td>
              <td className="border border-slate-400 px-1.5 py-1 font-mono">
                {CASH_LOCAL_TREASURY.code}
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(totalCollections, false)}
              </td>
              <td className="border border-slate-400 px-1.5 py-1" />
            </tr>
            {rcd.accountSummary.map((s) => (
              <tr key={s.accountCode}>
                <td className="border border-slate-400 px-1.5 py-1 pl-5">{s.accountName}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{s.accountCode}</td>
                <td className="border border-slate-400 px-1.5 py-1" />
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(s.amount, false)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid gap-8 sm:grid-cols-3">
          <SignatureLine label="Encoded by" />
          <SignatureLine label="Prepared by" />
          <SignatureLine label="Certified Correct" role="Municipal Accountant" />
        </div>
      </div>
    </div>
  );
}

