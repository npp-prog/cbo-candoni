import { useEffect, useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { ReportShell } from '@/components/ReportShell';
import { Spinner, Alert, Card } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAccounts, useLedgerEntries } from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { monthName } from '@/lib/dates';
import { QUARTER_LABELS, type Quarter } from '@/lib/budgetPeriods';
import {
  buildReceiptsReport,
  monthsOfQuarter,
  type IncomeEstimates,
  type QuarterEstimate,
  type ReceiptEntry,
  type ReceiptRow,
} from './quarterlyReceipts';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import { fundLabel } from '../budget/Obligations';

/**
 * LBAc Form No. 1 — Quarterly Report of Receipts.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 5 of Part II, Item
 * 5.5. Prepared by the Local Treasurer, certified correct by the Local
 * Accountant, submitted to the Local Finance Committee through the Local
 * Budget Officer on or before the tenth day of the month following the quarter
 * reported.
 *
 * ---------------------------------------------------------------------------
 * THE ACTUAL INCOME COMES FROM THE LEDGER, NOT THE COLLECTIONS REGISTER
 * ---------------------------------------------------------------------------
 * The manual ties column 9 to the Trial Balance: it "should tally with the
 * income account per Trial Balance as of date". The collections register and
 * the General Ledger agree once the day's collections are journalised and
 * differ until then, so reading the register would produce a form that
 * disagrees with the books it is filed beside - by exactly the receipts nobody
 * has posted yet, which is the hardest kind of difference to find later.
 *
 * ---------------------------------------------------------------------------
 * THE ESTIMATES ARE NOMINATED, NOT DERIVED
 * ---------------------------------------------------------------------------
 * Estimated income is a budget PREPARATION figure: what the Local Finance
 * Committee certified as reasonably expected, quarter by quarter. CBO holds no
 * such figure anywhere, and nothing in the system implies it - last year's
 * collections divided by four is not an estimate, it is a guess wearing one.
 *
 * So the form asks for them once per year per fund, stores them in settings,
 * and where they are missing it reports the variance column as unavailable
 * rather than computing one against zero. A form that shows a confident
 * variance against a denominator nobody certified is worse than a form that
 * shows a blank, because the Treasurer signs it.
 * ---------------------------------------------------------------------------
 */

interface EstimatesDoc {
  estimates?: IncomeEstimates;
  updatedAt?: string;
}

const QUARTER_KEYS: Array<keyof QuarterEstimate> = ['q1', 'q2', 'q3', 'q4'];

export default function QuarterlyReceipts() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const [quarter, setQuarter] = useState<Quarter>(1);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<IncomeEstimates>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const months = monthsOfQuarter(quarter);

  const accounts = useAccounts();
  // Through the end of the quarter reported. Column 9 is January to date, so
  // the whole year up to that point is needed - not just the three months.
  const ledger = useLedgerEntries(fiscalYear, fundCode, { throughPeriod: months[2] });

  const docId = `incomeEstimates-${fiscalYear}-${fundCode}`;
  const stored = useDocument<EstimatesDoc>(COL.settings, docId);

  // The stored figures land in the form once, and the form is the truth after
  // that - re-seeding on every snapshot would overwrite what is being typed.
  useEffect(() => {
    if (stored.loading || dirty) return;
    setForm(stored.data?.estimates ?? {});
  }, [stored.data, stored.loading, dirty]);

  const canEdit = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER', 'MUNICIPAL_TREASURER');

  const revenueAccounts = useMemo(
    () =>
      accounts.data
        .filter((a) => a.accountClass === 'REVENUE')
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts.data],
  );

  const accountNames = useMemo(
    () => new Map(revenueAccounts.map((a) => [a.code, a.name])),
    [revenueAccounts],
  );

  /**
   * Only the revenue accounts. An expense or an asset entry sharing the period
   * has no business on a report of receipts, and the ledger query brings back
   * every account for the period.
   */
  const entries = useMemo<ReceiptEntry[]>(
    () =>
      ledger.data
        .filter((e) => accountNames.has(e.accountCode))
        .map((e) => ({
          accountCode: e.accountCode,
          accountName: e.accountName || (accountNames.get(e.accountCode) ?? ''),
          period: e.period,
          signedAmount: e.signedAmount,
        })),
    [ledger.data, accountNames],
  );

  const estimates = stored.data?.estimates ?? {};

  const report = useMemo(
    () => buildReceiptsReport(entries, estimates, quarter),
    [entries, estimates, quarter],
  );

  /** The account name, falling back to the chart where the ledger carried none. */
  const nameOf = (row: ReceiptRow) => row.accountName || accountNames.get(row.accountCode) || '';

  const setEstimate = (code: string, key: keyof QuarterEstimate, value: Centavos | null) => {
    setDirty(true);
    setForm((prev) => ({ ...prev, [code]: { ...prev[code], [key]: value ?? 0 } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      // Accounts with nothing entered are dropped rather than stored as four
      // zeroes: a stored zero is a statement that nothing is expected, and the
      // report treats it as one.
      const cleaned: IncomeEstimates = {};
      for (const [code, q] of Object.entries(form)) {
        const total = QUARTER_KEYS.reduce((s, k) => s + (q[k] ?? 0), 0);
        if (total !== 0) cleaned[code] = q;
      }
      await setDoc(
        doc(db, COL.settings, docId),
        { estimates: cleaned, updatedAt: new Date().toISOString() },
        { merge: true },
      );
      setDirty(false);
      setEditing(false);
      toast.success(
        'Estimated income saved',
        `${Object.keys(cleaned).length} account${
          Object.keys(cleaned).length === 1 ? '' : 's'
        } for ${fundLabel(fundCode)}, ${fiscalYear}.`,
      );
    } catch (err) {
      toast.error('The estimates were not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const exportColumns: ExportColumn<ReceiptRow>[] = [
    { key: 'name', header: '(1) Account Title/Description of Income', value: (r) => nameOf(r) },
    { key: 'code', header: '(2) Account Code', value: (r) => r.accountCode },
    {
      key: 'estPrev',
      header: '(3) Estimated Income Previous Quarter',
      kind: 'amount',
      value: (r) => r.estimatedPrevious,
    },
    {
      key: 'estThis',
      header: '(4) Estimated Income This Quarter',
      kind: 'amount',
      value: (r) => r.estimatedThis,
    },
    {
      key: 'estToDate',
      header: '(5) Total Estimated Income to Date',
      kind: 'amount',
      value: (r) => r.estimatedToDate,
    },
    {
      key: 'm1',
      header: `(6) ${monthName(months[0])}`,
      kind: 'amount',
      value: (r) => r.months[0],
    },
    {
      key: 'm2',
      header: `(7) ${monthName(months[1])}`,
      kind: 'amount',
      value: (r) => r.months[1],
    },
    {
      key: 'm3',
      header: `(8) ${monthName(months[2])}`,
      kind: 'amount',
      value: (r) => r.months[2],
    },
    {
      key: 'actualToDate',
      header: '(9) Total Actual Income to Date',
      kind: 'amount',
      value: (r) => r.actualToDate,
    },
    { key: 'variance', header: '(10) Variance Amount', kind: 'amount', value: (r) => r.variance },
    {
      key: 'variancePct',
      header: '(11) Variance %',
      value: (r) => (r.variancePct === null ? '' : (r.variancePct * 100).toFixed(2)),
    },
    {
      key: 'remarks',
      header: '(12) Remarks',
      value: (r) => (r.unestimated ? 'No estimate certified for this account' : ''),
    },
  ];

  const loading = ledger.loading || accounts.loading || stored.loading;
  const error = ledger.error ?? accounts.error ?? stored.error;

  return (
    <ReportShell
      meta={{
        title: 'Quarterly Report of Receipts',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the Quarter Ending ${monthName(months[2])} ${fiscalYear}`,
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Reports' }, { label: 'LBAc Form No. 1' }]}
      rows={report.rows}
      exportColumns={exportColumns}
      actions={
        canEdit ? (
          <Button size="sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close estimates' : 'Estimated income'}
          </Button>
        ) : undefined
      }
      filters={
        <Field label="Quarter" className="w-64">
          <Select
            value={String(quarter)}
            onChange={(e) => setQuarter(Number(e.target.value) as Quarter)}
          >
            {([1, 2, 3, 4] as Quarter[]).map((q) => (
              <option key={q} value={q}>
                {QUARTER_LABELS[q]}
              </option>
            ))}
          </Select>
        </Field>
      }
      footnote={
        <>
          LBAc Form No. 1, Budget Operations Manual for LGUs, 2023 Edition. Prepared by the Local
          Treasurer and certified correct by the Local Accountant, based on the actual collections
          from the Report of Daily Collections. Submitted to the Local Finance Committee through the
          Local Budget Officer on or before the tenth day of the month following the quarter
          reported. The column numbers above are the manual&rsquo;s own. Column 5 is the estimate
          from January to the end of the quarter reported, and column 9 the actual income over the
          same period &mdash; neither is the sum of the columns beside it, and column 9 should tally
          with the income accounts on the Trial Balance as of that date.
        </>
      }
    >
      {editing && (
        <Card
          title={`Estimated income · ${fundLabel(fundCode)} · ${fiscalYear}`}
          subtitle="What the Local Finance Committee certified as reasonably expected, quarter by quarter. CBO does not derive these from anything."
          className="mb-5 no-print"
          footer={
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-slate-600">
                Saved once per fiscal year per fund. Leave an account blank where nothing is
                expected from it.
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setDirty(false);
                    setForm(stored.data?.estimates ?? {});
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
                <Button variant="primary" loading={saving} disabled={saving} onClick={() => void save()}>
                  Save the estimates
                </Button>
              </div>
            </div>
          }
        >
          {revenueAccounts.length === 0 ? (
            <Alert tone="warning">
              No revenue account is in the Chart of Accounts yet. Load the Revised Chart of Accounts
              first &mdash; this form is a list of income accounts, and without them it has no rows.
            </Alert>
          ) : (
            <div className="max-h-[28rem] overflow-y-auto rounded border border-slate-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Account</th>
                    {QUARTER_KEYS.map((k, i) => (
                      <th
                        key={k}
                        className="px-2 py-1.5 text-right font-medium"
                        style={{ width: '9rem' }}
                      >
                        {QUARTER_LABELS[(i + 1) as Quarter]}
                      </th>
                    ))}
                    <th className="px-2 py-1.5 text-right font-medium" style={{ width: '9rem' }}>
                      Year
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {revenueAccounts.map((a) => {
                    const q = form[a.code] ?? {};
                    const year = QUARTER_KEYS.reduce((s, k) => s + (q[k] ?? 0), 0);
                    return (
                      <tr key={a.code}>
                        <td className="px-2 py-1.5">
                          <span className="font-mono text-2xs text-slate-500">{a.code}</span>{' '}
                          <span>{a.name}</span>
                        </td>
                        {QUARTER_KEYS.map((k) => (
                          <td key={k} className="px-2 py-1.5">
                            <AmountInput
                              value={q[k] ?? null}
                              onChange={(v) => setEstimate(a.code, k, v)}
                            />
                          </td>
                        ))}
                        <td className="px-2 py-1.5 text-right font-mono">
                          {year === 0 ? '—' : formatPeso(year, { symbol: false })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {loading ? (
        <Spinner />
      ) : error ? (
        <Alert tone="error" title="The report could not be built">
          {error}
        </Alert>
      ) : (
        <>
          {report.noEstimates && (
            <Alert
              tone="warning"
              title="No estimated income has been recorded for this fund"
              className="mb-4 no-print"
            >
              Columns 3, 4, 5, 10 and 11 are the estimate and the variance against it, and this
              form exists to show that variance. Without the figures the Local Finance Committee
              certified, what is below is a list of collections and not LBAc Form No. 1.
              {canEdit ? (
                <> Use &ldquo;Estimated income&rdquo; above to record them.</>
              ) : (
                <> The Treasurer or the Budget Officer can record them.</>
              )}
            </Alert>
          )}

          {!report.noEstimates && report.unestimatedCodes.length > 0 && (
            <Alert
              tone="info"
              title={`${report.unestimatedCodes.length} account${
                report.unestimatedCodes.length === 1 ? '' : 's'
              } collected income that was not estimated`}
              className="mb-4 no-print"
            >
              {report.unestimatedCodes.join(', ')}. Their variance is the whole amount collected and
              column 11 is left blank, because the manual&rsquo;s percentage divides by the
              estimate. Either the estimate belongs on one of these accounts, or the collection
              belongs on another &mdash; worth settling before this is signed.
            </Alert>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="cbo-th" rowSpan={2}>
                    Account Title/Description of Income (1)
                  </th>
                  <th className="cbo-th" rowSpan={2}>
                    Account Code (2)
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Estimated Income Previous Quarter (3)
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Estimated Income This Quarter (4)
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Total Estimated Income to Date (5)
                  </th>
                  <th className="cbo-th text-center" colSpan={3}>
                    Actual Income for the Quarter
                  </th>
                  <th className="cbo-th text-right" rowSpan={2}>
                    Total Actual Income to Date (9)
                  </th>
                  <th className="cbo-th text-center" colSpan={2}>
                    Variance
                  </th>
                  <th className="cbo-th" rowSpan={2}>
                    Remarks (12)
                  </th>
                </tr>
                <tr>
                  <th className="cbo-th text-right">{monthName(months[0])} (6)</th>
                  <th className="cbo-th text-right">{monthName(months[1])} (7)</th>
                  <th className="cbo-th text-right">{monthName(months[2])} (8)</th>
                  <th className="cbo-th text-right">Amount (10)</th>
                  <th className="cbo-th text-right">% (11)</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.accountCode}>
                    <td className="cbo-td">{nameOf(r)}</td>
                    <td className="cbo-td font-mono text-2xs text-slate-500">{r.accountCode}</td>
                    <Amount value={r.estimatedPrevious} />
                    <Amount value={r.estimatedThis} />
                    <Amount value={r.estimatedToDate} />
                    <Amount value={r.months[0]} />
                    <Amount value={r.months[1]} />
                    <Amount value={r.months[2]} />
                    <Amount value={r.actualToDate} />
                    <Amount value={r.variance} negative={r.variance < 0} />
                    <Percent value={r.variancePct} />
                    <td className="cbo-td text-2xs text-slate-500">
                      {r.unestimated ? 'No estimate certified' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 font-semibold">
                  <td className="cbo-td border-b-0" colSpan={2}>
                    TOTAL
                  </td>
                  <Amount value={report.total.estimatedPrevious} foot />
                  <Amount value={report.total.estimatedThis} foot />
                  <Amount value={report.total.estimatedToDate} foot />
                  <Amount value={report.total.months[0]} foot />
                  <Amount value={report.total.months[1]} foot />
                  <Amount value={report.total.months[2]} foot />
                  <Amount value={report.total.actualToDate} foot />
                  <Amount
                    value={report.total.variance}
                    negative={report.total.variance < 0}
                    foot
                  />
                  <Percent value={report.total.variancePct} foot />
                  <td className="cbo-td border-b-0" />
                </tr>
              </tfoot>
            </table>
          </div>

          {report.rows.length === 0 && (
            <Alert tone="info" title="No income recorded yet" className="mt-4">
              No revenue account carries an entry in {fiscalYear} for {fundLabel(fundCode)} up to
              the end of the {QUARTER_LABELS[quarter].toLowerCase()}, and no estimate has been
              recorded either.
            </Alert>
          )}

          <div className="mt-10 grid grid-cols-2 gap-10 text-2xs">
            <div>
              <p className="text-slate-500">Prepared by:</p>
              <p className="mt-10 border-t border-slate-500 pt-1 text-center font-semibold">
                &nbsp;
              </p>
              <p className="text-center text-slate-500">Local Treasurer</p>
              <p className="mt-2 text-slate-500">Date: ______________</p>
            </div>
            <div>
              <p className="text-slate-500">Certified Correct by:</p>
              <p className="mt-10 border-t border-slate-500 pt-1 text-center font-semibold">
                &nbsp;
              </p>
              <p className="text-center text-slate-500">Local Accountant</p>
              <p className="mt-2 text-slate-500">Date: ______________</p>
            </div>
          </div>
        </>
      )}
    </ReportShell>
  );
}

function Amount({
  value,
  negative,
  foot,
}: {
  value: Centavos;
  negative?: boolean;
  foot?: boolean;
}) {
  return (
    <td
      className={`cbo-td cbo-amount ${negative ? 'text-rose-700' : ''} ${foot ? 'border-b-0' : ''}`}
    >
      {formatPeso(value, { symbol: false, dash: !foot, parens: true })}
    </td>
  );
}

/**
 * The manual's column 11.
 *
 * A blank, not a zero and not a dash, where there is no estimate to divide by:
 * a dash in a percentage column reads as "no change", and no change against
 * nothing expected is precisely the wrong thing to tell the Treasurer.
 */
function Percent({ value, foot }: { value: number | null; foot?: boolean }) {
  return (
    <td className={`cbo-td cbo-amount ${foot ? 'border-b-0' : ''}`}>
      {value === null ? (
        <span className="text-slate-300">&nbsp;</span>
      ) : (
        <span className={value < 0 ? 'text-rose-700' : undefined}>
          {(value * 100).toFixed(2)}%
        </span>
      )}
    </td>
  );
}
