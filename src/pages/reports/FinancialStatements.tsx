import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner, Tabs } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAccounts, useLedgerEntries, useBudgetBalances } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { monthName } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import type { Centavos } from '@/types/common';
import type { FsClassification } from '@/types/enums';
import { fundLabel } from '../budget/Obligations';

/**
 * The financial statements.
 *
 * All five are built from the same source: posted ledger entries, grouped by
 * each account's financial-statement classification as recorded in the Chart
 * of Accounts. No statement balance is stored anywhere in CBO, so there is no
 * possibility of the statements and the ledger disagreeing.
 *
 * The sign convention is the one thing worth explaining. Ledger entries carry
 * a signed amount where a debit is positive. Assets and expenses are debit-
 * normal, so their balance is presented as-is; liabilities, equity and revenue
 * are credit-normal, so their balance is negated for presentation. Getting
 * this backwards produces a statement that foots perfectly and reads as
 * nonsense.
 */

interface FsLine {
  accountCode: string;
  accountName: string;
  classification: FsClassification;
  /** Presentation balance, already sign-adjusted for the account's nature. */
  amount: Centavos;
}

const STATEMENTS = [
  { id: 'position', label: 'Financial Position' },
  { id: 'performance', label: 'Financial Performance' },
  { id: 'cashflow', label: 'Cash Flows' },
  { id: 'equity', label: 'Changes in Net Assets/Equity' },
  { id: 'budget', label: 'Budget and Actual' },
] as const;

type StatementId = (typeof STATEMENTS)[number]['id'];

const CREDIT_NORMAL: FsClassification[] = [
  'CURRENT_LIABILITY',
  'NON_CURRENT_LIABILITY',
  'NET_ASSETS_EQUITY',
  'REVENUE',
];

export default function FinancialStatements() {
  const { fiscalYear, fundCode, period } = useFilters();
  const [throughPeriod, setThroughPeriod] = useState<number>(period ?? 12);
  const [statement, setStatement] = useState<StatementId>('position');

  const accounts = useAccounts(false);
  const ledger = useLedgerEntries(fiscalYear, fundCode, { throughPeriod });
  const budget = useBudgetBalances(fiscalYear, fundCode);

  const lines = useMemo<FsLine[]>(() => {
    const byAccount = new Map<string, { name: string; signed: Centavos }>();

    for (const e of ledger.data) {
      if (e.period > throughPeriod) continue;
      const entry = byAccount.get(e.accountCode) ?? { name: e.accountName, signed: 0 };
      entry.signed += e.signedAmount ?? 0;
      byAccount.set(e.accountCode, entry);
    }

    const out: FsLine[] = [];
    for (const [code, value] of byAccount) {
      const account = accounts.data.find((a) => a.code === code);
      const classification = (account?.fsClassification ?? 'NON_FINANCIAL_ITEM') as FsClassification;
      // Debit-positive signed balance, flipped for credit-normal accounts so
      // every figure presents as a positive number on the face of the
      // statement.
      const amount = CREDIT_NORMAL.includes(classification) ? -value.signed : value.signed;
      if (amount === 0) continue;
      out.push({ accountCode: code, accountName: value.name, classification, amount });
    }

    return out.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }, [ledger.data, accounts.data, throughPeriod]);

  const group = (classification: FsClassification) =>
    lines.filter((l) => l.classification === classification);

  const sum = (classification: FsClassification) =>
    group(classification).reduce((s, l) => s + l.amount, 0);

  const currentAssets = sum('CURRENT_ASSET');
  const nonCurrentAssets = sum('NON_CURRENT_ASSET');
  const totalAssets = currentAssets + nonCurrentAssets;
  const currentLiabilities = sum('CURRENT_LIABILITY');
  const nonCurrentLiabilities = sum('NON_CURRENT_LIABILITY');
  const totalLiabilities = currentLiabilities + nonCurrentLiabilities;
  const revenue = sum('REVENUE');
  const expenses = sum('EXPENSE');
  const surplus = revenue - expenses;
  const equityBrought = sum('NET_ASSETS_EQUITY');
  const netAssets = equityBrought + surplus;

  const exportColumns: ExportColumn<FsLine>[] = [
    { key: 'code', header: 'Account Code', value: (l) => l.accountCode },
    { key: 'name', header: 'Account Title', value: (l) => l.accountName },
    { key: 'class', header: 'Classification', value: (l) => l.classification },
    { key: 'amount', header: 'Amount', kind: 'amount', value: (l) => l.amount },
  ];

  const statementTitle =
    statement === 'position'
      ? 'Statement of Financial Position'
      : statement === 'performance'
        ? 'Statement of Financial Performance'
        : statement === 'cashflow'
          ? 'Statement of Cash Flows'
          : statement === 'equity'
            ? 'Statement of Changes in Net Assets/Equity'
            : 'Statement of Comparison of Budget and Actual Amounts';

  return (
    <ReportShell
      meta={{
        title: statementTitle,
        fundLabel: fundLabel(fundCode),
        periodLabel:
          statement === 'position'
            ? `As at ${monthName(throughPeriod)} ${fiscalYear}`
            : `For the period ended ${monthName(throughPeriod)} ${fiscalYear}`,
        preparedBy: 'Municipal Accountant',
        certifiedBy: 'Municipal Accountant',
      }}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Financial Statements' }]}
      rows={lines}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="Statement">
            <Select value={statement} onChange={(e) => setStatement(e.target.value as StatementId)}>
              {STATEMENTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Through period">
            <Select value={throughPeriod} onChange={(e) => setThroughPeriod(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          Prepared from posted journal entries. Classification follows each account&rsquo;s
          financial-statement category in the Chart of Accounts; an account with no classification
          recorded is excluded and should be corrected under Master Data.
        </>
      }
    >
      {ledger.loading ? (
        <Spinner label="Building the statement from the General Ledger" />
      ) : lines.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No journal entries have been posted for the {fundLabel(fundCode)} in this period.
        </p>
      ) : statement === 'position' ? (
        <>
          <StatementSection title="Assets">
            <SubSection title="Current assets" lines={group('CURRENT_ASSET')} total={currentAssets} />
            <SubSection title="Non-current assets" lines={group('NON_CURRENT_ASSET')} total={nonCurrentAssets} />
            <GrandTotal label="Total assets" value={totalAssets} />
          </StatementSection>

          <StatementSection title="Liabilities">
            <SubSection title="Current liabilities" lines={group('CURRENT_LIABILITY')} total={currentLiabilities} />
            <SubSection
              title="Non-current liabilities"
              lines={group('NON_CURRENT_LIABILITY')}
              total={nonCurrentLiabilities}
            />
            <GrandTotal label="Total liabilities" value={totalLiabilities} />
          </StatementSection>

          <StatementSection title="Net assets / equity">
            <SubSection title="" lines={group('NET_ASSETS_EQUITY')} total={equityBrought} />
            <Row label="Surplus for the period" amount={surplus} />
            <GrandTotal label="Total net assets / equity" value={netAssets} />
          </StatementSection>

          {totalAssets !== totalLiabilities + netAssets && (
            <Alert tone="error" className="mt-4" title="The statement does not balance">
              Total assets of {formatPeso(totalAssets)} do not equal liabilities plus net assets of{' '}
              {formatPeso(totalLiabilities + netAssets)}. This normally means one or more accounts
              have no financial-statement classification set in the Chart of Accounts.
            </Alert>
          )}
        </>
      ) : statement === 'performance' ? (
        <>
          <StatementSection title="Revenue">
            <SubSection title="" lines={group('REVENUE')} total={revenue} />
          </StatementSection>
          <StatementSection title="Expenses">
            <SubSection title="" lines={group('EXPENSE')} total={expenses} />
          </StatementSection>
          <GrandTotal label={surplus >= 0 ? 'Surplus for the period' : 'Deficit for the period'} value={surplus} />
        </>
      ) : statement === 'cashflow' ? (
        <CashFlowStatement ledger={ledger.data} throughPeriod={throughPeriod} />
      ) : statement === 'equity' ? (
        <>
          <Row label="Net assets / equity, beginning of period" amount={equityBrought} />
          <Row label={surplus >= 0 ? 'Add: surplus for the period' : 'Less: deficit for the period'} amount={surplus} />
          <GrandTotal label="Net assets / equity, end of period" value={netAssets} />
          <Alert tone="info" className="mt-4">
            Prior period adjustments and other direct movements in equity appear here once they
            are posted as journal entries of type Prior Period Adjustment.
          </Alert>
        </>
      ) : (
        <BudgetAndActual budget={budget.data} expenses={group('EXPENSE')} />
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

function StatementSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
        {title}
      </h3>
      {children}
    </section>
  );
}

function SubSection({ title, lines, total }: { title: string; lines: FsLine[]; total: Centavos }) {
  if (lines.length === 0) return null;
  return (
    <div className="mb-3">
      {title && <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">{title}</p>}
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l) => (
            <tr key={l.accountCode}>
              <td className="cbo-td border-b-0 py-1 pl-4">
                <span className="font-mono text-2xs text-slate-400">{l.accountCode}</span>{' '}
                <span className="text-sm">{l.accountName}</span>
              </td>
              <td className="cbo-td cbo-amount w-44 border-b-0 py-1">
                {formatPeso(l.amount, { symbol: false, parens: true })}
              </td>
            </tr>
          ))}
          <tr className="border-t border-slate-300">
            <td className="cbo-td border-b-0 py-1 font-medium">{title ? `Total ${title.toLowerCase()}` : 'Total'}</td>
            <td className="cbo-td cbo-amount border-b-0 py-1 font-medium">
              {formatPeso(total, { symbol: false, parens: true })}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, amount }: { label: string; amount: Centavos }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 pl-4">
      <span className="text-sm text-navy-800">{label}</span>
      <span className="w-44 text-right font-mono text-sm tabular text-navy-900">
        {formatPeso(amount, { symbol: false, parens: true })}
      </span>
    </div>
  );
}

function GrandTotal({ label, value }: { label: string; value: Centavos }) {
  return (
    <div className="mt-2 flex items-baseline justify-between gap-4 border-t-2 border-navy-800 py-1.5">
      <span className="text-sm font-semibold text-navy-900">{label}</span>
      <span className="w-44 text-right font-mono text-sm font-semibold tabular text-navy-900">
        {formatPeso(value, { symbol: false, parens: true })}
      </span>
    </div>
  );
}

function CashFlowStatement({
  ledger,
  throughPeriod,
}: {
  ledger: Array<{ period: number; cashFlowClass?: string | null; accountCode: string; signedAmount: number }>;
  throughPeriod: number;
}) {
  const flows = useMemo(() => {
    const relevant = ledger.filter((e) => e.period <= throughPeriod);
    const cashAccounts = relevant.filter((e) => e.accountCode?.startsWith('1010'));

    const byClass = { OPERATING: 0, INVESTING: 0, FINANCING: 0 };
    for (const e of cashAccounts) {
      const cls = (e.cashFlowClass ?? 'OPERATING') as keyof typeof byClass;
      if (cls in byClass) byClass[cls] += e.signedAmount;
    }
    const net = byClass.OPERATING + byClass.INVESTING + byClass.FINANCING;
    return { ...byClass, net };
  }, [ledger, throughPeriod]);

  return (
    <>
      <Row label="Net cash from operating activities" amount={flows.OPERATING} />
      <Row label="Net cash from investing activities" amount={flows.INVESTING} />
      <Row label="Net cash from financing activities" amount={flows.FINANCING} />
      <GrandTotal label="Net increase in cash and cash equivalents" value={flows.net} />

      <Alert tone="info" className="mt-4">
        Classified by the cash-flow category recorded against each journal entry line. Lines posted
        without a classification are treated as operating; set the cash-flow classification on the
        account in the Chart of Accounts so future postings classify themselves.
      </Alert>
    </>
  );
}

function BudgetAndActual({
  budget,
  expenses,
}: {
  budget: Array<{ accountCode: string; accountName: string; appropriationRevised: number; obligated: number; disbursed: number }>;
  expenses: FsLine[];
}) {
  const rows = useMemo(() => {
    const map = new Map<string, { code: string; name: string; budget: number; obligated: number; actual: number }>();

    for (const b of budget) {
      const row = map.get(b.accountCode) ?? {
        code: b.accountCode,
        name: b.accountName,
        budget: 0,
        obligated: 0,
        actual: 0,
      };
      row.budget += b.appropriationRevised;
      row.obligated += b.obligated;
      map.set(b.accountCode, row);
    }

    // Actual expenditure comes from the ledger, not from the budget registry:
    // the whole point of this statement is to compare the two independently
    // derived figures.
    for (const e of expenses) {
      const row = map.get(e.accountCode) ?? {
        code: e.accountCode,
        name: e.accountName,
        budget: 0,
        obligated: 0,
        actual: 0,
      };
      row.actual += e.amount;
      map.set(e.accountCode, row);
    }

    return [...map.values()]
      .filter((r) => r.budget !== 0 || r.actual !== 0)
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [budget, expenses]);

  const totals = rows.reduce(
    (acc, r) => ({
      budget: acc.budget + r.budget,
      obligated: acc.obligated + r.obligated,
      actual: acc.actual + r.actual,
    }),
    { budget: 0, obligated: 0, actual: 0 },
  );

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className="cbo-th">Account</th>
          <th className="cbo-th text-right">Budget (revised appropriation)</th>
          <th className="cbo-th text-right">Obligations</th>
          <th className="cbo-th text-right">Actual (per ledger)</th>
          <th className="cbo-th text-right">Difference</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code}>
            <td className="cbo-td">
              <span className="font-mono text-xs text-slate-500">{r.code}</span>{' '}
              <span className="text-sm">{r.name}</span>
            </td>
            <td className="cbo-td cbo-amount">{formatPeso(r.budget, { symbol: false, dash: true })}</td>
            <td className="cbo-td cbo-amount">{formatPeso(r.obligated, { symbol: false, dash: true })}</td>
            <td className="cbo-td cbo-amount">{formatPeso(r.actual, { symbol: false, dash: true })}</td>
            <td className="cbo-td cbo-amount">{formatPeso(r.budget - r.actual, { symbol: false, parens: true })}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-navy-800 font-semibold">
          <td className="cbo-td border-b-0">Total</td>
          <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.budget, { symbol: false })}</td>
          <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.obligated, { symbol: false })}</td>
          <td className="cbo-td cbo-amount border-b-0">{formatPeso(totals.actual, { symbol: false })}</td>
          <td className="cbo-td cbo-amount border-b-0">
            {formatPeso(totals.budget - totals.actual, { symbol: false, parens: true })}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
