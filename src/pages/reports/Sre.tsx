import { useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { ReportShell } from '@/components/ReportShell';
import { Spinner, Alert, Card } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useAccounts,
  useBudgetBalances,
  useEstimatedReceipts,
  useLedgerEntries,
} from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { monthName } from '@/lib/dates';
import { SRE_BUCKET_LABELS } from '@/lib/sectors';
import { annualOf } from '@/lib/estimatedReceipts';
import {
  SRE_MAPPABLE_LINES,
  SRE_RECEIPT_LINES,
  appropriationsByFund,
  estimatesAsEntries,
  expendituresByFund,
  mappingConflicts,
  receiptsByLine,
  resolveTotals,
  unmappedReceipts,
  type SreEntry,
  type SreMapping,
} from '@/lib/sre';
import type { Centavos, PeriodNo } from '@/types/common';

/**
 * Statement of Receipts and Expenditures.
 *
 * DBM-DOF-DILG Joint Memorandum Circular No. 2018-1, Annex A. Submitted to the
 * DOF-BLGF through the LGU Integrated Financial Tools.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE IGNORES THE FUND FILTER
 * ---------------------------------------------------------------------------
 * Every other report in CFMS is for one fund, because every other report
 * answers a question about one fund. The SRE is not: its expenditure section
 * has a line for the General Fund, a line for the Special Education Fund and a
 * line for the Trust Fund, and it is submitted for the municipality as a
 * whole. So it reads all three regardless of what the filter at the top of the
 * screen says, and says so on its face rather than quietly showing a third of
 * the answer under a familiar heading.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BEGINNING AND ENDING CASH BALANCES ARE NOT FILLED IN
 * ---------------------------------------------------------------------------
 * Annex A opens with the beginning cash balance and closes with the ending
 * one. Both are cash figures, and CFMS's cash position is built from the bank
 * ledgers and the treasury's own books rather than from the General Ledger
 * entries this statement reads. Deriving them here from a different source
 * than the rest of the statement would produce two figures that look like a
 * pair and are not, and the difference would land on the one line nobody
 * checks. They are left for the Treasurer to enter on the form.
 * ---------------------------------------------------------------------------
 */


export default function Sre() {
  const { fiscalYear } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const [throughPeriod, setThroughPeriod] = useState<PeriodNo>(12);
  const [showMapping, setShowMapping] = useState(false);
  const [saving, setSaving] = useState(false);

  // The three funds, read separately because the statement reports them
  // separately. Calling the hook three times is deliberate and fixed: hooks
  // may not be called in a loop whose length can change.
  const gf = useLedgerEntries(fiscalYear, 'GF', { throughPeriod });
  const sef = useLedgerEntries(fiscalYear, 'SEF', { throughPeriod });
  const tf = useLedgerEntries(fiscalYear, 'TF', { throughPeriod });

  const gfBudget = useBudgetBalances(fiscalYear, 'GF');
  const sefBudget = useBudgetBalances(fiscalYear, 'SEF');
  const tfBudget = useBudgetBalances(fiscalYear, 'TF');

  /*
   * The Budget Year column.
   *
   * Annex A asks for it on both sides. On the spending side CFMS has always had
   * it - the appropriation ordinance is loaded. On the receiving side it did
   * not exist anywhere in the system, because an ordinance authorises
   * expenditure and says nothing about what will pay for it; the figures now
   * come from the estimated receipts recorded under Budget.
   */
  const gfEstimate = useEstimatedReceipts(fiscalYear, 'GF');
  const sefEstimate = useEstimatedReceipts(fiscalYear, 'SEF');
  const tfEstimate = useEstimatedReceipts(fiscalYear, 'TF');
  const accounts = useAccounts(false);
  const mappingDoc = useDocument<{ lines?: SreMapping }>(COL.settings, 'sreMapping');

  const mapping: SreMapping = useMemo(() => mappingDoc.data?.lines ?? {}, [mappingDoc.data]);
  const [draft, setDraft] = useState<SreMapping | null>(null);
  const working = draft ?? mapping;

  const entries = useMemo<SreEntry[]>(
    () =>
      [...gf.data, ...sef.data, ...tf.data].map((e) => ({
        fundCode: e.fundCode,
        accountCode: e.accountCode,
        accountName: e.accountName,
        fppCode: e.fppCode,
        debit: e.debit,
        credit: e.credit,
      })),
    [gf.data, sef.data, tf.data],
  );

  const revenueCodes = useMemo(
    () => new Set(accounts.data.filter((a) => a.accountClass === 'REVENUE').map((a) => a.code)),
    [accounts.data],
  );

  const figures = useMemo(
    () => resolveTotals(receiptsByLine(entries, mapping)),
    [entries, mapping],
  );

  /** The estimate, placed by the same mapping that places the actual. */
  const budgetFigures = useMemo(
    () =>
      resolveTotals(
        receiptsByLine(
          estimatesAsEntries(
            [...gfEstimate.data, ...sefEstimate.data, ...tfEstimate.data].map((r) => ({
              fundCode: r.fundCode,
              accountCode: r.accountCode,
              accountName: r.accountName,
              annual: annualOf(r),
            })),
          ),
          mapping,
        ),
      ),
    [gfEstimate.data, sefEstimate.data, tfEstimate.data, mapping],
  );

  const budgetExpenditures = useMemo(
    () =>
      appropriationsByFund(
        [...gfBudget.data, ...sefBudget.data, ...tfBudget.data].map((b) => ({
          fundCode: b.fundCode,
          fppCode: b.fppCode,
          sector: b.sector,
          serviceSector: b.serviceSector,
          appropriationRevised: b.appropriationRevised,
        })),
      ),
    [gfBudget.data, sefBudget.data, tfBudget.data],
  );

  /** Nothing recorded anywhere, so the whole column would be a row of dashes. */
  const noEstimate =
    gfEstimate.data.length === 0 &&
    sefEstimate.data.length === 0 &&
    tfEstimate.data.length === 0;

  const unmapped = useMemo(
    () => unmappedReceipts(entries, mapping, (code) => revenueCodes.has(code)),
    [entries, mapping, revenueCodes],
  );

  const conflicts = useMemo(() => mappingConflicts(mapping), [mapping]);

  const expenditures = useMemo(
    () =>
      expendituresByFund(
        entries,
        gfBudget.data.map((b) => ({
          fppCode: b.fppCode,
          sector: b.sector,
          serviceSector: b.serviceSector,
        })),
      ),
    [entries, gfBudget.data],
  );

  const canEditMapping = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT', 'MUNICIPAL_TREASURER');

  const saveMapping = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await setDoc(doc(db, COL.settings, 'sreMapping'), { lines: draft }, { merge: false });
      toast.success('Mapping saved', 'The statement will use it from now on.');
      setDraft(null);
    } catch (err) {
      toast.error('Could not save the mapping', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const assign = (accountCode: string, lineKey: string) =>
    setDraft(() => {
      const next: SreMapping = Object.fromEntries(
        Object.entries(working).map(([k, v]) => [k, v.filter((c) => c !== accountCode)]),
      );
      if (lineKey) next[lineKey] = [...(next[lineKey] ?? []), accountCode];
      return next;
    });

  const loading = gf.loading || sef.loading || tf.loading || accounts.loading;
  const error = gf.error ?? sef.error ?? tf.error ?? accounts.error;

  /** Every revenue account, with what it currently maps to. */
  const revenueRows = useMemo(() => {
    const lineOf = new Map<string, string>();
    for (const [lineKey, codes] of Object.entries(working)) {
      for (const code of codes) lineOf.set(code, lineKey);
    }
    const totals = new Map<string, Centavos>();
    for (const e of entries) {
      if (!revenueCodes.has(e.accountCode)) continue;
      totals.set(e.accountCode, (totals.get(e.accountCode) ?? 0) + e.credit - e.debit);
    }
    return accounts.data
      .filter((a) => a.accountClass === 'REVENUE' && a.postable !== false)
      .map((a) => ({
        code: a.code,
        name: a.name,
        amount: totals.get(a.code) ?? 0,
        lineKey: lineOf.get(a.code) ?? '',
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts.data, entries, revenueCodes, working]);

  return (
    <ReportShell
      meta={{
        title: 'Statement of Receipts and Expenditures',
        fundLabel: 'All funds — General, Special Education and Trust',
        periodLabel:
          throughPeriod === 12
            ? `For the year ended 31 December ${fiscalYear}`
            : `For the period January to ${monthName(throughPeriod)} ${fiscalYear}`,
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Reports' }, { label: 'SRE (LBAc 4)' }]}
      actions={
        canEditMapping ? (
          <Button size="sm" onClick={() => setShowMapping((v) => !v)}>
            {showMapping ? 'Hide the mapping' : 'Map revenue accounts'}
          </Button>
        ) : undefined
      }
      filters={
        <Field label="Up to and including" className="w-44">
          <Select
            value={String(throughPeriod)}
            onChange={(e) => setThroughPeriod(Number(e.target.value) as PeriodNo)}
          >
            {Array.from({ length: 12 }, (_, i) => (i + 1) as PeriodNo).map((p) => (
              <option key={p} value={p}>
                {monthName(p)}
              </option>
            ))}
          </Select>
        </Field>
      }
      footnote={
        <>
          DBM-DOF-DILG Joint Memorandum Circular No. 2018-1, Annex A. All three funds, whatever the
          fund filter above says — the statement is submitted for the municipality as a whole. The
          beginning and ending cash balances are left blank: they are cash figures and CFMS builds
          its cash position from the bank ledgers rather than from the entries this statement reads,
          so deriving them here would put two figures that look like a pair, and are not, at the top
          and bottom of the form.
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : error ? (
        <Alert tone="error" title="The statement could not be built">
          {error}
        </Alert>
      ) : (
        <>
          {Object.keys(mapping).length === 0 && (
            <Alert tone="warning" title="No revenue account has been mapped yet" className="mb-4 no-print">
              The receipts section will be empty until each revenue account is put on one of the
              twenty lines of Annex A. CFMS ships with none of that filled in on purpose: which of
              your account codes belongs on "Regulatory Fees" rather than "Service/User Charges" is
              a judgement for the Accountant and the Treasurer, and a mapping invented for you would
              give a statement that foots correctly and reports the wrong figures to BLGF.
              {canEditMapping && ' Press "Map revenue accounts" above to begin.'}
            </Alert>
          )}

          {conflicts.length > 0 && (
            <Alert tone="error" title="An account is on more than one line" className="mb-4 no-print">
              {conflicts.map((c) => c.accountCode).join(', ')} — counted on every line it appears on,
              so the receipts total is overstated by that much.
            </Alert>
          )}

          {noEstimate && (
            <Alert
              tone="warning"
              title="The Budget Year column for receipts is empty"
              className="mb-4 no-print"
            >
              No estimated receipts have been recorded for {fiscalYear}. The appropriation
              ordinance authorises expenditure only, so the receipts side of this column cannot be
              read off it &mdash; it comes from the estimated receipts schedule under Budget, which
              is the receipts portion of LBP Form No. 1. The expenditure side of the column is the
              appropriation and is filled in below.
            </Alert>
          )}

          {unmapped.length > 0 && (
            <Alert
              tone="warning"
              title={`${unmapped.length} revenue account${unmapped.length === 1 ? '' : 's'} not on any line`}
              className="mb-4 no-print"
            >
              {unmapped.slice(0, 8).map((u) => `${u.accountCode} (${formatPeso(u.amount)})`).join(', ')}
              {unmapped.length > 8 ? ', and others' : ''}. They are not in the figures below. A
              statement that foots to its own totals while leaving a revenue account out is wrong in
              the way that is hardest to notice.
            </Alert>
          )}

          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="cbo-th">Particulars</th>
                <th className="cbo-th w-44 text-right">Actual</th>
                <th className="cbo-th w-44 text-right">Budget Year</th>
              </tr>
            </thead>
            <tbody>
              <SectionRow label="RECEIPTS" />
              <tr>
                <td className="cbo-td text-sm text-slate-500">Beginning Cash Balance</td>
                <td className="cbo-td cbo-amount text-slate-400">to be entered</td>
                <td className="cbo-td cbo-amount text-slate-400">to be entered</td>
              </tr>
              {SRE_RECEIPT_LINES.map((line) => (
                <tr key={line.key} className={line.kind === 'TOTAL' ? 'font-semibold' : undefined}>
                  <td
                    className={`cbo-td text-sm ${
                      line.kind === 'HEADING' ? 'font-medium text-navy-900' : 'text-navy-800'
                    }`}
                    style={{ paddingLeft: `${0.75 + line.indent * 1.25}rem` }}
                  >
                    {line.label}
                  </td>
                  <td className="cbo-td cbo-amount">
                    {line.kind === 'HEADING'
                      ? ''
                      : formatPeso(figures.get(line.key) ?? 0, { symbol: false, dash: true })}
                  </td>
                  <td className="cbo-td cbo-amount">
                    {line.kind === 'HEADING'
                      ? ''
                      : formatPeso(budgetFigures.get(line.key) ?? 0, { symbol: false, dash: true })}
                  </td>
                </tr>
              ))}

              <SectionRow label="EXPENDITURES" />
              <tr>
                <td className="cbo-td pl-3 text-sm font-medium text-navy-900">I. General Fund</td>
                <td className="cbo-td" />
                <td className="cbo-td" />
              </tr>
              {(['GENERAL', 'ECONOMIC', 'SOCIAL', 'DEBT'] as const).map((b) => (
                <tr key={b}>
                  <td className="cbo-td text-sm" style={{ paddingLeft: '2rem' }}>
                    {SRE_BUCKET_LABELS[b]}
                  </td>
                  <td className="cbo-td cbo-amount">
                    {formatPeso(expenditures.generalFund[b], { symbol: false, dash: true })}
                  </td>
                  <td className="cbo-td cbo-amount">
                    {formatPeso(budgetExpenditures.generalFund[b], { symbol: false, dash: true })}
                  </td>
                </tr>
              ))}
              {expenditures.generalFundUnclassified !== 0 && (
                <tr className="bg-amber-50">
                  <td className="cbo-td text-sm text-amber-900" style={{ paddingLeft: '2rem' }}>
                    Not yet classified
                    <span className="block text-2xs">
                      Charged to a budget line whose sector is a funding source with no service
                      named, or to no budget line at all. Counted in the total so nothing is lost.
                    </span>
                  </td>
                  <td className="cbo-td cbo-amount text-amber-900">
                    {formatPeso(expenditures.generalFundUnclassified, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount text-amber-900">
                    {formatPeso(budgetExpenditures.generalFundUnclassified, {
                      symbol: false,
                      dash: true,
                    })}
                  </td>
                </tr>
              )}
              <tr>
                <td className="cbo-td pl-3 text-sm font-medium text-navy-900">
                  II. Special Education Fund
                </td>
                <td className="cbo-td cbo-amount">
                  {formatPeso(expenditures.specialEducationFund, { symbol: false, dash: true })}
                </td>
                <td className="cbo-td cbo-amount">
                  {formatPeso(budgetExpenditures.specialEducationFund, {
                    symbol: false,
                    dash: true,
                  })}
                </td>
              </tr>
              <tr>
                <td className="cbo-td pl-3 text-sm font-medium text-navy-900">
                  III. Trust Fund from National Government Transfers
                </td>
                <td className="cbo-td cbo-amount">
                  {formatPeso(expenditures.trustFund, { symbol: false, dash: true })}
                </td>
                <td className="cbo-td cbo-amount">
                  {formatPeso(budgetExpenditures.trustFund, { symbol: false, dash: true })}
                </td>
              </tr>
              <tr className="border-t-2 border-navy-800 font-semibold">
                <td className="cbo-td">Total Expenditures</td>
                <td className="cbo-td cbo-amount">
                  {formatPeso(expenditures.total, { symbol: false })}
                </td>
                <td className="cbo-td cbo-amount">
                  {formatPeso(budgetExpenditures.total, { symbol: false })}
                </td>
              </tr>
              <tr>
                <td className="cbo-td text-sm text-slate-500">Ending Cash Balance</td>
                <td className="cbo-td cbo-amount text-slate-400">to be entered</td>
                <td className="cbo-td cbo-amount text-slate-400">to be entered</td>
              </tr>
            </tbody>
          </table>

          {showMapping && canEditMapping && (
            <Card
              title="Which line each revenue account belongs on"
              subtitle="Saved for the whole municipality. Nothing is applied to the statement until you save."
              className="mt-6 no-print"
            >
              <div className="max-h-96 overflow-auto rounded border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Account</th>
                      <th className="px-2 py-1.5 text-right font-medium">This period</th>
                      <th className="px-2 py-1.5 font-medium" style={{ minWidth: '18rem' }}>
                        SRE line
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {revenueRows.map((r) => (
                      <tr key={r.code} className={!r.lineKey && r.amount !== 0 ? 'bg-amber-50' : undefined}>
                        <td className="px-2 py-1.5">
                          <span className="font-mono text-slate-500">{r.code}</span>{' '}
                          <span>{r.name}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular">
                          {formatPeso(r.amount, { symbol: false, dash: true })}
                        </td>
                        <td className="px-2 py-1.5">
                          <Select
                            value={r.lineKey}
                            onChange={(e) => assign(r.code, e.target.value)}
                            className="py-1 text-xs"
                          >
                            <option value="">Not on the statement</option>
                            {SRE_MAPPABLE_LINES.map((l) => (
                              <option key={l.key} value={l.key}>
                                {l.label.replace(/^[a-z0-9]\.\s*/i, '')}
                              </option>
                            ))}
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {revenueRows.length === 0 && (
                <Alert tone="info" className="mt-3">
                  There are no revenue accounts in the Chart of Accounts yet. Load it under Master
                  Data first.
                </Alert>
              )}

              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="primary"
                  loading={saving}
                  disabled={!draft || saving}
                  onClick={() => void saveMapping()}
                >
                  Save the mapping
                </Button>
                <Button variant="ghost" disabled={!draft} onClick={() => setDraft(null)}>
                  Discard changes
                </Button>
                {draft && (
                  <span className="text-xs text-amber-700">
                    Not saved yet — the statement above still shows the saved mapping.
                  </span>
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </ReportShell>
  );
}

function SectionRow({ label }: { label: string }) {
  return (
    <tr className="bg-slate-100">
      <td className="cbo-td text-sm font-semibold uppercase tracking-wide text-navy-900" colSpan={3}>
        {label}
      </td>
    </tr>
  );
}
