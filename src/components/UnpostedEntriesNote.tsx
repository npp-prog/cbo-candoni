import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/Layout';
import { useJevs } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { awaitingPosting, totalAwaitingPosting } from '@/lib/postingQueue';

/**
 * Why a ledger-backed report is empty.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * Every financial report in CFMS is drawn from POSTED journal entries. A
 * prepared entry - one raised from a voucher, waiting for the Municipal
 * Accountant - is not in the General Ledger and must not be: posting is the
 * act that writes the books, and it belongs to one officer.
 *
 * That is correct, and it is also invisible. An Accountant who has approved a
 * voucher, seen "JEV 100-26-01-0001 was generated", and then opened the
 * General Ledger to find nothing has every reason to conclude the reports are
 * not connected to the journal entries at all. Ours said only:
 *
 *     "No entries have been posted against 50203010 Office Supplies Expenses"
 *
 * - which is true, and tells you nothing about the three entries sitting one
 * screen away with your name on them.
 *
 * So the report now says what is waiting and where it is. The reports were
 * always connected to the journal entries. What was missing was anything on
 * the screen that said so.
 */
export function UnpostedEntriesNote({
  fiscalYear,
  fundCode,
  /** Shown only when the report itself found nothing, unless `always`. */
  always,
  className,
}: {
  fiscalYear: number;
  fundCode: string;
  always?: boolean;
  className?: string;
}) {
  const { data } = useJevs(fiscalYear, fundCode);

  const waiting = useMemo(() => awaitingPosting(data), [data]);

  if (waiting.length === 0) return null;

  const total = totalAwaitingPosting(waiting);

  return (
    <Alert
      tone="warning"
      title={`${waiting.length} journal ${
        waiting.length === 1 ? 'entry is' : 'entries are'
      } prepared but not posted`}
      className={className}
    >
      <p>
        {formatPeso(total)} across {waiting.length}{' '}
        {waiting.length === 1 ? 'entry' : 'entries'} for this fund and year.{' '}
        {always
          ? 'They are not in this report yet.'
          : 'That is why there is nothing here.'}{' '}
        An entry reaches the General Ledger - and every report drawn from it - when the Municipal
        Accountant posts it.
      </p>
      <p className="mt-2">
        <Link to="/accounting/journal-entries" className="font-medium underline">
          Open the Journal Entries Register
        </Link>
        {' '}&mdash; every entry in the books is listed there, whatever raised it. An entry raised
        by a voucher is posted on the voucher itself; one written in Accounting is posted from
        General Transactions.
      </p>
    </Alert>
  );
}
