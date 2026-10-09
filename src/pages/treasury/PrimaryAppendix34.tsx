import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import {
  Letterhead,
  SectionTitle,
  SignatureLine,
  SummaryLine,
  blankRows,
} from '@/components/print/formParts';
import { useFilters } from '@/context/FilterContext';
import { usePrimaryReports, useRcds } from '@/data/queries';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { PRIMARY_REPORT_TYPE_LABELS, reconcileDeposit } from '@/types/primaryReports';
import { useEntity } from '@/data/useEntity';
import { fundLabel } from '../budget/Obligations';

/**
 * The Liquidating Officer's Appendix 34.
 *
 * ---------------------------------------------------------------------------
 * WHY SECTIONS A.1 AND C ARE BLANK HERE
 * ---------------------------------------------------------------------------
 * It is the same sheet of paper as the collector's, and on the collector's
 * copy A.1 lists the receipts they wrote and C accounts for the booklets they
 * hold. The Liquidating Officer wrote no receipts and holds no booklets - they
 * received remittances from people who did. So on their copy those two
 * sections are ruled and empty, and the collectors appear instead in A.2, one
 * line each, with the report number they filed.
 *
 * That is how the paper form works, and reproducing it faithfully matters more
 * than filling every box: an auditor reading A.1 on a Liquidating Officer's
 * report and finding receipts listed there would have a question, not a
 * convenience.
 * ---------------------------------------------------------------------------
 */

const BLANK_ROWS = { a1: 6, a2: 8, b: 3, c: 4 };

export default function PrimaryAppendix34() {
  const entity = useEntity();
  const { id } = useParams<{ id: string }>();
  const { fiscalYear, fundCode } = useFilters();

  const { data: primaries, loading } = usePrimaryReports(fiscalYear, fundCode);
  const { data: rcds } = useRcds(fiscalYear, fundCode);

  const primary = primaries.find((p) => p.id === id);
  const isDeposit = primary?.reportType === 'DEPOSIT';

  const secondaries = useMemo(
    () => (primary ? rcds.filter((r) => primary.rcdIds.includes(r.id)) : []),
    [primary, rcds],
  );

  const coveredPrimaries = useMemo(
    () => (primary ? primaries.filter((p) => primary.coveredPrimaryIds.includes(p.id)) : []),
    [primary, primaries],
  );

  const coveredTotal = coveredPrimaries.reduce((s, p) => s + p.totalAmount, 0);
  const recon = primary?.deposit
    ? reconcileDeposit(primary.deposit.total, coveredTotal)
    : null;

  if (loading) return <Spinner label="Reading the report" />;

  if (!primary) {
    return (
      <Alert tone="warning" title="That report is not in this fund and year">
        Check the fiscal year and fund in the header, then open it again from{' '}
        <Link className="underline" to="/treasury/collections/primary">
          the primary report register
        </Link>
        .
      </Alert>
    );
  }

  const depositRows = primary.deposit
    ? [
        ...(primary.deposit.cash > 0
          ? [{ who: `${primary.deposit.bankName} — cash`, ref: primary.deposit.bankAccountNumber, amount: primary.deposit.cash }]
          : []),
        ...primary.deposit.checks.map((c) => ({
          who: `${primary.deposit!.bankName} — check`,
          ref: `${c.checkNo}${c.payor ? ` / ${c.payor}` : ''}`,
          amount: c.amount,
        })),
        ...primary.deposit.online.map((o) => ({
          who: `${primary.deposit!.bankName} — online`,
          ref: `${o.referenceNo}${o.particulars ? ` / ${o.particulars}` : ''}`,
          amount: o.amount,
        })),
      ]
    : [];

  const collectionsTotal = isDeposit ? 0 : primary.totalAmount;
  const depositTotal = primary.deposit?.total ?? 0;

  return (
    <div>
      <PageHeader
        title={primary.primaryNo ? `Primary ${primary.primaryNo}` : 'Primary report (open)'}
        subtitle={PRIMARY_REPORT_TYPE_LABELS[primary.reportType]}
        breadcrumbs={[
          { label: 'Treasury', to: '/treasury' },
          { label: 'Primary Reports', to: '/treasury/collections/primary' },
          { label: primary.primaryNo ?? 'Open' },
        ]}
        actions={
          <Button variant="primary" onClick={() => window.print()}>
            Print
          </Button>
        }
      />

      {primary.status === 'OPEN' && (
        <Alert tone="warning" title="This report is still open" className="mb-4 no-print">
          It has no number yet and what it covers can still change. Close it before it is signed or
          transmitted.
        </Alert>
      )}

      {recon && recon.verdict !== 'RECONCILED' && recon.verdict !== 'EMPTY' && (
        <Alert tone="warning" title={`The deposit is ${recon.verdict.toLowerCase()}`} className="mb-4 no-print">
          {recon.message}
        </Alert>
      )}

      <div className="cbo-card px-6 py-6 text-xs print:border-0 print:px-0 print:py-0">
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
                <span className="font-mono font-semibold">{primary.primaryNo ?? '—'}</span>
              </td>
            </tr>
            <tr>
              <td className="py-0.5">
                <span className="text-slate-500">Name of Accountable Officer: </span>
                <span className="font-semibold">{primary.accountableOfficerName}</span>
              </td>
              <td className="py-0.5">
                <span className="text-slate-500">Date: </span>
                <span className="font-semibold">{formatShortDate(primary.reportDate)}</span>
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
          </thead>
          <tbody>
            {blankRows(BLANK_ROWS.a1, 4, 'a1')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={3}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(0, false)}
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
            {secondaries.map((r) => (
              <tr key={r.id}>
                <td className="border border-slate-400 px-1.5 py-1">{r.collectingOfficerName}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono">{r.rcdNo}</td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(r.totalCollections, false)}
                </td>
              </tr>
            ))}
            {blankRows(BLANK_ROWS.a2 - secondaries.length, 3, 'a2')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(collectionsTotal, false)}
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
              <th className="border border-slate-400 px-1.5 py-1 text-left">Reference</th>
              <th className="border border-slate-400 px-1.5 py-1 text-right" style={{ width: '8rem' }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {depositRows.map((d, i) => (
              <tr key={`${d.ref}-${i}`}>
                <td className="border border-slate-400 px-1.5 py-1">{d.who}</td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono text-[9px]">
                  {d.ref}
                  {i === 0 && coveredPrimaries.length > 0 && (
                    <span className="block text-slate-500">
                      Covering {coveredPrimaries.map((p) => p.primaryNo).join(', ')}
                    </span>
                  )}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {formatAmount(d.amount, false)}
                </td>
              </tr>
            ))}
            {blankRows(BLANK_ROWS.b - depositRows.length, 3, 'b')}
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={2}>
                TOTAL
              </td>
              <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(depositTotal, false)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* --- C. ACCOUNTABILITY ----------------------------------------- */}
        <SectionTitle>C. Accountability for Accountable Forms</SectionTitle>
        <table className="mb-1 w-full border-collapse text-[9px]">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-1 py-1 text-left">Name of Form &amp; No.</th>
              {['Beginning Balance', 'Receipt', 'Issued', 'Ending Balance'].map((h) => (
                <th key={h} className="border border-slate-400 px-1 py-1 text-center" colSpan={3}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{blankRows(BLANK_ROWS.c, 13, 'c')}</tbody>
        </table>
        <p className="mb-4 text-[9px] italic text-slate-500">
          Accountability for accountable forms is reported by the collecting officers on their own
          reports.
        </p>

        {/* --- D. SUMMARY ------------------------------------------------ */}
        <SectionTitle>D. Summary of Collections and Remittances / Deposits</SectionTitle>
        <div className="mb-4 sm:w-1/2">
          <table className="w-full border-collapse text-2xs">
            <tbody>
              <SummaryLine label="Beginning Balance" value={0} />
              <SummaryLine label="Add: Collections received" value={collectionsTotal} />
              <SummaryLine label="Total" value={collectionsTotal} bold />
              <SummaryLine
                label="Less: Remittance / Deposit to Depository Bank"
                value={depositTotal}
              />
              <SummaryLine label="Balance" value={collectionsTotal - depositTotal} bold double />
            </tbody>
          </table>
        </div>

        {/* --- Certification --------------------------------------------- */}
        <div className="mb-4 grid gap-6 border border-slate-400 p-3 sm:grid-cols-2">
          <div>
            <p className="text-2xs font-semibold uppercase">Certification</p>
            <p className="mt-1 text-2xs leading-relaxed">
              I hereby certify that the foregoing report of collections and deposits is true and
              correct.
            </p>
            <p className="mt-8 border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
              {primary.accountableOfficerName}
            </p>
            <p className="text-center text-[9px] text-slate-500">
              {primary.accountableOfficerPosition ?? 'Accountable Officer'}
            </p>
          </div>
          <div>
            <p className="text-2xs font-semibold uppercase">Verification and Acknowledgment</p>
            <p className="mt-1 text-2xs leading-relaxed">
              I hereby certify that the foregoing report has been verified and acknowledge receipt
              of{' '}
              <span className="font-semibold">
                {amountInWords(isDeposit ? depositTotal : collectionsTotal)}
              </span>
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
          <tbody>{blankRows(3, 4, 'e')}</tbody>
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
