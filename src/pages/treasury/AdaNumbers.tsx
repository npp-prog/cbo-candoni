import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput, TextArea, DateInput, Checkbox } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAda, useAdaNumbers } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatShortDate, todayPh } from '@/lib/dates';
import {
  ADA_NUMBER_STATE_HINTS,
  ADA_NUMBER_STATE_LABELS,
  type AdaNumberRecord,
  type AdaNumberState,
  type AdaSeriesGap,
} from '@/types/adaNumbers';
import { fundLabel } from '../budget/Obligations';
import { ADA_TABS } from './sections';

/**
 * The ADA number series, and every hole in it.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY ROW THAT MATTERS
 * ---------------------------------------------------------------------------
 * This screen puts two lists side by side: the numbers missing from the issued
 * series, and the records that explain them. Almost every hole has an innocent
 * explanation - a reservation given up, a serial passed over when the register
 * was written by hand - and once recorded, it stops being a question.
 *
 * What is left is the point. A number missing from the series with nothing
 * accounting for it is either a payment made and never reported, or something
 * nobody remembers. It is one row on a screen now, instead of an hour with the
 * bank statements in March.
 *
 * ---------------------------------------------------------------------------
 * WHY A RETIRED NUMBER LEAVES A HOLE ON PURPOSE
 * ---------------------------------------------------------------------------
 * Giving the number back to the pool is the obvious convenience and the wrong
 * one: the bank may already hold it against an instruction the office
 * withdrew. So it stays consumed, the hole stays, and the hole is explained.
 * ---------------------------------------------------------------------------
 */

const STATE_TONE: Record<AdaNumberState, 'blue' | 'emerald' | 'slate' | 'amber'> = {
  RESERVED: 'blue',
  USED: 'emerald',
  RETIRED: 'slate',
  VOID_SKIPPED: 'amber',
};

/** Splits "100-26-09-0221" into its prefix and its sequence. */
function splitAdaNo(adaNo: string): { prefix: string; sequence: number; width: number } | null {
  const at = adaNo.lastIndexOf('-');
  if (at < 1) return null;
  const tail = adaNo.slice(at + 1);
  if (!/^\d+$/.test(tail)) return null;
  return { prefix: adaNo.slice(0, at), sequence: Number.parseInt(tail, 10), width: tail.length };
}

const joinAdaNo = (prefix: string, sequence: number, width: number) =>
  `${prefix}-${String(sequence).padStart(width, '0')}`;

export default function AdaNumbers() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data: records, loading, error } = useAdaNumbers(fiscalYear, fundCode);
  const { data: adas } = useAda();

  const [reserving, setReserving] = useState(false);
  const [retiring, setRetiring] = useState<AdaNumberRecord | null>(null);
  const [explaining, setExplaining] = useState<AdaSeriesGap | null>(null);
  const [busy, setBusy] = useState(false);

  const canReserve = can('treasury', 'create');
  const canRetire = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER');

  const issued = useMemo(
    () => adas.filter((a) => a.fiscalYear === fiscalYear && a.fundCode === fundCode),
    [adas, fiscalYear, fundCode],
  );

  /**
   * Holes in the series, with whatever accounts for them.
   *
   * Runs are analysed per prefix, because the sequence restarts each month and
   * a "gap" between one month's last number and the next month's first is not
   * a gap at all.
   */
  const gaps = useMemo(() => {
    const byPrefix = new Map<string, { width: number; seen: Set<number> }>();

    const note = (adaNo: string) => {
      const split = splitAdaNo(adaNo);
      if (!split) return;
      const entry = byPrefix.get(split.prefix) ?? { width: split.width, seen: new Set<number>() };
      entry.seen.add(split.sequence);
      entry.width = Math.max(entry.width, split.width);
      byPrefix.set(split.prefix, entry);
    };

    for (const a of issued) note(a.adaNo);
    for (const r of records) note(r.adaNo);

    const explanationFor = new Map(records.map((r) => [r.adaNo, r]));
    const out: AdaSeriesGap[] = [];

    for (const [prefix, { width, seen }] of byPrefix) {
      const numbers = [...seen].sort((a, b) => a - b);
      if (numbers.length < 2) continue;
      for (let n = numbers[0] + 1; n < numbers[numbers.length - 1]; n += 1) {
        if (seen.has(n)) continue;
        const adaNo = joinAdaNo(prefix, n, width);
        out.push({ prefix, adaNo, sequence: n, explanation: explanationFor.get(adaNo) ?? null });
      }
    }

    return out.sort((a, b) => a.adaNo.localeCompare(b.adaNo));
  }, [issued, records]);

  const unexplained = gaps.filter((g) => !g.explanation);
  const reservedOpen = records.filter((r) => r.state === 'RESERVED');

  const columns: Column<AdaNumberRecord>[] = [
    {
      key: 'adaNo',
      header: 'ADA No.',
      width: '11rem',
      value: (r) => r.adaNo,
      cell: (r) => <span className="font-mono text-xs">{r.adaNo}</span>,
    },
    {
      key: 'radaiNo',
      header: 'RADAI No.',
      width: '11rem',
      optional: true,
      value: (r) => r.radaiNo ?? '',
      cell: (r) => <span className="font-mono text-xs text-slate-500">{r.radaiNo ?? '—'}</span>,
    },
    {
      key: 'slotDate',
      header: 'Slot date',
      kind: 'date',
      width: '7rem',
      value: (r) => r.slotDate,
      cell: (r) => formatShortDate(r.slotDate),
    },
    {
      key: 'note',
      header: 'Note or reason',
      value: (r) => r.reason ?? r.note ?? '',
      cell: (r) => (
        <span className="text-xs text-slate-600">
          {r.reason ?? r.note ?? <span className="italic text-slate-400">&mdash;</span>}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      fixed: true,
      width: '13rem',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <Badge tone={STATE_TONE[r.state]}>{ADA_NUMBER_STATE_LABELS[r.state]}</Badge>
          {r.state === 'RESERVED' && canRetire && (
            <Button size="sm" variant="ghost" onClick={() => setRetiring(r)}>
              Retire
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="ADA Number Control"
        subtitle={`${fundLabel(fundCode)} — fiscal year ${fiscalYear}`}
        breadcrumbs={[
          { label: 'Treasury', to: '/treasury' },
          { label: 'ADA', to: '/treasury/ada' },
          { label: 'Numbers' },
        ]}
        actions={
          canReserve ? (
            <Button variant="primary" onClick={() => setReserving(true)}>
              Reserve numbers
            </Button>
          ) : null
        }
      />

      <SectionTabs tabs={ADA_TABS} />

      {unexplained.length > 0 ? (
        <Alert
          tone="error"
          title={`${unexplained.length} number${unexplained.length === 1 ? '' : 's'} missing from the series with nothing to account for ${unexplained.length === 1 ? 'it' : 'them'}`}
          className="mb-4"
        >
          <p>
            Each of these is either a payment made and never reported, or a serial the office
            passed over. Both are ordinary; neither explains itself six months from now.
          </p>
          <div className="mt-3 space-y-1.5">
            {unexplained.slice(0, 12).map((g) => (
              <div key={g.adaNo} className="flex items-center gap-3">
                <span className="font-mono text-xs font-semibold">{g.adaNo}</span>
                {canRetire && (
                  <Button size="sm" variant="secondary" onClick={() => setExplaining(g)}>
                    Explain it
                  </Button>
                )}
              </div>
            ))}
            {unexplained.length > 12 && (
              <p className="text-xs text-slate-600">and {unexplained.length - 12} more.</p>
            )}
          </div>
        </Alert>
      ) : (
        <Alert tone="success" title="The ADA series has no unexplained gaps" className="mb-4">
          Every number between the first and the last issued is either in the register or accounted
          for here.
        </Alert>
      )}

      {reservedOpen.length > 0 && (
        <Card
          title="Reserved and waiting"
          subtitle="Choose one of these on the voucher when the ADA is prepared, so the counter is not advanced past it."
          className="mb-5"
          bodyClassName="p-0"
        >
          <div className="divide-y divide-slate-100">
            {reservedOpen.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
                <span className="w-32 shrink-0 font-mono font-medium">{r.adaNo}</span>
                {r.radaiNo && (
                  <span className="w-32 shrink-0 font-mono text-slate-500">{r.radaiNo}</span>
                )}
                <span className="w-24 shrink-0 text-slate-500">{formatShortDate(r.slotDate)}</span>
                <span className="flex-1 truncate text-slate-600">{r.note ?? ''}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <DataTable
        rows={records}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        searchPlaceholder="ADA number, RADAI number or reason"
        emptyTitle="Nothing recorded against the series"
        emptyMessage="Reserve a number ahead of a batch, or record a serial the office skipped."
        exportMeta={{
          title: 'ADA Number Control',
          fundLabel: fundLabel(fundCode),
          periodLabel: `Fiscal year ${fiscalYear}`,
        }}
      />

      {reserving && (
        <ReserveDialog
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setReserving(false)}
          onReserved={(n) => {
            setReserving(false);
            toast.success(`${n} number${n === 1 ? '' : 's'} reserved`);
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(retiring)}
        onCancel={() => setRetiring(null)}
        title={`Retire ADA ${retiring?.adaNo ?? ''}`}
        confirmLabel="Retire the number"
        variant="danger"
        requireReason
        reasonLabel="Why this number will never be issued"
        reasonHint="This is what explains the gap it leaves. It stays on the record."
        loading={busy}
        message={
          <>
            <p>
              The number stays consumed and can never be issued. That is deliberate: the bank may
              already hold it against an instruction the office withdrew, and giving it to a
              different payee is how two ADAs end up indistinguishable.
            </p>
            <p className="mt-2">The series will show a gap here, and this reason will explain it.</p>
          </>
        }
        onConfirm={async (reason) => {
          if (!retiring) return;
          setBusy(true);
          try {
            await engine.retireAdaReservation({ recordId: retiring.id, reason: reason ?? '' });
            toast.success(`ADA ${retiring.adaNo} retired`);
            setRetiring(null);
          } catch (err) {
            toast.error('The number was not retired', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(explaining)}
        onCancel={() => setExplaining(null)}
        title={`Account for ADA ${explaining?.adaNo ?? ''}`}
        confirmLabel="Record the explanation"
        requireReason
        reasonLabel="What happened to this number"
        reasonHint="At least ten characters. It is what stops this being a question next year."
        loading={busy}
        message="This records that the number was passed over and will never be issued. If it was in fact used, find the ADA instead - the register should carry it."
        onConfirm={async (reason) => {
          if (!explaining) return;
          setBusy(true);
          try {
            await engine.voidSkippedAdaNumber({
              fiscalYear,
              fundCode,
              adaNo: explaining.adaNo,
              slotDate: todayPh(),
              reason: reason ?? '',
            });
            toast.success(`ADA ${explaining.adaNo} accounted for`);
            setExplaining(null);
          } catch (err) {
            toast.error('It was not recorded', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReserveDialog({
  fiscalYear,
  fundCode,
  onClose,
  onReserved,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onReserved: (count: number) => void;
}) {
  const toast = useToast();
  const [slotDate, setSlotDate] = useState(todayPh());
  const [count, setCount] = useState('1');
  const [withRadai, setWithRadai] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const n = Number.parseInt(count, 10);

  const reserve = async () => {
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      return toast.error('How many?', 'Between 1 and 20.');
    }
    setBusy(true);
    try {
      const r = await engine.reserveAdaNumbers({
        fiscalYear,
        fundCode,
        slotDate,
        count: n,
        withRadai,
        note: note.trim() || undefined,
      });
      onReserved(r.reserved.length);
    } catch (err) {
      toast.error('Nothing was reserved', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Reserve ADA numbers"
      description="Drawn from the same counter an ADA draws from, so nobody else can be given them."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={reserve} loading={busy}>
            Reserve
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Slot date"
          required
          hint="The date the batch is meant for. A reserved number used later should stay between its neighbours in the series."
        >
          <DateInput value={slotDate} onChange={setSlotDate} />
        </Field>

        <Field label="How many" required hint="Between 1 and 20.">
          <TextInput
            value={count}
            onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))}
            className="w-24 font-mono"
          />
        </Field>

        <Field label="Report numbers">
          <Checkbox
            checked={withRadai}
            onChange={setWithRadai}
            label="Reserve a RADAI number with each one"
            hint="The office usually reserves them as a pair, so the report and the advice carry matching numbers."
          />
        </Field>

        <Field label="What these are for">
          <TextArea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="September payroll ET. AL. batch"
          />
        </Field>

        <Alert tone="warning" title="A reserved number cannot be given back">
          If the batch does not happen, retire the number rather than leaving it. It stays consumed
          either way &mdash; retiring it is how the gap gets explained.
        </Alert>
      </div>
    </Modal>
  );
}
