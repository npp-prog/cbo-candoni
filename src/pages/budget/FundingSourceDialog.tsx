import { useState } from 'react';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, AmountInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker } from '@/components/pickers';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { SOURCE_SECTIONS, sectionLabel, type SourceSection } from '@/lib/budgetActs';
import type { FundingSource, Ordinance } from '@/types/budget';

/**
 * Encoding a source of financing. Patch 123.
 *
 * Opened from inside an act (the source is that act's) or from the Sources
 * tab (open to any act of the kind it finances). Saved by the engine, which
 * refuses a correction that would leave an approved act short.
 */
export function FundingSourceDialog({
  fiscalYear,
  fundCode,
  act,
  existing,
  sections,
  onClose,
}: {
  fiscalYear: number;
  fundCode: string;
  /** The act it is being encoded in, or null on the Sources tab. */
  act: Ordinance | null;
  existing?: FundingSource | null;
  /** The sections offered; defaults to all. */
  sections?: SourceSection[];
  onClose: () => void;
}) {
  const toast = useToast();
  const offered = SOURCE_SECTIONS.filter((s) => !sections || sections.includes(s.value));
  const [section, setSection] = useState<SourceSection>(
    (existing?.section as SourceSection) ?? offered[0]?.value ?? 'NEW_REVENUE',
  );
  const [particulars, setParticulars] = useState(existing?.particulars ?? '');
  const [accountCode, setAccountCode] = useState<string | null>(existing?.accountCode ?? null);
  const [accountName, setAccountName] = useState<string | null>(existing?.accountName ?? null);
  const [amount, setAmount] = useState<number | null>(existing?.amount ?? null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await engine.saveFundingSource({
        id: existing?.id,
        fiscalYear,
        fundCode,
        section,
        particulars,
        accountCode,
        accountName,
        amount: amount ?? 0,
        actId: existing ? (existing.actId ?? null) : (act?.id ?? null),
      });
      toast.success(
        existing ? 'Source corrected' : 'Source encoded',
        `${sectionLabel(section)} - ${formatPeso(amount ?? 0)}`,
      );
      onClose();
    } catch (err) {
      toast.error('Not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const hint =
    section === 'NEW_REVENUE'
      ? 'A new tax, fee or charge, or loan proceeds, that finances a supplemental budget.'
      : section === 'EXCESS_COLLECTION'
        ? 'What was collected beyond the estimate, as certified by the Treasurer.'
        : "Last year's unexpended authority, carried into this year.";

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? 'Correct a source' : 'Encode a source'}
      description={
        act
          ? `Encoded in ${act.reference}. It finances this act and no other.`
          : 'Encoded on the Sources tab. It is open to any act of the kind it finances.'
      }
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {existing ? 'Save' : 'Encode'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Source" required htmlFor="srcSection" hint={hint} className="sm:col-span-2">
          <Select
            id="srcSection"
            value={section}
            disabled={Boolean(existing)}
            onChange={(e) => setSection(e.target.value as SourceSection)}
          >
            {offered.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Particulars" required htmlFor="srcPart" className="sm:col-span-2">
          <TextInput
            id="srcPart"
            value={particulars}
            onChange={(e) => setParticulars(e.target.value)}
            placeholder={
              section === 'NEW_REVENUE'
                ? 'Tax Revenue - new market stall fees'
                : section === 'EXCESS_COLLECTION'
                  ? 'Excess collection, Real Property Tax'
                  : 'Continuing appropriation, FY 2025 - Construction of ...'
            }
          />
        </Field>
        <Field
          label="Account classification"
          htmlFor="srcAcct"
          hint="The revenue account, where there is one. Optional."
        >
          <AccountPicker
            id="srcAcct"
            value={accountCode}
            onChange={(code, acct) => {
              setAccountCode(code);
              setAccountName(acct?.name ?? null);
            }}
          />
        </Field>
        <Field label="Amount" required htmlFor="srcAmt">
          <AmountInput id="srcAmt" value={amount} onChange={setAmount} />
        </Field>
      </div>
    </Modal>
  );
}

/** A list of sources with correct and remove. */
export function FundingSourceList({
  sources,
  canEdit,
  onEdit,
  empty,
}: {
  sources: FundingSource[];
  canEdit: boolean;
  onEdit: (s: FundingSource) => void;
  empty: string;
}) {
  const toast = useToast();
  const [removing, setRemoving] = useState<FundingSource | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await engine.saveFundingSource({ id: removing.id, remove: true });
      toast.success('Source removed');
      setRemoving(null);
    } catch (err) {
      toast.error('Not removed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (sources.length === 0)
    return <p className="px-4 py-6 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Particulars</th>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Encoded in</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="w-36 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sources.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2">{sectionLabel(s.section)}</td>
                <td className="px-3 py-2">{s.particulars}</td>
                <td className="px-3 py-2 font-mono">{s.accountCode ?? ''}</td>
                <td className="px-3 py-2 text-slate-600">
                  {s.actReference ?? 'Sources tab - open'}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatPeso(s.amount, { symbol: false })}
                </td>
                <td className="px-3 py-2 text-right">
                  {canEdit && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => onEdit(s)}>
                        Correct
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(s)}>
                        Remove
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy-800 bg-slate-50 font-semibold">
              <td className="px-3 py-2" colSpan={4}>
                Total
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {formatPeso(
                  sources.reduce((t, s) => t + s.amount, 0),
                  { symbol: false },
                )}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <ConfirmDialog
        open={Boolean(removing)}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
        loading={busy}
        title="Remove this source"
        confirmLabel="Remove"
        variant="danger"
        message={
          <p>
            {removing?.particulars} ({formatPeso(removing?.amount ?? 0)}) is removed. If an act
            already approved needs it, the removal is refused and the act is named.
          </p>
        }
      />
    </>
  );
}
