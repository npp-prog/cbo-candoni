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
import type { AppropriationKind } from '@/types/budget';
import { ORDINANCE_KINDS, ordinanceId } from './ordinanceModel';

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
}: {
  fiscalYear: number;
  fundCode: string;
  actor: ActorStamp | null;
  onClose: () => void;
  /** Called with the id of the ordinance - new, or the one already there. */
  onRecorded: (id: string, existed: boolean) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<AppropriationKind>('ORIGINAL');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayPh());
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const chosen = ORDINANCE_KINDS.find((k) => k.value === kind);

  const save = async () => {
    if (!actor) return;
    if (!reference.trim()) {
      toast.error(
        'The ordinance number is required',
        'It is what every line of it is recorded under.',
      );
      return;
    }
    setSaving(true);
    try {
      const id = ordinanceId({ fiscalYear, fundCode, kind, reference });
      const ref = doc(db, COL.ordinances, id);
      const existing = await getDoc(ref);
      if (existing.exists()) {
        toast.info(
          'That ordinance is already recorded',
          'Opening it. Record its lines there rather than recording the ordinance again.',
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
        'Could not record the ordinance',
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
      title="Record an ordinance"
      description="The ordinance first; its lines are recorded inside it, the signed copy is attached to it, and it is printed on LBP Form No. 2 before it is approved."
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
            onChange={(e) => setKind(e.target.value as AppropriationKind)}
          >
            {ORDINANCE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ordinance or resolution number" required htmlFor="ordRef">
          <TextInput
            id="ordRef"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Ord. No. 2026-01"
          />
        </Field>
        <Field label="Date enacted" required htmlFor="ordDate">
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
