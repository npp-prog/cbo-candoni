import { useEffect, useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field, Select, TextInput } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import {
  useAda,
  useChecks,
  useDisbursementVouchers,
  usePayrolls,
  useTreasuryReports,
} from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatLongDate, todayPh } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import { ADVANCES_FOR_PAYROLL } from '@/lib/chartOfAccounts';
import { buildCashAdvanceBook, type CbcaBook } from './cashAdvanceBookReport';
import { fundLabel } from '@/pages/budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { CASH_BOOK_TABS } from '@/layout/sections';

/**
 * Cash Book - Cash Advances. GAM for LGUs, Appendix 26.
 *
 * One book per disbursing officer. The balance column is the point of it:
 * instruction 9 says it "shall be equal to the amount of cash in hand of
 * Disbursing Officers".
 *
 * Patch 177: made of the Advances for Payroll (debits) and the payrolls on a
 * certified RCDisb (credits) only, and struck between two dates - From and To -
 * instead of a period and a month.
 */
function defaultTo(fiscalYear: number): string {
  const today = todayPh();
  return today.slice(0, 4) === String(fiscalYear) ? today : `${fiscalYear}-12-31`;
}

export default function CashAdvanceBook() {
  const { fiscalYear, fundCode } = useFilters();
  const [officerId, setOfficerId] = useState<string>('');
  const [fromDate, setFromDate] = useState(`${fiscalYear}-01-01`);
  const [toDate, setToDate] = useState(() => defaultTo(fiscalYear));

  useEffect(() => {
    setFromDate(`${fiscalYear}-01-01`);
    setToDate(defaultTo(fiscalYear));
  }, [fiscalYear]);

  const vouchers = useDisbursementVouchers(fiscalYear, fundCode);
  const payrolls = usePayrolls(fiscalYear, fundCode);
  const rcdisbs = useTreasuryReports('RCDISB', fiscalYear, fundCode);
  const checks = useChecks();
  const adas = useAda();

  const payments = useMemo(
    () => [
      ...checks.data.map((c) => ({
        dvId: c.dvId,
        no: `Check ${c.checkNo}`,
        date: c.checkDate,
        status: c.status,
      })),
      ...adas.data.map((a) => ({
        dvId: a.dvId,
        no: `ADA ${a.adaNo}`,
        date: a.adaDate,
        status: a.status,
      })),
    ],
    [checks.data, adas.data],
  );

  const allBooks = useMemo(
    () =>
      buildCashAdvanceBook({
        vouchers: vouchers.data,
        payments,
        payrolls: payrolls.data,
        rcdisbs: rcdisbs.data,
        advanceAccountCode: ADVANCES_FOR_PAYROLL.code,
        from: fromDate,
        to: toDate,
        fundCode,
      }),
    [vouchers.data, payments, payrolls.data, rcdisbs.data, fromDate, toDate, fundCode],
  );
  const books = officerId ? allBooks.filter((b) => b.officerId === officerId) : allBooks;
  const officers = allBooks.map((b) => [b.officerId, b.officerName] as const);

  const loading = vouchers.loading || payrolls.loading || rcdisbs.loading;
  const periodLabel = `${formatLongDate(fromDate)} to ${formatLongDate(toDate)}`;

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
        periodLabel,
      }}
      breadcrumbs={[{ label: 'Treasury' }, { label: 'Cash Book - Cash Advances' }]}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="From">
            <TextInput
              type="date"
              value={fromDate}
              max={toDate}
              onChange={(e) => e.target.value && setFromDate(e.target.value)}
            />
          </Field>
          <Field label="To">
            <TextInput
              type="date"
              value={toDate}
              min={fromDate}
              onChange={(e) => e.target.value && setToDate(e.target.value)}
            />
          </Field>
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
            26. The balance column is the cash that should be in the disbursing officer&apos;s
            hands.
          </p>
          <p className="mt-1">
            Debit: each Advance for Payroll (a voucher debiting Advances for Payroll), referenced by
            the check or ADA that paid it. Credit: each payroll reported on a certified Report of
            Cash Disbursements (RCDisb), at its net. Nothing else is in this book.
          </p>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : books.length === 0 ? (
        <Alert tone="info" title="No cash advance to report">
          No Advance for Payroll and no RCDisb in the {fundLabel(fundCode)} up to{' '}
          {formatLongDate(toDate)}.
        </Alert>
      ) : (
        books.map((b) => <Book key={`${b.officerId}__${b.fundCode}`} book={b} />)
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
              <td className={`cbo-td cbo-amount ${book.closingBalance < 0 ? 'text-rose-600' : ''}`}>
                {formatPeso(book.closingBalance)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
