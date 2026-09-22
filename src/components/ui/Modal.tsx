import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button } from './Button';
import { TextArea } from './Field';

type Size = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const SIZES: Record<Size, string> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
  full: 'max-w-[95vw]',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: Size;
  children: ReactNode;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto no-print" role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-navy-950/40 backdrop-blur-[1px]"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />
      <div className="flex min-h-full items-start justify-center p-4 sm:p-6">
        <div
          ref={panelRef}
          tabIndex={-1}
          className={clsx(
            'relative w-full rounded-lg bg-white shadow-raised ring-1 ring-slate-900/5',
            'my-8 focus:outline-none',
            SIZES[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-navy-900">{title}</h2>
              {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
            </div>
            <button
              onClick={onClose}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>

          <div className="px-5 py-4">{children}</div>

          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 rounded-b-lg">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmation dialog for consequential acts.
 *
 * `requireReason` is used wherever the reason becomes part of the permanent
 * record - cancelling a voucher, reversing a posted entry, reopening a closed
 * period, obligating beyond available allotment. In those cases the text typed
 * here is written to the audit trail and shown to COA, so the dialog says so
 * plainly rather than presenting it as an optional note.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'primary',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonHint,
  minReasonLength = 10,
  loading,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: (reason?: string) => void | Promise<void>;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  variant?: 'primary' | 'danger' | 'success';
  requireReason?: boolean;
  reasonLabel?: string;
  reasonHint?: string;
  minReasonLength?: number;
  loading?: boolean;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const reasonTooShort = requireReason && reason.trim().length < minReasonLength;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      closeOnBackdrop={!loading}
      footer={
        <>
          <Button onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={variant}
            loading={loading}
            disabled={reasonTooShort}
            onClick={() => void onConfirm(requireReason ? reason.trim() : undefined)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-navy-700">{message}</div>

      {requireReason && (
        <div className="mt-4">
          <label className="cbo-label" htmlFor="confirm-reason">
            {reasonLabel}
            <span className="text-rose-600 ml-0.5">*</span>
          </label>
          <TextArea
            id="confirm-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="State the reason in full."
          />
          <p className="mt-1 text-xs text-slate-500">
            {reasonHint ??
              'This reason is recorded permanently in the audit trail and is visible to the Commission on Audit.'}
            {reasonTooShort && reason.length > 0 && (
              <span className="text-amber-700">
                {' '}
                At least {minReasonLength} characters.
              </span>
            )}
          </p>
        </div>
      )}
    </Modal>
  );
}
