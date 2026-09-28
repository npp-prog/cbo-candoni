import { Fragment, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ReportShell } from '@/components/ReportShell';
import { Field, DateInput, Select } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { useCollections, useAccountableFormTypes } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { analyzeContinuity, toNumber } from '@/lib/serials';
import type { Collection } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';

/**
 * Abstract of General Collection.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COLUMNS ARE NOT FIXED
 * ---------------------------------------------------------------------------
 * This is the one report in CBO whose shape is decided by its own data. The
 * abstract proves, receipt by receipt, that the collections of a period add up
 * two ways: across, to each receipt's own total, and down, to each revenue
 * account's total for the period. To do that it needs one column per account
 * actually collected into - eleven columns one month, six the next.
 *
 * A fixed set of columns cannot do this. Too few and the abstract stops
 * footing; too many and it is unreadable and will not fit a sheet of paper.
 * So the columns are built from the period's own receipts, sorted by account
 * code, and the grand-total row under them is what an auditor ties to the
 * Summary of Collections.
 *
 * ---------------------------------------------------------------------------
 * WHY CASH TICKETS ARE LEFT OUT
 * ---------------------------------------------------------------------------
 * Accountable Form No. 56 is a cash ticket: a market vendor pays five pesos
 * and receives a numbered stub, hundreds a day. Listing them here, one line
 * each, would bury the general collection in noise for a figure that belongs on
 * its own report. They are excluded by the form they were issued on and their
 * count is printed at the foot, so their absence is stated rather than silent.
 * ---------------------------------------------------------------------------
 */

const CASH_TICKET_FORM = 'AF56';

/** "AF 51", "af-51" and "AF51" are one booklet. */
function normaliseFormCode(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface Row {
  collection: Collection;
  lineNo: number;
  formCode: string;
  /** Set when this receipt's serial is a duplicate or opens a gap. */
  flag: 'gap' | 'duplicate' | null;
}

export default function AbstractOfCollections() {
  const { fiscalYear, fundCode } = useFilters();
  const { data: collections, loading } = useCollections(fiscalYear, fundCode);
  const { data: formTypes } = useAccountableFormTypes();

  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);
  const [officer, setOfficer] = useState('');

  const officers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of collections) seen.set(c.collectingOfficerId, c.collectingOfficerName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [collections]);

  const inPeriod = useMemo(
    () =>
      collections.filter(
        (c) => c.orDate >= from && c.orDate <= to && (!officer || c.collectingOfficerId === officer),
      ),
    [collections, from, to, officer],
  );

  const cashTickets = useMemo(
    () =>
      inPeriod.filter(
        (c) => normaliseFormCode((c as { accountableForm?: string }).accountableForm ?? c.accountableFormId) === CASH_TICKET_FORM,
      ),
    [inPeriod],
  );

  const reportable = useMemo(
    () => inPeriod.filter((c) => !cashTickets.includes(c)),
    [inPeriod, cashTickets],
  );

  /** One column per account code actually collected into, in code order. */
  const accountColumns = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of reportable) {
      for (const line of c.lines) seen.set(line.accountCode, line.accountName);
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [reportable]);

  /**
   * Grouped by collecting officer, because that is who signs for the receipts
   * and who an auditor holds to account. Line numbers restart in each group.
   */
  const groups = useMemo(() => {
    const byOfficer = new Map<string, Collection[]>();
    for (const c of reportable) {
      const list = byOfficer.get(c.collectingOfficerId) ?? [];
      list.push(c);
      byOfficer.set(c.collectingOfficerId, list);
    }

    return [...byOfficer.entries()]
      .map(([id, list]) => {
        const sorted = [...list].sort((a, b) => {
          const fa = normaliseFormCode((a as { accountableForm?: string }).accountableForm ?? a.accountableFormId);
          const fb = normaliseFormCode((b as { accountableForm?: string }).accountableForm ?? b.accountableFormId);
          if (fa !== fb) return fa.localeCompare(fb);
          if (a.orDate !== b.orDate) return a.orDate.localeCompare(b.orDate);
          const na = toNumber(a.orNumber);
          const nb = toNumber(b.orNumber);
          if (na !== null && nb !== null) return na - nb;
          return a.orNumber.localeCompare(b.orNumber);
        });

        // Continuity is judged per accountable form, since two forms have two
        // independent serial runs and a "gap" between them is not a gap.
        const flags = new Map<string, 'gap' | 'duplicate'>();
        const byForm = new Map<string, Collection[]>();
        for (const c of sorted) {
          const f = normaliseFormCode((c as { accountableForm?: string }).accountableForm ?? c.accountableFormId) || '-';
          byForm.set(f, [...(byForm.get(f) ?? []), c]);
        }
        for (const list of byForm.values()) {
          const report = analyzeContinuity(list.map((c) => c.orNumber));
          for (const g of report.gaps) {
            const after = list.find((c) => toNumber(c.orNumber) === toNumber(g.before));
            if (after) flags.set(after.id, 'gap');
          }
          // A duplicate outranks a gap: the same serial twice is the more
          // serious finding, and one badge per row is all the paper allows.
          for (const d of report.duplicates) {
            for (const c of list.filter((x) => toNumber(x.orNumber) === toNumber(d.serial))) {
              flags.set(c.id, 'duplicate');
            }
          }
        }

        const rows: Row[] = sorted.map((c, i) => ({
          collection: c,
          lineNo: i + 1,
          formCode: normaliseFormCode((c as { accountableForm?: string }).accountableForm ?? c.accountableFormId),
          flag: flags.get(c.id) ?? null,
        }));

        return { officerId: id, officerName: list[0].collectingOfficerName, rows };
      })
      .sort((a, b) => a.officerName.localeCompare(b.officerName));
  }, [reportable]);

  const codeTotal = (code: string) =>
    reportable.reduce(
      (sum, c) => sum + c.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.amount, 0),
      0,
    );

  const grandTotal = reportable.reduce((s, c) => s + c.totalAmount, 0);

  const printedName = (code: string) =>
    formTypes.find((t) => t.code === code)?.printedAs ?? code ?? '';

  if (loading) return <Spinner label="Reading the collections" />;

  return (
    <ReportShell
      meta={{
        title: 'Abstract of General Collection',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the period ${formatShortDate(from)} to ${formatShortDate(to)}`,
        preparedBy: 'Municipal Treasurer’s Office',
        certifiedBy: 'Municipal Treasurer',
      }}
      breadcrumbs={[{ label: 'Treasury', to: '/treasury' }, { label: 'Abstract of Collections' }]}
      filters={
        <>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={setFrom} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={setTo} />
          </Field>
          <Field label="Collecting officer" className="w-56">
            <Select value={officer} onChange={(e) => setOfficer(e.target.value)}>
              <option value="">Every collecting officer</option>
              {officers.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={
        <div className="space-y-1.5">
          {cashTickets.length > 0 && (
            <p>
              {cashTickets.length} cash-ticket receipt
              {cashTickets.length === 1 ? '' : 's'} on Accountable Form No. 56, totalling{' '}
              {formatAmount(cashTickets.reduce((s, c) => s + c.totalAmount, 0))}, are reported
              separately and are excluded from this abstract.
            </p>
          )}
          <p className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-sm bg-rose-100 ring-1 ring-rose-300" />
              Gap in the serials, or a form out of series
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-sm bg-blue-100 ring-1 ring-blue-300" />
              Serial issued more than once
            </span>
          </p>
        </div>
      }
    >
      {reportable.length === 0 ? (
        <Alert tone="info" title="No collections in this period">
          Nothing was receipted between those dates in the {fundLabel(fundCode)}.
        </Alert>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-2xs">
            <thead>
              <tr className="bg-slate-100">
                <th className="border border-slate-300 px-1.5 py-1 text-left" rowSpan={2}>
                  Line
                </th>
                <th className="border border-slate-300 px-1.5 py-1 text-left" rowSpan={2}>
                  Date
                </th>
                <th className="border border-slate-300 px-1.5 py-1 text-left" rowSpan={2}>
                  Accountable Form
                </th>
                <th className="border border-slate-300 px-1.5 py-1 text-center" colSpan={2}>
                  O.R. Number
                </th>
                <th className="border border-slate-300 px-1.5 py-1 text-left" rowSpan={2}>
                  Name of Payor
                </th>
                <th className="border border-slate-300 px-1.5 py-1 text-right" rowSpan={2}>
                  Total Amount
                </th>
                {accountColumns.map(([code, name]) => (
                  <th
                    key={code}
                    className="border border-slate-300 px-1.5 py-1 text-right align-bottom"
                    rowSpan={2}
                    style={{ minWidth: '5rem' }}
                  >
                    <span className="block font-normal leading-tight">{name}</span>
                    <span className="block font-mono text-[9px] text-slate-500">{code}</span>
                  </th>
                ))}
              </tr>
              <tr className="bg-slate-100">
                <th className="border border-slate-300 px-1.5 py-1">From</th>
                <th className="border border-slate-300 px-1.5 py-1">To</th>
              </tr>
            </thead>

            <tbody>
              {groups.map((g) => (
                <Fragment key={g.officerId}>
                  <tr className="bg-slate-50">
                    <td
                      className="border border-slate-300 px-1.5 py-1 font-semibold uppercase tracking-wide"
                      colSpan={7 + accountColumns.length}
                    >
                      Collector: {g.officerName}
                    </td>
                  </tr>
                  {g.rows.map((r) => (
                    <tr
                      key={r.collection.id}
                      className={clsx(
                        r.flag === 'duplicate' && 'bg-blue-50',
                        r.flag === 'gap' && 'bg-rose-50',
                      )}
                    >
                      <td className="border border-slate-300 px-1.5 py-1 text-right">{r.lineNo}</td>
                      <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">
                        {formatShortDate(r.collection.orDate)}
                      </td>
                      <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">
                        {printedName(r.formCode)}
                      </td>
                      <td className="border border-slate-300 px-1.5 py-1 font-mono">
                        {r.collection.orNumber}
                      </td>
                      <td className="border border-slate-300 px-1.5 py-1 font-mono">
                        {r.collection.orNumber}
                      </td>
                      <td className="border border-slate-300 px-1.5 py-1">
                        {r.collection.payorName}
                        {r.collection.status === 'CANCELLED' && (
                          <span className="ml-1 font-semibold uppercase text-rose-700">Cancelled</span>
                        )}
                      </td>
                      <td className="border border-slate-300 px-1.5 py-1 text-right tabular-nums">
                        {formatAmount(r.collection.totalAmount)}
                      </td>
                      {accountColumns.map(([code]) => {
                        const amount = r.collection.lines
                          .filter((l) => l.accountCode === code)
                          .reduce((s, l) => s + l.amount, 0);
                        return (
                          <td
                            key={code}
                            className="border border-slate-300 px-1.5 py-1 text-right tabular-nums"
                          >
                            {amount ? formatAmount(amount) : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>

            <tfoot>
              <tr className="bg-slate-100 font-semibold">
                <td className="border border-slate-300 px-1.5 py-1.5 text-right" colSpan={6}>
                  T O T A L
                </td>
                <td className="border border-slate-300 px-1.5 py-1.5 text-right tabular-nums">
                  {formatAmount(grandTotal)}
                </td>
                {accountColumns.map(([code]) => (
                  <td
                    key={code}
                    className="border border-slate-300 px-1.5 py-1.5 text-right tabular-nums"
                  >
                    {formatAmount(codeTotal(code))}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </ReportShell>
  );
}
