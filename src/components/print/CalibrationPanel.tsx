import { useState } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextArea, Checkbox } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import {
  clearCalibration,
  defaultCalibration,
  exportCalibration,
  importCalibration,
  saveCalibration,
  type Calibration,
  type PrintField,
} from '@/lib/printCalibration';

/**
 * The controls beside the sheet.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NUDGE IS SEPARATE FROM THE FIELD POSITIONS
 * ---------------------------------------------------------------------------
 * Two different things go wrong, and conflating them costs an afternoon.
 *
 * The first is the LAYOUT: a field sits in the wrong box because the office's
 * stock differs from the specimen. That is fixed once, by dragging that field,
 * and it is the same on every printer.
 *
 * The second is the FEED: the whole sheet lands two millimetres low because
 * this printer grips the paper slightly differently. That is fixed by moving
 * everything together, and it is different on every printer.
 *
 * Mixing them means re-dragging twenty fields when somebody changes the
 * printer. So the nudge moves the whole sheet and nothing else.
 * ---------------------------------------------------------------------------
 */
export function CalibrationPanel({
  form,
  fields,
  calibration,
  onChange,
  selectedKey,
  onSelectField,
  showGuide,
  onShowGuide,
  hasRowSpacing,
}: {
  /** Storage key for this form. */
  form: string;
  fields: PrintField[];
  calibration: Calibration;
  onChange: (next: Calibration) => void;
  selectedKey: string | null;
  onSelectField: (key: string) => void;
  showGuide: boolean;
  onShowGuide: (on: boolean) => void;
  hasRowSpacing?: boolean;
}) {
  const toast = useToast();
  const [transfer, setTransfer] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);

  const nudge = (dx: number, dy: number) =>
    onChange({ ...calibration, offsetX: calibration.offsetX + dx, offsetY: calibration.offsetY + dy });

  const setSize = (key: string, delta: number) => {
    const pos = calibration.fields[key];
    if (!pos) return;
    onChange({
      ...calibration,
      fields: { ...calibration.fields, [key]: { ...pos, size: Math.max(4, pos.size + delta) } },
    });
  };

  const moveSelected = (dx: number, dy: number) => {
    if (!selectedKey) return;
    const pos = calibration.fields[selectedKey];
    if (!pos) return;
    onChange({
      ...calibration,
      fields: { ...calibration.fields, [selectedKey]: { ...pos, x: pos.x + dx, y: pos.y + dy } },
    });
  };

  return (
    <div className="space-y-4 no-print">
      <Card title="Printer feed" subtitle="Moves the whole sheet. Use this when everything is out by the same amount.">
        <div className="flex items-center gap-4">
          <div className="grid grid-cols-3 gap-1">
            <span />
            <Button size="sm" variant="secondary" onClick={() => nudge(0, -0.5)}>
              &uarr;
            </Button>
            <span />
            <Button size="sm" variant="secondary" onClick={() => nudge(-0.5, 0)}>
              &larr;
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...calibration, offsetX: 0, offsetY: 0 })}>
              &middot;
            </Button>
            <Button size="sm" variant="secondary" onClick={() => nudge(0.5, 0)}>
              &rarr;
            </Button>
            <span />
            <Button size="sm" variant="secondary" onClick={() => nudge(0, 0.5)}>
              &darr;
            </Button>
            <span />
          </div>
          <div className="text-xs">
            <p className="font-mono">
              X {calibration.offsetX.toFixed(1)} mm &nbsp; Y {calibration.offsetY.toFixed(1)} mm
            </p>
            <p className="mt-1 text-slate-500">Half a millimetre at a time.</p>
          </div>
        </div>
      </Card>

      <Card
        title="Fields"
        subtitle="Drag one on the sheet, or select it here and use the arrows."
        bodyClassName="p-0"
      >
        <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto">
          {fields.map((f) => {
            const pos = calibration.fields[f.key];
            const selected = selectedKey === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => onSelectField(f.key)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50 ${
                  selected ? 'bg-brand-50' : ''
                }`}
              >
                <span className="flex-1">
                  {f.label}
                  {f.optional && <span className="ml-1 text-slate-400">(optional)</span>}
                </span>
                <span className="font-mono text-2xs text-slate-500">
                  {pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}` : ''}
                </span>
                <span className="font-mono text-2xs text-slate-400">{pos?.size.toFixed(0)}pt</span>
              </button>
            );
          })}
        </div>
      </Card>

      {selectedKey && (
        <Card title={fields.find((f) => f.key === selectedKey)?.label ?? 'Field'}>
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid grid-cols-3 gap-1">
              <span />
              <Button size="sm" variant="secondary" onClick={() => moveSelected(0, -0.5)}>
                &uarr;
              </Button>
              <span />
              <Button size="sm" variant="secondary" onClick={() => moveSelected(-0.5, 0)}>
                &larr;
              </Button>
              <span />
              <Button size="sm" variant="secondary" onClick={() => moveSelected(0.5, 0)}>
                &rarr;
              </Button>
              <span />
              <Button size="sm" variant="secondary" onClick={() => moveSelected(0, 0.5)}>
                &darr;
              </Button>
              <span />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600">Type size</span>
              <Button size="sm" variant="secondary" onClick={() => setSize(selectedKey, -0.5)}>
                &minus;
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setSize(selectedKey, 0.5)}>
                +
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Whole form">
        <div className="space-y-3">
          <Field label="Type size, everything" hint="For a printer that renders heavy or light.">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  onChange({ ...calibration, fontScale: Math.max(0.5, calibration.fontScale - 0.05) })
                }
              >
                &minus;
              </Button>
              <span className="w-16 text-center font-mono text-xs">
                {Math.round(calibration.fontScale * 100)}%
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  onChange({ ...calibration, fontScale: Math.min(2, calibration.fontScale + 0.05) })
                }
              >
                +
              </Button>
            </div>
          </Field>

          {hasRowSpacing && (
            <Field label="Space between line items" hint="Millimetres from one line to the next.">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    onChange({ ...calibration, rowSpacing: Math.max(2, calibration.rowSpacing - 0.5) })
                  }
                >
                  &minus;
                </Button>
                <span className="w-16 text-center font-mono text-xs">
                  {calibration.rowSpacing.toFixed(1)} mm
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onChange({ ...calibration, rowSpacing: calibration.rowSpacing + 0.5 })}
                >
                  +
                </Button>
              </div>
            </Field>
          )}

          <Checkbox
            checked={showGuide}
            onChange={onShowGuide}
            label="Print the alignment guide"
            hint="A ruled grid and the sheet outline. Print it on plain paper and hold it against a real form."
          />
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            const ok = saveCalibration(form, calibration);
            if (ok) toast.success('Calibration saved on this computer');
            else
              toast.error(
                'It could not be saved',
                'This browser is not allowing storage. The calibration will work until the page is reloaded.',
              );
          }}
        >
          Save on this computer
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            clearCalibration(form);
            onChange(defaultCalibration(fields, calibration.rowSpacing));
            toast.success('Back to the measured defaults');
          }}
        >
          Start again
        </Button>
        <Button variant="ghost" onClick={() => setShowTransfer((s) => !s)}>
          {showTransfer ? 'Hide' : 'Copy to another computer'}
        </Button>
      </div>

      {showTransfer && (
        <Card title="Carry this calibration to another workstation">
          <Alert tone="info" title="It is per computer, not per office" className="mb-3">
            The calibration belongs to this printer and this browser. Copy the text below into the
            same box on another workstation rather than measuring it again there.
          </Alert>
          <Field label="Calibration">
            <TextArea
              rows={6}
              className="font-mono text-2xs"
              value={transfer || exportCalibration(calibration)}
              onChange={(e) => setTransfer(e.target.value)}
            />
          </Field>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const parsed = importCalibration(transfer, fields);
                if (!parsed) return toast.error('That is not a calibration', 'Paste the whole text.');
                onChange(parsed);
                toast.success('Calibration loaded', 'Save it to keep it on this computer.');
              }}
            >
              Load what is in the box
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTransfer('')}>
              Show this computer&rsquo;s
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
