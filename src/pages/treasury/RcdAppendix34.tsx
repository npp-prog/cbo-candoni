import { Fragment, useMemo, type ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useFilters } from '@/context/FilterContext';
import {
  useCollections,
  useDeposits,
  useFormMovements,
  useRcds,
  useAccountableFormTypes,
  useTreasuryReports,
  useRemittances,
} from '@/data/queries';
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
  FormHeaderFields,
  Letterhead,
  SectionTitle,
  SignatureLine,
  SummaryLine,
  blankRows,
} from '@/components/print/formParts';
import { CASH_LOCAL_TREASURY } from '@/lib/chartOfAccounts';
import { officerHoldings } from '@/lib/formCustody';
import { useEntity } from '@/data/useEntity';
import { FormPrintStyle, isCertifiedCopy } from '@/components/print/FormPrintStyle';
import { FormBackButton } from './FormBackButton';
import type { TreasuryReport } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { usePrintTitle, printFileName } from '@/lib/printTitle';

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

/**
 * Patch 166: Collection, Remittance or Deposit - as chosen when the RCD was
 * prepared (patch 165), or read from what an older RCD carries.
 */
export function rcdKindLabel(report?: TreasuryReport | null): string {
  if (!report) return '';
  const k =
    report.rcdKind ??
    ((report.lines ?? []).length
      ? 'COLLECTION'
      : (report.remittances ?? []).length
        ? 'REMITTANCE'
        : (report.deposits ?? []).length
          ? 'DEPOSIT'
          : null);
  return k === 'COLLECTION'
    ? 'Collection'
    : k === 'REMITTANCE'
      ? 'Remittance'
      : k === 'DEPOSIT'
        ? 'Deposit'
        : '';
}

export default function RcdAppendix34({ report }: { report?: TreasuryReport }) {
  const entity = useEntity();
  const { id } = useParams<{ id: string }>();
  const { fiscalYear, fundCode } = useFilters();

  const { data: rcds, loading } = useRcds(fiscalYear, fundCode);
  const { data: collections } = useCollections(fiscalYear, fundCode);
  const { data: deposits } = useDeposits();
  /* Patch 159: this officer's earlier RCDs, for the Section D beginning balance. */
  const { data: rcdReports } = useTreasuryReports('RCD', fiscalYear, fundCode);
  /* Patch 161: remittances - received (A.2) and made (B). */
  const { data: remittances } = useRemittances(fiscalYear, fundCode);
  const received = report?.remittances ?? [];
  const totalReceived = received.reduce((t, r) => t + r.amount, 0);
  const made = useMemo(
    () =>
      report
        ? remittances.filter((m) => m.collectorReportId === report.id && m.status !== 'CANCELLED')
        : [],
    [remittances, report],
  );
  const totalMade = made.reduce((t, m) => t + m.amount, 0);
  /*
   * Patch 161: last year's movements too - a booklet issued in December is
   * still in the collector's hands in January, and Section C's beginning
   * balance must show it.
   */
  const { data: movementsNow } = useFormMovements(fiscalYear);
  const { data: movementsPrev } = useFormMovements(fiscalYear - 1);
  const movements = useMemo(
    () => [...movementsPrev, ...movementsNow],
    [movementsPrev, movementsNow],
  );
  const { data: formTypes } = useAccountableFormTypes();
  /* Patch 161: a form type by its code however it is written ("AF-51" = "AF51"). */
  const typeOf = (code: string) =>
    formTypes.find((t) => FORM_CODE({ accountableForm: t.code }) === code);

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
    /*
     * Patch 157: an RCD names its deposits itself (Section B) - they may bank
     * collections reported on an earlier RCD, and an RCD may carry deposits
     * only. One prepared before that names none; its deposits are found
     * through the receipts it covers, as before.
     */
    const named = new Set((report.deposits ?? []).map((d) => d.sourceId));
    const bankedIds = named.size
      ? named
      : new Set(covered.map((c) => c.depositId).filter(Boolean) as string[]);
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
      const size = typeOf(code)?.bookletSize ?? 50;
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
      // Patch 161: a receipt with no form recorded prints as such, not "-".
      const printed = code === '-' ? 'Form not recorded' : (typeOf(code)?.printedAs ?? code);
      group.ranges.forEach((range, i) => {
        // The amount is apportioned to the range by the receipts inside it, so
        // a booklet split does not put one booklet's money on the other's line.
        // The comparison has to be numeric: as text, "100" sorts below "99".
        const lo = toNumber(range.from);
        const hi = toNumber(range.to);
        const amount = covered
          .filter((c) => {
            // Patch 161: the same key the receipts were grouped by - a receipt
            // with no form is grouped under "-", and was then never matched
            // here, so its amount printed as 0.00 beside a correct total.
            if ((FORM_CODE(c) || '-') !== code) return false;
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
      // Patch 161: no form recorded - nothing to account for in Section C.
      if (code === '-') continue;
      const type = typeOf(code);
      const size = type?.bookletSize ?? 50;

      // What the officer had been issued, less what they had already used
      // before this report's date.
      // Patch 161: what the officer HOLDS by the report date - issued to them,
      // less anything returned, spoiled or cancelled (the RAAF's replay).
      const issuedToOfficer = officerHoldings(live, rcd.collectingOfficerId, code, rcd.rcdDate);

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
            FORM_CODE({ accountableForm: m.formCode }) === code &&
            m.custodianId === rcd.collectingOfficerId &&
            m.movementDate === rcd.rcdDate,
        )
        .map((m) => rangeFrom(m.serialFrom, m.serialTo))
        .filter((r): r is NumericRange => r !== null);

      // What they held when the day opened: everything ever issued to them,
      // less anything issued today, less every receipt already written.
      const beginning = subtract(subtract(issuedToOfficer, receiptedNow), usedBefore);
      const issuedNow = collapse(
        covered.filter((c) => FORM_CODE(c) === code).map((c) => c.orNumber),
      );

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
      else if (c.paymentForm === 'ONLINE' || c.paymentForm === 'CARD')
        split.online += c.totalAmount;
      else split.cash += c.totalAmount;
    }
    return split;
  }, [covered]);

  const checks = useMemo(() => covered.filter((c) => c.paymentForm === 'CHECK'), [covered]);

  /*
   * Patch 157 - the BEGINNING BALANCE of Section D: collections reported on
   * earlier RCDs not yet reported as deposited.
   *
   * Patch 159: PER ACCOUNTABLE OFFICER. The balance is what THIS officer
   * still holds: the collections on their earlier certified RCDs less the
   * deposits on them. Another officer's undeposited cash is not in this
   * officer's hands and is not on this report. An RCD with no officer named
   * (before patch 155) falls back to the fund, as before.
   */
  const beginning = useMemo(() => {
    if (!report?.reportNo) return 0;
    const no = report.reportNo;
    const officer = report.accountableOfficerId ?? null;
    if (officer) {
      const earlier = rcdReports.filter(
        (r) =>
          r.id !== report.id &&
          r.accountableOfficerId === officer &&
          (r.status === 'CERTIFIED' || r.status === 'JOURNALIZED') &&
          !!r.reportNo &&
          (r.reportDate < report.reportDate ||
            (r.reportDate === report.reportDate && r.reportNo < no)),
      );
      // Patch 161: what the officer took in (collections, remittances received)
      // less what left their hands (deposits, remittances made).
      const ids = new Set(earlier.map((r) => r.id));
      const collected = earlier.reduce(
        (t, r) => t + (r.totalAmount ?? 0) + (r.totalRemittances ?? 0),
        0,
      );
      const banked =
        earlier.reduce((t, r) => t + (r.totalDeposits ?? 0), 0) +
        remittances
          .filter(
            (m) => m.status !== 'CANCELLED' && m.collectorReportId && ids.has(m.collectorReportId),
          )
          .reduce((t, m) => t + m.amount, 0);
      return Math.max(0, collected - banked);
    }
    const earlier = (x: { treasuryReportType?: string; treasuryReportNo?: string }) =>
      x.treasuryReportType === 'RCD' && !!x.treasuryReportNo && x.treasuryReportNo < no;
    const reported = collections
      .filter((c) => c.status !== 'CANCELLED' && !c.eCollectionKind)
      .filter((c) => earlier(c as never))
      .reduce((t, c) => t + c.totalAmount, 0);
    const banked = deposits
      .filter((d) => d.status !== 'CANCELLED' && d.fundCode === report.fundCode)
      .filter((d) => earlier(d as never))
      .reduce((t, d) => t + d.amount, 0);
    return Math.max(0, reported - banked);
  }, [report, collections, deposits, rcdReports, remittances]);

  // Patch 156: saved to PDF as "Report of Collections and Deposits_<No.>".
  usePrintTitle(rcd ? printFileName('Report of Collections and Deposits', rcd.rcdNo) : null);

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
  const balance = beginning + totalCollections + totalReceived - totalDeposits - totalMade;

  /*
   * Patch 160: the ACCOUNTING ENTRIES are the report's own entry - the one
   * certified and journalized, with the deposits it books (patch 159). The
   * form read an `accountSummary` that only the old RCD record had; on every
   * RCD prepared as a treasury report it was missing and the whole form
   * failed to open (a blank page). The old record still prints its summary.
   */
  const reportEntry = (report?.entry ?? []) as Array<{
    accountCode: string;
    accountName: string;
    debit: number;
    credit: number;
    subsidiaryName?: string | null;
  }>;
  const legacySummary =
    (
      rcd as {
        accountSummary?: Array<{ accountCode: string; accountName: string; amount: number }>;
      }
    ).accountSummary ?? [];
  const entryRows = reportEntry.length
    ? reportEntry
    : [
        ...(totalCollections
          ? [
              {
                accountCode: CASH_LOCAL_TREASURY.code,
                accountName: CASH_LOCAL_TREASURY.name,
                debit: totalCollections,
                credit: 0,
                subsidiaryName: null,
              },
            ]
          : []),
        ...legacySummary.map((a) => ({
          accountCode: a.accountCode,
          accountName: a.accountName,
          debit: 0,
          credit: a.amount,
          subsidiaryName: null,
        })),
      ];

  const status = (rcd as { status?: string }).status;
  const certified = isCertifiedCopy(status);

  return (
    <div>
      {/* Patch 161: the RCD on A4 PORTRAIT, the seal centred above the heading. */}
      <FormPrintStyle orientation="portrait" />

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
        <Letterhead
          appendix="Appendix 34"
          title="Report of Collections and Deposits"
          lines={entity.headingLines}
          seal="center"
        />

        {/* Patch 161: Report No., Sheet No. and Date at the far right, aligned. */}
        <FormHeaderFields
          left={[
            ['Fund:', fundLabel(fundCode)],
            ['Name of Accountable Officer:', rcd.collectingOfficerName],
            // Patch 166: what the RCD is for - Collection, Remittance or Deposit.
            ...(rcdKindLabel(report)
              ? [
                  [
                    'RCD for:',
                    <span className="font-semibold uppercase">{rcdKindLabel(report)}</span>,
                  ] as [string, ReactNode],
                ]
              : []),
          ]}
          right={[
            ['Report No.:', <span className="font-mono">{rcd.rcdNo}</span>],
            ['Sheet No.:', '1 of 1'],
            ['Date:', formatShortDate(rcd.rcdDate)],
          ]}
        />

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
              <th
                className="border border-slate-400 px-1.5 py-1 text-right"
                style={{ width: '8rem' }}
              >
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
              <th
                className="border border-slate-400 px-1.5 py-1 text-left"
                style={{ width: '9rem' }}
              >
                Report No.
              </th>
              <th
                className="border border-slate-400 px-1.5 py-1 text-right"
                style={{ width: '8rem' }}
              >
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Patch 161: the collectors' remittances this officer received. */}
            {received.map((r) => (
              <tr key={r.sourceId}>
                <td className="border border-slate-400 px-1.5 py-1">{r.collectorName}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">
                  {r.collectorReportNo ?? ''}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(r.amount, false)}
                </td>
              </tr>
            ))}
            {blankRows(BLANK_ROWS.a2 - received.length, 3, 'a2')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(totalReceived, false)}
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
              <th
                className="border border-slate-400 px-1.5 py-1 text-left"
                style={{ width: '12rem' }}
              >
                Reference
              </th>
              <th
                className="border border-slate-400 px-1.5 py-1 text-right"
                style={{ width: '8rem' }}
              >
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
            {/* Patch 161: what this collector remitted to the Liquidating Officer. */}
            {made.map((m) => (
              <tr key={m.id}>
                <td className="border border-slate-400 px-1.5 py-1">
                  {m.liquidatingOfficerName} (Liquidating Officer)
                </td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">
                  {m.referenceNo ?? formatShortDate(m.remittanceDate)}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(m.amount, false)}
                </td>
              </tr>
            ))}
            {blankRows(BLANK_ROWS.b - coveredDeposits.length - made.length, 3, 'b')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(totalDeposits + totalMade, false)}
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
              <SummaryLine label="Beginning Balance" value={beginning} />
              <tr>
                <td className="border border-slate-400 px-1.5 py-1 font-semibold" colSpan={2}>
                  Add: Collections
                </td>
              </tr>
              <SummaryLine label="Cash" value={tender.cash} indent />
              <SummaryLine label="Online Payment" value={tender.online} indent />
              <SummaryLine label="Check/s" value={tender.check} indent />
              {totalReceived > 0 && (
                <SummaryLine label="Remittances received (A.2)" value={totalReceived} indent />
              )}
              <SummaryLine label="Total" value={totalCollections + totalReceived} bold />
              <SummaryLine
                label="Less: Remittance / Deposit to Depository Bank"
                value={totalDeposits + totalMade}
              />
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
                  <td className="border border-slate-400 px-1.5 py-1 font-mono">
                    {c.checkNo ?? ''}
                  </td>
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
              <th
                className="border border-slate-400 px-1.5 py-1 text-left"
                style={{ width: '10rem' }}
              >
                Account
              </th>
              <th
                className="border border-slate-400 px-1.5 py-1 text-right"
                style={{ width: '7rem' }}
              >
                Debit
              </th>
              <th
                className="border border-slate-400 px-1.5 py-1 text-right"
                style={{ width: '7rem' }}
              >
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
            {entryRows.map((s, i) => (
              <tr key={`${s.accountCode}-${i}`}>
                <td className={`border border-slate-400 px-1.5 py-1 ${s.credit ? 'pl-5' : ''}`}>
                  {s.accountName}
                  {s.subsidiaryName ? (
                    <span className="text-slate-500"> - {s.subsidiaryName}</span>
                  ) : null}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{s.accountCode}</td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {s.debit ? formatAmount(s.debit, false) : ''}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {s.credit ? formatAmount(s.credit, false) : ''}
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
