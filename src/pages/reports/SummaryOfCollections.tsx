import { Fragment, useMemo, useState } from 'react';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { ReportShell } from '@/components/ReportShell';
import { Field, DateInput, Checkbox } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { useAccounts, useCollections } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from '../treasury/sections';

/**
 * Summary of Collections.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ZERO ROWS ARE PRINTED
 * ---------------------------------------------------------------------------
 * This is an official form, and an official form is read by someone checking
 * that a particular line is there. A summary that prints only the accounts
 * with money in them is shorter and, for that reader, useless: they cannot tell
 * a nil month for Real Property Tax from a Real Property Tax line that was
 * accidentally left off. So every revenue account in the Chart of Accounts is
 * printed, whether it collected anything or not, and the switch that hides the
 * empty ones is off by default.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FORM IS GENERATED RATHER THAN STORED
 * ---------------------------------------------------------------------------
 * The office's own spreadsheet carries this form as a fixed list of rows. That
 * works until the Chart of Accounts changes, and then the form and the ledger
 * quietly disagree - the new account collects money that appears in the grand
 * total and on no line of the form.
 *
 * Here the form is built from the Chart of Accounts every time it is opened, so
 * it cannot fall behind it. The one thing the ledger can still show that the
 * chart cannot explain - a collection posted to a code that is not an account -
 * is given its own block at the foot rather than being folded silently into the
 * total.
 * ---------------------------------------------------------------------------
 */

/** The first three digits of a UACS code, which is its major group. */
const groupOf = (code: string) => code.slice(0, 3);

export default function SummaryOfCollections() {
  const { fiscalYear, fundCode } = useFilters();
  const { data: collections, loading } = useCollections(fiscalYear, fundCode);
  const { data: accounts } = useAccounts(false);

  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);
  const [hideEmpty, setHideEmpty] = useState(false);

  const inPeriod = useMemo(
    () => collections.filter((c) => c.orDate >= from && c.orDate <= to),
    [collections, from, to],
  );

  /** Collected, by account code. */
  const collected = useMemo(() => {
    const byCode = new Map<string, number>();
    for (const c of inPeriod) {
      for (const line of c.lines) {
        byCode.set(line.accountCode, (byCode.get(line.accountCode) ?? 0) + line.amount);
      }
    }
    return byCode;
  }, [inPeriod]);

  const revenueAccounts = useMemo(
    () => accounts.filter((a) => a.accountClass === 'REVENUE').sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );

  /**
   * Major groups, each headed by the grouping account of the same code where
   * the chart has one. Where it does not, the heading is left as the code
   * itself rather than invented: a wrong heading on an official form is worse
   * than a bare one.
   */
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof revenueAccounts>();
    for (const a of revenueAccounts) {
      if (!a.postable) continue; // grouping accounts are headings, not lines
      const g = groupOf(a.code);
      byGroup.set(g, [...(byGroup.get(g) ?? []), a]);
    }

    return [...byGroup.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([code, lines]) => {
        const header = revenueAccounts.find((a) => !a.postable && groupOf(a.code) === code);
        return {
          code,
          label: header?.name ?? `Account group ${code}`,
          lines,
          total: lines.reduce((s, a) => s + (collected.get(a.code) ?? 0), 0),
        };
      });
  }, [revenueAccounts, collected]);

  /** Money collected into codes the Chart of Accounts does not carry. */
  const orphans = useMemo(() => {
    const known = new Set(revenueAccounts.map((a) => a.code));
    return [...collected.entries()]
      .filter(([code, amount]) => !known.has(code) && amount !== 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [collected, revenueAccounts]);

  const orphanTotal = orphans.reduce((s, [, amount]) => s + amount, 0);
  const grandTotal = [...collected.values()].reduce((s, a) => s + a, 0);

  if (loading) return <Spinner label="Reading the collections" />;

  return (
    <ReportShell
      meta={{
        title: 'Summary of Collections',
        fundLabel: fundLabel(fundCode),
        periodLabel: `For the period ${formatShortDate(from)} to ${formatShortDate(to)}`,
        preparedBy: 'Municipal Treasurer’s Office',
        certifiedBy: 'Municipal Treasurer',
      }}
      breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Summary of Collections' }]}
      tabs={<GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />}
      filters={
        <>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={setFrom} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={setTo} />
          </Field>
          <Field label="Accounts shown" className="w-56">
            <Checkbox
              checked={hideEmpty}
              onChange={setHideEmpty}
              label="Hide accounts with no collection"
            />
          </Field>
        </>
      }
      footnote={
        <>
          Built from the Chart of Accounts, so a revenue account added to the chart appears here
          without this report being changed. The grand total ties to the Abstract of General
          Collection for the same period.
        </>
      }
    >
      {revenueAccounts.length === 0 ? (
        <Alert tone="warning" title="No revenue accounts in the Chart of Accounts">
          This form is generated from the chart. Add the revenue accounts under{' '}
          <strong>Master Data &rsaquo; Chart of Accounts</strong> and it will fill itself in.
        </Alert>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-300 px-2 py-1.5 text-left" style={{ width: '9rem' }}>
                Code
              </th>
              <th className="border border-slate-300 px-2 py-1.5 text-left">Account Name</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right" style={{ width: '9rem' }}>
                Amount
              </th>
            </tr>
          </thead>

          <tbody>
            {groups.map((g) => {
              const lines = hideEmpty
                ? g.lines.filter((a) => (collected.get(a.code) ?? 0) !== 0)
                : g.lines;
              if (hideEmpty && lines.length === 0) return null;

              return (
                <Fragment key={g.code}>
                  <tr className="bg-slate-50">
                    <td className="border border-slate-300 px-2 py-1 font-mono font-semibold">{g.code}</td>
                    <td
                      className="border border-slate-300 px-2 py-1 font-semibold uppercase tracking-wide"
                      colSpan={2}
                    >
                      {g.label}
                    </td>
                  </tr>

                  {lines.map((a) => (
                    <tr key={a.code}>
                      <td className="border border-slate-300 px-2 py-1 font-mono text-slate-600">
                        {a.code}
                      </td>
                      <td className="border border-slate-300 px-2 py-1 pl-5">{a.name}</td>
                      <td className="border border-slate-300 px-2 py-1 text-right tabular-nums">
                        {formatAmount(collected.get(a.code) ?? 0, false)}
                      </td>
                    </tr>
                  ))}

                  <tr className="font-semibold">
                    <td className="border border-slate-300 px-2 py-1" />
                    <td className="border border-slate-300 px-2 py-1 text-right">
                      Total &mdash; {g.label}
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-right tabular-nums">
                      {formatAmount(g.total, false)}
                    </td>
                  </tr>
                </Fragment>
              );
            })}

            {orphans.length > 0 && (
              <Fragment>
                <tr className="bg-amber-50">
                  <td
                    className="border border-slate-300 px-2 py-1 font-semibold uppercase tracking-wide"
                    colSpan={3}
                  >
                    Collections posted to codes not in the Chart of Accounts
                  </td>
                </tr>
                {orphans.map(([code, amount]) => (
                  <tr key={code} className="bg-amber-50/50">
                    <td className="border border-slate-300 px-2 py-1 font-mono">{code}</td>
                    <td className="border border-slate-300 px-2 py-1 pl-5 italic text-slate-600">
                      Not an account in the chart &mdash; correct it under Master Data
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-right tabular-nums">
                      {formatAmount(amount, false)}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="border border-slate-300 px-2 py-1" />
                  <td className="border border-slate-300 px-2 py-1 text-right">
                    Total &mdash; unclassified
                  </td>
                  <td className="border border-slate-300 px-2 py-1 text-right tabular-nums">
                    {formatAmount(orphanTotal, false)}
                  </td>
                </tr>
              </Fragment>
            )}
          </tbody>

          <tfoot>
            <tr className="bg-slate-100 text-sm font-bold">
              <td className="border-2 border-slate-400 px-2 py-2" />
              <td className="border-2 border-slate-400 px-2 py-2 text-right uppercase tracking-wide">
                Grand Total
              </td>
              <td className="border-2 border-slate-400 px-2 py-2 text-right tabular-nums">
                {formatAmount(grandTotal, false)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportShell>
  );
}
