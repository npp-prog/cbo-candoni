import { Field, Select } from '@/components/ui/Field';
import {
  MONTH_NAMES,
  PERIOD_MODE_HINTS,
  PERIOD_MODE_LABELS,
  type PeriodMode,
  type ReportPeriod,
} from '@/lib/reportPeriods';
import { QUARTER_LABELS, type Quarter } from '@/lib/budgetPeriods';

/**
 * Choosing what a report covers.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CONTROL HERE HAS A FIXED WIDTH
 * ---------------------------------------------------------------------------
 * The second control changes with the first: a quarter, a month, or nothing
 * at all for a whole year. When it sized itself to whatever it happened to be
 * holding, picking a different period moved the controls sideways under the
 * cursor - the row reflowed on every change, and it read as though the screen
 * were unfinished.
 *
 * So each control has a fixed width, wide enough for the longest thing it can
 * ever hold, and the space the second one occupies is held whether it is
 * there or not. Changing the period changes what the row SAYS, never where
 * anything sits.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXPLANATION IS ON ITS OWN LINE
 * ---------------------------------------------------------------------------
 * It used to sit under the first control as a field hint, where it wrapped to
 * three lines under a narrow box and dragged the whole row out of alignment.
 * A `basis-full` child in a wrapping flex row starts a new line, so the
 * explanation now runs the full width beneath both controls and the controls
 * themselves stay level.
 */

/**
 * The two widths, both fixed.
 *
 * What has to hold is that a control keeps the SAME width in every mode -
 * otherwise picking a different period slides the row sideways under the
 * cursor. It does not have to hold that the two controls are the same width
 * as each other, and making them so only wastes space: the first one never
 * holds more than "As of a month", the second has to hold "Fourth Quarter
 * (Oct-Dec)".
 *
 * Both were measured in the browser rather than guessed. A select loses about
 * 46px to its padding and its arrow, so the text room is the width below
 * minus that: 146px for the first, 242px for the second. The longest thing
 * each can hold needs 112px and 200px. The slack is deliberate - a machine
 * with a slightly wider system font must not start clipping - and the earlier
 * try at 224px, which left ten pixels, did clip on screen.
 */
const MODE_CONTROL = 'w-48';
const INDEX_CONTROL = 'w-72';

export function PeriodPicker({
  value,
  onChange,
}: {
  value: ReportPeriod;
  onChange: (next: ReportPeriod) => void;
}) {
  const needsQuarter = value.mode === 'QUARTERLY';
  const needsMonth = value.mode === 'MONTHLY' || value.mode === 'AS_OF';

  return (
    <>
      <Field label="Period" className={MODE_CONTROL}>
        <Select
          value={value.mode}
          onChange={(e) => onChange({ mode: e.target.value as PeriodMode, index: 1 })}
        >
          {(Object.keys(PERIOD_MODE_LABELS) as PeriodMode[]).map((m) => (
            <option key={m} value={m}>
              {PERIOD_MODE_LABELS[m]}
            </option>
          ))}
        </Select>
      </Field>

      {needsQuarter && (
        <Field label="Quarter" className={INDEX_CONTROL}>
          <Select
            value={String(value.index)}
            onChange={(e) => onChange({ ...value, index: Number(e.target.value) })}
          >
            {([1, 2, 3, 4] as Quarter[]).map((q) => (
              <option key={q} value={q}>
                {QUARTER_LABELS[q]}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {needsMonth && (
        <Field label={value.mode === 'AS_OF' ? 'Up to and including' : 'Month'} className={INDEX_CONTROL}>
          <Select
            value={String(value.index)}
            onChange={(e) => onChange({ ...value, index: Number(e.target.value) })}
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {/*
        The whole year needs no second control, but taking the space away
        would slide everything after it sideways. The space is held, empty.
      */}
      {!needsQuarter && !needsMonth && <div className={INDEX_CONTROL} aria-hidden="true" />}

      <p className="basis-full text-xs text-slate-500">{PERIOD_MODE_HINTS[value.mode]}</p>
    </>
  );
}
