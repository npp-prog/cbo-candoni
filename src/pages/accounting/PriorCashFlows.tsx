import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso, parsePeso } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { ACCOUNTING_SETUP_TABS } from '@/layout/sections';
import { captionsForFund, type CashFlowSection } from '@/lib/cashFlowLines';
import {
  cashFlowKey,
  cashOn,
  priorCashFlowId,
  priorCashFlowTotals,
  type PriorCashFlowLine,
} from '@/lib/priorCashFlow';
import { priorTbId } from '@/lib/priorTrialBalance';
import type { StoredPriorTb } from './PriorTrialBalances';
import { fundLabel } from '../budget/Obligations';

/**
 * Patch 170 - Accounting > Setup > Prior Year Cash Flows.
 *
 * The preceding year's Statement of Cash Flows, one figure per caption, for
 * the comparative column of the statement in the year CFMS takes over. See
 * src/lib/priorCashFlow.ts.
 */

export interface StoredPriorCashFlow {
  fiscalYear: number;
  fundCode: string;
  beginningCash: number;
  lines: PriorCashFlowLine[];
  netFlows: number;
  endingCash: number;
  checkedAgainst?: string[];
  savedAt?: string;
  savedBy?: { name?: string };
}

const SECTION_TITLES: Record<CashFlowSection, string> = {
  OPERATING: 'Cash Flows from Operating Activities',
  INVESTING: 'Cash Flows from Investing Activities',
  FINANCING: 'Cash Flows from Financing Activities',
};
const SECTIONS: CashFlowSection[] = ['OPERATING', 'INVESTING', 'FINANCING'];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export default function PriorCashFlows() {
  const { fiscalYear, fundCode } = useFilters();
  const year = fiscalYear - 1;
  const { hasRole } = useAuth();
  const canSave = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const captions = useMemo(() => captionsForFund(fundCode), [fundCode]);
  const stored = useDocument<StoredPriorCashFlow>(
    COL.priorCashFlows,
    priorCashFlowId(year, fundCode),
  );

  /* What the year must end on: the next year's opening cash, and the trial balance. */
  const marker = useDocument<{ jevId?: string; jevNo?: string }>(
    COL.openingBalances,
    `${fiscalYear}__${fundCode}`,
  );
  const openingJev = useDocument<{
    lines?: Array<{ accountCode: string; debit?: number; credit?: number }>;
  }>(COL.jevs, marker.data?.jevId ?? null);
  const postTb = useDocument<StoredPriorTb>(
    COL.priorTrialBalances,
    priorTbId(year, fundCode, 'POST'),
  );
  const preTb = useDocument<StoredPriorTb>(
    COL.priorTrialBalances,
    priorTbId(year, fundCode, 'PRE'),
  );

  const targets = useMemo(() => {
    const out: Array<{ label: string; cash: number }> = [];
    if (marker.data && openingJev.data) {
      out.push({
        label: `Opening Balances of ${fiscalYear} (JEV ${marker.data.jevNo ?? ''})`,
        cash: cashOn(openingJev.data.lines ?? []),
      });
    }
    const tb = postTb.data ?? preTb.data;
    if (tb) {
      out.push({
        label: `${postTb.data ? 'Post-closing' : 'Pre-closing'} trial balance of ${year}`,
        cash: cashOn(tb.lines),
      });
    }
    return out;
  }, [marker.data, openingJev.data, postTb.data, preTb.data, fiscalYear, year]);

  // --- the figures being edited --------------------------------------------
  const [beginning, setBeginning] = useState<number | null>(null);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const savedStamp = stored.data?.savedAt ?? '';
  useEffect(() => {
    if (dirty) return;
    const s = stored.data;
    setBeginning(s ? s.beginningCash : null);
    setAmounts(
      Object.fromEntries(
        (s?.lines ?? []).map((l) => [cashFlowKey(l.section, l.direction, l.caption), l.amount]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedStamp, year, fundCode]);

  const lines: PriorCashFlowLine[] = useMemo(
    () =>
      captions.map((d) => ({
        section: d.section,
        direction: d.direction,
        caption: d.caption,
        amount: amounts[cashFlowKey(d.section, d.direction, d.caption)] ?? 0,
      })),
    [captions, amounts],
  );
  const totals = useMemo(() => priorCashFlowTotals(lines, beginning ?? 0), [lines, beginning]);
  const misses = targets.filter((t) => t.cash !== totals.endingCash);
  const savable = canSave && dirty && beginning !== null && misses.length === 0;

  const setAmount = (key: string, v: number | null) => {
    setAmounts((a) => ({ ...a, [key]: v ?? 0 }));
    setDirty(true);
  };

  // --- Excel -----------------------------------------------------------------
  const downloadTemplate = () => {
    const rows: Array<Array<string | number>> = [['Particulars', 'Amount']];
    rows.push(['Cash Balance, Beginning', (beginning ?? 0) / 100]);
    for (const section of SECTIONS) {
      rows.push([SECTION_TITLES[section], '']);
      for (const dir of ['IN', 'OUT'] as const) {
        rows.push([dir === 'IN' ? 'Cash Inflows' : 'Cash Outflows', '']);
        for (const l of lines.filter((x) => x.section === section && x.direction === dir)) {
          rows.push([l.caption, l.amount / 100]);
        }
      }
    }
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [{ wch: 60 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(book, sheet, 'Cash Flows');
    XLSX.writeFile(book, `Prior Year Cash Flows ${fundCode} ${year}.xlsx`);
  };

  const readFile = async (file: File) => {
    try {
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
      const sheet = book.Sheets[book.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
      let section: CashFlowSection | null = null;
      let direction: 'IN' | 'OUT' | null = null;
      const next: Record<string, number> = {};
      let begin: number | null = null;
      let matched = 0;
      const skipped: string[] = [];
      for (const row of grid) {
        const cells = row.map((c) => String(c ?? '').trim());
        const label = cells.find((c) => c && parsePeso(c) === null) ?? '';
        if (!label) continue;
        const amountCell = [...cells].reverse().find((c) => c && parsePeso(c) !== null);
        const amount = amountCell ? Math.abs(parsePeso(amountCell) ?? 0) : null;
        const n = norm(label);
        if (/operating activities/.test(n)) section = 'OPERATING';
        else if (/investing activities/.test(n)) section = 'INVESTING';
        else if (/financing activities/.test(n)) section = 'FINANCING';
        if (/^cash inflows?$/.test(n)) direction = 'IN';
        if (/^cash outflows?$/.test(n)) direction = 'OUT';
        if (/beginning/.test(n) && amount !== null) {
          begin = amount;
          continue;
        }
        if (amount === null || /^(total|net|add|cash balance)/.test(n)) continue;
        const candidates = captions.filter(
          (d) =>
            norm(d.caption) === n &&
            (!section || d.section === section) &&
            (!direction || d.direction === direction),
        );
        if (candidates.length === 1) {
          const d = candidates[0];
          next[cashFlowKey(d.section, d.direction, d.caption)] = amount;
          matched++;
        } else if (amount !== 0) {
          skipped.push(label);
        }
      }
      if (!matched && begin === null) {
        toast.error(
          'Nothing read',
          'No line of the sheet matched a caption of the statement. Download the template and fill it in.',
        );
        return;
      }
      setAmounts(next);
      if (begin !== null) setBeginning(begin);
      setDirty(true);
      if (skipped.length) {
        toast.error(
          `${skipped.length} line${skipped.length === 1 ? '' : 's'} not taken`,
          `Not a caption of this fund's statement: ${skipped.slice(0, 5).join('; ')}.`,
        );
      } else {
        toast.success(`${matched} captions read`, 'Check the figures, then save.');
      }
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await engine.savePriorCashFlow({
        fiscalYear: year,
        fundCode,
        beginningCash: beginning ?? 0,
        lines: lines.filter((l) => l.amount !== 0),
      });
      toast.success(
        'Prior year cash flows saved',
        `Cash at the end of ${year}: ${formatPeso(r.endingCash)}.`,
      );
      setDirty(false);
    } catch (err) {
      toast.error('Not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Prior year cash flows"
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Prior year cash flows' }]}
        subtitle={`${fundLabel(fundCode)} - the Statement of Cash Flows of ${year}, for the comparative column of ${fiscalYear}.`}
        actions={
          canSave ? (
            <div className="flex gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f);
                  e.target.value = '';
                }}
              />
              <Button size="sm" variant="secondary" onClick={downloadTemplate}>
                Excel template
              </Button>
              <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                Upload
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={saving}
                disabled={!savable}
                onClick={() => void save()}
              >
                Save
              </Button>
            </div>
          ) : undefined
        }
      />
      <SectionTabs tabs={ACCOUNTING_SETUP_TABS} />

      <Alert tone="info" className="mb-4">
        <p>
          A trial balance shows where the cash ended, not how it moved, so the {year} column of the
          Statement of Cash Flows is set up here: the cash at the beginning of {year} and each
          caption&rsquo;s figure, as on the statement submitted for {year}. Type them below, or
          download the Excel template, fill in the Amount column and upload it. It is used only
          where the General Ledger has no {year} of its own, and nothing is posted.
        </p>
        <p className="mt-1">
          The cash at the end of {year} must be the cash {fiscalYear} opened with: the cash accounts
          on the Opening Balances of {fiscalYear}, and on the {year} trial balance where one is
          uploaded.
        </p>
      </Alert>

      {stored.data && !dirty && (
        <p className="mb-3 text-xs text-slate-600">
          Saved {stored.data.savedAt ? formatLongDate(stored.data.savedAt.slice(0, 10)) : ''}
          {stored.data.savedBy?.name ? ` by ${stored.data.savedBy.name}` : ''}.
          {stored.data.checkedAgainst?.length
            ? ` Agrees with the ${stored.data.checkedAgainst.join(' and the ')}.`
            : ' There was nothing yet to check it against.'}
        </p>
      )}
      {dirty && <p className="mb-3 text-xs font-medium text-amber-700">Changed - not yet saved.</p>}

      <Card>
        <div className="mx-auto max-w-3xl">
          {SECTIONS.map((section) => {
            const t = totals.bySection[section];
            return (
              <section key={section} className="mb-5">
                <h3 className="mb-2 border-b border-slate-300 pb-1 text-sm font-semibold uppercase tracking-wide text-navy-900">
                  {SECTION_TITLES[section]}
                </h3>
                {(['IN', 'OUT'] as const).map((dir) => (
                  <div key={dir} className="mb-2">
                    <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">
                      {dir === 'IN' ? 'Cash Inflows' : 'Cash Outflows'}
                    </p>
                    {lines
                      .filter((l) => l.section === section && l.direction === dir)
                      .map((l) => {
                        const key = cashFlowKey(l.section, l.direction, l.caption);
                        return (
                          <div
                            key={key}
                            className="flex items-center justify-between gap-4 py-0.5 pl-4"
                          >
                            <span className="text-sm text-navy-800">{l.caption}</span>
                            <div className="w-48">
                              <AmountInput
                                value={amounts[key] ?? null}
                                disabled={!canSave}
                                onChange={(v) => setAmount(key, v)}
                              />
                            </div>
                          </div>
                        );
                      })}
                    <Line
                      label={dir === 'IN' ? 'Total Cash Inflows' : 'Total Cash Outflows'}
                      amount={dir === 'IN' ? t.totalIn : t.totalOut}
                    />
                  </div>
                ))}
                <Line label="Net Cash Provided by (Used in) the activities" amount={t.net} strong />
              </section>
            );
          })}

          <Line
            label="Total Cash Provided by Operating, Investing and Financing Activities"
            amount={totals.netFlows}
          />
          <div className="flex items-center justify-between gap-4 py-1 pl-4">
            <span className="text-sm text-navy-800">Add: Cash Balance, Beginning {year}</span>
            <div className="w-48">
              <AmountInput
                value={beginning}
                disabled={!canSave}
                onChange={(v) => {
                  setBeginning(v);
                  setDirty(true);
                }}
              />
            </div>
          </div>
          <Line label={`Cash Balance, End ${year}`} amount={totals.endingCash} strong />

          <div className="mt-4 space-y-2">
            {targets.length === 0 && (
              <Alert tone="warning">
                Neither the Opening Balances of {fiscalYear} nor a {year} trial balance is in yet,
                so the cash at the end of {year} cannot be checked. It will be, when these figures
                are next saved after they are.
              </Alert>
            )}
            {targets.map((t) =>
              t.cash === totals.endingCash ? (
                <Alert key={t.label} tone="success">
                  Ends on the cash of the {t.label}: {formatPeso(t.cash)}.
                </Alert>
              ) : (
                <Alert key={t.label} tone="error">
                  The {t.label} carries {formatPeso(t.cash)} of cash; these figures end on{' '}
                  {formatPeso(totals.endingCash)} - a difference of{' '}
                  {formatPeso(totals.endingCash - t.cash)}. It cannot be saved until they agree.
                </Alert>
              ),
            )}
          </div>
        </div>
      </Card>
    </>
  );
}

function Line({ label, amount, strong }: { label: string; amount: number; strong?: boolean }) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1 pl-4 ${
        strong ? 'border-t border-slate-300 font-semibold' : ''
      }`}
    >
      <span className="text-sm text-navy-800">{label}</span>
      <span className="w-48 pr-3 text-right font-mono text-sm tabular text-navy-900">
        {formatPeso(amount, { symbol: false, parens: true })}
      </span>
    </div>
  );
}
