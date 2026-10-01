import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader, Card, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { useAccounts } from '@/data/queries';
import { engine } from '@/lib/engine';
import { readSheet, findText, type SheetRow } from '@/lib/spreadsheet';
import {
  checkChart,
  checkNamedAccounts,
  deriveAccount,
  isContraAccount,
  type ChartRowInput,
  type DerivedAccount,
} from '@/lib/chartOfAccounts';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';

/**
 * Loading the Revised Chart of Accounts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN PREVIEWS BEFORE IT LOADS
 * ---------------------------------------------------------------------------
 * COA publishes a code and a title. Everything else CFMS needs — the account
 * class, which way the account normally moves, where it lands on the
 * statements, whether it may be posted to at all — is derived from the code.
 *
 * Six hundred accounts is too many to check afterwards, and the derivations
 * that matter most are the ones nobody would think to look at: a hundred and
 * thirty-eight contra accounts that must move against their class, and
 * twenty-five registry accounts that must not be posted to. So the whole
 * classification is shown here, summarised and searchable, before a single
 * document is written.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEFAULT KEEPS WHAT THE OFFICE CHANGED
 * ---------------------------------------------------------------------------
 * The derivation is a starting point, not a ruling: which accounts need a
 * subsidiary ledger, and where one sits between current and non-current, are
 * the Accountant's decisions, and the Chart of Accounts screen exists for them
 * to be made. A second load — to add accounts, or after COA revises the list —
 * updates titles and leaves those decisions alone, because re-deriving would
 * quietly undo a year of corrections and nobody would find out until a
 * statement moved.
 * ---------------------------------------------------------------------------
 */

const COLUMNS = {
  code: [/account\s*code/i, /^code$/i, /uacs/i, /^acct/i],
  name: [/account\s*(title|name)/i, /^title$/i, /^name$/i, /description/i],
};

interface PreviewRow extends ChartRowInput {
  account: DerivedAccount | null;
}

export default function ChartUpload() {
  const { hasRole } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const existing = useAccounts(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [mode, setMode] = useState<'KEEP_EDITS' | 'REDERIVE'>('KEEP_EDITS');
  const [filter, setFilter] = useState('');

  const canLoad = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const check = useMemo(() => (rows.length ? checkChart(rows) : null), [rows]);
  /*
   * A chart can be perfectly well formed and still not contain the accounts
   * CFMS posts to by code - or contain them under different titles, which is
   * worse, because the postings then go to the wrong account and balance
   * while doing it.
   */
  const namedAccounts = useMemo(
    () => (rows.length ? checkNamedAccounts(rows) : []),
    [rows],
  );
  const unclassified = useMemo(() => rows.filter((r) => r.account === null), [rows]);

  const summary = useMemo(() => {
    const accounts = rows.map((r) => r.account).filter((a): a is DerivedAccount => a !== null);
    const tally = <T extends string>(pick: (a: DerivedAccount) => T) =>
      accounts.reduce<Record<string, number>>((m, a) => {
        const k = pick(a);
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {});
    return {
      total: accounts.length,
      byClass: tally((a) => a.accountClass),
      contra: accounts.filter((a) => isContraAccount(a.name)).length,
      notPostable: accounts.filter((a) => !a.postable).length,
      subsidiary: accounts.filter((a) => a.requiresSubsidiary).length,
      byExpenseClass: tally((a) => (a.expenseClass ?? 'none') as string),
    };
  }, [rows]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? rows.filter(
          (r) => r.code.includes(q) || r.name.toLowerCase().includes(q),
        )
      : rows;
    return list.slice(0, 200);
  }, [rows, filter]);

  const read = async (file: File) => {
    setReading(true);
    try {
      const sheet = await readSheet(file);
      const parsed: PreviewRow[] = [];

      sheet.forEach((raw: SheetRow, i) => {
        const code = findText(raw, COLUMNS.code);
        const name = findText(raw, COLUMNS.name);
        if (!code && !name) return;
        const row: ChartRowInput = { lineNo: i + 1, code, name };
        parsed.push({ ...row, account: deriveAccount(row) });
      });

      if (parsed.length === 0) {
        toast.error(
          'Nothing was read',
          'CFMS could not find an account code and an account title in that file. The first row should be the column headings.',
        );
        return;
      }

      setRows(parsed);
      setFileName(file.name);
      toast.success(
        `${parsed.length} account${parsed.length === 1 ? '' : 's'} read from ${file.name}`,
        'Nothing has been loaded yet. Check the classification below, then load.',
      );
    } catch (err) {
      toast.error('That file could not be read', err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const load = async () => {
    setSaving(true);
    try {
      const result = await engine.importChartOfAccounts({
        rows: rows.map((r) => ({ code: r.code, name: r.name })),
        fileName,
        mode,
      });
      toast.success(
        `${result.total} accounts loaded`,
        `${result.created} new, ${result.updated} updated, ${result.unchanged} already as they were.`,
      );
      setRows([]);
      setFileName('');
      navigate('/master-data/accounts');
    } catch (err) {
      toast.error('Nothing was loaded', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const ready = rows.length > 0 && check?.ok && unclassified.length === 0;

  return (
    <div>
      <PageHeader
        title="Load the Chart of Accounts"
        subtitle="A code and a title per row. Every classification is derived from the code."
        breadcrumbs={[
          { label: 'Master Data' },
          { label: 'Chart of Accounts', to: '/master-data/accounts' },
          { label: 'Load' },
        ]}
        actions={
          canLoad ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void read(file);
                }}
              />
              <Button size="sm" loading={reading} onClick={() => fileInput.current?.click()}>
                Choose a file
              </Button>
            </>
          ) : undefined
        }
      />

      {!canLoad && (
        <Alert tone="warning" className="mb-4">
          Only the Municipal Accountant and an administrator may load the chart. An account&rsquo;s
          classification decides where it appears on every financial statement, so changing one
          restates prior periods.
        </Alert>
      )}

      {existing.data.length > 0 && rows.length === 0 && (
        <Alert tone="info" className="mb-4">
          There {existing.data.length === 1 ? 'is' : 'are'} already{' '}
          <strong>{existing.data.length}</strong> account
          {existing.data.length === 1 ? '' : 's'} in the chart. Loading a file again adds what is
          new and updates the titles; it does not delete anything.
        </Alert>
      )}

      {rows.length === 0 ? (
        <Card title="What the file should look like">
          <p className="text-sm text-slate-700">
            Two columns, with the headings on the first row:
          </p>
          <table className="mt-3 border-collapse text-xs">
            <thead>
              <tr>
                <th className="cbo-th">Account Code</th>
                <th className="cbo-th">Account Title</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="cbo-td font-mono">10101010</td>
                <td className="cbo-td">Cash Local Treasury</td>
              </tr>
              <tr>
                <td className="cbo-td font-mono">50203010</td>
                <td className="cbo-td">Office Supplies Expenses</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-4 text-sm text-slate-700">
            CSV or Excel. The code must be the eight digits of the Revised Chart of Accounts for
            Local Government Units &mdash; the digits are what every classification is read out of,
            so a code of another shape cannot be classified at all.
          </p>
          <p className="mt-2 text-sm text-slate-700">
            The municipality&rsquo;s own chart ships with CFMS as{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
              data/chart-of-accounts.csv
            </code>
            .
          </p>
        </Card>
      ) : (
        <>
          {check && !check.ok && (
            <Alert tone="error" title="This file cannot be loaded" className="mb-4">
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {check.violations.slice(0, 6).map((v, i) => (
                  <li key={i}>{v.message}</li>
                ))}
              </ul>
              {check.violations.length > 6 && (
                <p className="mt-1">and {check.violations.length - 6} more.</p>
              )}
            </Alert>
          )}

          {namedAccounts.length > 0 && (
            <Alert
              tone="warning"
              title="CFMS posts to accounts this chart does not have under those titles"
              className="mb-4"
            >
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {namedAccounts.map((v, i) => (
                  <li key={i}>{v.message}</li>
                ))}
              </ul>
              <p className="mt-1">
                The chart will still load. But a collection, a deposit, a payroll or a voucher
                posted afterwards will go to whichever account carries that code, and it will
                balance while doing it — so nothing later will report the mistake.
              </p>
            </Alert>
          )}

          {unclassified.length > 0 && (
            <Alert
              tone="error"
              title={`${unclassified.length} account${
                unclassified.length === 1 ? '' : 's'
              } cannot be classified`}
              className="mb-4"
            >
              {unclassified.slice(0, 10).map((r) => r.code).join(', ')}
              {unclassified.length > 10 ? ', and others' : ''}. A Revised Chart of Accounts code
              begins with 1 to 5 &mdash; asset, liability, equity, revenue or expense.
            </Alert>
          )}

          <Card
            title={`${summary.total} accounts read from ${fileName}`}
            subtitle="Nothing has been written yet."
            className="mb-4"
            footer={
              /*
               * items-end, so the buttons sit level with the BOTTOM of the
               * select beside them. Centred, they floated up beside the
               * label instead, which reads as though they belonged to it.
               */
              canLoad ? (
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <Field label="Accounts already in the chart" className="w-80">
                    <Select
                      value={mode}
                      onChange={(e) => setMode(e.target.value as 'KEEP_EDITS' | 'REDERIVE')}
                    >
                      <option value="KEEP_EDITS">
                        Update the title only, keep my corrections
                      </option>
                      <option value="REDERIVE">Re-classify everything from the code</option>
                    </Select>
                  </Field>
                  <div className="flex gap-2">
                    <Button onClick={() => setRows([])}>Discard</Button>
                    <Button
                      variant="primary"
                      loading={saving}
                      disabled={!ready || saving}
                      onClick={() => void load()}
                    >
                      Load the chart
                    </Button>
                  </div>
                </div>
              ) : undefined
            }
          >
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Assets" value={summary.byClass.ASSET ?? 0} />
              <Stat label="Liabilities" value={summary.byClass.LIABILITY ?? 0} />
              <Stat label="Equity" value={summary.byClass.EQUITY ?? 0} />
              <Stat label="Revenue" value={summary.byClass.REVENUE ?? 0} />
              <Stat label="Expenses" value={summary.byClass.EXPENSE ?? 0} />
              <Stat
                label="Contra accounts"
                value={summary.contra}
                hint="Turned around, so they reduce rather than add"
              />
              <Stat
                label="Registry accounts"
                value={summary.notPostable}
                hint="Loaded but not postable — CFMS keeps the budget registry itself"
              />
              <Stat
                label="Need a subsidiary"
                value={summary.subsidiary}
                hint="Payables, receivables and cash advances"
              />
            </dl>

            <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-medium text-navy-900">Chargeable to a budget line</p>
              <p className="mt-1 text-xs text-slate-600">
                {(['PS', 'MOOE', 'FE', 'CO'] as ExpenseClass[])
                  .map(
                    (c) =>
                      `${summary.byExpenseClass[c] ?? 0} ${EXPENSE_CLASS_LABELS[c]}`,
                  )
                  .join(' · ')}
              </p>
              <p className="mt-1 text-2xs text-slate-500">
                Capital Outlay has no expense account in the Revised Chart of Accounts &mdash; it
                is charged to the asset acquired, so the Capital Outlay figure above is the
                buildings, equipment, software and other capitalisable assets.
              </p>
            </div>

            {mode === 'REDERIVE' && (
              <Alert tone="warning" className="mt-4">
                Every account already in the chart will be re-classified from its code, and any
                correction the office has made to it will be overwritten. Choose this only after a
                COA revision, and only if nobody has corrected the chart since the last load.
              </Alert>
            )}
          </Card>

          <Card title="What each account will be loaded as" bodyClassName="p-0">
            <div className="border-b border-slate-200 p-3">
              <input
                className="cbo-input w-full max-w-md"
                placeholder="Search by code or title"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Code</th>
                    <th className="px-2 py-1.5 font-medium">Title</th>
                    <th className="px-2 py-1.5 font-medium">Class</th>
                    <th className="px-2 py-1.5 font-medium">Normal</th>
                    <th className="px-2 py-1.5 font-medium">Statement</th>
                    <th className="px-2 py-1.5 font-medium">Cash flow</th>
                    <th className="px-2 py-1.5 font-medium">Budget</th>
                    <th className="px-2 py-1.5 font-medium">Postable</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((r) => (
                    <tr key={r.code} className={r.account ? undefined : 'bg-rose-50'}>
                      <td className="px-2 py-1 font-mono text-slate-500">{r.code}</td>
                      <td className="px-2 py-1">{r.name}</td>
                      <td className="px-2 py-1">{r.account?.accountClass ?? '—'}</td>
                      <td className="px-2 py-1">
                        <span
                          className={
                            r.account && isContraAccount(r.name)
                              ? 'font-medium text-amber-800'
                              : undefined
                          }
                        >
                          {r.account?.normalBalance ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-slate-600">
                        {r.account?.fsClassification.replace(/_/g, ' ').toLowerCase() ?? '—'}
                      </td>
                      <td className="px-2 py-1 text-slate-600">
                        {r.account?.cashFlowClass.toLowerCase() ?? '—'}
                      </td>
                      <td className="px-2 py-1">{r.account?.expenseClass ?? ''}</td>
                      <td className="px-2 py-1">
                        {r.account ? (
                          r.account.postable ? (
                            ''
                          ) : (
                            <span className="text-2xs text-slate-500">registry only</span>
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > shown.length && (
              <div className="border-t border-slate-200 p-3 text-xs text-slate-500">
                Showing {shown.length} of {rows.length}. Search above to find the rest — all{' '}
                {rows.length} will be loaded.
              </div>
            )}
          </Card>

          <p className="mt-4 text-xs text-slate-500">
            Every classification here can be changed afterwards, one account at a time, on{' '}
            <Link className="underline" to="/master-data/accounts">
              Master Data &rsaquo; Chart of Accounts
            </Link>
            .
          </p>
        </>
      )}

      {reading && <Spinner label="Reading the file" />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded border border-slate-200 p-3">
      <dt className="text-xs font-medium text-navy-800">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg text-navy-900">{value}</dd>
      {hint && <dd className="mt-0.5 text-2xs leading-snug text-slate-500">{hint}</dd>}
    </div>
  );
}
