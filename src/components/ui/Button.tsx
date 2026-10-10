import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  fullWidth?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm disabled:bg-brand-300',
  // Patch 167: navy label, a navy-tinted border and hover, from the mark's navy.
  secondary:
    'bg-white text-navy-700 border border-navy-200 hover:bg-navy-50 hover:border-navy-300 active:bg-navy-100 shadow-sm disabled:text-slate-400 disabled:border-slate-200',
  ghost: 'text-navy-700 hover:bg-navy-50 active:bg-navy-100 disabled:text-slate-400',
  // Reserved for irreversible acts: cancelling a voucher, reversing a posted
  // entry, reopening a closed period.
  danger: 'bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800 shadow-sm disabled:bg-rose-300',
  // Patch 167: the teal of the CFMS mark's bars, darkened to read white on.
  success: 'bg-accent-600 text-white hover:bg-accent-700 active:bg-accent-800 shadow-sm disabled:bg-accent-300',
};

/*
 * A MINIMUM WIDTH PER SIZE, SO A ROW OF BUTTONS IS A ROW.
 *
 * Padding alone sizes a button to its own label, so "Add a line" came out
 * visibly narrower than "Upload a schedule" sitting beside it and the pair
 * read as two unrelated controls rather than one set of choices. The minimum
 * holds the short ones out to the width of a normal label; a longer label
 * still grows past it rather than being clipped.
 *
 * `justify-center` is what makes the extra width look deliberate - without it
 * the label sits left in a wide box.
 */
const SIZES: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5 gap-1.5 min-w-[6rem]',
  md: 'text-sm px-3.5 py-2 gap-2 min-w-[8rem]',
  lg: 'text-sm px-5 py-2.5 gap-2 min-w-[9rem]',
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, fullWidth, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      ) : (
        icon
      )}
      {children}
    </button>
  );
});
