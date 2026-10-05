import { useEffect, useMemo, useRef, useState } from 'react';
import { Combobox } from '@/components/pickers/Combobox';
import { PageHeader, Card, Alert, Tabs, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Select, TextInput, AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAccounts, useEstimatedReceipts } from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso, formatAmount } from '@/lib/money';
import {
  SRE_RECEIPT_LINES,
  estimatesAsEntries,
  receiptsByLine,
  resolveTotals,
  type SreMapping,
} from '@/lib/sre';
import {
  INCOME_CLASSES,
  INCOME_CLASS_HINTS,
  INCOME_CLASS_LABELS,
  annualOf,
  checkReceiptSet,
  type IncomeClass,
} from '@/lib/estimatedReceipts';
import { parseReceiptsFile, type ParsedReceiptRow } from './parseReceipts';
import type { EstimatedReceipt } from '@/types/budget';
import type { Centavos } from '@/types/common';
import { fundLabel } from './Obligations';

/**
 * Estimated Receipts — the financing side of the budget year.
 *
 * LBP Form No. 1, "Budget of Expenditures and Sources of Financing", section
 * II. Certified by the Local Treasurer, the Local Budget Officer, the Local
 * Planning and Development Coordinator and the Local Accountant as
 * "reasonably projected as collectible for the Budget Year".
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS FILLS
 * ---------------------------------------------------------------------------
 * An appropriation ordinance authorises EXPENDITURE. It does not enact the
 * receipts that pay for it. So CFMS, which loads the ordinance, had a budget
 * figure for every peso going out and none at all for any peso coming in - and
 * both the Statement of Receipts and Expenditures and the Statement of
 * Comparison of Budget and Actual Amounts have a budget column for receipts
 * that no amount of reading the ordinance could ever fill.
 *
 * ---------------------------------------------------------------------------
 * ONE MAPPING, NOT TWO
 * ---------------------------------------------------------------------------
 * The estimate is recorded per account code, and placed on a statement line by
 * the SRE mapping the office has already made. The alternative - a second
 * mapping for the budget column - would work until the day somebody corrected
 * one of them, after which the estimate and the actual would sit on different
 * lines of the same statement and it would still foot.
 * ---------------------------------------------------------------------------
 */

interface DraftRow {
  key: string;
  accountCode: string;
  accountName: string;
  incomeClass: IncomeClass;
  q1: Centavos;
  q2: Centavos;
  q3: Centavos;
  q4: Centavos;
  particulars: string;
  /** Present on a row read from a file that gave no quarterly split. */
  annualOnly?: boolean;
}

let nextKey = 1;

const fromStored = (r: EstimatedReceipt): DraftRow => ({
  key: `s${r.id}`,
  accountCode: r.accountCode,
  accountName: r.accountName,
  incomeClass: r.incomeClass,
  q1: r.q1,
  q2: r.q2,
  q3: r.q3,
  q4: r.q4,
  particulars: r.particulars ?? '',
});

const blankRow = (): DraftRow => ({
  key: `n${nextKey++}`,
  accountCode: '',
  accountName: '',
  incomeClass: 'REGULAR',
  q1: 0,
  q2: 0,
  q3: 0,
  q4: 0,
  particulars: '',
});

export default function EstimatedReceipts() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const stored = useEstimatedReceipts(fiscalYear, fundCode);
  const accounts = useAccounts(false);
  const mappingDoc = useDocument<{ lines?: SreMapping }>(COL.settings, 'sreMapping');

  const [tab, setTab] = useState<'schedule' | 'form'>('schedule');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const canEdit = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER', 'MUNICIPAL_TREASURER');

  // The stored rows seed the table once. After that the table is the truth, or
  // an edit in progress would be overwritten by the next snapshot.
  useEffect(() => {
    if (stored.loading || dirty) return;
    setRows(stored.data.map(fromStored));
  }, [stored.data, stored.loading, dirty]);

  const revenueAccounts = useMemo(
    () =>
      accounts.data
        .filter((a) => a.accountClass !== 'EXPENSE')
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts.data],
  );

  const accountByCode = useMemo(
    () => new Map(revenueAccounts.map((a) => [a.code, a])),
    [revenueAccounts],
  );

  /** The same accounts, as the searchable picker wants them. */
  const revenueOptions = useMemo(
    () =>
      revenueAccounts.map((a) => ({
        value: a.code,
        code: a.code,
        label: a.name,
        detail: a.accountClass,
      })),
    [revenueAccounts],
  );

  const mapping: SreMapping = useMemo(() => mappingDoc.data?.lines ?? {}, [mappingDoc.data]);

  const filled = useMemo(
    () => rows.filter((r) => r.accountCode || annualOf(r) !== 0),
    [rows],
  );

  /** The shared rule, run here exactly as the server will run it. */
  const check = useMemo(
    () =>
      filled.length === 0
        ? null
        : checkReceiptSet(
            filled.map((r, i) => ({
              lineNo: i + 1,
              accountCode: r.accountCode,
              incomeClass: r.incomeClass,
              q1: r.q1,
              q2: r.q2,
              q3: r.q3,
              q4: r.q4,
            })),
          ),
    [filled],
  );

  const totals = useMemo(() => {
    const byClass: Record<IncomeClass, Centavos> = {
      REGULAR: 0,
      NON_REGULAR: 0,
      NON_INCOME: 0,
    };
    for (const r of filled) byClass[r.incomeClass] += annualOf(r);
    return {
      byClass,
      grand: byClass.REGULAR + byClass.NON_REGULAR + byClass.NON_INCOME,
      q: [
        filled.reduce((s, r) => s + r.q1, 0),
        filled.reduce((s, r) => s + r.q2, 0),
        filled.reduce((s, r) => s + r.q3, 0),
        filled.reduce((s, r) => s + r.q4, 0),
      ] as [Centavos, Centavos, Centavos, Centavos],
    };
  }, [filled]);

  const set = (key: string, patch: Partial<DraftRow>) => {
    setDirty(true);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const chooseAccount = (key: string, code: string) => {
    const account = accountByCode.get(code);
    set(key, { accountCode: code, accountName: account?.name ?? '' });
  };

  const readFile = async (file: File) => {
    setReading(true);
    try {
      const parsed = await parseReceiptsFile(file);
      if (parsed.length === 0) {
        toast.error('Nothing was read', 'That file has no rows CFMS could recognise as receipts.');
        return;
      }
      setRows(
        parsed.map((p: ParsedReceiptRow) => ({
          key: `f${nextKey++}`,
          accountCode: p.accountCode,
          accountName: p.accountName || accountByCode.get(p.accountCode)?.name || '',
          incomeClass: p.incomeClass,
          q1: p.q1,
          q2: p.q2,
          q3: p.q3,
          q4: p.q4,
          particulars: p.particulars,
          annualOnly: p.annualOnly,
        })),
      );
      setUploadName(file.name);
      setDirty(true);
      setTab('schedule');
      toast.success(
        `${parsed.length} line${parsed.length === 1 ? '' : 's'} read from ${file.name}`,
        'Nothing has been recorded yet. Check the table, then save.',
      );
    } catch (err) {
      toast.error('That file could not be read', err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const save = async (mode: 'MERGE' | 'REPLACE') => {
    setSaving(true);
    try {
      const result = await engine.recordEstimatedReceipts({
        fiscalYear,
        fundCode,
        mode,
        fileName: uploadName || undefined,
        lines: filled.map((r) => ({
          accountCode: r.accountCode,
          accountName: r.accountName,
          incomeClass: r.incomeClass,
          q1: r.q1,
          q2: r.q2,
          q3: r.q3,
          q4: r.q4,
          particulars: r.particulars || undefined,
        })),
      });
      setDirty(false);
      setUploadName('');
      toast.success(
        `${result.lineCount} line${result.lineCount === 1 ? '' : 's'} recorded`,
        `${formatPeso(result.total)} estimated for ${fundLabel(fundCode)}, ${fiscalYear}` +
          (result.removed > 0
            ? `. ${result.removed} account${result.removed === 1 ? '' : 's'} no longer on the schedule ${
                result.removed === 1 ? 'was' : 'were'
              } removed.`
            : '.'),
      );
    } catch (err) {
      toast.error('Nothing was recorded', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // ---- the LBP Form No. 1 view ----------------------------------------------

  const lineTotals = useMemo(
    () =>
      resolveTotals(
        receiptsByLine(
          estimatesAsEntries(
            filled.map((r) => ({
              fundCode,
              accountCode: r.accountCode,
              accountName: r.accountName,
              annual: annualOf(r),
            })),
          ),
          mapping,
        ),
      ),
    [filled, mapping, fundCode],
  );

  const mappedCodes = useMemo(() => new Set(Object.values(mapping).flat()), [mapping]);

  const unmapped = useMemo(
    () => filled.filter((r) => r.accountCode && !mappedCodes.has(r.accountCode)),
    [filled, mappedCodes],
  );

  const unmappedTotal = unmapped.reduce((s, r) => s + annualOf(r), 0);

  const annualOnlyCount = filled.filter((r) => r.annualOnly).length;

  const loading = stored.loading || accounts.loading;

  return (
    <div>
      <PageHeader
        title="Estimated Receipts"
        subtitle={`${fundLabel(fundCode)} · budget year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Estimated Receipts' }]}
        actions={
          canEdit ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readFile(file);
                }}
              />
              <Button size="sm" loading={reading} onClick={() => fileInput.current?.click()}>
                Upload a schedule
              </Button>
              <Button size="sm" onClick={() => setRows((rs) => [...rs, blankRow()])}>
                Add a line
              </Button>
            </>
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { id: 'schedule', label: 'Schedule', count: filled.length },
          { id: 'form', label: 'LBP Form No. 1 · Receipts' },
        ]}
        active={tab}
        onChange={(id) => setTab(id as 'schedule' | 'form')}
      />

      {loading ? (
        <Spinner />
      ) : tab === 'schedule' ? (
        <Card
          className="mt-4"
          bodyClassName="p-0"
          footer={
            canEdit ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-600">
                  <strong className="font-mono">{formatPeso(totals.grand)}</strong> estimated in
                  total &mdash; {formatPeso(totals.byClass.REGULAR, { symbol: false })} regular,{' '}
                  {formatPeso(totals.byClass.NON_REGULAR, { symbol: false })} non-regular,{' '}
                  {formatPeso(totals.byClass.NON_INCOME, { symbol: false })} non-income.
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={!dirty || saving}
                    onClick={() => {
                      setDirty(false);
                      setUploadName('');
                      setRows(stored.data.map(fromStored));
                    }}
                  >
                    Discard changes
                  </Button>
                  <Button
                    loading={saving}
                    disabled={saving || filled.length === 0 || !check?.ok}
                    onClick={() => void save('MERGE')}
                  >
                    Save and keep the rest
                  </Button>
                  <Button
                    variant="primary"
                    loading={saving}
                    disabled={saving || filled.length === 0 || !check?.ok}
                    onClick={() => void save('REPLACE')}
                  >
                    Save as the whole schedule
                  </Button>
                </div>
              </div>
            ) : undefined
          }
        >
          {check && !check.ok && (
            <div className="border-b border-slate-200 p-4">
              <Alert tone="error" title="This schedule cannot be saved yet">
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {check.violations.slice(0, 6).map((v, i) => (
                    <li key={i}>{v.message}</li>
                  ))}
                </ul>
                {check.violations.length > 6 && (
                  <p className="mt-1">and {check.violations.length - 6} more.</p>
                )}
              </Alert>
            </div>
          )}

          {annualOnlyCount > 0 && (
            <div className="border-b border-slate-200 p-4">
              <Alert tone="warning" title="The file gave a year total and no quarterly split">
                {annualOnlyCount} line{annualOnlyCount === 1 ? '' : 's'} arrived with the whole
                year in one figure, and CFMS has put it in the fourth quarter rather than dividing
                it by four. Quartering it would invent three figures nobody estimated, and the
                Quarterly Report of Receipts would then show the Local Finance Committee a
                shortfall CFMS made up. Enter the split below where you have it.
              </Alert>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-2 py-1.5 font-medium" style={{ minWidth: '18rem' }}>
                    Account
                  </th>
                  <th className="px-2 py-1.5 font-medium" style={{ width: '11rem' }}>
                    Income class
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" style={{ width: '9rem' }}>
                    1st Quarter
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" style={{ width: '9rem' }}>
                    2nd Quarter
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" style={{ width: '9rem' }}>
                    3rd Quarter
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" style={{ width: '9rem' }}>
                    4th Quarter
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" style={{ width: '9rem' }}>
                    Budget Year
                  </th>
                  <th className="w-8 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.key} className="align-top">
                    <td className="px-2 py-1.5">
                      {canEdit ? (
                        /*
                          A searchable picker, not a dropdown.

                          The revenue side of the chart runs to a few hundred
                          accounts, and a plain list of them is scrolled past
                          rather than read - which is how a receipt ends up on
                          whichever account was nearest the one wanted. Typing
                          "real property" or "40102040" narrows it to the few
                          that match, which is what the clerk has in their
                          head when they start.
                        */
                        <Combobox
                          options={revenueOptions}
                          value={r.accountCode || null}
                          onChange={(code) => chooseAccount(r.key, code ?? '')}
                          placeholder="Account code or name"
                          emptyMessage="No revenue account matches"
                        />
                      ) : (
                        <span>
                          <span className="font-mono text-2xs text-slate-500">{r.accountCode}</span>{' '}
                          {r.accountName}
                        </span>
                      )}
                      {canEdit && (
                        <TextInput
                          className="mt-1"
                          placeholder="Wording on the form, if different"
                          value={r.particulars}
                          onChange={(e) => set(r.key, { particulars: e.target.value })}
                        />
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Select
                        value={r.incomeClass}
                        disabled={!canEdit}
                        onChange={(e) =>
                          set(r.key, { incomeClass: e.target.value as IncomeClass })
                        }
                      >
                        {INCOME_CLASSES.map((c) => (
                          <option key={c} value={c}>
                            {INCOME_CLASS_LABELS[c]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    {(['q1', 'q2', 'q3', 'q4'] as const).map((q) => (
                      <td key={q} className="px-2 py-1.5">
                        <AmountInput
                          value={r[q]}
                          disabled={!canEdit}
                          onChange={(v) => set(r.key, { [q]: v ?? 0 } as Partial<DraftRow>)}
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-right font-mono">
                      {formatAmount(annualOf(r))}
                    </td>
                    <td className="px-2 py-1.5">
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setDirty(true);
                            setRows((rs) => rs.filter((x) => x.key !== r.key));
                          }}
                        >
                          &times;
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 bg-slate-50 font-semibold">
                  <td className="px-2 py-2" colSpan={2}>
                    TOTAL
                  </td>
                  {totals.q.map((v, i) => (
                    <td key={i} className="px-2 py-2 text-right font-mono">
                      {formatAmount(v)}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right font-mono">{formatAmount(totals.grand)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {rows.length === 0 && (
            <div className="p-4">
              <Alert tone="info" title="No estimated receipts recorded for this fund">
                Upload the receipts side of LBP Form No. 1, or add lines one at a time. Until this
                is filled in, the SRE and the Statement of Comparison have no budget column for
                receipts at all.
              </Alert>
            </div>
          )}
        </Card>
      ) : (
        <Card className="mt-4" bodyClassName="p-0">
          <div className="p-4">
            <p className="text-xs text-slate-600">
              The receipts section of LBP Form No. 1 for the budget year, in the statutory line
              order. Each account is placed by the SRE mapping the office has already made, so the
              estimate appears on exactly the line its collections will appear on.
            </p>
          </div>

          {Object.keys(mapping).length === 0 && (
            <div className="px-4 pb-4">
              <Alert tone="warning" title="No account has been mapped to a receipt line yet">
                The schedule is recorded, but nothing can be placed on the form until the SRE
                mapping is filled in. It is on the SRE screen, under &ldquo;Mapping&rdquo;, and the
                same mapping serves both.
              </Alert>
            </div>
          )}

          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="cbo-th">Particulars</th>
                <th className="cbo-th text-right" style={{ width: '12rem' }}>
                  Budget Year (Proposed)
                </th>
              </tr>
            </thead>
            <tbody>
              {SRE_RECEIPT_LINES.map((line) => {
                const value = lineTotals.get(line.key) ?? 0;
                const bold = line.kind === 'SUBTOTAL' || line.kind === 'TOTAL';
                return (
                  <tr key={line.key} className={bold ? 'font-semibold' : undefined}>
                    <td
                      className="cbo-td"
                      style={{ paddingLeft: `${0.5 + line.indent * 1.25}rem` }}
                    >
                      {line.label}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {line.kind === 'HEADING' ? '' : formatAmount(value)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {unmapped.length > 0 && (
            <div className="p-4">
              <Alert
                tone="error"
                title={`${unmapped.length} account${
                  unmapped.length === 1 ? '' : 's'
                } on the schedule sit${unmapped.length === 1 ? 's' : ''} on no line of the form`}
              >
                <p>
                  {formatPeso(unmappedTotal)} of the {formatPeso(totals.grand)} recorded is not
                  shown above, so Total Receipts on this form is short by that much. Map these on
                  the SRE screen:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {unmapped.slice(0, 10).map((r) => (
                    <li key={r.key}>
                      <span className="font-mono">{r.accountCode}</span> {r.accountName} &mdash;{' '}
                      {formatPeso(annualOf(r))}
                    </li>
                  ))}
                </ul>
                {unmapped.length > 10 && <p className="mt-1">and {unmapped.length - 10} more.</p>}
              </Alert>
            </div>
          )}

          <div className="border-t border-slate-200 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              By income class
            </h3>
            <dl className="mt-2 grid gap-3 sm:grid-cols-3">
              {INCOME_CLASSES.map((c) => (
                <div key={c} className="rounded border border-slate-200 p-3">
                  <dt className="text-xs font-medium text-navy-800">{INCOME_CLASS_LABELS[c]}</dt>
                  <dd className="mt-1 font-mono text-sm">{formatPeso(totals.byClass[c])}</dd>
                  <dd className="mt-1 text-2xs leading-snug text-slate-500">
                    {INCOME_CLASS_HINTS[c]}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-2xs text-slate-500">
              On LBP Form No. 1, Non-Income Receipts is section B of Non-Regular Income; the two
              add up to Total Non-Regular Income. The split is kept because the regular part alone
              is the base of the LDRRMF and the Personal Services limit.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
