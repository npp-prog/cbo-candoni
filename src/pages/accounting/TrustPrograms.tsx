import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, TextArea, AmountInput } from '@/components/ui/Field';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { useFilters } from '@/context/FilterContext';
import { useTrustPrograms } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso, formatAmount } from '@/lib/money';
import { checkTrustProgram, TRUST_PROGRAM_STATUSES } from '@/lib/trustPrograms';
import type { TrustProgram } from '@/types/budget';
import type { Centavos } from '@/types/common';

/**
 * Trust Fund programmes — the Fund Receipts Program.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN ACCOUNTING SCREEN
 * ---------------------------------------------------------------------------
 * There is no ordinance behind a trust programme and nothing for the Budget
 * Officer to release. The money arrived under a memorandum of agreement, a
 * deed or an advice; the Accountant books it, reports on it, and answers to
 * the source for it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REPLACES
 * ---------------------------------------------------------------------------
 * Until this existed CBO checked every fund against the released allotment,
 * the Trust Fund included — so a Funding Utilization Request could not be
 * certified at all unless somebody first invented an appropriation and an
 * Allotment Release Order for money the municipality had not been given. Had
 * they done so, those invented figures would have flowed into the Statement of
 * Receipts and Expenditures and into the Personal Services and LDRRMF limits.
 *
 * The programmed amount plays the part the released allotment plays in the
 * General Fund: it is the ceiling, and a utilisation may not pass it.
 * ---------------------------------------------------------------------------
 */

interface FormState {
  programId?: string;
  programCode: string;
  programName: string;
  sourceAgency: string;
  reference: string;
  startYear: number | null;
  programmed: Centavos | null;
  received: Centavos | null;
  status: 'ACTIVE' | 'CLOSED';
  notes: string;
}

const empty = (startYear: number): FormState => ({
  programCode: '',
  programName: '',
  sourceAgency: '',
  reference: '',
  startYear,
  programmed: null,
  received: null,
  status: 'ACTIVE',
  notes: '',
});

const fromProgram = (p: TrustProgram): FormState => ({
  programId: p.id,
  programCode: p.programCode,
  programName: p.programName,
  sourceAgency: p.sourceAgency,
  reference: p.reference,
  startYear: p.startYear ?? null,
  programmed: p.programmed,
  received: p.received,
  status: p.status,
  notes: p.notes ?? '',
});

export default function TrustPrograms() {
  const { fiscalYear } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const programs = useTrustPrograms();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const canEdit = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const totals = useMemo(
    () =>
      programs.data.reduce(
        (acc, p) => ({
          programmed: acc.programmed + p.programmed,
          received: acc.received + p.received,
          utilised: acc.utilised + p.utilised,
          disbursed: acc.disbursed + p.disbursed,
        }),
        { programmed: 0, received: 0, utilised: 0, disbursed: 0 },
      ),
    [programs.data],
  );

  const check = useMemo(
    () =>
      form
        ? checkTrustProgram({
            programCode: form.programCode,
            programName: form.programName,
            sourceAgency: form.sourceAgency,
            reference: form.reference,
            programmed: form.programmed ?? 0,
            received: form.received ?? 0,
            status: form.status,
          })
        : null,
    [form],
  );

  const set = (patch: Partial<FormState>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const result = await engine.recordTrustProgram({
        programId: form.programId,
        programCode: form.programCode.trim().toUpperCase(),
        programName: form.programName.trim(),
        sourceAgency: form.sourceAgency.trim(),
        reference: form.reference.trim(),
        startYear: form.startYear ?? undefined,
        programmed: form.programmed ?? 0,
        received: form.received ?? 0,
        status: form.status,
        notes: form.notes.trim() || undefined,
      });
      toast.success(
        `${result.programCode} ${form.programId ? 'amended' : 'recorded'}`,
        `${formatPeso(result.programmed)} programmed, ${formatPeso(
          result.availableToUtilise,
        )} still available to utilise.`,
      );
      setForm(null);
    } catch (err) {
      toast.error('Nothing was recorded', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<TrustProgram>[] = [
    {
      key: 'programCode',
      header: 'Code',
      width: '10rem',
      value: (p) => p.programCode,
      cell: (p) => <span className="font-mono text-xs">{p.programCode}</span>,
    },
    {
      key: 'programName',
      header: 'Programme',
      value: (p) => `${p.programName} ${p.sourceAgency}`,
      cell: (p) => (
        <div>
          <span className="text-sm">{p.programName}</span>
          <span className="block text-2xs text-slate-500">
            {p.sourceAgency} &middot; {p.reference}
          </span>
        </div>
      ),
    },
    {
      key: 'programmed',
      header: 'Programmed',
      kind: 'amount',
      width: '9rem',
      value: (p) => p.programmed,
      cell: (p) => <span>{formatAmount(p.programmed)}</span>,
    },
    {
      key: 'received',
      header: 'Received',
      kind: 'amount',
      width: '9rem',
      value: (p) => p.received,
      cell: (p) => (
        <span className={p.received < p.utilised ? 'text-amber-800' : undefined}>
          {formatAmount(p.received)}
        </span>
      ),
    },
    {
      key: 'utilised',
      header: 'Utilised',
      kind: 'amount',
      width: '9rem',
      value: (p) => p.utilised,
      cell: (p) => <span>{formatAmount(p.utilised)}</span>,
    },
    {
      key: 'disbursed',
      header: 'Disbursed',
      kind: 'amount',
      width: '9rem',
      value: (p) => p.disbursed,
      cell: (p) => <span>{formatAmount(p.disbursed)}</span>,
      optional: true,
    },
    {
      key: 'available',
      header: 'Available',
      kind: 'amount',
      width: '9rem',
      value: (p) => p.availableToUtilise,
      cell: (p) => (
        <span className={p.availableToUtilise === 0 ? 'text-slate-400' : undefined}>
          {formatAmount(p.availableToUtilise)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '9rem',
      value: (p) => p.status,
      cell: (p) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={p.status} />
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setForm(fromProgram(p));
              }}
            >
              Edit
            </Button>
          )}
        </div>
      ),
      fixed: true,
      sortable: false,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Trust Fund Programmes"
        subtitle="The Fund Receipts Program — what each trust is for, and what may be spent on it"
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Trust Fund Programmes' }]}
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setForm(empty(fiscalYear))}>
              Record a programme
            </Button>
          ) : undefined
        }
      />

      <Alert tone="info" className="mb-4">
        The Trust Fund has no appropriation and no allotment &mdash; the money is not the
        municipality&rsquo;s, and there is no ordinance behind it. The{' '}
        <strong>programmed amount</strong> is what a Funding Utilization Request is checked
        against, exactly as a released allotment is in the General Fund. A programme is not tied
        to a fiscal year: trust money does not expire with the budget.
      </Alert>

      <Card bodyClassName="p-0">
        <DataTable
          rows={programs.data}
          columns={columns}
          rowKey={(p) => p.id}
          loading={programs.loading}
          error={programs.error}
          searchPlaceholder="Code, programme, source agency or reference"
          emptyTitle="No trust programme has been recorded"
          emptyMessage="Until a programme exists, no Funding Utilization Request in the Trust Fund can be certified — there is nothing for it to be charged to."
          footer={
            programs.data.length > 0 ? (
              <tr className="border-t-2 border-navy-800 font-semibold">
                <td className="cbo-td" colSpan={2}>
                  TOTAL
                </td>
                <td className="cbo-td cbo-amount">{formatAmount(totals.programmed)}</td>
                <td className="cbo-td cbo-amount">{formatAmount(totals.received)}</td>
                <td className="cbo-td cbo-amount">{formatAmount(totals.utilised)}</td>
                <td className="cbo-td cbo-amount">
                  {formatAmount(totals.programmed - totals.utilised)}
                </td>
                <td className="cbo-td" />
              </tr>
            ) : undefined
          }
        />
      </Card>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.programId ? `Amend ${form.programCode}` : 'Record a trust programme'}
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={saving || !check?.ok}
              onClick={() => void save()}
            >
              {form?.programId ? 'Save the amendment' : 'Record it'}
            </Button>
          </div>
        }
      >
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Programme code"
              required
              hint="What a utilisation is charged to. Two programmes cannot share one."
            >
              <TextInput
                value={form.programCode}
                onChange={(e) => set({ programCode: e.target.value.toUpperCase() })}
              />
            </Field>

            <Field label="Start year" hint="For sorting and reporting only. Not a control.">
              <TextInput
                inputMode="numeric"
                value={form.startYear === null ? '' : String(form.startYear)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set({ startYear: Number.isInteger(n) && n > 0 ? n : null });
                }}
              />
            </Field>

            <Field label="Programme name" required className="sm:col-span-2">
              <TextInput
                value={form.programName}
                onChange={(e) => set({ programName: e.target.value })}
              />
            </Field>

            <Field
              label="Source"
              required
              hint="The agency or person the money came from, and who is owed a report on it."
            >
              <TextInput
                value={form.sourceAgency}
                onChange={(e) => set({ sourceAgency: e.target.value })}
              />
            </Field>

            <Field
              label="Reference"
              required
              hint="The memorandum of agreement, deed or advice the money arrived under."
            >
              <TextInput
                value={form.reference}
                onChange={(e) => set({ reference: e.target.value })}
              />
            </Field>

            <Field
              label="Programmed amount"
              required
              hint="The ceiling. Every utilisation is checked against it."
            >
              <AmountInput value={form.programmed} onChange={(v) => set({ programmed: v })} />
            </Field>

            <Field
              label="Received"
              hint="What the source has actually remitted. Reported, never used to refuse a utilisation."
            >
              <AmountInput value={form.received} onChange={(v) => set({ received: v })} />
            </Field>

            <Field label="Status" required>
              <Select
                value={form.status}
                onChange={(e) => set({ status: e.target.value as 'ACTIVE' | 'CLOSED' })}
              >
                {TRUST_PROGRAM_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'ACTIVE' ? 'Active' : 'Closed'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Notes" className="sm:col-span-2">
              <TextArea
                rows={2}
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
              />
            </Field>

            {check && !check.ok && (
              <div className="sm:col-span-2">
                <Alert tone="error">
                  <ul className="list-inside list-disc space-y-0.5">
                    {check.violations.map((v, i) => (
                      <li key={i}>{v.message}</li>
                    ))}
                  </ul>
                </Alert>
              </div>
            )}

            {form.programId && (
              <div className="sm:col-span-2">
                <Alert tone="info">
                  The programmed amount may be lowered, but not below what has already been
                  utilised &mdash; those commitments have numbers issued against them, and a
                  ceiling beneath them would show a negative balance no document caused. Closing a
                  programme with vouchers still outstanding is refused for the same reason.
                </Alert>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
