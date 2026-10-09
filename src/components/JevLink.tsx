import type { MouseEvent, ReactNode } from 'react';
import { ReturnLink } from './ui/BackButton';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Patch 150. A JEV number that opens its journal entry.
 *
 * Wherever a report or a document shows the JEV it was taken up in, the number
 * is a link to that entry - with the way back to the page it was clicked on
 * (ReturnLink), so the officer is never left in the journal with no road home.
 *
 * Shown as plain text when there is no entry id to go to, or the officer has
 * no access to Accounting (the Treasury staff, for whom the link would only
 * open a "not permitted" page). On paper it prints as plain text.
 *
 * The click does not reach the row underneath: on a register whose rows open
 * the report, the number opens the ENTRY, and only the entry.
 */
export function JevLink({
  jevId,
  jevNo,
  children,
  className,
}: {
  jevId?: string | null;
  jevNo?: string | null;
  /** What to show; defaults to the number itself. */
  children?: ReactNode;
  className?: string;
}) {
  const { can } = useAuth();
  const label = children ?? jevNo ?? '';
  if (!jevId || !can('accounting', 'view')) {
    return <span className={className}>{label}</span>;
  }
  return (
    <ReturnLink
      to={jevPath(jevId)}
      title={jevNo ? `Open JEV ${jevNo}` : 'Open the journal entry'}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      className={`${className ?? ''} text-brand-700 underline decoration-dotted underline-offset-2 hover:decoration-solid print:text-inherit print:no-underline`.trim()}
    >
      {label}
    </ReturnLink>
  );
}

/** The page of one journal entry, whatever its source. */
export function jevPath(jevId: string): string {
  return `/accounting/journal-entries/${jevId}`;
}
