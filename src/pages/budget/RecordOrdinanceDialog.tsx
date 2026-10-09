import { useState } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, DateInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { COL } from '@/lib/collections';
import { todayPh } from '@/lib/dates';
import type { ActorStamp } from '@/types/common';
import { ACT_KINDS, actId, type ActKind } from '@/lib/budgetActs';

/**
 * Recording an ordinance - the header its lines are then recorded under.
 * Patch 119.
 *
 * The id is made from the year, fund, kind and number, and the record is
 * written only if nothing is there already: the same ordinance recorded twice
 * is the mistake this is built to refuse, and the office is sent to the one
 * that exists instead.
 */
export function RecordOrdinanceDialog({
  fiscalYear,
  fundCode,
  actor,
  onClose,
  onRecorded,
  preset,
}: {
  /** Filled in from a prepared set that names an act not yet recorded. */
  preset?: { kind: ActKind; reference: string; date?: string };
  fiscalYear: number;
  fundCode: string;
  actor: ActorStamp | null;
  onClose: () => void;
  /** Called with the id of the ordinance - new, or the one already there. */
  onRecorded: (id: string, existed: boolean) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<ActKind>(preset?.kind ?? 'ORIGINAL');
  const [reference, setReference] = useState(preset?.reference ?? '');
  const [date, setDate] = useState(preset?.date || todayPh());
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const chosen = ACT_KINDS.find((k) => k.value === kind);

  const save = async () => {
    if (!actor) return;
    if (!reference.trim()) {
      toast.error(
        `The ${(chosen?.numberLabel ?? 'number').toLowerCase()} is required`,
        'It is what every line of it is recorded under.',
      );
      return;
    }
    setSaving(true);
    try {
      const id = actId({ fiscalYear, fundCode, kind, reference });
      const ref = doc(db, COL.ordinances, id);
      const existing = await getDoc(ref);
      if (existing.exists()) {
        toast.info(
          'That is already recorded',
          'Opening it. Record its lines there rather than recording it again.',
        );
        onRecorded(id, true);
        return;
      }
      await setDoc(ref, {
        fiscalYear,
        fundCode,
        kind,
        reference: reference.trim(),
        date,
        title: title.trim() || null,
        createdBy: actor,
        createdAt: serverTimestamp(),
      });
      onRecorded(id, false);
    } catch (err) {
      toast.error(
        'Could not record it',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record an authority"
      description="An ordinance, an augmentation order, or the continuing appropriations. Its lines and its sources are recorded inside it and the signed copy is attached to it; it cannot be approved without both."
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Record and open
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Kind"
          required
          htmlFor="ordKind"
          hint={chosen?.hint}
          className="sm:col-span-2"
        >
          <Select
            id="ordKind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ActKind)}
          >
            {ACT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={chosen?.numberLabel ?? 'Number'} required htmlFor="ordRef">
          <TextInput
            id="ordRef"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={chosen?.placeholder}
          />
        </Field>
        <Field
          label={kind === 'AUGMENTATION' ? 'Date signed' : kind === 'CONTINUING' ? 'Date' : 'Date enacted'}
          required
          htmlFor="ordDate"
        >
          <DateInput id="ordDate" value={date} onChange={setDate} />
        </Field>
        <Field
          label="Title"
          htmlFor="ordTitle"
          className="sm:col-span-2"
          hint="As the office calls it. Shown on the list; nothing else reads it."
        >
          <TextInput
            id="ordTitle"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`Annual Budget FY ${fiscalYear}`}
          />
        </Field>
      </div>
    </Modal>
  );
}
