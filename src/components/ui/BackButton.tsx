import { useCallback } from 'react';
import { Link, useLocation, useNavigate, type LinkProps } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { backTarget, hereAsReturn, withReturn } from '@/lib/returnTo';

/**
 * Leaving a document the way it was entered. Patch 114.
 *
 * Three pieces, used together:
 *
 *   useOpenWithReturn   a list opens a document and writes its own address -
 *                       path and tab - into the document's address
 *   ReturnLink          the same, for a link from one document to another:
 *                       a voucher's OBR, an entry's voucher
 *   BackButton          the document reads that address back and offers the
 *                       way out, by name: "Back to Index of Payment"
 *
 * A document opened from a bookmark or a typed link carries no return
 * address, and its button goes to the document's own list instead.
 */

/** Opens a document from here, remembering here. */
export function useOpenWithReturn() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (to: string) => navigate(withReturn(to, hereAsReturn(location))),
    [navigate, location],
  );
}

/** A link to another document that remembers the page it was followed from. */
export function ReturnLink({ to, ...rest }: Omit<LinkProps, 'to'> & { to: string }) {
  const location = useLocation();
  return <Link to={withReturn(to, hereAsReturn(location))} {...rest} />;
}

/**
 * The way back, for a document's header.
 *
 * `list` is the document's own list - where the button goes when the address
 * does not say where the document was opened from.
 */
export function BackButton({ list }: { list: { to: string; label: string } }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { to, label } = backTarget(search, list);
  return (
    <Button variant="secondary" onClick={() => navigate(to)}>
      &larr; Back to {label}
    </Button>
  );
}

/**
 * The address a document moves to after its first save - from /new to its
 * own id - keeping the return address it was opened with, so Back still
 * goes to the table it was started from.
 */
export function keepReturn(to: string, search: string): string {
  const from = new URLSearchParams(search).get('from');
  return withReturn(to, from);
}
