import { useMemo, useRef, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, DateInput, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useOffices, useAccounts } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import { fundLabel } from './Obligations';
import { parseBudgetFile, type ParsedBudgetRow } from './parseBudget';

/**
 * Uploading the appropriation ordinance, and allotment releases.
 *
 * One screen for both, because they are the same act on two different figures:
 * a spreadsheet the Budget Office already keeps, read line by line into the
 * budget ledger.
 *
 * The screen checks the whole file against the Chart of Accounts and the office
 * list before anything is sent, and refuses to send while any row is unusable.
 * That is not politeness - the engine applies the same rule and would reject
 * the file anyway. Doing it here means the Budget Officer sees all forty
 * problems at once and fixes them in one pass, rather than learning about them
 * one upload at a time.
 */

const KINDS = [
  { value: 'ORIGINAL', label: 'Original appropriation', hint: 'The annual budget as enacted.' },
  { value: 'SUPPLEMENTAL', label: 'Supplemental', hint: 'Additional authority enacted during the year.' },
  { value: 'CONTINUING', label: 'Continuing', hint: 'Authority carried forward from the previous year.' },
  { value: 'REALIGNMENT', label: 'Realignment', hint: 'Moves authority between lines. Amounts may be negative.' },
  { value: 'TRANSFER', label: 'Transfer', hint: 'Moves authority between offices. Amounts may be negative.' },
  { value: 'ADJUSTMENT', label: 'Adjustment', hint: 'A correction. Amounts may be negative.' },
];

/** Rows per call to the engine. Matches the server's own ceiling. */
const CHUNK = 150;

export default function BudgetUpload({ kind }: { kind: 'APPROPRIATION' | 'ALLOTMENT' }) {
  const { fiscalYear, fundCode } = useFilters();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const offices = useOffices();
  const accounts = useAccounts(false);

  const isAppropriation = kind === 'APPROPRIATION';

  const [appropriationKind, setAppropriationKind] = useState('ORIGINAL');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayPh());
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ParsedBudgetRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const signed = ['REALIGNMENT', 'TRANSFER', 'ADJUSTMENT'].includes(appropriationKind);

  /**
   * The same checks the engine makes, run here so the whole list of problems is
   * visible at once. The engine is still the authority - this only saves a
   * round trip per mistake.
   */
  const checked = useMemo(() => {
    const officeKeys = new Set<string>();
    for (const o of offices.data) {
      for (const alias of [o.code, o.name, o.shortName]) {
        if (alias) officeKeys.add(alias.trim().toUpperCase());
      }
    }
    const byCode = new Map(accounts.data.map((a) => [a.code, a]));

    return rows.map((row) => {
      if (row.problem) return row;
      const problems: string[] = [];

      if (!officeKeys.has(row.office.trim().toUpperCase())) {
        problems.push(`office "${row.office}" is not in Master Data`);
      }
      const account = byCode.get(row.accountCode);
      if (!account) problems.push(`account ${row.accountCode} is not in the Chart of Accounts`);
      else if (account.postable === false) problems.push('that account is a grouping account');
      else if (account.active === false) problems.push('that account has been deactivated');

      const ec = row.expenseClass || account?.expenseClass || '';
      if (!['PS', 'MOOE', 'FE', 'CO'].includes(ec)) {
        problems.push('no expense classification');
      }
      if (row.amount < 0 && !(isAppropriation && signed)) {
        problems.push('a negative amount');
      }

      return { ...row, problem: problems.length ? problems.join(', ') : undefined };
    });
  }, [rows, offices.data, accounts.data, isAppropriation, signed]);

  const bad = checked.filter((r) => r.problem);
  const total = checked.reduce((s, r) => s + r.amount, 0);
  const lineCount = new Set(checked.map((r) => `${r.office}__${r.accountCode}`)).size;

  const read = async (file: File) => {
    try {
      const parsed = await parseBudgetFile(file);
      if (!parsed.length) {
        toast.error('Nothing to read', 'No budget lines were found in the first sheet of that file.');
        return;
      }
      setRows(parsed);
      setFileName(file.name);
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : String(err));
    }
  };

  const post = async () => {
    if (bad.length || !checked.length || !reference.trim()) return;
    setBusy(true);
    let posted = 0;
    let amount = 0;

    try {
      for (let i = 0; i < checked.length; i += CHUNK) {
        const chunk = checked.slice(i, i + CHUNK);
        setProgress(`Posting ${i + 1} to ${i + chunk.length} of ${checked.length}`);

        const res = await engine.importBudgetLines({
          kind,
          fiscalYear,
          fundCode,
          appropriationKind: isAppropriation ? appropriationKind : undefined,
          reference: reference.trim(),
          date,
          fileName,
          rows: chunk.map((r) => ({
            lineNo: r.lineNo,
            office: r.office,
            accountCode: r.accountCode,
            expenseClass: r.expenseClass || undefined,
            amount: r.amount,
            particulars: r.particulars || undefined,
          })),
        });
        posted += res.posted;
        amount += res.total;
      }

      toast.success(
        isAppropriation ? 'Appropriation posted' : 'Allotment released',
        `${posted} line${posted === 1 ? '' : 's'}, ${formatPeso(amount)}. It is in the budget ledger now and available ${isAppropriation ? 'for allotment' : 'to obligate'}.`,
      );
      setRows([]);
      setFileName('');
      setReference('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      toast.error(
        posted > 0 ? `Stopped after ${posted} lines` : 'Nothing was posted',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const chosenKind = KINDS.find((k) => k.value === appropriationKind);

  return (
    <div>
      <PageHeader
        title={isAppropriation ? 'Upload appropriations' : 'Upload allotment releases'}
        subtitle={
          isAppropriation
            ? 'The annex to the appropriation ordinance, read line by line into the budget ledger. One row per office per account.'
            : 'A batch of allotment releases, read from the spreadsheet the Budget Office already keeps. Each line is checked against the appropriation it draws on.'
        }
        breadcrumbs={[
          { label: 'Budget' },
          { label: isAppropriation ? 'Appropriation' : 'Allotments' },
          { label: 'Upload' },
        ]}
      />

      <Card title={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}>
        <div className="grid gap-4 md:grid-cols-3">
          {isAppropriation && (
            <Field label="Type" required hint={chosenKind?.hint}>
              <Select
                value={appropriationKind}
                onChange={(e) => setAppropriationKind(e.target.value)}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label={isAppropriation ? 'Ordinance number' : 'Release reference'}
            required
            hint="This is what stops the same file being posted twice. Give each ordinance or release its own."
          >
            <TextInput
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={isAppropriation ? 'Ordinance No. 2026-01' : 'ARO 2026-03'}
            />
          </Field>

          <Field
            label={isAppropriation ? 'Authority date' : 'Release date'}
            required
            hint={isAppropriation ? 'The date the ordinance was enacted.' : undefined}
          >
            <DateInput value={date} onChange={setDate} />
          </Field>
        </div>

        <div className="mt-4">
          <Field
            label="The file"
            hint="A .csv, .xls or .xlsx. It needs an office, an account code and an amount on each row; the expense class is taken from the Chart of Accounts when the file does not say."
          >
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.xls,.xlsx"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void read(file);
              }}
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-navy-900 file:px-3 file:py-2 file:text-sm file:text-white hover:file:bg-navy-800"
            />
          </Field>
        </div>

        {checked.length > 0 && (
          <div className="mt-4">
            {bad.length > 0 ? (
              <Alert tone="error" title={`${bad.length} of ${checked.length} rows cannot be posted`} className="mb-3">
                Nothing will be sent until these are fixed. An ordinance goes into the books whole or
                not at all - a budget missing a few lines looks complete, foots to a total nobody
                reconciles against the ordinance, and refuses an office its obligation months later
                for no visible reason.
              </Alert>
            ) : (
              <Alert tone="info" className="mb-3">
                {checked.length} rows falling on {lineCount} budget line
                {lineCount === 1 ? '' : 's'}, totalling{' '}
                <strong className="cbo-amount">{formatPeso(total)}</strong>.{' '}
                {isAppropriation
                  ? 'Posting records this as enacted authority; it becomes available for allotment straight away.'
                  : 'Each line is checked against its appropriation before anything is released.'}
              </Alert>
            )}

            <PreviewTable rows={checked} />

            <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
              <p className="text-sm text-slate-600">
                {progress ?? `${checked.length - bad.length} of ${checked.length} rows ready.`}
              </p>
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || bad.length > 0 || !reference.trim()}
                onClick={() => void post()}
              >
                Post {checked.length} line{checked.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function PreviewTable({ rows }: { rows: ParsedBudgetRow[] }) {
  return (
    <div className="max-h-96 overflow-auto rounded border border-slate-200">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
          <tr>
            <th className="px-2 py-1.5 font-medium">Row</th>
            <th className="px-2 py-1.5 font-medium">Office</th>
            <th className="px-2 py-1.5 font-medium">Account</th>
            <th className="px-2 py-1.5 font-medium">Class</th>
            <th className="px-2 py-1.5 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.lineNo} className={r.problem ? 'bg-rose-50' : undefined}>
              <td className="px-2 py-1.5 text-slate-500">{r.lineNo}</td>
              <td className="px-2 py-1.5">{r.office || '-'}</td>
              <td className="px-2 py-1.5">
                <span className="font-mono text-slate-500">{r.accountCode || '-'}</span>
                {r.accountName && <span className="ml-2">{r.accountName}</span>}
                {r.problem && <span className="block text-[11px] text-rose-700">{r.problem}</span>}
              </td>
              <td className="px-2 py-1.5">
                {r.expenseClass ? (
                  <span title={EXPENSE_CLASS_LABELS[r.expenseClass as ExpenseClass]}>
                    {r.expenseClass}
                  </span>
                ) : (
                  <span className="text-slate-400">-</span>
                )}
              </td>
              <td className="cbo-amount px-2 py-1.5 text-right">
                {formatPeso(r.amount, { symbol: false, parens: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
