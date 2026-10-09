import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { updateDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import { renumberedDraft } from '@/lib/reportNumber';
import type { TreasuryReport } from '@/types/treasury';

/**
 * Patch 149. The report number of a DRAFT treasury report (RCI, RADAI, RCD,
 * eRCD, RCDisb), shown with an Edit button while the report is a draft.
 *
 * The number is the office's own, from its book; on a draft it binds nothing.
 * It is reserved against the report only when the Treasurer certifies, and
 * the engine refuses a number already used then. Once certified it is fixed.
 *
 * Changing it also renames the RCI's Cash in Bank lines ("Payment of RCI
 * <no> Check No. ...", patch 147), so the entry never carries the old number.
 */
export function ReportNumberEdit({
  report,
  short,
  editable,
}: {
  report: TreasuryReport;
  short: string;
  editable: boolean;
}) {
  const { user, profile } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const current = hasDocumentNumber(report.reportNo) ? (report.reportNo as string) : '';

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        <span>{current || 'Not yet assigned'}</span>
        {editable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue(current);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </span>
    );
  }

  const save = async () => {
    const next = value.trim();
    if (!next) {
      toast.error(`The ${short} number is missing`, "Type it from the office's own book.");
      return;
    }
    if (!user) return;
    if (next === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateDraft(
        COL.treasuryReports,
        report.id,
        renumberedDraft(report, next),
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
      );
      toast.success(`${short} number changed`, `${current || 'Draft'} is now ${next}.`);
      setEditing(false);
    } catch (err) {
      toast.error('Could not change the number', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <TextInput
        autoFocus
        className="w-40 font-mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        aria-label={`${short} number`}
      />
      <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </span>
  );
}
