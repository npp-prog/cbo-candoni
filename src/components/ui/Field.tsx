import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import clsx from 'clsx';
import { formatPeso, parsePeso } from '@/lib/money';
import type { Centavos } from '@/types/common';

interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}

export function Field({ label, hint, error, required, children, className, htmlFor }: FieldProps) {
  return (
    <div className={className}>
      {label && (
        // `title` because the label is clipped to one line: the full wording
        // stays available on hover and to a screen reader.
        <label className="cbo-label" htmlFor={htmlFor} title={label}>
          {label}
          {required && <span className="text-rose-600 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="mt-1 text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function TextInput({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={clsx('cbo-input', invalid && 'border-rose-400 focus:border-rose-500 focus:ring-rose-500', className)}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={clsx('cbo-input pr-8', invalid && 'border-rose-400', className)}
        {...rest}
      >
        {children}
      </select>
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, rows = 3, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={clsx('cbo-input resize-y', className)} {...rest} />;
  },
);

/**
 * Amount input.
 *
 * Holds a peso string while the user is typing and reports centavos to the
 * parent. Formatting happens on blur, never on every keystroke: reformatting
 * mid-entry moves the caret and makes rapid numeric entry maddening for
 * someone keying in a hundred voucher lines.
 *
 * The value that leaves this component is always an integer number of
 * centavos, so no peso-as-float ever reaches the rest of the system.
 */
export function AmountInput({
  value,
  onChange,
  disabled,
  invalid,
  placeholder = '0.00',
  className,
  allowNegative = false,
  id,
  onBlur,
}: {
  value: Centavos | null;
  onChange: (value: Centavos | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  className?: string;
  allowNegative?: boolean;
  id?: string;
  onBlur?: () => void;
}) {
  const [text, setText] = useState(() => (value === null ? '' : formatPeso(value, { symbol: false })));
  const [focused, setFocused] = useState(false);

  // Follow the parent when it changes the value from outside (a computed
  // total, a reset), but never while the field has focus - that would rewrite
  // what the user is in the middle of typing.
  useEffect(() => {
    if (focused) return;
    setText(value === null ? '' : formatPeso(value, { symbol: false }));
  }, [value, focused]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
        &#8369;
      </span>
      <input
        id={id}
        inputMode="decimal"
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onFocus={(e) => {
          setFocused(true);
          // Strip grouping while editing so the caret behaves predictably.
          setText(value === null ? '' : String(value / 100));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const parsed = parsePeso(raw);
          if (parsed === null) {
            onChange(raw.trim() === '' ? null : value);
            return;
          }
          onChange(!allowNegative && parsed < 0 ? Math.abs(parsed) : parsed);
        }}
        onBlur={() => {
          setFocused(false);
          const parsed = parsePeso(text);
          const settled = parsed === null ? null : !allowNegative && parsed < 0 ? Math.abs(parsed) : parsed;
          onChange(settled);
          setText(settled === null ? '' : formatPeso(settled, { symbol: false }));
          onBlur?.();
        }}
        className={clsx(
          'cbo-input pl-7 font-mono text-right tabular',
          invalid && 'border-rose-400 focus:border-rose-500 focus:ring-rose-500',
          className,
        )}
      />
    </div>
  );
}

/**
 * Date input. Native, because the browser's own picker is familiar and
 * keyboard-accessible, and because the value is already the `YYYY-MM-DD`
 * string CBO stores.
 */
export function DateInput({
  value,
  onChange,
  disabled,
  invalid,
  min,
  max,
  id,
  className,
}: {
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  min?: string;
  max?: string;
  id?: string;
  className?: string;
}) {
  return (
    <input
      id={id}
      type="date"
      value={value ?? ''}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={clsx('cbo-input', invalid && 'border-rose-400', className)}
    />
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
      <div>
        <label htmlFor={id} className="text-sm text-navy-800 select-none">
          {label}
        </label>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}
