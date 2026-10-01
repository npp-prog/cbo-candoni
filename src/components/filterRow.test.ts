import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QUARTER_LABELS, type Quarter } from '@/lib/budgetPeriods';
import { PERIOD_MODE_LABELS, type PeriodMode } from '@/lib/reportPeriods';

/**
 * ---------------------------------------------------------------------------
 * THE FILTER ROW MUST NOT MOVE
 * ---------------------------------------------------------------------------
 *
 * A filter row is the strip of controls above a report or a register. It was
 * misaligning in two different ways at once, and both were reported as the
 * same complaint - "it keeps changing, it doesn't line up".
 *
 *   1. The row aligned its BOTTOMS (`items-end`). A field carrying a hint
 *      underneath it is taller than one without, so aligning the bottoms
 *      pushed that field's control UP and left its neighbour sitting low.
 *      Worse, the hint appears and disappears as the period is changed, so
 *      the row moved every time it was touched.
 *
 *   2. A label that wrapped to two lines pushed its own control down a line
 *      while the control next to it stayed put.
 *
 * The fix is in ONE place - the `.cbo-filter-row` class - so that it applies
 * to every filter row in CFMS rather than the one screen that was complained
 * about. These tests exist because that is exactly the kind of fix that gets
 * undone by a later edit to a single screen.
 */

const read = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');

describe('the shared filter row', () => {
  const css = read('src/index.css');

  it('aligns the tops of the row, not the bottoms', () => {
    const block = css.slice(css.indexOf('.cbo-filter-row {'));
    expect(block).toContain('items-start');
    expect(block).not.toContain('items-end');
  });

  it('holds every label in the row to one line', () => {
    expect(css).toContain('.cbo-filter-row .cbo-label');
    const scoped = css.slice(css.indexOf('.cbo-filter-row .cbo-label'));
    expect(scoped).toContain('truncate');
  });

  /**
   * Scoped, deliberately. A label in a FORM is allowed to wrap - "Requires a
   * subsidiary on every line" needs its two lines, and clipping it would hide
   * the half that says what the setting does. Only the filter row, where the
   * labels are one or two words and the alignment matters more, is clipped.
   */
  it('does not clip labels everywhere', () => {
    const plain = css.slice(css.indexOf('.cbo-label {'), css.indexOf('.cbo-filter-row {'));
    expect(plain).not.toContain('truncate');
  });

  it.each([
    ['ReportShell', 'src/components/ReportShell.tsx'],
    ['AttachmentsPanel', 'src/components/AttachmentsPanel.tsx'],
  ])('%s puts its filters in the shared row', (_name, file) => {
    expect(read(file)).toContain('cbo-filter-row');
  });
});

/**
 * Each control in a filter row has a FIXED width - wide enough for the longest
 * thing it can ever hold - so that changing the period does not slide the row
 * sideways under the cursor. That only works while the words still fit: an
 * option cut off mid-word, "First Quarter (January to M...", cannot be told
 * apart from a short one and there is no way to see the rest of it.
 *
 * These limits come from measuring in a browser, not from counting on paper.
 * The quarter box has 242px of text room and "Fourth Quarter (Oct-Dec)" takes
 * 200px of it, which is about 24 characters at 8px each. The period box has
 * 146px and "As of a month" takes 112px. The limits below sit just above what
 * is in use, so a longer wording fails here rather than on Neil's screen.
 *
 * If a label must get longer, widen its control in PeriodPicker and raise the
 * limit here together - and measure, because the earlier try that left ten
 * pixels of slack still clipped.
 */
describe('the words fit in the box', () => {
  const QUARTER_LIMIT = 26; // w-72, 242px of text room
  const MODE_LIMIT = 16; // w-48, 146px

  it.each([1, 2, 3, 4] as Quarter[])('quarter %i', (q) => {
    expect(QUARTER_LABELS[q].length, QUARTER_LABELS[q]).toBeLessThanOrEqual(QUARTER_LIMIT);
  });

  it.each(Object.keys(PERIOD_MODE_LABELS) as PeriodMode[])('period mode %s', (m) => {
    expect(PERIOD_MODE_LABELS[m].length, PERIOD_MODE_LABELS[m]).toBeLessThanOrEqual(MODE_LIMIT);
  });
});
