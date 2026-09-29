import { useEffect, useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, AmountInput, Checkbox } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useBudgetBalances } from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import {
  INCOME_CLASS_LABELS,
  checkStatutoryLimits,
  psCapRate,
  type IncomeClass,
  type LimitResult,
  type LimitVerdict,
} from '@/lib/statutoryLimits';
import { fundLabel } from './Obligations';
import type { Centavos } from '@/types/common';

/**
 * The limits an appropriation ordinance is reviewed against.
 *
 * Budget Operations Manual for LGUs, 2023 Edition, Chapter 3 of Part II.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * These are the tests the reviewing authority applies AFTER the Sanggunian has
 * enacted the budget. By then the offices have begun spending against it, and
 * the remedy is an amendment. Applied here, while the ordinance is still being
 * drafted, the remedy is a change to a spreadsheet.
 *
 * The consequences are not warnings. A Personal Services appropriation over
 * the cap is disallowed and the ordinance is inoperative IN PART. An LDRRMF
 * below five per cent makes it inoperative IN ITS ENTIRETY - the whole budget
 * of the municipality, for a shortfall on one line.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DENOMINATORS ARE TYPED IN AND NOT DERIVED
 * ---------------------------------------------------------------------------
 * CBO could compute last year's income from its own ledger. It deliberately
 * does not. The reviewing authority will use the figure in the LGU's own
 * statements, and a test run against a different number than the reviewer's is
 * a test that passes here and fails there. The Treasurer states the figure
 * once a year; CBO checks against what was stated.
 * ---------------------------------------------------------------------------
 */

interface Settings {
  incomeClass?: IncomeClass;
  regularIncomePrecedingYear?: Centavos;
  estimatedRegularIncome?: Centavos;
  nationalTaxAllotment?: Centavos;
  /** Budget balance ids the office has nominated as Quick Response Fund. */
  quickResponseLineIds?: string[];
}

const VERDICT_TONE: Record<LimitVerdict, 'emerald' | 'rose' | 'amber' | 'slate'> = {
  OK: 'emerald',
  BREACH: 'rose',
  CONDITION: 'amber',
  UNKNOWN: 'slate',
};

const VERDICT_LABEL: Record<LimitVerdict, string> = {
  OK: 'Compliant',
  BREACH: 'Breach',
  CONDITION: 'Condition',
  UNKNOWN: 'Cannot tell',
};

export default function StatutoryLimits() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const balances = useBudgetBalances(fiscalYear, fundCode);
  const docId = `statutoryLimits-${fiscalYear}`;
  const stored = useDocument<Settings>(COL.settings, docId);

  const [form, setForm] = useState<Settings>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // The stored figures land in the form once, and the form is the truth after
  // that - re-seeding on every snapshot would overwrite what is being typed.
  useEffect(() => {
    if (stored.loading || dirty) return;
    setForm(stored.data ?? {});
  }, [stored.data, stored.loading, dirty]);

  const canEdit = hasRole('SUPER_ADMIN', 'BUDGET_OFFICER', 'MUNICIPAL_TREASURER');

  const set = (patch: Partial<Settings>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  /** The LDRRMF budget lines, which is what may be nominated as Quick Response Fund. */
  const ldrrmfLines = useMemo(
    () =>
      balances.data
        .filter((b) => (b.sector ?? '').trim().toUpperCase() === 'LDRRMF')
        .filter((b) => b.appropriationRevised !== 0)
        .sort((a, b) => a.fppCode.localeCompare(b.fppCode)),
    [balances.data],
  );

  // Built inside the memo, not beside it. A Set constructed on every render
  // would be a new object every time and the memo below would never hit,
  // recomputing four totals over every budget line on each keystroke in the
  // income boxes.
  const nominatedIds = form.quickResponseLineIds;
  const nominated = useMemo(() => new Set(nominatedIds ?? []), [nominatedIds]);

  const totals = useMemo(() => {
    let personalServices = 0;
    let ldrrmf = 0;
    let quickResponseFund = 0;
    let developmentFund = 0;

    for (const b of balances.data) {
      const sector = (b.sector ?? '').trim().toUpperCase();
      if (b.expenseClass === 'PS') personalServices += b.appropriationRevised;
      if (sector === 'LDRRMF') {
        ldrrmf += b.appropriationRevised;
        if (nominated.has(b.id)) quickResponseFund += b.appropriationRevised;
      }
      if (sector === '20% DEVELOPMENT FUND') developmentFund += b.appropriationRevised;
    }

    return { personalServices, ldrrmf, quickResponseFund, developmentFund };
  }, [balances.data, nominated]);

  const results = useMemo(
    () =>
      checkStatutoryLimits(
        {
          incomeClass: form.incomeClass ?? '4',
          regularIncomePrecedingYear: form.regularIncomePrecedingYear ?? 0,
          estimatedRegularIncome: form.estimatedRegularIncome ?? 0,
          nationalTaxAllotment: form.nationalTaxAllotment ?? 0,
        },
        totals,
      ),
    [form, totals],
  );

  const breaches = results.filter((r) => r.verdict === 'BREACH');

  const save = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, COL.settings, docId), form, { merge: true });
      toast.success('Saved', 'The checks will use these figures from now on.');
      setDirty(false);
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Statutory limits"
        subtitle={`${fundLabel(fundCode)} · fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Statutory limits' }]}
        actions={
          canEdit ? (
            <Button variant="primary" loading={saving} disabled={!dirty || saving} onClick={() => void save()}>
              Save the figures
            </Button>
          ) : undefined
        }
      />

      <Alert tone="info" title="Checked before enactment, not after" className="mb-5">
        These are the tests the reviewing authority applies to the ordinance once the Sanggunian has
        enacted it — by which time the offices have begun spending against it and the remedy is an
        amendment. Run here while the budget is still being drafted, the remedy is a change to a
        spreadsheet.
      </Alert>

      {breaches.length > 0 && (
        <Alert
          tone="error"
          title={`${breaches.length} limit${breaches.length === 1 ? ' is' : 's are'} breached`}
          className="mb-5"
        >
          {breaches.map((b) => b.label).join('; ')}. Read the consequence beside each one — they are
          not the same. One of them voids the whole ordinance.
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card title="The tests" bodyClassName="p-0">
          <ul className="divide-y divide-slate-100">
            {results.map((r) => (
              <LimitRow key={r.key} result={r} />
            ))}
          </ul>
        </Card>

        <div className="space-y-5">
          <Card
            title="The figures these are measured against"
            subtitle="Stated by the Treasurer once a year. CBO does not derive them — see the note below."
          >
            <div className="space-y-4">
              <Field label="Income class" hint={`Decides the Personal Services cap: ${(psCapRate(form.incomeClass ?? '4') * 100).toFixed(0)}%.`}>
                <Select
                  value={form.incomeClass ?? '4'}
                  disabled={!canEdit}
                  onChange={(e) => set({ incomeClass: e.target.value as IncomeClass })}
                >
                  {(Object.keys(INCOME_CLASS_LABELS) as IncomeClass[]).map((c) => (
                    <option key={c} value={c}>
                      {INCOME_CLASS_LABELS[c]} ({['1', '2', '3'].includes(c) ? '45%' : '55%'})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Regular income realised last year"
                hint={`Total annual income from regular sources for ${fiscalYear - 1}. The base of the PS cap.`}
              >
                <AmountInput
                  value={form.regularIncomePrecedingYear ?? null}
                  disabled={!canEdit}
                  onChange={(v) => set({ regularIncomePrecedingYear: v ?? 0 })}
                />
              </Field>

              <Field
                label="Estimated regular income this year"
                hint="The base of the 5% LDRRMF minimum."
              >
                <AmountInput
                  value={form.estimatedRegularIncome ?? null}
                  disabled={!canEdit}
                  onChange={(v) => set({ estimatedRegularIncome: v ?? 0 })}
                />
              </Field>

              <Field
                label="National Tax Allotment this year"
                hint="The base of the 20% Development Fund minimum."
              >
                <AmountInput
                  value={form.nationalTaxAllotment ?? null}
                  disabled={!canEdit}
                  onChange={(v) => set({ nationalTaxAllotment: v ?? 0 })}
                />
              </Field>
            </div>
          </Card>

          <Card
            title="Which LDRRMF lines are the Quick Response Fund"
            subtitle="Nominated, not guessed."
          >
            {ldrrmfLines.length === 0 ? (
              <p className="text-sm text-slate-500">
                No LDRRMF appropriation has been recorded for {fiscalYear} in this fund.
              </p>
            ) : (
              <>
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {ldrrmfLines.map((b) => (
                    <Checkbox
                      key={b.id}
                      checked={nominated.has(b.id)}
                      disabled={!canEdit}
                      onChange={(on) =>
                        set({
                          quickResponseLineIds: on
                            ? [...nominated, b.id]
                            : [...nominated].filter((id) => id !== b.id),
                        })
                      }
                      label={`${b.fppCode} ${b.fppName || b.accountName}`}
                      hint={`${b.officeName} · ${formatPeso(b.appropriationRevised)}`}
                    />
                  ))}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  A rule that guessed the Quick Response Fund from a project name would be wrong on
                  the first ordinance that spelled it differently, so CBO asks instead.
                </p>
              </>
            )}
          </Card>
        </div>
      </div>

      <Card title="What CBO cannot see" className="mt-5">
        <ul className="space-y-2 text-sm text-slate-600">
          <li>
            The Personal Services cap excludes the salaries of officials and employees of economic
            enterprises and public utilities the municipality owns. CBO has no marker for those, so
            the PS total above includes them — if Candoni runs any, the figure shown is higher than
            the one the reviewer will use, and the test is stricter than the law. Tell me and I will
            add the marker.
          </li>
          <li>
            The figures on the right are not derived from CBO&rsquo;s own ledger on purpose. The
            reviewing authority uses the figure in the municipality&rsquo;s own statements, and a
            test run against a different number than the reviewer&rsquo;s is one that passes here
            and fails there.
          </li>
        </ul>
      </Card>
    </div>
  );
}

function LimitRow({ result }: { result: LimitResult }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-navy-900">{result.label}</p>
          <p className="mt-0.5 text-xs text-slate-500">{result.consequence}</p>
        </div>
        <Badge tone={VERDICT_TONE[result.verdict]}>{VERDICT_LABEL[result.verdict]}</Badge>
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-2xs uppercase tracking-wide text-slate-500">Appropriated</dt>
          <dd className="cbo-amount text-sm">{formatPeso(result.actual, { symbol: false })}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-slate-500">Required</dt>
          <dd className="cbo-amount text-sm">
            {result.threshold === null ? '—' : formatPeso(result.threshold, { symbol: false })}
          </dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-slate-500">Difference</dt>
          <dd
            className={`cbo-amount text-sm ${result.verdict === 'BREACH' ? 'text-rose-700' : ''}`}
          >
            {result.shortfall === null ? '—' : formatPeso(result.shortfall, { symbol: false })}
          </dd>
        </div>
      </dl>

      <p className={`mt-2 text-xs ${result.verdict === 'BREACH' ? 'text-rose-700' : 'text-slate-600'}`}>
        {result.note}
      </p>
    </li>
  );
}
