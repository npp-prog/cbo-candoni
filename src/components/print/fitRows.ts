import { useLayoutEffect, useRef, useState } from 'react';

/**
 * How many ruled blank rows a printed form gets. Patch 141.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A FIXED NUMBER
 * ---------------------------------------------------------------------------
 * The RCI, the RADAI and the RCDisb used to pad every report to fourteen
 * rows, so a short report still looked like the form. Fourteen rows plus the
 * letterhead plus the certification is more than one A4 sheet holds, so a
 * report with ONE line printed on two pages, with the certification alone on
 * the second - the thing a ruled form is meant to avoid.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES INSTEAD
 * ---------------------------------------------------------------------------
 * A hidden copy of the form is laid out exactly as the paper is (the same
 * width in millimetres, the same type size - FormPrintStyle writes both from
 * one set of rules) with no blank rows and one probe row. Its height says how
 * much of the sheet the report itself needs; the probe says how tall a ruled
 * row is. The form then gets as many ruled rows as fill what is left of ONE
 * sheet, less a little room for the printer:
 *
 *   - a short report fills its page and ends with the certification on it;
 *   - a report that already fills the page gets none;
 *   - a report longer than a page simply runs on to the next - no blank rows
 *     are added to it.
 *
 * Long particulars that wrap onto two lines are measured, not guessed.
 */

const PX_PER_MM = 96 / 25.4;

/** The arithmetic, apart from the browser, so it can be tested. */
export function rowsToFill({
  pageHeightPx,
  contentPx,
  rowPx,
  safetyPx = 0,
  max = 60,
}: {
  pageHeightPx: number;
  contentPx: number;
  rowPx: number;
  safetyPx?: number;
  max?: number;
}): number {
  if (!(rowPx > 0) || !(pageHeightPx > 0)) return 0;
  const room = pageHeightPx - safetyPx - contentPx;
  if (room <= 0) return 0;
  return Math.min(max, Math.floor(room / rowPx));
}

/**
 * The hook. Put `ref` on a `.cbo-form-measure` wrapper around a copy of the
 * form rendered with NO blank rows and ONE row marked `data-fit-probe`; use
 * `blank` as the number of ruled rows on the real form.
 *
 * `key` should change whenever the report's content does.
 */
export function useFitRows(pageHeightMm: number, key: unknown, safetyMm = 5) {
  const ref = useRef<HTMLDivElement>(null);
  const [blank, setBlank] = useState(0);

  useLayoutEffect(() => {
    let alive = true;
    const measure = () => {
      const el = ref.current;
      if (!el || !alive) return;
      const probe = el.querySelector<HTMLElement>('[data-fit-probe]');
      const rowPx = probe ? probe.getBoundingClientRect().height : 0;
      const totalPx = el.getBoundingClientRect().height;
      setBlank(
        rowsToFill({
          pageHeightPx: pageHeightMm * PX_PER_MM,
          contentPx: totalPx - rowPx,
          rowPx,
          safetyPx: safetyMm * PX_PER_MM,
        }),
      );
    };
    measure();
    // Again once the fonts are in: a fallback font measures differently.
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pageHeightMm, key, safetyMm]);

  return { ref, blank };
}
