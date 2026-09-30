import { Fragment, useMemo, useState } from 'react';
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
import { FUND_BALANCE_CAPTIONS } from '@/lib/fsGroups';
import { buildEquityStatement, type EquityStatement } from './equityStatement';
import { isCashAccount } from '@/lib/cashFlowLines';
import {
  SECTION_LABELS,
  buildCashFlows,
  type CashFlowEntry,
  type CashFlowRow as CashFlowStatementRow,
} from './cashFlows';
import {
  condensePerformance,
  condensePosition,
  type CondensedLine,
  type CondensedPerformance,
  type CondensedPosition,
  type FsAccountBalance,
  type UnmappedBalance,
} from './condensedFs';
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
  /*
   * The comparative column. GAM Volume I, Sections 366 and 368: both
   * statements are presented "with comparative figure of the preceding year".
   *
   * The whole of the preceding year, not the same months of it. The comparative
   * is the year as it closed, which is the figure that was submitted; cutting
   * it to September because this year's column stops in September would print
   * a number nobody has ever seen.
   */
  const priorLedger = useLedgerEntries(fiscalYear - 1, fundCode, { throughPeriod: 12 });
  const budget = useBudgetBalances(fiscalYear, fundCode);

  const lines = useMemo<FsLine[]>(
    () => balancesFrom(ledger.data, accounts.data, throughPeriod),
    [ledger.data, accounts.data, throughPeriod],
  );

  /** The same balances for the whole of the preceding year. */
  const priorLines = useMemo<FsLine[]>(
    () => balancesFrom(priorLedger.data, accounts.data, 12),
    [priorLedger.data, accounts.data],
  );

  const condensed = useMemo(
    () => condensePosition(lines as FsAccountBalance[], priorLines as FsAccountBalance[]),
    [lines, priorLines],
  );
  const performance = useMemo(
    // The Trust Fund has its own shorter form, Annex 6-A.
    () => condensePerformance(lines as FsAccountBalance[], priorLines as FsAccountBalance[], fundCode),
    [lines, priorLines, fundCode],
  );

  const equityStatement = useMemo(
    () =>
      buildEquityStatement({
        current: lines as FsAccountBalance[],
        prior: priorLines as FsAccountBalance[],
        surplus: performance.surplus,
      }),
    [lines, priorLines, performance.surplus],
  );

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
          <p>
            Prepared from posted journal entries. No statement balance is stored anywhere in CBO,
            so the statements cannot disagree with the ledger.
          </p>
          {(statement === 'position' || statement === 'performance') && (
            <p className="mt-1">
              Presented in the condensed format GAM Volume I, Sections 366 and 368 prescribe:
              Annexes 5 and 6. Each line is an account group of the Revised Chart of Accounts, read
              off the account code, and the second money column is the whole of {fiscalYear - 1} as
              it closed — not the same months of it, which would be a figure nobody has seen.
            </p>
          )}
          {statement === 'performance' && (
            <p className="mt-1">
              &ldquo;Share from Internal Revenue Collections&rdquo; is account 40106010 alone;
              &ldquo;Other Share from National Taxes&rdquo; is the rest of sub-major group 4-01-06
              — Expanded VAT, National Wealth, Tobacco Excise and Economic Zones. Both sit inside
              major group 4-01 Tax Revenue in the chart and the annex prints them apart from it, so
              Tax Revenue above excludes them.
            </p>
          )}
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
        <PositionStatement
          data={condensed}
          fiscalYear={fiscalYear}
          surplus={performance.surplus}
        />
      ) : statement === 'performance' ? (
        <PerformanceStatement data={performance} fiscalYear={fiscalYear} />
      ) : statement === 'cashflow' ? (
        <CashFlowStatement
          ledger={ledger.data as unknown as CashFlowEntry[]}
          priorLedger={priorLedger.data}
          throughPeriod={throughPeriod}
          fiscalYear={fiscalYear}
          fundCode={fundCode}
        />
      ) : statement === 'equity' ? (
        <EquityStatementView data={equityStatement} fiscalYear={fiscalYear} />
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

/**
 * The Statement of Cash Flows, Annex 9.
 *
 * The statement CBO shipped with read the cash-flow class off the cash line of
 * each entry and printed three net figures. That could not work: the class of
 * a cash account is always OPERATING, and every posting routine on the server
 * writes that literal in any case, so the investing and financing lines were
 * structurally incapable of carrying anything. What replaces it is the direct
 * method the annex actually prescribes - see lib/cashFlowLines.ts for why it
 * needs no allocation rule.
 */
function CashFlowStatement({
  ledger,
  priorLedger,
  throughPeriod,
  fiscalYear,
  fundCode,
}: {
  ledger: CashFlowEntry[];
  priorLedger: Array<{ accountCode: string; signedAmount: number }>;
  throughPeriod: number;
  fiscalYear: number;
  fundCode?: string;
}) {
  const priorClosingCash = useMemo(
    () =>
      priorLedger
        .filter((e) => isCashAccount(e.accountCode))
        .reduce((s, e) => s + e.signedAmount, 0),
    [priorLedger],
  );

  const data = useMemo(
    () => buildCashFlows({ entries: ledger, throughPeriod, priorClosingCash, fundCode }),
    [ledger, throughPeriod, priorClosingCash, fundCode],
  );

  const openedTwice = data.priorClosingCash !== 0 && data.openingFromOpeningEntry !== 0;

  return (
    <>
      {!data.tiesOut && (
        <Alert tone="error" className="mb-4">
          <p className="font-medium">This statement does not tie to the General Ledger.</p>
          <p className="mt-1">
            It reports a closing balance of {formatPeso(data.closingCash)} while the cash accounts
            in the ledger stand at {formatPeso(data.closingCashPerLedger)} — a difference of{' '}
            {formatPeso(data.drift)}. Nothing on this statement is rounded or apportioned, so a
            difference of even one centavo is a real defect and not an artefact. Do not submit it
            until the cause is found.
          </p>
          {data.unbalanced.length > 0 && (
            <p className="mt-1">
              {data.unbalanced.length === 1 ? 'This journal entry does' : 'These journal entries do'}{' '}
              not foot:{' '}
              {data.unbalanced.map((u) => `${u.jevNo} (out by ${formatPeso(u.difference)})`).join('; ')}.
            </p>
          )}
        </Alert>
      )}

      {openedTwice && (
        <Alert tone="warning" className="mb-4">
          {fiscalYear} carries an opening-balance journal entry of{' '}
          {formatPeso(data.openingFromOpeningEntry)} even though {fiscalYear - 1} is already in CBO
          and closed with {formatPeso(data.priorClosingCash)} in cash. Opening balances are encoded
          once, on conversion; the year opened twice over and the opening line below is the sum of
          both.
        </Alert>
      )}

      {data.blocks.map((block) => (
        <StatementSection key={block.section} title={SECTION_LABELS[block.section]}>
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">
            Cash Inflows
          </p>
          {block.inflows.map((r) => (
            <CashFlowRowView key={r.caption} row={r} />
          ))}
          <Row label="Total Cash Inflows" amount={block.totalIn} />

          <p className="mb-1 mt-3 text-xs font-medium uppercase tracking-wider text-slate-500">
            Cash Outflows
          </p>
          {block.outflows.map((r) => (
            <CashFlowRowView key={r.caption} row={r} />
          ))}
          <Row label="Total Cash Outflows" amount={block.totalOut} />

          <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-slate-300 py-1">
            <span className="text-sm font-medium text-navy-900">
              Net Cash Provided by (Used in) {SECTION_LABELS[block.section].replace('Cash Flows From ', '')}
            </span>
            <span className="w-44 text-right font-mono text-sm font-medium tabular text-navy-900">
              {formatPeso(block.net, { symbol: false, parens: true })}
            </span>
          </div>
        </StatementSection>
      ))}

      <Row
        label="Total Cash Provided by Operating, Investing and Financing Activities"
        amount={data.netFlows}
      />
      <Row label={`Add: Cash Balance, Beginning ${fiscalYear}`} amount={data.openingCash} />
      <GrandTotal label="Cash Balance, End of the Period" value={data.closingCash} />

      {data.tiesOut && (
        <Alert tone="success" className="mt-4">
          This statement ties to the General Ledger exactly: the closing balance above is the
          balance of the cash accounts in the ledger, to the centavo. The two were built from
          different lines of the same journal entries — this statement from the counterpart lines,
          the ledger balance from the cash lines — so they agree only if every entry was counted
          once and in full.
        </Alert>
      )}

      <Alert tone="info" className="mt-3">
        <p>
          Prepared by the direct method, GAM Annex 9. Each caption is the counterpart of the cash
          line in the journal entry: a cheque drawn against Salaries and Wages is a payment to
          employees, one drawn against Office Equipment is a purchase of Property, Plant and
          Equipment. Because a journal entry balances, each counterpart line accounts for exactly
          its own amount of the cash that moved — nothing here is apportioned or estimated.
        </p>
        <p className="mt-1">
          {data.cashEntries.toLocaleString()} journal{' '}
          {data.cashEntries === 1 ? 'entry' : 'entries'} moved cash and{' '}
          {data.transferEntries.toLocaleString()}{' '}
          {data.transferEntries === 1 ? 'was a transfer' : 'were transfers'} between cash accounts —
          a deposit of collections, or a movement between bank accounts. Transfers are deliberately
          absent: the money was reported when it was collected, and reporting it again on deposit
          would double the statement.
        </p>
        <p className="mt-1">
          Amounts are shown gross. Where tax is withheld from a payment, the full expense appears as
          an outflow and the tax withheld as a receipt, because the LGU kept that money until it is
          remitted. The two net to the cash that left the bank.
        </p>
        {fundCode === 'TF' && (
          <p className="mt-1">
            The Trust Fund is presented on Annex 9-A, the shorter face: one operating receipt line,
            two payment lines, and investing and financing shown only where there is something in
            them.
          </p>
        )}
      </Alert>

      <Alert tone="warning" className="mt-3">
        Until this release the investing and financing sections of this statement could never carry
        anything, whatever Candoni bought or borrowed, because they were read from a classification
        the server writes as &ldquo;operating&rdquo; on every line it posts. Any Statement of Cash
        Flows printed from CBO before this release showed the whole year under operating activities
        and should not be relied on.
      </Alert>
    </>
  );
}

/** One caption, with the counterpart accounts behind it available on demand. */
function CashFlowRowView({ row }: { row: CashFlowStatementRow }) {
  const [open, setOpen] = useState(false);
  const canOpen = row.accounts.length > 0;

  return (
    <>
      <div className="flex items-baseline justify-between gap-4 py-1 pl-4">
        {canOpen ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-left text-sm text-navy-800 underline decoration-dotted underline-offset-2 hover:text-navy-900"
          >
            {row.caption}
          </button>
        ) : (
          <span className="text-sm text-slate-400">{row.caption}</span>
        )}
        <span
          className={`w-44 text-right font-mono text-sm tabular ${row.amount === 0 ? 'text-slate-400' : 'text-navy-900'}`}
        >
          {formatPeso(row.amount, { symbol: false, parens: true })}
        </span>
      </div>
      {open &&
        row.accounts.map((a) => (
          <div key={a.accountCode} className="flex items-baseline justify-between gap-4 py-0.5 pl-10">
            <span className="text-xs text-slate-500">
              <span className="font-mono text-2xs text-slate-400">{a.accountCode}</span>{' '}
              {a.accountName}
            </span>
            <span className="w-44 text-right font-mono text-xs tabular text-slate-500">
              {formatPeso(a.amount, { symbol: false, parens: true })}
            </span>
          </div>
        ))}
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

/**
 * Account balances for a year, sign-adjusted for presentation.
 *
 * Pulled out of the component because the comparative column needs the same
 * computation over a different year. Two copies of the sign convention is how
 * a statement comes to show last year's revenue as negative.
 */
function balancesFrom(
  entries: Array<{ accountCode: string; accountName: string; period: number; signedAmount?: number }>,
  accounts: Array<{ code: string; fsClassification?: string | null }>,
  throughPeriod: number,
): FsLine[] {
  const byAccount = new Map<string, { name: string; signed: Centavos }>();

  for (const e of entries) {
    if (e.period > throughPeriod) continue;
    const entry = byAccount.get(e.accountCode) ?? { name: e.accountName, signed: 0 };
    entry.signed += e.signedAmount ?? 0;
    byAccount.set(e.accountCode, entry);
  }

  const out: FsLine[] = [];
  for (const [code, value] of byAccount) {
    const account = accounts.find((a) => a.code === code);
    const classification = (account?.fsClassification ?? 'NON_FINANCIAL_ITEM') as FsClassification;
    // Debit-positive signed balance, flipped for credit-normal accounts so
    // every figure presents as a positive number on the face of the statement.
    const amount = CREDIT_NORMAL.includes(classification) ? -value.signed : value.signed;
    if (amount === 0) continue;
    out.push({ accountCode: code, accountName: value.name, classification, amount });
  }

  return out.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

// ---------------------------------------------------------------------------
// The condensed statements, Annexes 5 and 6
// ---------------------------------------------------------------------------

/** Two money columns: this year and the one before it, as the annexes print them. */
function TwoYearRow({
  label,
  current,
  prior,
  indent = 0,
  emphasis,
  rule,
  note,
}: {
  label: string;
  current: Centavos;
  prior: Centavos;
  indent?: number;
  emphasis?: boolean;
  rule?: boolean;
  note?: string;
}) {
  return (
    <tr
      className={`${rule ? 'border-t border-slate-300' : 'border-b border-slate-100'} ${
        emphasis ? 'font-semibold text-navy-900' : 'text-slate-700'
      }`}
    >
      <td className="cbo-td" style={{ paddingLeft: `${0.5 + indent * 1.25}rem` }}>
        {label}
      </td>
      <td className="cbo-td text-center text-xs text-slate-500" style={{ width: '4rem' }}>
        {note ?? ''}
      </td>
      <td className="cbo-td cbo-amount" style={{ width: '10rem' }}>
        {formatPeso(current)}
      </td>
      <td className="cbo-td cbo-amount text-slate-500" style={{ width: '10rem' }}>
        {formatPeso(prior)}
      </td>
    </tr>
  );
}

function TwoYearHead({ fiscalYear }: { fiscalYear: number }) {
  return (
    <thead>
      <tr className="border-b border-slate-300 text-slate-600">
        <th className="cbo-th text-left" />
        <th className="cbo-th text-center" style={{ width: '4rem' }}>
          Note
        </th>
        <th className="cbo-th text-right" style={{ width: '10rem' }}>
          {fiscalYear}
        </th>
        <th className="cbo-th text-right" style={{ width: '10rem' }}>
          {fiscalYear - 1}
        </th>
      </tr>
    </thead>
  );
}

function CaptionLines({ lines }: { lines: CondensedLine[] }) {
  return (
    <>
      {lines.map((l) => (
        <TwoYearRow key={l.caption} label={l.caption} current={l.current} prior={l.prior} indent={1} />
      ))}
    </>
  );
}

/**
 * Anything the statement could not place.
 *
 * Shown above the statement and not below it. A condensed statement goes on
 * balancing when an account is missing from it, so this is the only thing
 * standing between a dropped figure and a submitted return.
 */
function Unplaced({ rows }: { rows: UnmappedBalance[] }) {
  if (rows.length === 0) return null;
  return (
    <Alert
      tone="error"
      title={`${rows.length} account${rows.length === 1 ? '' : 's'} could not be placed on this statement`}
      className="mb-4"
    >
      <p className="mb-2">
        These carry a balance and appear under no caption, so the statement below is incomplete —
        and it still balances, which is why this is an error and not a note.
      </p>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.accountCode} className="font-mono text-xs">
            {r.accountCode} {r.accountName} — {formatPeso(r.current)}
            <span className="ml-2 font-sans text-slate-600">{r.reason}</span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function PositionStatement({
  data,
  fiscalYear,
  surplus,
}: {
  data: CondensedPosition;
  fiscalYear: number;
  surplus: { current: Centavos; prior: Centavos };
}) {
  const sec = (key: string) => data.sections.find((s) => s.key === key)!;
  const equityCurrent = data.equityTotal.current + surplus.current;
  const equityPrior = data.equityTotal.prior + surplus.prior;
  const balanced =
    data.totalAssets.current === data.totalLiabilities.current + equityCurrent;

  return (
    <>
      <Unplaced rows={data.unmapped} />

      <table className="w-full text-sm">
        <TwoYearHead fiscalYear={fiscalYear} />
        <tbody>
          <TwoYearRow label="ASSETS" current={0} prior={0} emphasis />
          {(['CURRENT_ASSET', 'NON_CURRENT_ASSET'] as const).map((key) => (
            <Fragment key={key}>
              <TwoYearRow label={sec(key).title} current={0} prior={0} indent={1} />
              <CaptionLines lines={sec(key).lines} />
              <TwoYearRow
                label={sec(key).totalLabel}
                current={sec(key).totalCurrent}
                prior={sec(key).totalPrior}
                indent={2}
                rule
              />
            </Fragment>
          ))}
          <TwoYearRow
            label="TOTAL ASSETS"
            current={data.totalAssets.current}
            prior={data.totalAssets.prior}
            emphasis
            rule
          />

          <TwoYearRow label="LIABILITIES" current={0} prior={0} emphasis />
          {(['CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY'] as const).map((key) => (
            <Fragment key={key}>
              <TwoYearRow label={sec(key).title} current={0} prior={0} indent={1} />
              <CaptionLines lines={sec(key).lines} />
              <TwoYearRow
                label={sec(key).totalLabel}
                current={sec(key).totalCurrent}
                prior={sec(key).totalPrior}
                indent={2}
                rule
              />
            </Fragment>
          ))}
          <TwoYearRow
            label="TOTAL LIABILITIES"
            current={data.totalLiabilities.current}
            prior={data.totalLiabilities.prior}
            emphasis
            rule
          />

          <TwoYearRow label="NET ASSETS/EQUITY" current={0} prior={0} emphasis />
          <CaptionLines lines={data.equity} />
          <TwoYearRow
            label="Surplus (Deficit) for the period"
            current={surplus.current}
            prior={surplus.prior}
            indent={1}
          />
          <TwoYearRow
            label="TOTAL LIABILITIES AND NET ASSETS/EQUITY"
            current={data.totalLiabilities.current + equityCurrent}
            prior={data.totalLiabilities.prior + equityPrior}
            emphasis
            rule
          />
        </tbody>
      </table>

      {!balanced && (
        <Alert tone="error" className="mt-4" title="The statement does not balance">
          Total assets of {formatPeso(data.totalAssets.current)} do not equal liabilities plus net
          assets of {formatPeso(data.totalLiabilities.current + equityCurrent)}.
        </Alert>
      )}

      {/*
        Annex 5 prints a Fund Balance block beneath Government Equity. CBO
        cannot fill it from the ledger and says so rather than leaving four
        blank lines for the reader to wonder about.
      */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Fund Balance</p>
        <table className="mt-2 w-full text-sm">
          <tbody>
            {FUND_BALANCE_CAPTIONS.map((c) => (
              <tr key={c} className="border-b border-slate-100 text-slate-700">
                <td className="cbo-td">{c}</td>
                <td className="cbo-td cbo-amount text-slate-400" style={{ width: '10rem' }}>
                  —
                </td>
                <td className="cbo-td cbo-amount text-slate-400" style={{ width: '10rem' }}>
                  —
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">
          Blank on purpose. The budgetary registry accounts (3-05) are not postable in CBO — the
          registry is kept in the budget balances the Cloud Functions maintain and is never
          journalised — so the general ledger carries nothing against them. These figures can be
          derived from the Registry instead, but which registry figure answers to which caption is
          a decision for the Accountant, and one wrong mapping here is a wrong figure on a
          submitted statement.
          {data.fundBalanceAccounts.length > 0 && (
            <>
              {' '}
              <span className="text-amber-700">
                {data.fundBalanceAccounts.length} registry account
                {data.fundBalanceAccounts.length === 1 ? ' has' : 's have'} been posted to
                notwithstanding; that should not happen and is worth looking at.
              </span>
            </>
          )}
        </p>
      </section>
    </>
  );
}

function PerformanceStatement({
  data,
  fiscalYear,
}: {
  data: CondensedPerformance;
  fiscalYear: number;
}) {
  return (
    <>
      <Unplaced rows={data.unmapped} />

      <table className="w-full text-sm">
        <TwoYearHead fiscalYear={fiscalYear} />
        <tbody>
          <TwoYearRow label="Revenue" current={0} prior={0} emphasis />
          <CaptionLines lines={data.revenue} />
          <TwoYearRow
            label="Total Revenue"
            current={data.totalRevenue.current}
            prior={data.totalRevenue.prior}
            emphasis
            rule
          />

          <TwoYearRow label="Less: Current Operating Expenses" current={0} prior={0} emphasis />
          <CaptionLines lines={data.expenses} />
          <TwoYearRow
            label="Current Operating Expenses"
            current={data.totalExpenses.current}
            prior={data.totalExpenses.prior}
            emphasis
            rule
          />

          <TwoYearRow
            label="Surplus (Deficit) from Current Operation"
            current={data.surplusFromOperation.current}
            prior={data.surplusFromOperation.prior}
            emphasis
            rule
          />
          <TwoYearRow label="Add (Deduct):" current={0} prior={0} />
          <TwoYearRow
            label="Transfers and Subsidy From"
            current={data.transfersFrom.current}
            prior={data.transfersFrom.prior}
            indent={1}
          />
          <TwoYearRow
            label="Transfers and Subsidy To"
            current={-data.transfersTo.current}
            prior={-data.transfersTo.prior}
            indent={1}
          />
          <TwoYearRow
            label="Surplus (Deficit) for the period"
            current={data.surplus.current}
            prior={data.surplus.prior}
            emphasis
            rule
          />
        </tbody>
      </table>
    </>
  );
}

/**
 * Annex 7, the Statement of Changes in Net Assets/Equity.
 *
 * Eight lines and the manual's own wording for each. The comparative column's
 * opening balance is blank rather than nil: with two years of ledger loaded,
 * the close of the year before the comparative one is not knowable, and a zero
 * there would read as a municipality that began with nothing.
 */
function EquityStatementView({
  data,
  fiscalYear,
}: {
  data: EquityStatement;
  fiscalYear: number;
}) {
  const priorOpeningKnown = data.openingBalance.prior !== 0;

  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-slate-600">
            <th className="cbo-th text-left" />
            <th className="cbo-th text-right" style={{ width: '10rem' }}>
              {fiscalYear}
            </th>
            <th className="cbo-th text-right" style={{ width: '10rem' }}>
              {fiscalYear - 1}
            </th>
          </tr>
        </thead>
        <tbody>
          <EquityRow
            label={`Balance at January 1, ${fiscalYear}`}
            current={data.openingBalance.current}
            prior={data.openingBalance.prior}
            priorBlank={!priorOpeningKnown}
          />
          <EquityRow label="Add (Deduct)" current={null} prior={null} />
          <EquityRow
            label="Change in Accounting Policy"
            current={data.changeInAccountingPolicy.current}
            prior={data.changeInAccountingPolicy.prior}
            indent
          />
          <EquityRow
            label="Prior Period Errors"
            current={data.priorPeriodErrors.current}
            prior={data.priorPeriodErrors.prior}
            indent
          />
          <EquityRow
            label="Restated Balance"
            current={data.restatedBalance.current}
            prior={data.restatedBalance.prior}
            priorBlank={!priorOpeningKnown}
            rule
          />
          <EquityRow
            label="Add (Deduct) Changes in net assets/equity during the year"
            current={null}
            prior={null}
          />
          <EquityRow
            label="Adjustment of net revenue recognized directly in net assets/equity"
            current={data.adjustmentRecognisedInEquity.current}
            prior={data.adjustmentRecognisedInEquity.prior}
            indent
          />
          <EquityRow
            label="Surplus (Deficit) for the period"
            current={data.surplus.current}
            prior={data.surplus.prior}
            indent
          />
          <EquityRow
            label="Total recognized revenue and expenses for the period"
            current={data.totalRecognised.current}
            prior={data.totalRecognised.prior}
            rule
          />
          <EquityRow
            label={`Balance at December 31, ${fiscalYear}`}
            current={data.closingBalance.current}
            prior={data.closingBalance.prior}
            priorBlank={!priorOpeningKnown}
            emphasis
            rule
          />
        </tbody>
      </table>

      {data.accountingPolicyNotTracked && (
        <p className="mt-3 text-xs text-slate-500">
          Change in Accounting Policy is nil because no account holds one: a change of policy is
          restated through the accounts it affects rather than booked to one of its own. The line is
          printed because Annex 7 prints it.
        </p>
      )}
      {!priorOpeningKnown && (
        <p className="mt-1 text-xs text-slate-500">
          The {fiscalYear - 1} column has no opening balance because the close of {fiscalYear - 2} is
          not in the ledger this screen reads. Blank rather than nil — nil would read as a
          municipality that began with nothing.
        </p>
      )}
    </>
  );
}

function EquityRow({
  label,
  current,
  prior,
  indent,
  emphasis,
  rule,
  priorBlank,
}: {
  label: string;
  current: Centavos | null;
  prior: Centavos | null;
  indent?: boolean;
  emphasis?: boolean;
  rule?: boolean;
  priorBlank?: boolean;
}) {
  return (
    <tr
      className={`${rule ? 'border-t border-slate-300' : 'border-b border-slate-100'} ${
        emphasis ? 'font-semibold text-navy-900' : 'text-slate-700'
      }`}
    >
      <td className="cbo-td" style={{ paddingLeft: indent ? '2rem' : '0.5rem' }}>
        {label}
      </td>
      <td className="cbo-td cbo-amount">{current === null ? '' : formatPeso(current)}</td>
      <td className="cbo-td cbo-amount text-slate-500">
        {prior === null || priorBlank ? '' : formatPeso(prior)}
      </td>
    </tr>
  );
}
