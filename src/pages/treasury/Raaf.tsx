import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { Button } from '@/components/ui/Button';
import { Field, DateInput } from '@/components/ui/Field';
import { EmployeePicker } from '@/components/pickers';
import { where, orderBy } from 'firebase/firestore';
import { useFilters } from '@/context/FilterContext';
import { useCollection } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { formatLongDate, formatShortDate } from '@/lib/dates';
import type { AccountableForm } from '@/types/treasury';

/**
 * Report of Accountability for Accountable Forms (RAAF).
 *
 * The one report in Treasury that raises no journal entry, and deliberately so.
 * An official receipt booklet is not money. Until a receipt is issued, the
 * municipality has collected nothing; what the RAAF accounts for is custody -
 * how many forms an officer began with, received, issued, cancelled, and still
 * holds, with the serial numbers to prove it.
 *
 * That is why this sits beside the other treasury reports in the menu but not
 * in the journalizing queue. Putting it through the same certify-and-journalize
 * path would have required inventing an accounting entry for a stewardship
 * report, and an invented entry in a financial system is worse than no entry.
 *
 * The figures are not typed here. They are the accountable-form records
 * themselves, grouped by officer and form type, so the report cannot disagree
 * with the register it is drawn from.
 */
export default function Raaf() {
  const { fiscalYear } = useFilters();
  const { data, loading, error } = useCollection<AccountableForm>(
    COL.accountableForms,
    [where('fiscalYear', '==', fiscalYear), orderBy('formType')],
    ['accountableForms', fiscalYear],
  );

  const [asOf, setAsOf] = useState<string>('');
  const [officerId, setOfficerId] = useState<string | null>(null);

  /**
   * Grouped by accountable officer, then by form type. An officer signs one
   * report for everything in their custody, and the report is meaningless
   * across officers - accountability is personal.
   */
  const groups = useMemo(() => {
    const filtered = data.filter((form: AccountableForm) => {
      if (officerId && form.accountableOfficerId !== officerId) return false;
      if (asOf && form.asOfDate > asOf) return false;
      return true;
    });

    const byOfficer = new Map<string, { officerName: string; forms: AccountableForm[] }>();
    for (const form of filtered) {
      const key = form.accountableOfficerId;
      const existing = byOfficer.get(key);
      if (existing) existing.forms.push(form);
      else byOfficer.set(key, { officerName: form.accountableOfficerName, forms: [form] });
    }

    return [...byOfficer.entries()]
      .map(([id, group]) => ({
        officerId: id,
        officerName: group.officerName,
        forms: [...group.forms].sort(
          (a, b) => a.formCode.localeCompare(b.formCode) || a.serialFrom.localeCompare(b.serialFrom),
        ),
        totals: group.forms.reduce(
          (acc, f) => ({
            beginningBalance: acc.beginningBalance + f.beginningBalance,
            received: acc.received + f.received,
            issued: acc.issued + f.issued,
            cancelled: acc.cancelled + f.cancelled,
            endingBalance: acc.endingBalance + f.endingBalance,
          }),
          { beginningBalance: 0, received: 0, issued: 0, cancelled: 0, endingBalance: 0 },
        ),
      }))
      .sort((a, b) => a.officerName.localeCompare(b.officerName));
  }, [data, officerId, asOf]);

  /**
   * A form whose stated ending balance does not equal what came in less what
   * went out. Shown rather than silently corrected: the arithmetic is the whole
   * point of the report, and a discrepancy is something the officer has to
   * explain, not something the screen should tidy away.
   */
  const discrepancies = useMemo(
    () =>
      data.filter(
        (f: AccountableForm) =>
          f.endingBalance !== f.beginningBalance + f.received - f.issued - f.cancelled,
      ),
    [data],
  );

  return (
    <>
      <PageHeader
        title="Report of Accountability for Accountable Forms"
        breadcrumbs={[{ label: 'Treasury' }, { label: 'RAAF' }]}
        subtitle="Custody of accountable forms by officer: what was held, received, issued, cancelled and remains. This report accounts for forms, not money, so it raises no journal entry."
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            Print
          </Button>
        }
      />

      <SectionTabs
        tabs={[
          { label: 'Accountable Forms', to: '/treasury/accountable-forms' },
          { label: 'Report of Accountability (RAAF)', to: '/treasury/accountable-forms/raaf' },
        ]}
      />

      <Card className="no-print">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="As at" hint="Leave blank to include every record for the fiscal year.">
            <DateInput value={asOf} onChange={setAsOf} />
          </Field>
          <Field label="Accountable officer" hint="Leave blank for all officers.">
            <EmployeePicker value={officerId} onChange={(id) => setOfficerId(id)} />
          </Field>
        </div>
      </Card>

      {discrepancies.length > 0 && (
        <Alert tone="warning" className="mt-4 no-print">
          {discrepancies.length} record{discrepancies.length === 1 ? ' does' : 's do'} not foot:
          the ending balance does not equal beginning plus received less issued and cancelled. Those
          rows are marked below and must be explained before the report is signed.
        </Alert>
      )}

      <Card className="mt-4">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
        ) : error ? (
          <Alert tone="error">{error}</Alert>
        ) : groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            No accountable forms recorded for fiscal year {fiscalYear}.
          </p>
        ) : (
          <div id="raaf-print">
            <div className="mb-5 text-center">
              <h2 className="text-base font-semibold uppercase text-navy-900">
                Report of Accountability for Accountable Forms
              </h2>
              <p className="text-sm text-slate-600">
                Municipal Government of Candoni, Province of Negros Occidental
              </p>
              <p className="text-sm text-slate-600">
                As at {asOf ? formatLongDate(asOf) : `fiscal year ${fiscalYear}`}
              </p>
            </div>

            {groups.map((group) => (
              <section key={group.officerId} className="mb-8">
                <h3 className="mb-2 text-sm font-semibold text-navy-900">
                  Accountable officer: {group.officerName}
                </h3>

                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-y border-slate-300 bg-slate-50 text-xs uppercase text-slate-600">
                      <th className="px-2 py-2 text-left">Form</th>
                      <th className="px-2 py-2 text-left">Serial range</th>
                      <th className="px-2 py-2 text-right">Beginning</th>
                      <th className="px-2 py-2 text-right">Received</th>
                      <th className="px-2 py-2 text-right">Issued</th>
                      <th className="px-2 py-2 text-right">Cancelled</th>
                      <th className="px-2 py-2 text-right">Ending</th>
                      <th className="px-2 py-2 text-left">As at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.forms.map((form) => {
                      const expected =
                        form.beginningBalance + form.received - form.issued - form.cancelled;
                      const foots = expected === form.endingBalance;
                      return (
                        <tr
                          key={form.id}
                          className={`border-b border-slate-100 ${foots ? '' : 'bg-amber-50'}`}
                        >
                          <td className="px-2 py-1.5">
                            {form.formType}
                            <span className="ml-1 font-mono text-xs text-slate-500">
                              {form.formCode}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 font-mono text-xs">
                            {form.serialFrom} - {form.serialTo}
                          </td>
                          <td className="px-2 py-1.5 text-right">{form.beginningBalance}</td>
                          <td className="px-2 py-1.5 text-right">{form.received}</td>
                          <td className="px-2 py-1.5 text-right">{form.issued}</td>
                          <td className="px-2 py-1.5 text-right">{form.cancelled}</td>
                          <td className="px-2 py-1.5 text-right font-semibold">
                            {form.endingBalance}
                            {!foots && (
                              <span className="ml-1 text-xs font-normal text-amber-700">
                                (should be {expected})
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-xs text-slate-500">
                            {formatShortDate(form.asOfDate)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-400 font-semibold">
                      <td className="px-2 py-2" colSpan={2}>
                        Total
                      </td>
                      <td className="px-2 py-2 text-right">{group.totals.beginningBalance}</td>
                      <td className="px-2 py-2 text-right">{group.totals.received}</td>
                      <td className="px-2 py-2 text-right">{group.totals.issued}</td>
                      <td className="px-2 py-2 text-right">{group.totals.cancelled}</td>
                      <td className="px-2 py-2 text-right">{group.totals.endingBalance}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>

                <div className="mt-6 grid grid-cols-2 gap-8 text-sm">
                  <div>
                    <p className="mb-8 text-xs text-slate-600">
                      I certify that the above is a true statement of the accountable forms in my
                      custody.
                    </p>
                    <div className="border-t border-slate-400 pt-1 text-center">
                      <div className="font-semibold uppercase">{group.officerName}</div>
                      <div className="text-xs text-slate-500">Accountable Officer</div>
                    </div>
                  </div>
                  <div>
                    <p className="mb-8 text-xs text-slate-600">Verified as to serial numbers.</p>
                    <div className="border-t border-slate-400 pt-1 text-center">
                      <div className="text-xs text-slate-500">Municipal Treasurer</div>
                    </div>
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
