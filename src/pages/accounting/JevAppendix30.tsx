import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { hasJevNumber } from '@/lib/jevNumbers';
import { Letterhead, SignatureLine, blankRows } from '@/components/print/formParts';
import type { JournalEntryVoucher } from '@/types/accounting';
import { useEntity } from '@/data/useEntity';
import { fundLabel } from '../budget/Obligations';
import { usePrintTitle, printFileName } from '@/lib/printTitle';

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
 * IT IS THE JOURNAL VOUCHER, AND THAT IS SETTLED
 * ---------------------------------------------------------------------------
 * CFMS calls this entry a JEV everywhere, and so does the office in
 * conversation, so patch 84 printed "JOURNAL ENTRY VOUCHER" on the form and
 * left the question open.
 *
 * The municipality's own Appendix 30 - sheet A30-JEV of `Appendix_Forms.xlsx`,
 * already carrying Candoni's name - is headed JOURNAL VOUCHER, and its number
 * box is JV No. The appendix index said the same and I did not follow it. The
 * printed form follows the form now; the screens go on saying JEV, which is
 * what the office says and what every other part of CFMS is built around.
 */

/** Minimum ruled rows, so a two-line entry still fills the sheet. */
const BLANK_ROWS = 12;

export default function JevAppendix30() {
  const { id } = useParams<{ id: string }>();
  const { data: jev, loading } = useDocument<JournalEntryVoucher>(COL.jevs, id);
  const entity = useEntity();
  // Patch 156: saved to PDF as "Journal Voucher_<JV No.>".
  usePrintTitle(jev ? printFileName('Journal Voucher', hasJevNumber(jev.jevNo) ? jev.jevNo : 'unnumbered') : null);

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
          title={hasJevNumber(jev.jevNo) ? `JV ${jev.jevNo}` : "Journal voucher (unnumbered)"}
          subtitle="The form as COA prints it"
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
          title="Journal Voucher"
          lines={entity.headingLines}
          seal="center"
        />

        {/*
          ------------------------------------------------------------------
          THE FORM AS THE MUNICIPALITY'S OWN APPENDIX 30 PRINTS IT
          ------------------------------------------------------------------
          Rebuilt in patch 89 against `Appendix_Forms.xlsx`, sheet A30-JEV -
          the workbook already carrying Candoni's name. What CFMS printed
          before was built from the field set and was wrong in four places:

            * the heading said JOURNAL ENTRY VOUCHER. The form says JOURNAL
              VOUCHER, and the number is JV No., not JEV No. The appendix
              index said so and I kept the office's spoken name instead.
            * it carried Entity Name and Fund Cluster boxes. The form has
              Fund and JV No. on one line and Date under them; the entity is
              the letterhead.
            * the first column was Particulars. On the form it is FPP - the
              budget line - and the account column is headed "Accounts and
              Explanation".
            * it had three signature blocks. The form has two: Prepared by,
              and Certified Correct.

          There is also a narrow "P" column between the account code and the
          amounts. It is the posting reference, ticked by hand when the entry
          is written into the ledger, and it stays blank here deliberately:
          CFMS posts to the ledger itself, and printing a tick would assert
          somebody had done the manual step.
        */}
        {/*
          Patch 152: Fund and Date at the left; JV No. at the far right, its
          label and value in their own columns so the number lines up.
        */}
        <div className="mb-2 flex items-start justify-between gap-6">
          <table style={{ width: 'auto' }}>
            <tbody>
              <tr>
                <td className="py-0.5 text-slate-500" style={{ paddingRight: '0.5rem' }}>
                  Fund:
                </td>
                <td className="py-0.5 font-semibold">{fundLabel(jev.fundCode)}</td>
              </tr>
              <tr>
                <td className="py-0.5 text-slate-500" style={{ paddingRight: '0.5rem' }}>
                  Date:
                </td>
                <td className="py-0.5 font-semibold">{formatShortDate(jev.jevDate)}</td>
              </tr>
            </tbody>
          </table>
          <table className="shrink-0" style={{ width: 'auto' }}>
            <tbody>
              <tr>
                <td className="py-0.5 text-slate-500" style={{ paddingRight: '0.5rem' }}>
                  JV No.:
                </td>
                <td className="py-0.5 font-mono font-semibold">
                  {hasJevNumber(jev.jevNo) ? jev.jevNo : ''}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="w-20 border border-slate-400 px-1.5 py-1 text-left" rowSpan={2}>
                FPP
              </th>
              <th
                className="border border-slate-400 px-1.5 py-1 text-center"
                colSpan={4}
              >
                ACCOUNTING ENTRIES
              </th>
            </tr>
            <tr>
              <th className="border border-slate-400 px-1.5 py-1 text-left">
                Accounts and Explanation
              </th>
              <th className="w-24 border border-slate-400 px-1.5 py-1 text-left">Account Code</th>
              <th className="w-28 border border-slate-400 px-1.5 py-1 text-right">Debit</th>
              <th className="w-28 border border-slate-400 px-1.5 py-1 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.lineNo}>
                <td className="border border-slate-400 px-1.5 py-1 font-mono text-[10px]">
                  {line.fppCode ?? ''}
                </td>
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

            {/*
              "Explanation" is the other half of that column's heading. The
              entry's own particulars go under the accounts, where a hand-
              written voucher puts them - the lines above say which accounts
              moved, this says what the transaction was.
            */}
            <tr>
              <td className="border border-slate-400 px-1.5 py-1" />
              <td className="border border-slate-400 px-1.5 py-1 italic" colSpan={4}>
                {jev.particulars}
                {reference && (
                  <span className="not-italic text-slate-500"> ({reference})</span>
                )}
              </td>
            </tr>

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

        <div className="mt-8 grid grid-cols-2 gap-10">
          <SignatureLine
            label="Prepared by:"
            name={jev.createdBy?.name || entity.bookkeeper.name}
            role={jev.createdBy?.position || entity.bookkeeper.position}
          />
          <SignatureLine
            label="Certified Correct:"
            name={jev.postedBy?.name || entity.municipalAccountant.name}
            role={jev.postedBy?.position || entity.municipalAccountant.position}
          />
        </div>
      </div>
    </div>
  );
}
