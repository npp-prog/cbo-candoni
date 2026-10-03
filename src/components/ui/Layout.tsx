import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';

/**
 * Small structural pieces shared by every screen: page headers, cards,
 * breadcrumbs, empty and loading states, inline alerts and tabs.
 */

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
}: {
  title: string;
  subtitle?: string;
  breadcrumbs?: Array<{ label: string; to?: string }>;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 no-print">
      {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-navy-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav className="mb-2 flex items-center gap-1.5 text-xs text-slate-500" aria-label="Breadcrumb">
      {items.map((item, i) => (
        <span key={`${item.label}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && (
            <svg className="h-3 w-3 text-slate-300" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                clipRule="evenodd"
              />
            </svg>
          )}
          {item.to ? (
            <Link to={item.to} className="hover:text-brand-700 hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-slate-600">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  footer,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
}) {
  return (
    <section className={clsx('cbo-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-navy-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx('px-4 py-4', bodyClassName)}>{children}</div>
      {footer && <footer className="border-t border-slate-200 bg-slate-50 px-4 py-3">{footer}</footer>}
    </section>
  );
}

export function EmptyState({
  title,
  message,
  action,
  icon,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-400">
        {icon ?? (
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5A3.375 3.375 0 0010.125 2.25H8.25m3.75 9v6m3-3H9M9.75 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            />
          </svg>
        )}
      </div>
      <p className="text-sm font-medium text-navy-800">{title}</p>
      {message && <p className="mt-1 max-w-md text-sm text-slate-500">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <div className={clsx('flex items-center justify-center gap-2 py-10 text-sm text-slate-500', className)}>
      <svg className="h-4 w-4 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      {label}
    </div>
  );
}

type AlertTone = 'info' | 'warning' | 'error' | 'success';

/**
 * The `info` tone is deliberately GREY, not blue.
 *
 * The blue panel was being used for two different jobs, and only one of them
 * was ever wanted: explaining how an accounting procedure works, and reporting
 * the state of the data in front of the reader ("nothing on this registry
 * yet", "3 accounts in the chart", "posted as JEV 2026-01-0004").
 *
 * The explanations have been taken out of the screens altogether. What remains
 * on this tone is the second job - a statement of fact about the data - and a
 * fact about the data is not a note. It is shown quietly, in grey, so it reads
 * as part of the page rather than as something coloured demanding attention.
 *
 * Attention is what the other three tones are for, and they keep their colour:
 * amber where something needs doing, rose where something is wrong, green
 * where something succeeded. Spending colour on explanation is what made the
 * real warnings easy to scroll past.
 */
const ALERT_STYLES: Record<AlertTone, string> = {
  info: 'border-slate-200 bg-slate-50 text-slate-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  error: 'border-rose-200 bg-rose-50 text-rose-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('rounded-md border px-4 py-3 text-sm', ALERT_STYLES[tone], className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title && <p className="font-medium">{title}</p>}
          {children && <div className={clsx(title && 'mt-1', 'text-sm opacity-90')}>{children}</div>}
        </div>
        {action}
      </div>
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; count?: number }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="border-b border-slate-200 no-print">
      <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={clsx(
              'whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              active === tab.id
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-navy-800',
            )}
            aria-current={active === tab.id ? 'page' : undefined}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={clsx(
                  'ml-2 rounded-full px-1.5 py-0.5 text-2xs',
                  active === tab.id ? 'bg-brand-100 text-brand-800' : 'bg-slate-100 text-slate-600',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** A labelled read-only value, used throughout the document detail screens. */
export function DetailField({
  label,
  children,
  mono,
  className,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-2xs font-medium uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={clsx('mt-0.5 text-sm text-navy-900', mono && 'font-mono tabular')}>
        {children ?? <span className="text-slate-400">-</span>}
      </dd>
    </div>
  );
}
