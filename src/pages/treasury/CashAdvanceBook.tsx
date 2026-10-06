import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { PeriodPicker } from '@/components/PeriodPicker';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useCashAdvances, useChecks, useLiquidations } from '@/data/queries';
import { periodHeading, periodRange, type ReportPeriod } from '@/lib/reportPeriods';
import { formatPeso } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import { buildCashAdvanceBook, type CbcaBook } from './cashAdvanceBookReport';
import { fundLabel } from '@/pages/budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { CASH_BOOK_TABS } from '@/layout/sections';

/**
 * Cash Book - Cash Advances. GAM for LGUs, Appendix 26.
 *
 * One book per disbursing officer. The balance column is the point of it:
 * instruction 9 says it "shall be equal to the amount of cash in hand of
 * Disbursing Officers", which is what somebody counting the drawer is holding
 * this record against.
 */
export default function CashAdvanceBook() {
  const { fiscalYear, fundCode } = useFilters();
  const [officerId, setOfficerId] = useState<string>('');
  const [period, setPeriod] = useState<ReportPeriod>(() => ({
    mode: 'MONTHLY',
    index: Number(todayPh().slice(0, 4)) === fiscalYear ? Number(todayPh().slice(5, 7)) : 1,
  }));

  // Every advance of the year, not only the outstanding ones: a book that
  // dropped an advance the moment it was fully liquidated would have debits
  // with no matching credits and would not foot.
  const advances = useCashAdvances(fiscalYear, false);
  const liquidations = useLiquidations(fiscalYear);
  const checks = useChecks();

  const range = periodRange(period, fiscalYear);

  const books = useMemo(
    () =>
      buildCashAdvanceBook({
        advances: advances.data,
        liquidations: liquidations.data,
        checks: checks.data,
        from: range.from,
        to: range.to,
        officerId: officerId || null,
        fundCode,
      }),
    [advances.data, liquidations.data, checks.data, range.from, range.to, officerId, fundCode],
  );

  const officers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of advances.data) {
      if (a.fundCode === fundCode) seen.set(a.accountableOfficerId, a.accountableOfficerName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [advances.data, fundCode]);

  const loading = advances.loading || liquidations.loading;
  const drifting = books.filter((b) => b.coversEverything && b.drift !== 0);

  const exportRows = books.flatMap((b) => b.entries.map((e) => ({ book: b, e })));
  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: 'officer', header: 'Disbursing Officer', value: (x) => x.book.officerName },
    { key: 'date', header: 'Date', value: (x) => x.e.date },
    { key: 'particulars', header: 'Particulars', value: (x) => x.e.particulars },
    { key: 'ref', header: 'Ref.', value: (x) => x.e.reference },
    { key: 'debit', header: 'Debit', kind: 'amount', value: (x) => x.e.debit },
    { key: 'credit', header: 'Credit', kind: 'amount', value: (x) => x.e.credit },
    { key: 'balance', header: 'Balance', kind: 'amount', value: (x) => x.e.balance },
  ];

  return (
    <ReportShell
      tabs={<SectionTabs tabs={CASH_BOOK_TABS} />}
      meta={{
        title: 'Cash Book - Cash Advances',
        fundLabel: fundLabel(fundCode),
        periodLabel: periodHeading(period, fiscalYear),
      }}
      breadcrumbs={[{ label: 'Treasury' }, { label: 'Cash Book - Cash Advances' }]}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={
        <>
          <PeriodPicker value={period} onChange={setPeriod} />
          <Field label="Disbursing Officer" className="w-72">
            <Select value={officerId} onChange={(e) => setOfficerId(e.target.value)}>
              <option value="">Every officer</option>
              {officers.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            <strong>Cash Book - Cash Advances</strong> - GAM for Local Government Units, Appendix
            26. Maintained by the Treasurer or the disbursing officer. The balance column is the
            cash that should be in the officer&apos;s hands.
          </p>
          <p className="mt-1">
            The debit is the advance, referenced by the check that paid it. The credit is what was
            liquidated, and cash handed back is a credit of its own. A liquidation counts only once
            it is posted, which is the point at which the records themselves move.
          </p>
          {/*
            A reimbursement is the officer's own money, not the LGU's cash in
            his hands. Saying so here stops the obvious question about why the
            book and the liquidation report differ by that amount.
          */}
          <p className="mt-1">
            A reimbursement - where the officer spent more than he was advanced and is owed the
            difference - is not in this book. It is his money, not cash of the municipality in his
            hands, and including it would make the balance disagree with a count of the drawer.
          </p>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : books.length === 0 ? (
        <Alert tone="info" title="No cash advance to report">
          No cash advance was granted in {fiscalYear} out of the {fundLabel(fundCode)}.
        </Alert>
      ) : (
        <>
          {/*
            The closing balance and the stored outstanding balance are worked
            out by different code from the same documents. Where they disagree
            and the book covers everything, one of them is wrong, and that is
            worth interrupting for.
          */}
          {drifting.length > 0 && (
            <Alert
              tone="error"
              title="A book does not agree with the recorded balance"
              className="mb-4 no-print"
            >
              <p>
                For {drifting.map((b) => b.officerName).join(', ')}, the balance this book foots to
                is not the outstanding balance held against the cash advances. The two are worked
                out separately from the same documents, so one of them is wrong. Do not sign the
                book until it is explained.
              </p>
            </Alert>
          )}

          {books.map((b) => (
            <Book key={`${b.officerId}__${b.fundCode}`} book={b} />
          ))}
        </>
      )}
    </ReportShell>
  );
}

function Book({ book }: { book: CbcaBook }) {
  return (
    <section className="mb-8 break-inside-avoid">
      <header className="mb-2 border-b border-slate-300 pb-1.5">
        <p className="text-sm font-semibold text-navy-900">
          Disbursing Officer: {book.officerName}
        </p>
        <p className="text-xs text-slate-500">{fundLabel(book.fundCode)}</p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-300 text-left text-slate-600">
              <th className="cbo-th" style={{ width: '6rem' }}>
                Date
              </th>
              <th className="cbo-th">Particulars</th>
              <th className="cbo-th" style={{ width: '9rem' }}>
                Ref.
              </th>
              <th className="cbo-th text-right" style={{ width: '9rem' }}>
                Debit
              </th>
              <th className="cbo-th text-right" style={{ width: '9rem' }}>
                Credit
              </th>
              <th className="cbo-th text-right" style={{ width: '9rem' }}>
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Instruction 5: the previous balance carried forward as the opening. */}
            <tr className="border-b border-slate-100 text-slate-600">
              <td className="cbo-td" colSpan={3}>
                Balance brought forward
              </td>
              <td className="cbo-td" />
              <td className="cbo-td" />
              <td className="cbo-td cbo-amount">{formatPeso(book.broughtForward)}</td>
            </tr>

            {book.entries.map((e, i) => (
              <tr key={`${e.reference}-${i}`} className="border-b border-slate-100">
                <td className="cbo-td font-mono">{e.date}</td>
                <td className="cbo-td">{e.particulars}</td>
                <td className="cbo-td font-mono">{e.reference}</td>
                <td className="cbo-td cbo-amount">{e.debit ? formatPeso(e.debit) : ''}</td>
                <td className="cbo-td cbo-amount">{e.credit ? formatPeso(e.credit) : ''}</td>
                <td className="cbo-td cbo-amount">{formatPeso(e.balance)}</td>
              </tr>
            ))}

            <tr className="border-t border-slate-300 text-slate-600">
              <td className="cbo-td" colSpan={3}>
                Totals for the period
              </td>
              <td className="cbo-td cbo-amount">{formatPeso(book.totalDebit)}</td>
              <td className="cbo-td cbo-amount">{formatPeso(book.totalCredit)}</td>
              <td className="cbo-td" />
            </tr>
            <tr className="border-t-2 border-navy-800 font-semibold text-navy-900">
              <td className="cbo-td" colSpan={5}>
                Cash in hand at the closing date
              </td>
              <td
                className={`cbo-td cbo-amount ${book.closingBalance < 0 ? 'text-rose-600' : ''}`}
              >
                {formatPeso(book.closingBalance)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-slate-500">
        Outstanding against the cash advances on record: {formatPeso(book.outstandingRecorded)}.{' '}
        {book.coversEverything ? (
          book.drift === 0 ? (
            <span className="text-emerald-700">The book agrees with it.</span>
          ) : (
            <span className="text-rose-600">
              The book is out by {formatPeso(book.drift)}; one of the two is wrong.
            </span>
          )
        ) : (
          // Said rather than shown as a discrepancy. A book struck at a past
          // date has not reached documents the stored figure already counts.
          <span>
            A document falls after the closing date, so the two are not comparable on this period.
          </span>
        )}
      </p>
    </section>
  );
}
