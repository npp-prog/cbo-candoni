import { useCallback, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  fieldStyle,
  type Calibration,
  type PrintField,
  type SheetSize,
} from '@/lib/printCalibration';

/**
 * One sheet of pre-printed stock, with the fields laid on top of it.
 *
 * ---------------------------------------------------------------------------
 * THE SAME COMPONENT PRINTS AND CALIBRATES
 * ---------------------------------------------------------------------------
 * It would be easier to build a calibration screen and a printing screen
 * separately, and it would be wrong: the office would calibrate one layout and
 * print another, and nobody would find out until a hundred checks were spoiled.
 * So there is one component. In calibration mode it draws a grid and lets the
 * fields be dragged; in print mode it draws nothing but the ink. The positions
 * are the same object either way.
 *
 * ---------------------------------------------------------------------------
 * THE GUIDE
 * ---------------------------------------------------------------------------
 * `guide` draws the outline of the sheet and a ruled grid so the office can
 * print onto PLAIN paper, hold it against a real check, and see exactly how far
 * out the printer is. That is the whole calibration procedure, and it costs one
 * sheet of scrap rather than one spoiled accountable form.
 * ---------------------------------------------------------------------------
 */

export interface SheetValue {
  /** Field key to the text printed there. */
  values: Record<string, string>;
  /** Repeating rows, for the receipt's line items. */
  rows?: Array<{ description: string; amount: string }>;
}

export function CalibrationSheet({
  sheet,
  fields,
  calibration,
  value,
  mode,
  onMoveField,
  selectedKey,
  onSelectField,
  children,
}: {
  sheet: SheetSize;
  fields: PrintField[];
  calibration: Calibration;
  value: SheetValue;
  /** `print` draws only the ink. `calibrate` adds the grid and dragging. */
  mode: 'print' | 'calibrate';
  /** Drawn only in calibrate mode: the sheet outline and a ruled grid. */
  onMoveField?: (key: string, dx: number, dy: number) => void;
  selectedKey?: string | null;
  onSelectField?: (key: string) => void;
  /** A drawn specimen of the stock, shown behind the fields while calibrating. */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ key: string; startX: number; startY: number } | null>(null);

  /** Converts a pixel drag into millimetres, using the element's own scale. */
  const pxToMm = useCallback(
    (px: number, axis: 'x' | 'y') => {
      const el = ref.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const mmPerPx = axis === 'x' ? sheet.width / rect.width : sheet.height / rect.height;
      return px * mmPerPx;
    },
    [sheet],
  );

  const onPointerDown = (key: string) => (e: React.PointerEvent) => {
    if (mode !== 'calibrate' || !onMoveField) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = { key, startX: e.clientX, startY: e.clientY };
    onSelectField?.(key);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag || !onMoveField) return;
    const dx = pxToMm(e.clientX - drag.startX, 'x');
    const dy = pxToMm(e.clientY - drag.startY, 'y');
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return;
    onMoveField(drag.key, dx, dy);
    dragging.current = { ...drag, startX: e.clientX, startY: e.clientY };
  };

  const endDrag = () => {
    dragging.current = null;
  };

  return (
    <div
      ref={ref}
      className={clsx(
        'relative overflow-hidden bg-white',
        mode === 'calibrate' && 'border border-slate-400 shadow-sm',
      )}
      style={{
        width: `${sheet.width}mm`,
        height: `${sheet.height}mm`,
        fontFamily: '"Courier New", monospace',
        color: '#000',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* The drawn specimen, behind everything, on screen only. */}
      {mode === 'calibrate' && children}

      {/* A 5 mm grid, so a drag can be judged against something. */}
      {mode === 'calibrate' && (
        <div
          className="pointer-events-none absolute inset-0 no-print"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(37,99,235,0.10) 0.2mm, transparent 0.2mm),' +
              'linear-gradient(to bottom, rgba(37,99,235,0.10) 0.2mm, transparent 0.2mm)',
            backgroundSize: '5mm 5mm',
          }}
        />
      )}

      {fields.map((f) => {
        const isRowAnchor = f.key === 'lineDescription' || f.key === 'lineAmount';
        const rows = value.rows ?? [];

        // The line-item anchors print once per row, spaced by the calibration.
        if (isRowAnchor && rows.length > 0) {
          return rows.map((row, i) => (
            <div
              key={`${f.key}-${i}`}
              style={fieldStyle(f, calibration, sheet, i)}
              className={clsx(
                mode === 'calibrate' && 'cursor-move',
                mode === 'calibrate' && selectedKey === f.key && 'bg-brand-100/70 outline outline-1 outline-brand-500',
              )}
              onPointerDown={i === 0 ? onPointerDown(f.key) : undefined}
            >
              {f.key === 'lineDescription' ? row.description : row.amount}
            </div>
          ));
        }

        const text = value.values[f.key] ?? '';
        if (!text && mode === 'print') return null;

        return (
          <div
            key={f.key}
            style={fieldStyle(f, calibration, sheet)}
            className={clsx(
              mode === 'calibrate' && 'cursor-move',
              mode === 'calibrate' && !text && 'text-slate-400 italic',
              mode === 'calibrate' &&
                selectedKey === f.key &&
                'bg-brand-100/70 outline outline-1 outline-brand-500',
            )}
            onPointerDown={onPointerDown(f.key)}
          >
            {text || (mode === 'calibrate' ? f.label : '')}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The plain-paper alignment guide.
 *
 * Printed onto scrap and held against a real form, this shows the office
 * exactly how far out the printer's feed is, in millimetres they can read off.
 * It is the cheapest possible way to answer the only question that matters,
 * and it is why nobody has to spoil an accountable form to calibrate.
 */
export function AlignmentGuide({ sheet }: { sheet: SheetSize }) {
  const verticals = Math.floor(sheet.width / 10);
  const horizontals = Math.floor(sheet.height / 10);

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <div className="absolute inset-0 border border-dashed border-slate-500" />
      {Array.from({ length: verticals }, (_, i) => (
        <div
          key={`v${i}`}
          className="absolute top-0 border-l border-dotted border-slate-400"
          style={{ left: `${(i + 1) * 10}mm`, height: '100%' }}
        >
          <span className="absolute left-0.5 top-0 text-[5pt] text-slate-500">{(i + 1) * 10}</span>
        </div>
      ))}
      {Array.from({ length: horizontals }, (_, i) => (
        <div
          key={`h${i}`}
          className="absolute left-0 border-t border-dotted border-slate-400"
          style={{ top: `${(i + 1) * 10}mm`, width: '100%' }}
        >
          <span className="absolute left-0 top-0.5 text-[5pt] text-slate-500">{(i + 1) * 10}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The page rules for one sheet of pre-printed stock.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN index.css
 * ---------------------------------------------------------------------------
 * The application's print stylesheet says `@page { size: A4 portrait; margin:
 * 15mm 12mm }`, which is right for every report and fatal here: a 15 mm margin
 * on a check moves every field 15 mm in from where it was measured, and the
 * office would spend the afternoon calibrating that margin back out.
 *
 * So each printing screen emits its own `@page` while it is mounted. It comes
 * later in the cascade than index.css, so it wins, and it disappears with the
 * screen rather than changing how the rest of CFMS prints.
 *
 * The zero margin is deliberate and is the point: the sheet is positioned by
 * the measurements in the calibration, from the physical edge of the paper. A
 * margin here would be a second, invisible offset fighting the first.
 */
export function SheetPrintStyle({ sheet }: { sheet: SheetSize }) {
  const css = `
@media print {
  @page { size: ${sheet.width}mm ${sheet.height}mm; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  main { padding: 0 !important; margin: 0 !important; }
  .cbo-print-sheet { page-break-after: always; break-after: page; }
  .cbo-print-sheet:last-child { page-break-after: auto; break-after: auto; }
}`;
  return <style>{css}</style>;
}

/**
 * A drawn LANDBANK check, for calibrating against without a scan.
 *
 * It is not a facsimile and could not be mistaken for one: no bank name, no
 * branch, no MICR characters - only labelled empty zones showing where the
 * real form's printing sits, so the person calibrating can see what they must
 * avoid. That is all the job needs.
 */
export function CheckSpecimen() {
  return (
    <div className="pointer-events-none absolute inset-0 text-slate-300 no-print" aria-hidden="true">
      <Zone x={4} y={4} w={40} h={10} label="Barcode zone" />
      <Zone x={140} y={12} w={58} h={10} label="Date boxes" />
      <Zone x={6} y={26} w={14} h={7} label="Pay to" />
      <Zone x={168} y={26} w={30} h={8} label="Peso box" />
      <Zone x={6} y={45} w={20} h={6} label="Pesos line" />
      <Zone x={4} y={64} w={195} h={9} label="MICR band — keep clear" />
    </div>
  );
}

function Zone({
  x,
  y,
  w,
  h,
  label,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}) {
  return (
    <div
      className="absolute rounded-sm border border-dashed border-slate-300"
      style={{ left: `${x}mm`, top: `${y}mm`, width: `${w}mm`, height: `${h}mm` }}
    >
      <span className="absolute left-0.5 top-0.5 text-[5pt] uppercase tracking-wide">{label}</span>
    </div>
  );
}
