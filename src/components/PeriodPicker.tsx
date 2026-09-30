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
 * Two controls rather than one: what KIND of period, and then which one. A
 * single list of "January, February, … First Quarter, … Whole year" would be
 * twenty-odd entries with three different meanings mixed into it, and the one
 * that is actually submitted would be buried in the middle.
 *
 * The second control changes with the first, and disappears for a whole year,
 * because a year has only one of itself.
 */
export function PeriodPicker({
  value,
  onChange,
  className,
}: {
  value: ReportPeriod;
  onChange: (next: ReportPeriod) => void;
  className?: string;
}) {
  return (
    <>
      <Field label="Period" className={className ?? 'w-44'} hint={PERIOD_MODE_HINTS[value.mode]}>
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

      {value.mode === 'QUARTERLY' && (
        <Field label="Quarter" className="w-64">
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

      {(value.mode === 'MONTHLY' || value.mode === 'AS_OF') && (
        <Field label={value.mode === 'AS_OF' ? 'Up to and including' : 'Month'} className="w-44">
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
    </>
  );
}
