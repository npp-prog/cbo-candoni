import { useMemo, useState } from 'react';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ACCOUNTABLE_FORM_TABS } from './sections';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, Select, TextArea, DateInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAccountableFormTypes, useFormMovements } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatShortDate, todayPh } from '@/lib/dates';
import {
  count,
  describe,
  rangeFrom,
  renderSet,
  subtract,
  union,
  type NumericRange,
} from '@/lib/serials';
import {
  FORM_MOVEMENT_LABELS,
  type AccountableFormMovement,
  type FormMovementKind,
} from '@/types/accountableForms';

/**
 * Accountable forms: who is holding which serials.
 *
 * The register below is a movement ledger, not a stock list. That is the whole
 * difference between this screen and an inventory screen: an inventory says the
 * office has 412 receipts, which is the answer to a question COA does not ask.
 * What it asks is which serials Mrs Basillote is holding, and whether the
 * receipt she issued last Tuesday came out of a booklet she was actually given.
 *
 * The custody summary at the top is computed in the browser from the same
 * ledger the server decides with, so the officer can see what will happen
 * before they press anything. The server re-reads and re-decides regardless:
 * this page can be wrong, and the books cannot.
 */

const KINDS: FormMovementKind[] = ['RECEIPT', 'ISSUE', 'RETURN', 'SPOILED', 'CANCELLED'];

/** Which movements name an officer, and what the officer means on each. */
const OFFICER_ROLE: Record<FormMovementKind, string | null> = {
  RECEIPT: null,
  ISSUE: 'Issued to',
  RETURN: 'Returned by',
  SPOILED: 'Held by',
  CANCELLED: 'Held by',
};

const KIND_HINT: Record<FormMovementKind, string> = {
  RECEIPT: 'Booklets received from the Bureau of Treasury into the office’s own stock.',
  ISSUE: 'Booklets handed to a collecting officer, who becomes accountable for them.',
  RETURN: 'Unused booklets handed back to the office by the officer who held them.',
  SPOILED: 'Forms damaged or misprinted, written off and never issued to a payor.',
  CANCELLED: 'Forms cancelled out of the booklet. They stay accounted for; they collect nothing.',
};

const STOCK = '__STOCK__';

interface Holding {
  key: string;
  name: string;
  ranges: NumericRange[];
}

export default function AccountableForms() {
  const { fiscalYear } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data: movements, loading, error } = useFormMovements(fiscalYear);
  const { data: formTypes } = useAccountableFormTypes();

  const [showForm, setShowForm] = useState(false);
  const [voiding, setVoiding] = useState<AccountableFormMovement | null>(null);
  const [busy, setBusy] = useState(false);

  const canRecord = can('treasury', 'create');
  const canVoid = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER');

  const live = useMemo(() => movements.filter((m) => !m.voided), [movements]);

  /**
   * Replays the ledger into a custody position per form.
   *
   * The same fold the engine performs, for the same reason: custody is
   * cumulative, so the only way to know whether a serial is free is to walk
   * every movement that has ever touched it.
   */
  const custody = useMemo(() => {
    const byForm = new Map<string, Map<string, NumericRange[]>>();

    const ordered = [...live].sort((a, b) => a.movementDate.localeCompare(b.movementDate));
    const names = new Map<string, string>();

    for (const m of ordered) {
      const range = rangeFrom(m.serialFrom, m.serialTo);
      if (!range) continue;
      const holders = byForm.get(m.formCode) ?? new Map<string, NumericRange[]>();
      const get = (k: string) => holders.get(k) ?? [];
      const set = (k: string, v: NumericRange[]) => holders.set(k, v);

      if (m.custodianId && m.custodianName) names.set(m.custodianId, m.custodianName);
      if (m.fromCustodianId && m.fromCustodianName) names.set(m.fromCustodianId, m.fromCustodianName);

      switch (m.kind) {
        case 'RECEIPT':
          set(STOCK, union(get(STOCK), [range]));
          break;
        case 'ISSUE': {
          const to = m.custodianId ?? STOCK;
          set(STOCK, subtract(get(STOCK), [range]));
          set(to, union(get(to), [range]));
          break;
        }
        case 'RETURN': {
          const from = m.fromCustodianId ?? STOCK;
          set(from, subtract(get(from), [range]));
          set(STOCK, union(get(STOCK), [range]));
          break;
        }
        case 'SPOILED':
        case 'CANCELLED': {
          const from = m.fromCustodianId ?? STOCK;
          set(from, subtract(get(from), [range]));
          break;
        }
      }
      byForm.set(m.formCode, holders);
    }

    const out = new Map<string, Holding[]>();
    for (const [formCode, holders] of byForm) {
      const list: Holding[] = [];
      for (const [key, ranges] of holders) {
        if (count(ranges) === 0) continue;
        list.push({
          key,
          name: key === STOCK ? 'Office stock, not yet issued' : (names.get(key) ?? key),
          ranges,
        });
      }
      list.sort((a, b) => (a.key === STOCK ? -1 : b.key === STOCK ? 1 : a.name.localeCompare(b.name)));
      out.set(formCode, list);
    }
    return out;
  }, [live]);

  const columns: Column<AccountableFormMovement>[] = [
    {
      key: 'movementDate',
      header: 'Date',
      width: '7rem',
      kind: 'date',
      value: (m) => m.movementDate,
      cell: (m) => formatShortDate(m.movementDate),
    },
    {
      key: 'kind',
      header: 'Movement',
      width: '11rem',
      value: (m) => FORM_MOVEMENT_LABELS[m.kind],
      cell: (m) => (
        <Badge
          tone={
            m.kind === 'RECEIPT'
              ? 'emerald'
              : m.kind === 'ISSUE'
                ? 'blue'
                : m.kind === 'RETURN'
                  ? 'slate'
                  : 'amber'
          }
        >
          {FORM_MOVEMENT_LABELS[m.kind]}
        </Badge>
      ),
    },
    {
      key: 'form',
      header: 'Form',
      width: '10rem',
      value: (m) => m.formName,
      cell: (m) => <span className="text-xs">{m.formName}</span>,
    },
    {
      key: 'serials',
      header: 'Serial numbers',
      value: (m) => `${m.serialFrom} ${m.serialTo}`,
      cell: (m) => (
        <span className="font-mono text-xs">
          {m.serialFrom === m.serialTo ? m.serialFrom : `${m.serialFrom} – ${m.serialTo}`}
        </span>
      ),
    },
    {
      key: 'quantity',
      header: 'Qty',
      kind: 'number',
      width: '5rem',
      value: (m) => m.quantity,
      cell: (m) => m.quantity.toLocaleString('en-PH'),
    },
    {
      key: 'officer',
      header: 'Accountable officer',
      value: (m) => m.custodianName ?? m.fromCustodianName ?? '',
      cell: (m) => {
        const name = m.custodianName ?? m.fromCustodianName;
        if (!name) return <span className="text-xs text-slate-400">Office stock</span>;
        return (
          <span className="text-xs">
            <span className="text-slate-400">{OFFICER_ROLE[m.kind]} </span>
            {name}
          </span>
        );
      },
    },
    {
      key: 'sourceRef',
      header: 'Reference',
      optional: true,
      value: (m) => m.sourceRef ?? '',
      cell: (m) => <span className="text-xs text-slate-500">{m.sourceRef ?? '—'}</span>,
    },
    {
      key: 'state',
      header: '',
      fixed: true,
      width: '8rem',
      cell: (m) =>
        m.voided ? (
          <Badge tone="rose">Voided</Badge>
        ) : canVoid ? (
          <Button size="sm" variant="ghost" onClick={() => setVoiding(m)}>
            Void
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Accountable Forms"
        subtitle={`Custody of the municipality’s numbered forms — fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Treasury', to: '/treasury' }, { label: 'Accountable Forms' }]}
        actions={
          canRecord ? (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              Record movement
            </Button>
          ) : null
        }
      />

      <SectionTabs tabs={ACCOUNTABLE_FORM_TABS} />

      {formTypes.length === 0 && (
        <Alert tone="warning" title="No accountable forms are set up" className="mb-4">
          Nothing can be received or issued until the form types exist. Add them under{' '}
          <strong>Master Data &rsaquo; Accountable Forms</strong> &mdash; at minimum Accountable Form
          No. 51, the Official Receipt.
        </Alert>
      )}

      {/*
        Patch 177: the "Who is holding what" card is gone - it crowded the
        register. The same position, per officer, is the RAAF (Accountable
        Forms > RAAF), which is now built from these movements by itself. The
        holdings are still computed here: the movement form uses them.
      */}
      <DataTable
        rows={movements}
        columns={columns}
        rowKey={(m) => m.id}
        loading={loading}
        error={error}
        searchPlaceholder="Serial number, form or officer"
        emptyTitle="No movements recorded"
        emptyMessage="Record the booklets received from the Bureau of Treasury to open the ledger."
        emptyAction={
          canRecord ? (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              Record the first movement
            </Button>
          ) : undefined
        }
        printLayout="landscape"
        exportMeta={{
          title: 'Register of Accountable Forms',
          periodLabel: `Fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <MovementForm
          fiscalYear={fiscalYear}
          formTypes={formTypes}
          custody={custody}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Movement recorded');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(voiding)}
        onCancel={() => setVoiding(null)}
        title={voiding ? `Void ${voiding.formName} ${voiding.serialFrom}–${voiding.serialTo}` : ''}
        confirmLabel="Void the movement"
        variant="danger"
        requireReason
        reasonLabel="Why this movement should not stand"
        reasonHint="Recorded on the movement and in the audit trail. The row stays in the register, marked void."
        loading={busy}
        message={
          <>
            The movement is kept and marked void rather than deleted, so the register&rsquo;s own
            continuity stays intact. Voiding a receipt whose serials have since been issued is
            refused &mdash; those movements have to be voided first.
          </>
        }
        onConfirm={async (reason) => {
          if (!voiding) return;
          setBusy(true);
          try {
            await engine.voidFormMovement({ movementId: voiding.id, reason: reason ?? '' });
            toast.success('Movement voided');
            setVoiding(null);
          } catch (err) {
            toast.error('Could not void the movement', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The movement form
// ---------------------------------------------------------------------------

function MovementForm({
  fiscalYear,
  formTypes,
  custody,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  formTypes: Array<{ id: string; code: string; name: string; bookletSize?: number }>;
  custody: Map<string, Holding[]>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<FormMovementKind>('RECEIPT');
  const [formCode, setFormCode] = useState(formTypes[0]?.code ?? '');
  const [movementDate, setMovementDate] = useState(todayPh());
  const [serialFrom, setSerialFrom] = useState('');
  const [serialTo, setSerialTo] = useState('');
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [officerName, setOfficerName] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  const needsOfficer = kind === 'ISSUE' || kind === 'RETURN';
  const range = rangeFrom(serialFrom.trim(), (serialTo.trim() || serialFrom).trim());
  const quantity = range ? range.to - range.from + 1 : 0;

  /**
   * What the office holds that this movement could draw on.
   *
   * Shown before the button is pressed so the officer is not told "not in
   * stock" after typing a range: they can see the ranges available and pick
   * one out of them.
   */
  const available = useMemo(() => {
    const holders = custody.get(formCode) ?? [];
    if (kind === 'RECEIPT') return null;
    const key = kind === 'ISSUE' ? STOCK : (officerId ?? STOCK);
    return holders.find((h) => h.key === key) ?? { key, name: '', ranges: [] as NumericRange[] };
  }, [custody, formCode, kind, officerId]);

  const shortfall = useMemo(() => {
    if (!range || !available) return null;
    const missing = subtract([range], available.ranges);
    return count(missing) > 0 ? missing : null;
  }, [range, available]);

  const type = formTypes.find((t) => t.code === formCode);

  const save = async () => {
    if (!formCode) return toast.error('Incomplete', 'Choose the accountable form.');
    if (!range) {
      return toast.error(
        'The serial range cannot be read',
        'Both serials must be numeric, and the range must not run backwards.',
      );
    }
    if (needsOfficer && !officerId) {
      return toast.error('Incomplete', 'Choose the accountable officer.');
    }

    setBusy(true);
    try {
      const result = await engine.recordFormMovement({
        fiscalYear,
        formCode,
        kind,
        movementDate,
        serialFrom: serialFrom.trim(),
        serialTo: (serialTo.trim() || serialFrom).trim(),
        custodianId: officerId ?? undefined,
        custodianName: officerName || undefined,
        sourceRef: sourceRef.trim() || undefined,
        remarks: remarks.trim() || undefined,
      });
      toast.success(
        `${result.quantity.toLocaleString('en-PH')} forms recorded`,
        FORM_MOVEMENT_LABELS[kind],
      );
      onSaved();
    } catch (err) {
      toast.error('The movement was not recorded', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a movement of accountable forms"
      description="Custody moves in serial ranges. The server checks the range is where you think it is."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!range}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Movement" required hint={KIND_HINT[kind]} className="sm:col-span-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value as FormMovementKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {FORM_MOVEMENT_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Accountable form" required>
          <Select value={formCode} onChange={(e) => setFormCode(e.target.value)}>
            {formTypes.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Date" required>
          <DateInput value={movementDate} onChange={setMovementDate} />
        </Field>

        <Field label="Serial from" required>
          <TextInput
            value={serialFrom}
            onChange={(e) => setSerialFrom(e.target.value.toUpperCase())}
            placeholder="0007705351"
            className="font-mono"
          />
        </Field>

        <Field
          label="Serial to"
          hint="Leave blank for a single form."
        >
          <TextInput
            value={serialTo}
            onChange={(e) => setSerialTo(e.target.value.toUpperCase())}
            placeholder="0007705400"
            className="font-mono"
          />
        </Field>

        {(needsOfficer || kind === 'SPOILED' || kind === 'CANCELLED') && (
          <Field
            label={OFFICER_ROLE[kind] ?? 'Accountable officer'}
            required={needsOfficer}
            hint={
              needsOfficer
                ? undefined
                : 'Leave blank if the forms were spoiled in the office before being issued to anyone.'
            }
            className="sm:col-span-2"
          >
            <EmployeePicker
              value={officerId}
              onChange={(id, emp) => {
                setOfficerId(id);
                setOfficerName(emp?.name ?? '');
              }}
            />
          </Field>
        )}

        {kind === 'RECEIPT' && (
          <Field
            label="Requisition or delivery reference"
            hint="What the Bureau of Treasury issued these against. It keeps a repeat delivery from posting twice."
            className="sm:col-span-2"
          >
            <TextInput
              value={sourceRef}
              onChange={(e) => setSourceRef(e.target.value)}
              placeholder="RIS 2026-04-117"
            />
          </Field>
        )}

        <Field label="Remarks" className="sm:col-span-2">
          <TextArea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
      </div>

      {range && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs">
          <p className="font-medium text-navy-900">
            {quantity.toLocaleString('en-PH')} form{quantity === 1 ? '' : 's'}
            {type?.bookletSize ? `, ${Math.ceil(quantity / type.bookletSize)} booklet${Math.ceil(quantity / type.bookletSize) === 1 ? '' : 's'}` : ''}
          </p>
          {available && (
            <p className="mt-1 text-slate-600">
              Available to draw on:{' '}
              <span className="font-mono">
                {available.ranges.length > 0 ? describe(renderSet(available.ranges)) : 'nothing'}
              </span>
            </p>
          )}
        </div>
      )}

      {shortfall && (
        <Alert tone="error" title="These serials are not there to move" className="mt-3">
          {count(shortfall).toLocaleString('en-PH')} of them are unaccounted for at that location:{' '}
          <span className="font-mono">{describe(renderSet(shortfall))}</span>. They are either
          already issued to somebody else, or were never received into stock. The server will refuse
          this, so fix it here rather than finding out after.
        </Alert>
      )}
    </Modal>
  );
}
