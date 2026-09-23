import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { Button } from '@/components/ui/Button';
import { Field, DateInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAccounts } from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso, parsePeso } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { fundLabel } from '../budget/Obligations';
import type { Centavos } from '@/types/common';

/**
 * Opening balances.
 *
 * A municipality converting to CBO does not start at zero, so the balances
 * carried over have to get in. They get in as a **journal entry**, posted like
 * any other, and never as figures typed onto a statement.
 *
 * That distinction is the whole design. A typed statement balance has no
 * author, no date and no audit trail, and it can quietly disagree with the
 * ledger beneath it. A posted opening entry has all three and cannot disagree,
 * because it is the ledger. When an auditor asks where an opening figure came
 * from, there is a JEV to show them.
 *
 * The convenience is here in full - encode the lines, or upload the spreadsheet
 * the previous system produced. What is not here is a way for a balance to
 * exist outside the General Ledger.
 *
 * Entered once per fiscal year and fund. Afterwards this screen shows what was
 * posted and sends corrections to an adjusting entry, because an opening
 * balance that can be re-entered is one that can be changed after the fact
 * without anyone seeing.
 */

interface Row {
  key: number;
  accountCode: string;
  accountName: string;
  debit: Centavos;
  credit: Centavos;
  /**
   * Who the balance belongs to, and what document it came from.
   *
   * Blank for an ordinary account - Cash in Bank needs no party. Required for a
   * control account, because an opening payable encoded without the supplier can
   * never be split apart afterwards: the detail is simply gone, and the aging
   * report has nothing to age.
   */
  party: string;
  reference: string;
  /**
   * When the item arose - the date the voucher was approved, the cash advance
   * granted, the assessment raised. Not the conversion date. This is what the
   * aging report counts from, and it is the one fact only the old system holds.
   */
  since: string;
  /** Set when the code is not in the chart of accounts. */
  problem?: string;
}

/**
 * Reads whatever the previous system put in a date column.
 *
 * Spreadsheets hand back dates as serial numbers, as ISO strings, or as
 * whatever the encoder typed. A date that cannot be read is dropped rather than
 * guessed: an item with no date ages from the conversion, which is visibly
 * wrong on the report, where a date guessed the wrong way round is not.
 */
function normaliseDate(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel serial: days since 1899-12-30.
    const ms = Date.UTC(1899, 11, 30) + value * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 1990) {
    return parsed.toISOString().slice(0, 10);
  }
  return '';
}

let nextKey = 1;
const blankRow = (): Row => ({
  key: nextKey++,
  accountCode: '',
  accountName: '',
  debit: 0,
  credit: 0,
  party: '',
  reference: '',
  since: '',
});

export default function OpeningBalances() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const accounts = useAccounts(false);
  const { data: existing, loading: checking } = useDocument<{
    jevNo: string;
    asOfDate: string;
    lineCount: number;
    totalDebit: number;
    postedBy?: { name: string };
    postedAt?: string;
  }>(COL.openingBalances, `${fiscalYear}__${fundCode}`);

  const canPost = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const [asOfDate, setAsOfDate] = useState(`${fiscalYear - 1}-12-31`);
  const [remarks, setRemarks] = useState('');
  const [rows, setRows] = useState<Row[]>(() => [blankRow(), blankRow(), blankRow()]);
  const [posting, setPosting] = useState(false);

  const byCode = useMemo(
    () => new Map(accounts.data.map((a) => [a.code, a])),
    [accounts.data],
  );

  const totals = useMemo(() => {
    const debit = rows.reduce((s, r) => s + r.debit, 0);
    const credit = rows.reduce((s, r) => s + r.credit, 0);
    return { debit, credit, difference: debit - credit };
  }, [rows]);

  const filled = rows.filter((r) => r.accountCode && (r.debit || r.credit));
  const problems = filled.filter((r) => r.problem);
  const balanced = totals.debit === totals.credit && totals.debit > 0;
  const postable = canPost && balanced && filled.length > 0 && problems.length === 0;

  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        if (patch.accountCode !== undefined) {
          const account = byCode.get(patch.accountCode.trim());
          next.accountCode = patch.accountCode.trim();
          next.accountName = account?.name ?? '';
          next.problem = !next.accountCode
            ? undefined
            : !account
              ? 'Not in the Chart of Accounts'
              : account.postable === false
                ? 'Grouping account - cannot carry a balance'
                : account.active === false
                  ? 'Deactivated'
                  : undefined;
        }
        return next;
      }),
    );

  /**
   * Reads a spreadsheet of opening balances.
   *
   * Column names are matched loosely because the file comes from whatever
   * system the municipality used before, and insisting on an exact header is
   * how a genuine import turns into an afternoon of renaming columns. Anything
   * that looks like an account code, a debit or a credit is taken; everything
   * else is ignored.
   */
  const readFile = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const book = XLSX.read(buffer, { type: 'array', raw: false });
      const sheet = book.Sheets[book.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

      if (!json.length) {
        toast.error('Nothing to read', 'The first sheet of that file has no rows.');
        return;
      }

      const find = (row: Record<string, unknown>, patterns: RegExp[]) => {
        for (const key of Object.keys(row)) {
          if (patterns.some((p) => p.test(key))) return row[key];
        }
        return undefined;
      };

      const imported: Row[] = [];
      for (const raw of json) {
        const code = String(
          find(raw, [/account\s*code/i, /^code$/i, /uacs/i, /^account$/i]) ?? '',
        ).trim();
        if (!code) continue;

        const debit = parsePeso(String(find(raw, [/debit/i, /^dr$/i]) ?? '0')) ?? 0;
        const credit = parsePeso(String(find(raw, [/credit/i, /^cr$/i]) ?? '0')) ?? 0;
        if (!debit && !credit) continue;

        const account = byCode.get(code);
        const party = String(
          find(raw, [/payee/i, /supplier/i, /vendor/i, /officer/i, /employee/i,
                     /debtor/i, /party/i, /^name$/i, /subsidiary/i]) ?? '',
        ).trim();
        const reference = String(
          find(raw, [/reference/i, /^ref/i, /dv\s*no/i, /voucher/i, /^document/i]) ?? '',
        ).trim();
        const since = normaliseDate(find(raw, [/date/i, /since/i, /granted/i, /incurred/i]));

        imported.push({
          key: nextKey++,
          accountCode: code,
          accountName: account?.name ?? '',
          debit,
          credit,
          party,
          reference,
          since,
          problem: !account
            ? 'Not in the Chart of Accounts'
            : account.postable === false
              ? 'Grouping account - cannot carry a balance'
              : account.active === false
                ? 'Deactivated'
                : undefined,
        });
      }

      if (!imported.length) {
        toast.error(
          'No balances found',
          'No row had both an account code and an amount. The sheet needs a column for the account code and one each for debit and credit.',
        );
        return;
      }

      setRows([...imported, blankRow()]);
      const bad = imported.filter((r) => r.problem).length;
      toast.success(
        `${imported.length} lines read`,
        bad
          ? `${bad} need attention before this can be posted - they are marked below.`
          : 'Check the figures, then post.',
      );
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : String(err));
    }
  };

  const post = async () => {
    setPosting(true);
    try {
      const res = await engine.postOpeningBalances({
        fiscalYear,
        fundCode,
        asOfDate,
        remarks: remarks.trim() || undefined,
        lines: filled.map((r) => ({
          accountCode: r.accountCode,
          accountName: r.accountName,
          debit: r.debit,
          credit: r.credit,
          subsidiaryType: r.party ? 'PAYEE' : null,
          subsidiaryId: r.party ? r.party.toUpperCase() : null,
          subsidiaryName: r.party || null,
          referenceNo: r.reference || null,
          agingDate: r.since || null,
        })),
      });
      toast.success(
        `Opening balances posted as JEV ${res.jevNo}`,
        `${res.lineCount} accounts, ${formatPeso(res.total)}. They are in the General Ledger and will appear on every report.`,
      );
    } catch (err) {
      toast.error('Could not post', err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Opening balances"
        breadcrumbs={[{ label: 'Reports' }, { label: 'Opening balances' }]}
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}. Posted as a journal entry, so every later report is computed from the ledger as usual.`}
      />

      <SectionTabs
        tabs={[
          { label: 'Trial Balance', to: '/reports/trial-balance' },
          { label: 'Opening balances', to: '/accounting/opening-balances' },
        ]}
      />

      {checking ? null : existing ? (
        <Alert tone="info">
          Opening balances for {fundLabel(fundCode)} {fiscalYear} were posted as{' '}
          <strong>JEV {existing.jevNo}</strong> — {existing.lineCount} accounts,{' '}
          {formatPeso(existing.totalDebit)}, as at {formatLongDate(existing.asOfDate)}
          {existing.postedBy?.name ? `, by ${existing.postedBy.name}` : ''}. They are entered once.
          To correct a figure, record an adjusting entry under <strong>Accounting → Others</strong>,
          so the correction is visible rather than the original being changed.
        </Alert>
      ) : !canPost ? (
        <Alert tone="info">
          Only the Municipal Accountant may post opening balances.
        </Alert>
      ) : (
        <>
          <Card className="no-print">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Balances as at"
                required
                hint="Normally the last day of the preceding year."
              >
                <DateInput value={asOfDate} onChange={setAsOfDate} />
              </Field>
              <Field label="Remarks" className="sm:col-span-2" hint="Appears on the journal entry.">
                <TextInput
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder={`Opening balances of the ${fundCode} fund on conversion to CBO`}
                />
              </Field>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readFile(file);
                  e.target.value = '';
                }}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                Upload a spreadsheet
              </Button>
              <Button variant="ghost" onClick={() => setRows((r) => [...r, blankRow()])}>
                Add a line
              </Button>
              <span className="text-xs text-slate-500">
                The sheet needs a column for the account code and one each for debit and credit.
                For payables, receivables and cash advances, add a column naming the party, one for
                the reference document, and one for the date it arose - that date is what the aging
                report counts from, and it is the one thing the old system knows that cannot be
                worked out later. Other columns are ignored.
              </span>
            </div>
          </Card>

          <Card className="mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-600">
                  <th className="px-2 py-2 text-left" style={{ width: '10rem' }}>
                    Account code
                  </th>
                  <th className="px-2 py-2 text-left">Account</th>
                  <th className="px-2 py-2 text-left" style={{ width: '13rem' }}>
                    Party
                  </th>
                  <th className="px-2 py-2 text-left" style={{ width: '9rem' }}>
                    Reference
                  </th>
                  <th className="px-2 py-2 text-left" style={{ width: '9rem' }}>
                    Outstanding since
                  </th>
                  <th className="px-2 py-2 text-right" style={{ width: '11rem' }}>
                    Debit
                  </th>
                  <th className="px-2 py-2 text-right" style={{ width: '11rem' }}>
                    Credit
                  </th>
                  <th style={{ width: '3rem' }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={`border-b border-slate-100 ${row.problem ? 'bg-amber-50' : ''}`}>
                    <td className="px-2 py-1">
                      <TextInput
                        value={row.accountCode}
                        onChange={(e) => setRow(row.key, { accountCode: e.target.value })}
                        placeholder="50203010"
                        className="font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      {row.accountName ? (
                        <span className="text-sm">{row.accountName}</span>
                      ) : row.problem ? (
                        <span className="text-xs text-amber-800">{row.problem}</span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <TextInput
                        value={row.party}
                        onChange={(e) => setRow(row.key, { party: e.target.value })}
                        placeholder="Supplier or officer"
                        className="text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <TextInput
                        value={row.reference}
                        onChange={(e) => setRow(row.key, { reference: e.target.value })}
                        placeholder="DV 2025-08-0142"
                        className="font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <TextInput
                        type="date"
                        value={row.since}
                        onChange={(e) => setRow(row.key, { since: e.target.value })}
                        className="text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <TextInput
                        value={row.debit ? (row.debit / 100).toFixed(2) : ''}
                        onChange={(e) => setRow(row.key, { debit: parsePeso(e.target.value) ?? 0, credit: 0 })}
                        className="text-right"
                        placeholder="0.00"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <TextInput
                        value={row.credit ? (row.credit / 100).toFixed(2) : ''}
                        onChange={(e) => setRow(row.key, { credit: parsePeso(e.target.value) ?? 0, debit: 0 })}
                        className="text-right"
                        placeholder="0.00"
                      />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                        className="text-xs text-slate-400 hover:text-red-600"
                        aria-label="Remove line"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold">
                  <td className="px-2 py-2" colSpan={5}>
                    {filled.length} account{filled.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="cbo-amount">{formatPeso(totals.debit)}</span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="cbo-amount">{formatPeso(totals.credit)}</span>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>

            {problems.length > 0 && (
              <Alert tone="warning" className="mt-3">
                {problems.length} line{problems.length === 1 ? '' : 's'} cannot be posted: the
                account is missing from the Chart of Accounts, is a grouping account, or is
                deactivated. Add or correct those accounts under Master Data first.
              </Alert>
            )}

            {totals.difference !== 0 && (totals.debit > 0 || totals.credit > 0) && (
              <Alert tone="warning" className="mt-3">
                Out by {formatPeso(Math.abs(totals.difference))}. Debits and credits must be equal —
                a trial balance that does not foot cannot be the opening position of a set of books.
              </Alert>
            )}

            <div className="mt-4 flex justify-end">
              <Button onClick={post} loading={posting} disabled={!postable}>
                Post opening balances
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
