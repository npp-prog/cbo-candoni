import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, DateInput, TextInput } from '@/components/ui/Field';
import { SubsidiaryPicker } from '@/components/pickers';
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
import { ConfirmDialog } from '@/components/ui/Modal';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ACCOUNTING_SETUP_TABS } from '@/layout/sections';

/**
 * Opening balances.
 *
 * A municipality converting to CFMS does not start at zero, so the balances
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
   * The SUBSIDIARY LEDGER ACCOUNT this balance opens, and what document it
   * came from.
   *
   * ---------------------------------------------------------------------------
   * IT IS A RECORD NOW, NOT A TYPED NAME
   * ---------------------------------------------------------------------------
   * This used to be free text, and posting fabricated a subsidiary out of it:
   * the type was assumed to be PAYEE and the ID was the typed words in
   * capitals. So an opening payable to a supplier opened a subsidiary account
   * called "ABC TRADING", while every voucher paid to that same supplier posts
   * to the subsidiary keyed by their PAYEE RECORD.
   *
   * Two subsidiary accounts for one creditor. The opening balance then never
   * came down as the supplier was paid - it sat there looking like a creditor
   * nobody had settled, the subsidiary ledger did not agree with Accounts
   * Payable, and nothing on any screen said why.
   *
   * It is the same picker the journal entry uses now, over the same payees,
   * employees, offices, bank accounts and tax codes - so an opening balance and
   * the vouchers that pay it down land in ONE subsidiary account.
   *
   * Blank for an ordinary account: Cash in Bank needs no subsidiary. It matters
   * for a control account, because an opening payable encoded without the
   * supplier can never be split apart afterwards.
   */
  subsidiaryType: string;
  subsidiaryId: string;
  subsidiaryName: string;
  /**
   * The name as the uploaded spreadsheet wrote it, before anybody matched it.
   *
   * Kept so the officer can see what the file said while they choose the
   * record it means. Cleared once a record is chosen.
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
  subsidiaryType: '',
  subsidiaryId: '',
  subsidiaryName: '',
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
  const [reopening, setReopening] = useState(false);
  const [reopenBusy, setReopenBusy] = useState(false);

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
          /*
           * The spreadsheet's wording is kept as `party` and the subsidiary is
           * left EMPTY for the officer to choose.
           *
           * Matching a name to a record automatically was the old behaviour's
           * mistake in another form: "ABC Trdg." and "ABC Trading Inc." are
           * the same supplier to a person and two different strings to a
           * computer, and a wrong match is worse than no match - it opens a
           * payable against the wrong creditor and nothing says so.
           */
          subsidiaryType: '',
          subsidiaryId: '',
          subsidiaryName: '',
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
          // The chosen record, or nothing. Never a name turned into an id -
          // see the note on the row type.
          subsidiaryType: r.subsidiaryId ? r.subsidiaryType : null,
          subsidiaryId: r.subsidiaryId || null,
          subsidiaryName: r.subsidiaryId ? r.subsidiaryName : null,
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

  /*
    Re-opening. The engine reverses the posted entry and clears the marker; the
    screen then goes back to an empty grid of its own accord, because the
    marker is what it reads to know the fund has been opened.

    The confirmation is not ceremony. Somebody arriving at this screen to LOOK
    at what was posted is one click from undoing it, and the reversal is a real
    entry in the General Ledger either way - so the dialog says what will
    happen to the books before it happens, and takes the reason that goes with
    it into the audit trail.
  */
  const reopen = async (reason?: string) => {
    const why = (reason ?? '').trim();
    if (!why) return;
    setReopenBusy(true);
    try {
      const res = await engine.reopenOpeningBalances({ fiscalYear, fundCode, reason: why });
      toast.success(
        'Opening balances re-opened',
        res.reversingJevNo
          ? `JEV ${res.reversedJevNo} has been reversed by JEV ${res.reversingJevNo}. Both are in the books. Encode the corrected balances below and post them again.`
          : 'The entry had already been reversed. Encode the corrected balances below and post them again.',
      );
      setReopening(false);
    } catch (err) {
      toast.error('Could not re-open them', err instanceof Error ? err.message : String(err));
    } finally {
      setReopenBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Opening balances"
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Opening balances' }]}
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}. Posted as a journal entry, so every later report is computed from the ledger as usual.`}
      />

      <SectionTabs tabs={ACCOUNTING_SETUP_TABS} />

      {/*
        ---------------------------------------------------------------------
        NO TAB STRIP, AND THE TRIAL BALANCE IS NOT A SIBLING OF THIS SCREEN
        ---------------------------------------------------------------------
        It used to sit on a two-tab strip beside the Trial Balance, which put
        them side by side as if they were two views of one thing. They are
        opposites.

        The Trial Balance is a REPORT: it reads the ledger and shows what is
        in it, and nothing on it can be typed. This is the one-time act that
        WRITES the ledger - the payables, receivables and unliquidated cash
        advances carried in from whatever the municipality kept before,
        entered by hand and posted as a journal entry.

        A strip saying "Trial Balance | Opening balances" invited somebody
        looking for the balances to find a screen with an Upload button and a
        grid of empty rows on it, which is not a reassuring thing to arrive at
        by accident. It belongs under Accounting, where it already is in the
        menu, and on its own.
      */}

      <ConfirmDialog
        open={reopening}
        onCancel={() => setReopening(false)}
        onConfirm={reopen}
        loading={reopenBusy}
        variant="danger"
        title="Re-open the opening balances"
        confirmLabel="Reverse and re-open"
        requireReason
        reasonLabel="Why the opening position is being replaced"
        reasonHint="Written to the audit trail and read by COA. Say what was wrong with the figures, not that they were wrong."
        message={
          <>
            <p>
              JEV {existing?.jevNo} will be <strong>reversed</strong>, not deleted. A reversing
              entry is posted in the same month it was raised, so the two cancel exactly and every
              trial balance from that month onwards reads correctly once the corrected balances are
              posted.
            </p>
            <p className="mt-2">
              Both entries stay in the General Ledger afterwards, and so does this reason.
            </p>
            <p className="mt-2">
              If that month has been closed, this will be refused. A month that has been reported
              on is corrected by an adjusting entry, not by rewriting what was filed.
            </p>
          </>
        }
      />

      {checking ? null : existing ? (
        <Alert tone="info">
          Opening balances for {fundLabel(fundCode)} {fiscalYear} were posted as{' '}
          <strong>JEV {existing.jevNo}</strong> — {existing.lineCount} accounts,{' '}
          {formatPeso(existing.totalDebit)}, as at {formatLongDate(existing.asOfDate)}
          {existing.postedBy?.name ? `, by ${existing.postedBy.name}` : ''}.
          <p className="mt-2">
            To correct ONE figure, record an adjusting entry under{' '}
            <strong>Accounting → Others</strong>. That is the right remedy almost always: the
            correction is visible, and nothing already reported on moves.
          </p>
          {canPost && (
            <>
              <p className="mt-2">
                To replace the WHOLE set - a column read from the wrong trial balance, a fund
                converted before its figures were final - re-open them. JEV {existing.jevNo} is
                reversed rather than deleted, so the books carry the entry, its reversal and
                whatever is posted next.
              </p>
              <div className="mt-3">
                <Button variant="secondary" onClick={() => setReopening(true)}>
                  Re-open these balances
                </Button>
              </div>
            </>
          )}
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
                  placeholder={`Opening balances of the ${fundCode} fund on conversion to CFMS`}
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
                For payables, receivables and cash advances, add a column naming the subsidiary ledger account, one for
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
                  {/*
                    "Party" said who the balance was with; "Subsidiary Ledger
                    Account" says what it IS. The column carries the supplier,
                    the officer or the debtor whose subsidiary account this
                    opening balance opens - which is the same thing, named the
                    way the ledger names it rather than the way a form does.
                  */}
                  <th className="px-2 py-2 text-left" style={{ width: '13rem' }}>
                    Subsidiary ledger account
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
                        className="font-mono"
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
                      <>
                        <SubsidiaryPicker
                          fundCode={fundCode}
                          value={
                            row.subsidiaryType && row.subsidiaryId
                              ? `${row.subsidiaryType}:${row.subsidiaryId}`
                              : null
                          }
                          onChange={(chosen) =>
                            setRow(row.key, {
                              subsidiaryType: chosen?.type ?? '',
                              subsidiaryId: chosen?.id ?? '',
                              subsidiaryName: chosen?.name ?? '',
                              // The spreadsheet's wording has done its job once
                              // a record is chosen.
                              party: chosen ? '' : row.party,
                            })
                          }
                        />
                        {row.party && !row.subsidiaryId && (
                          /*
                            The uploaded file named somebody CFMS could not
                            match. Shown rather than silently dropped: the
                            officer is the only one who knows which record
                            "ABC Trdg." means, and an unmatched line posted
                            with no subsidiary is an opening payable that can
                            never be aged.
                          */
                          <p className="mt-1 text-xs text-amber-700">
                            The file said &ldquo;{row.party}&rdquo; - choose the record it means.
                          </p>
                        )}
                      </>
                    </td>
                    <td className="px-2 py-1">
                      <TextInput
                        value={row.reference}
                        onChange={(e) => setRow(row.key, { reference: e.target.value })}
                        placeholder="DV 2025-08-0142"
                        className="font-mono"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <TextInput
                        type="date"
                        value={row.since}
                        onChange={(e) => setRow(row.key, { since: e.target.value })}
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
