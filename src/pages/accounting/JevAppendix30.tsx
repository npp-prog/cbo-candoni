import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatAmount, amountInWords } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { hasJevNumber } from '@/lib/jevNumbers';
import { Letterhead, SignatureLine, blankRows } from '@/components/print/formParts';
import type { JournalEntryVoucher } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';

/**
 * The Journal Entry Voucher as the GAM prints it - Appendix 30.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE SCREEN FROM THE ENTRY ITSELF
 * ---------------------------------------------------------------------------
 * Same reasoning as the Report of Collections and Deposits at Appendix 34. The
 * entry screen is how Accounting works: tabs, a grid with pickers, the audit
 * history, the buttons that post and correct. This is the sheet of paper that
 * goes into the voucher file and to COA, and its shape is not ours to choose.
 *
 * Nothing on it can be typed. Every figure is read from the posted entry, so a
 * printed voucher and the General Ledger cannot disagree - which is the only
 * reason a printout is worth anything to an auditor.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ON THE FORM AND WHY
 * ---------------------------------------------------------------------------
 * ENTITY NAME and FUND CLUSTER head the form. The fund matters more here than
 * anywhere: the General Fund, the SEF and the Trust Fund keep separate books,
 * and a JEV printed without naming its fund could be filed against any of them.
 *
 * PARTICULARS, REFERENCE, ACCOUNT CODE, DEBIT, CREDIT are the five columns. The
 * reference column carries the document the entry came from - DV 100-26-09-0012,
 * RCI 2026-09-0004 - because that is what somebody pulling the voucher file
 * needs in order to find the paper behind the figure.
 *
 * RULED BLANK ROWS below the entry. Not decoration: a form padded to its full
 * height tells a reader the sheet is complete, where one that simply stops
 * leaves them wondering whether a page was lost.
 *
 * THE AMOUNT IN WORDS, under the total, for the same reason every COA money
 * form carries it - a figure can be altered by one stroke and a sentence cannot.
 *
 * THREE SIGNATURE BLOCKS, filled from the entry's own audit stamps rather than
 * left blank: whoever CFMS recorded as having prepared, reviewed and posted it
 * is who the form names. A name typed onto a printed form by hand is a name
 * nothing in the system stands behind.
 *
 * ---------------------------------------------------------------------------
 * ONE THING TO SETTLE WITH THE OFFICE
 * ---------------------------------------------------------------------------
 * The GAM appendix index the municipality supplied (`data/gam-appendix-index.csv`)
 * calls Appendix 30 the JOURNAL VOUCHER (JV). Every screen in CFMS, and the
 * office in conversation, calls it the Journal Entry Voucher. The heading below
 * follows the office. If COA wants the appendix's own wording it is one word on
 * one line.
 */

/** Minimum ruled rows, so a two-line entry still fills the sheet. */
const BLANK_ROWS = 12;

export default function JevAppendix30() {
  const { id } = useParams<{ id: string }>();
  const { data: jev, loading } = useDocument<JournalEntryVoucher>(COL.jevs, id);

  const lines = useMemo(() => [...(jev?.lines ?? [])].sort((a, b) => a.lineNo - b.lineNo), [jev]);

  const totals = useMemo(
    () =>
      lines.reduce(
        (acc, l) => ({ debit: acc.debit + (l.debit ?? 0), credit: acc.credit + (l.credit ?? 0) }),
        { debit: 0, credit: 0 },
      ),
    [lines],
  );

  if (loading) return <Spinner label="Loading journal entry" />;

  if (!jev) {
    return (
      <Alert tone="error" title="Journal entry not found">
        <Link to="/accounting/journal-entries" className="underline">
          Back to the Journal Entries Register
        </Link>
      </Alert>
    );
  }

  const reference = jev.referenceNo ?? '';

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title={hasJevNumber(jev.jevNo) ? `JEV ${jev.jevNo}` : 'Journal entry (unnumbered)'}
          subtitle="Appendix 30 - the form as COA prints it"
          breadcrumbs={[
            { label: 'Accounting' },
            { label: 'Journal entries', to: '/accounting/journal-entries' },
            { label: 'Print' },
          ]}
          actions={
            <>
              <Link to={`/accounting/jev/${jev.id}`}>
                <Button variant="secondary">Back to the entry</Button>
              </Link>
              <Button variant="primary" onClick={() => window.print()}>
                Print
              </Button>
            </>
          }
        />

        {!hasJevNumber(jev.jevNo) && (
          <Alert tone="warning" title="This entry has no number yet" className="mb-4">
            The Journal Entry Voucher number is drawn when the entry is posted. Printing it before
            then produces a form with a blank number, which is not a document anybody can file.
          </Alert>
        )}

        {jev.status !== 'POSTED' && (
          <Alert tone="warning" title={`This entry is ${jev.status.toLowerCase()}`} className="mb-4">
            Only a posted entry is in the books. A printed voucher for one that is not says the
            municipality recorded something it has not recorded.
          </Alert>
        )}

        {(jev.signedTotal ?? null) !== null && (
          <Alert tone="error" title="This entry does not agree with its document" className="mb-4">
            The form below prints what the General Ledger carries. The document behind it was
            signed for a different amount - see the entry itself.
          </Alert>
        )}
      </div>

      {/* --- the form ------------------------------------------------------- */}
      <div className="mx-auto max-w-[8.5in] bg-white p-6 text-[11px] text-navy-900 ring-1 ring-slate-200 print:p-0 print:ring-0">
        <Letterhead
          appendix="Appendix 30"
          title="Journal Entry Voucher"
          office="Office of the Municipal Accountant"
        />

        <table className="mb-2 w-full border-collapse">
          <tbody>
            <tr>
              <td className="w-1/2 border border-slate-400 px-1.5 py-1">
                <span className="text-slate-500">Entity Name:</span>{' '}
                <span className="font-semibold">Municipality of Candoni</span>
              </td>
              <td className="border border-slate-400 px-1.5 py-1">
                <span className="text-slate-500">JEV No.:</span>{' '}
                <span className="font-mono font-semibold">
                  {hasJevNumber(jev.jevNo) ? jev.jevNo : ''}
                </span>
              </td>
            </tr>
            <tr>
              <td className="border border-slate-400 px-1.5 py-1">
                <span className="text-slate-500">Fund Cluster:</span>{' '}
                <span className="font-semibold">{fundLabel(jev.fundCode)}</span>
              </td>
              <td className="border border-slate-400 px-1.5 py-1">
                <span className="text-slate-500">Date:</span>{' '}
                <span className="font-semibold">{formatShortDate(jev.jevDate)}</span>
              </td>
            </tr>
          </tbody>
        </table>

        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="border border-slate-400 px-1.5 py-1 text-left">Particulars</th>
              <th className="w-24 border border-slate-400 px-1.5 py-1 text-left">Ref.</th>
              <th className="w-24 border border-slate-400 px-1.5 py-1 text-left">Account Code</th>
              <th className="w-28 border border-slate-400 px-1.5 py-1 text-right">Debit</th>
              <th className="w-28 border border-slate-400 px-1.5 py-1 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {/*
              The entry's own particulars head the body, as on the paper form:
              the lines below say which accounts moved, and this says what the
              transaction WAS. Printing only the per-line text would leave a
              voucher whose every line reads "Fuel and oil" and nothing saying
              for which vehicle in which month.
            */}
            <tr>
              <td className="border border-slate-400 px-1.5 py-1 font-semibold" colSpan={3}>
                {jev.particulars}
              </td>
              <td className="border border-slate-400 px-1.5 py-1" />
              <td className="border border-slate-400 px-1.5 py-1" />
            </tr>

            {lines.map((line) => (
              <tr key={line.lineNo}>
                <td className="border border-slate-400 px-1.5 py-1">
                  {/* A credit is indented under the debits it answers, the way
                      a journal entry is written by hand. */}
                  <span className={line.credit > 0 ? 'pl-6' : undefined}>{line.accountName}</span>
                  {line.subsidiaryName && (
                    <span className="block pl-6 text-[9px] text-slate-500">
                      {line.subsidiaryName}
                    </span>
                  )}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono text-[10px]">
                  {reference}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 font-mono text-[10px]">
                  {line.accountCode}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {line.debit > 0 ? formatAmount(line.debit, false) : ''}
                </td>
                <td className="border border-slate-400 px-1.5 py-1 text-right tabular-nums">
                  {line.credit > 0 ? formatAmount(line.credit, false) : ''}
                </td>
              </tr>
            ))}

            {blankRows(BLANK_ROWS - lines.length, 5, 'jev')}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td className="border border-slate-400 px-1.5 py-1 text-right" colSpan={3}>
                TOTAL
              </td>
              <td className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(totals.debit, false)}
              </td>
              <td className="border border-b-4 border-double border-slate-400 px-1.5 py-1 text-right tabular-nums">
                {formatAmount(totals.credit, false)}
              </td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-2 border border-slate-400 px-1.5 py-1">
          <span className="text-slate-500">Amount in words:</span>{' '}
          <span className="font-semibold">{amountInWords(totals.debit)}</span>
        </p>

        <div className="mt-6 grid grid-cols-3 gap-6">
          <SignatureLine
            label="Prepared by:"
            name={jev.createdBy?.name}
            role={jev.createdBy?.position ?? 'Accounting Staff'}
          />
          <SignatureLine
            label="Certified Correct by:"
            name={jev.reviewedBy?.name ?? jev.approvedBy?.name}
            role={(jev.reviewedBy ?? jev.approvedBy)?.position ?? 'Accounting Reviewer'}
          />
          <SignatureLine
            label="Approved by:"
            name={jev.postedBy?.name}
            role={jev.postedBy?.position ?? 'Municipal Accountant'}
          />
        </div>
      </div>
    </div>
  );
}
