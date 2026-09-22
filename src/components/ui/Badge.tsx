import clsx from 'clsx';
import { STATUS_LABELS } from '@/types/enums';

/**
 * Status badges.
 *
 * Colour carries meaning here and is grouped by what a user must do about it:
 * slate is dormant, amber is waiting on someone, blue is progressing, emerald
 * is settled, rose is a problem or a dead end. Every badge also carries its
 * label in words, so the meaning never depends on colour alone.
 */

type Tone = 'slate' | 'amber' | 'blue' | 'emerald' | 'rose' | 'violet';

const TONES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  blue: 'bg-brand-50 text-brand-800 ring-brand-200',
  emerald: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  rose: 'bg-rose-50 text-rose-800 ring-rose-200',
  violet: 'bg-violet-50 text-violet-800 ring-violet-200',
};

const STATUS_TONES: Record<string, Tone> = {
  DRAFT: 'slate',
  SUBMITTED: 'amber',
  FOR_REVIEW: 'amber',
  FOR_SIGNATURE: 'amber',
  BUDGET_REVIEWED: 'blue',
  REVIEWED: 'blue',
  CERTIFIED: 'blue',
  APPROVED: 'blue',
  SIGNED: 'blue',
  PREPARED: 'slate',
  OBLIGATED: 'blue',
  RELEASED: 'blue',
  SUBMITTED_TO_BANK: 'blue',
  IN_TRANSIT: 'amber',
  IN_RCD: 'blue',
  ISSUED: 'blue',
  RECORDED: 'slate',
  VERIFIED: 'blue',
  POSTED: 'emerald',
  PAID: 'emerald',
  CLEARED: 'emerald',
  CREDITED: 'emerald',
  DEBITED: 'emerald',
  DEPOSITED: 'emerald',
  CLOSED: 'emerald',
  FINALIZED: 'emerald',
  FULLY_LIQUIDATED: 'emerald',
  PARTIALLY_LIQUIDATED: 'amber',
  OUTSTANDING: 'amber',
  RETURNED: 'rose',
  REJECTED: 'rose',
  CANCELLED: 'rose',
  STALE: 'rose',
  REVERSED: 'violet',
  REPLACED: 'violet',
  REOPENED: 'violet',
  WRITTEN_OFF: 'violet',
  OPEN: 'emerald',
  TEMPORARILY_LOCKED: 'amber',
  MATCHED: 'emerald',
  SUGGESTED: 'amber',
  PARTIALLY_MATCHED: 'amber',
  UNMATCHED: 'slate',
  BANK_CHARGE: 'violet',
  INTEREST_INCOME: 'violet',
  ERROR: 'rose',
  OUTSTANDING_CHECK: 'amber',
  DEPOSIT_IN_TRANSIT: 'amber',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONES[status] ?? 'slate';
  const label = STATUS_LABELS[status] ?? humanise(status);
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

export function Badge({
  children,
  tone = 'slate',
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

function humanise(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
