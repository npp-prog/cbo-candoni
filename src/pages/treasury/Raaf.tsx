import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Alert, Spinner } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ACCOUNTABLE_FORM_TABS } from './sections';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { engine } from '@/lib/engine';
import { MONTH_NAMES } from '@/lib/reportPeriods';
import { printAs, printFileName } from '@/lib/printTitle';
import {
  RAAF_TITLE,
  RAAF_CONSOLIDATED_TITLE,
  RaafPrintSheet,
  RaafConsolidatedPrintSheet,
  raafFormTotals,
} from './RaafPrintSheet';
import type { Raaf as RaafRecord, RaafLine, RaafSerialRange } from '@/types/accountableForms';

/**
 * Report of Accountability for Accountable Forms.
 *
 * ---------------------------------------------------------------------------
 * PATCH 177: NOTHING TO PREPARE
 * ---------------------------------------------------------------------------
 * The RAAF used to be prepared, one officer and one month at a time, and then
 * certified. Every figure on it was already computed - the beginning balance
 * from the movement ledger, the receipts and issues from the movements, a
 * collecting officer's "issued" from the Official Receipts actually encoded -
 * so the Prepare step only asked somebody to press a button for a report the
 * system could already see.
 *
 * Now the screen asks for the month and shows it: every accountable officer at
 * once (the consolidated RAAF), or one officer. Record a movement under
 * Accountable Forms, or a receipt in Collections, and the RAAF has it.
 *
 * What has not changed is the control: if a collecting officer wrote out a
 * receipt from a serial they were never issued, the line does not foot and the
 * report says so.
 */

const ALL = '__ALL__';

function monthBounds(fiscalYear: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(fiscalYear, month, 0)).getUTCDate();
  return {
    from: `${fiscalYear}-${mm}-01`,
    to: `${fiscalYear}-${mm}-${String(last).padStart(2, '0')}`,
  };
}

function defaultMonth(fiscalYear: number): number {
  const now = new Date();
  return now.getFullYear() === fiscalYear ? now.getMonth() + 1 : 12;
}

export default function Raaf() {
  const { fiscalYear } = useFilters();
  const { profile, user } = useAuth();

  const [month, setMonth] = useState(() => defaultMonth(fiscalYear));
  const [officer, setOfficer] = useState<string>(ALL);
  const [reports, setReports] = useState<RaafRecord[]>([]);
  const [periodLabel, setPeriodLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setMonth(defaultMonth(fiscalYear)), [fiscalYear]);

  const bounds = monthBounds(fiscalYear, month);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    engine
      .viewRaaf({ fiscalYear, periodFrom: bounds.from, periodTo: bounds.to })
      .then((r) => {
        if (!live) return;
        setReports(r.reports ?? []);
        setPeriodLabel(r.periodLabel ?? `${MONTH_NAMES[month - 1]} ${fiscalYear}`);
      })
      .catch((err) => {
        if (!live) return;
        setReports([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [fiscalYear, bounds.from, bounds.to, month]);

  // An officer who has nothing in the month chosen falls back to everybody.
  useEffect(() => {
    if (officer !== ALL && !loading && !reports.some((r) => r.officerId === officer)) {
      setOfficer(ALL);
    }
  }, [officer, reports, loading]);

  const preparedBy = profile?.displayName ?? user?.email ?? '';
  const one = officer === ALL ? null : (reports.find((r) => r.officerId === officer) ?? null);
  const shown = useMemo(
    () => (one ? { ...one, preparedBy: { uid: '', name: preparedBy, at: '' } } : null),
    [one, preparedBy],
  );
  const notFooting = reports.filter((r) => r.hasDiscrepancy);

  const print = () =>
    printAs(
      printFileName(
        shown ? RAAF_TITLE : RAAF_CONSOLIDATED_TITLE,
        `${shown ? shown.officerName : 'all officers'} ${periodLabel}`,
      ),
    );

  return (
    <div>
      <PageHeader
        title="Report of Accountability for Accountable Forms"
        subtitle={`Fiscal year ${fiscalYear} - computed from the movements of accountable forms and the receipts; nothing to prepare`}
        breadcrumbs={[
          { label: 'Treasury', to: '/treasury' },
          { label: 'Accountable Forms', to: '/treasury/accountable-forms' },
          { label: 'RAAF' },
        ]}
        actions={
          <Button variant="primary" onClick={print} disabled={loading || reports.length === 0}>
            Print
          </Button>
        }
      />

      <SectionTabs tabs={ACCOUNTABLE_FORM_TABS} />

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <Field label="Month">
            <Select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m} {fiscalYear}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Accountable officer">
            <Select value={officer} onChange={(e) => setOfficer(e.target.value)}>
              <option value={ALL}>All accountable officers (consolidated RAAF)</option>
              {reports.map((r) => (
                <option key={r.officerId} value={r.officerId}>
                  {r.officerName}
                  {r.hasDiscrepancy ? ' - does not foot' : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {error && (
        <Alert tone="error" title="The RAAF could not be computed" className="mb-4">
          {error}
        </Alert>
      )}

      {notFooting.length > 0 && (
        <Alert tone="warning" title="Reports that do not foot" className="mb-4">
          {notFooting.map((r) => r.officerName).join(', ')}{' '}
          {notFooting.length === 1 ? 'shows' : 'show'} serials issued that the officer was never
          recorded as receiving. Record the missing issue under <strong>Accountable Forms</strong>;
          the RAAF picks it up by itself.
        </Alert>
      )}

      {loading ? (
        <Spinner label="Computing the RAAF from the movements and the receipts" />
      ) : reports.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500">
            No accountable forms were held, received or issued by anyone in {periodLabel}. Record
            the booklets received and issued under Accountable Forms.
          </p>
        </Card>
      ) : shown ? (
        <>
          <RaafPrintSheet raaf={shown} />
          <OfficerReport raaf={shown} />
        </>
      ) : (
        <>
          <RaafConsolidatedPrintSheet
            reports={reports}
            periodLabel={periodLabel}
            preparedBy={preparedBy}
          />
          <Consolidated reports={reports} onOpen={setOfficer} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The report, on screen
// ---------------------------------------------------------------------------

function ranges(list: RaafSerialRange[]): string {
  if (!list || list.length === 0) return '-';
  return list.map((r) => (r.from === r.to ? r.from : `${r.from} - ${r.to}`)).join(', ');
}

function qty(n: number): string {
  return n ? n.toLocaleString('en-PH') : '-';
}

const HEAD =
  'border-b border-slate-200 bg-slate-50 text-2xs uppercase tracking-wide text-slate-500';

function SubHead({ lead }: { lead: number }) {
  return (
    <tr className="border-b border-slate-200 bg-slate-50 text-2xs text-slate-400">
      {Array.from({ length: lead }).map((_, i) => (
        <th key={`l${i}`} />
      ))}
      {['Qty', 'Serial nos.', 'Qty', 'Serial nos.', 'Qty', 'Serial nos.', 'Qty', 'Serial nos.'].map(
        (h, i) => (
          <th
            key={`${h}-${i}`}
            className={`px-2 pb-1.5 ${i % 2 === 0 ? 'border-l border-slate-200 text-right' : 'text-left'}`}
          >
            {h}
          </th>
        ),
      )}
    </tr>
  );
}

function GroupHead() {
  return (
    <>
      {['Beginning balance', 'Receipt', 'Issued', 'Ending balance'].map((h) => (
        <th key={h} className="border-l border-slate-200 px-2 py-1 text-center" colSpan={2}>
          {h}
        </th>
      ))}
    </>
  );
}

function LineCells({ l }: { l: RaafLine }) {
  return (
    <>
      <td className="px-2 py-1.5">
        <p className="font-medium text-navy-900">{l.printedAs}</p>
        {l.withdrawnQty > 0 && (
          <p className="text-2xs text-amber-700">
            {l.withdrawnQty} returned, spoiled or cancelled: {ranges(l.withdrawnRanges)}
          </p>
        )}
      </td>
      {(
        [
          [l.beginningQty, l.beginningRanges],
          [l.receiptQty, l.receiptRanges],
          [l.issuedQty, l.issuedRanges],
          [l.endingQty, l.endingRanges],
        ] as Array<[number, RaafSerialRange[]]>
      ).map(([q, r], i) => [
        <td key={`q${i}`} className="border-l border-slate-100 px-2 py-1.5 text-right tabular-nums">
          {qty(q)}
        </td>,
        <td key={`r${i}`} className="px-2 py-1.5 font-mono text-2xs text-slate-600">
          {ranges(r)}
        </td>,
      ])}
    </>
  );
}

function Consolidated({
  reports,
  onOpen,
}: {
  reports: RaafRecord[];
  onOpen: (officerId: string) => void;
}) {
  const totals = raafFormTotals(reports);
  return (
    <>
      <Card
        title="Consolidated RAAF - all accountable officers"
        subtitle="Click an officer's name for that officer's own report."
        bodyClassName="p-0"
        className="mb-4"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={HEAD}>
                <th className="px-2 py-2 text-left" rowSpan={2}>
                  Accountable officer
                </th>
                <th className="px-2 py-2 text-left" rowSpan={2}>
                  Form
                </th>
                <GroupHead />
              </tr>
              <SubHead lead={0} />
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reports.flatMap((r) =>
                r.lines.map((l, i) => (
                  <tr
                    key={`${r.officerId}-${l.formCode}`}
                    className={l.discrepancy ? 'bg-rose-50/60' : undefined}
                  >
                    {i === 0 && (
                      <td className="px-2 py-1.5 align-top" rowSpan={r.lines.length}>
                        <button
                          type="button"
                          className="text-left font-medium text-navy-900 underline-offset-2 hover:underline"
                          onClick={() => onOpen(r.officerId)}
                        >
                          {r.officerName}
                        </button>
                        {r.hasDiscrepancy && (
                          <p className="text-2xs text-rose-700">Does not foot</p>
                        )}
                      </td>
                    )}
                    <LineCells l={l} />
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Summary by form - the municipality as a whole" bodyClassName="p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className={HEAD}>
              {['Form', 'Beginning', 'Received (net of spoiled)', 'Issued to payors', 'Ending'].map(
                (h, i) => (
                  <th key={h} className={`px-2 py-2 ${i === 0 ? 'text-left' : 'text-right'}`}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {totals.map((t) => (
              <tr key={t.printedAs}>
                <td className="px-2 py-1.5 font-medium text-navy-900">{t.printedAs}</td>
                {[t.beginningQty, t.receivedNetQty, t.issuedQty, t.endingQty].map((n, i) => (
                  <td key={i} className="px-2 py-1.5 text-right tabular-nums">
                    {qty(n)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-slate-100 px-3 py-2 text-2xs text-slate-500">
          The municipality as a whole: forms handed from the office stock to an officer are not
          counted again. Received is the new stock less what was spoiled or cancelled.
        </p>
      </Card>
    </>
  );
}

function OfficerReport({ raaf }: { raaf: RaafRecord }) {
  const findings = raaf.lines.filter(
    (l) => l.discrepancy || (l.gaps?.length ?? 0) > 0 || (l.duplicates?.length ?? 0) > 0,
  );

  return (
    <>
      <Card
        title={raaf.officerName}
        subtitle={`${raaf.basis === 'CUSTODIAN' ? 'Custodian of stock' : 'Collecting officer'} - ${raaf.periodLabel}`}
        bodyClassName="p-0"
        className="mb-4"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={HEAD}>
                <th className="px-2 py-2 text-left" rowSpan={2}>
                  Form
                </th>
                <GroupHead />
              </tr>
              <SubHead lead={0} />
            </thead>
            <tbody className="divide-y divide-slate-100">
              {raaf.lines.map((l) => (
                <tr key={l.formCode} className={l.discrepancy ? 'bg-rose-50/60' : undefined}>
                  <LineCells l={l} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {findings.length > 0 && (
        <div className="space-y-3">
          {findings.map((l) => (
            <div key={l.formCode}>
              {l.discrepancy && (
                <Alert tone="error" title={`${l.printedAs} does not foot`}>
                  {l.discrepancy} Record the issue that put these serials in the officer&rsquo;s
                  hands; the RAAF picks it up by itself.
                </Alert>
              )}
              {(l.gaps?.length ?? 0) > 0 && (
                <Alert
                  tone="warning"
                  title={`${l.printedAs}: serials not accounted for`}
                  className="mt-2"
                >
                  <p>
                    {l.gaps!.length} hole{l.gaps!.length === 1 ? '' : 's'} in the run of receipts
                    issued. A cancelled receipt leaves one, and so does a missing one - the officer
                    has to say which.
                  </p>
                  <ul className="mt-1.5 space-y-0.5 font-mono text-2xs">
                    {l.gaps!.slice(0, 8).map((g) => (
                      <li key={`${g.after}-${g.before}`}>
                        after {g.after}: {g.missing} missing, next is {g.before}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
              {(l.duplicates?.length ?? 0) > 0 && (
                <Alert
                  tone="warning"
                  title={`${l.printedAs}: serials used more than once`}
                  className="mt-2"
                >
                  <span className="font-mono text-2xs">
                    {l.duplicates!.map((d) => `${d.serial} (${d.times}x)`).join(', ')}
                  </span>
                </Alert>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
