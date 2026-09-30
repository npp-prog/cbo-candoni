import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Spinner, Alert } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useObligations, useTrustPrograms } from '@/data/queries';
import { UTILISED } from '@/pages/budget/rstf';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import type { TrustProgram } from '@/types/budget';
import type { Centavos } from '@/types/common';

/**
 * Fund Utilization Report.
 *
 * What each trust programme was given, what has been committed against it and
 * what has been paid — the report the source agency is owed, and the reason
 * the Trust Fund needed a control of its own rather than being forced through
 * the appropriation chain.
 *
 * ---------------------------------------------------------------------------
 * WHY "RECEIVED" IS MARKED AS STATED
 * ---------------------------------------------------------------------------
 * The programmed, utilised and disbursed columns are all worked: the first is
 * recorded once and amended under a rule, and the other two are maintained
 * inside the transactions that certify a utilisation and approve a voucher, so
 * they cannot drift from the documents that moved them.
 *
 * "Received" is none of those. CBO does not yet tie a Trust Fund collection to
 * a programme, so the figure is the Accountant's statement of what the source
 * has remitted. Printing it beside three worked figures without saying so
 * would be the quiet kind of wrong: four columns that look equally solid, one
 * of which nothing in the system verifies.
 * ---------------------------------------------------------------------------
 */

interface Row extends TrustProgram {
  /** Utilisations certified in the fiscal year on the filter, for the movement. */
  utilisedThisYear: Centavos;
}

export default function FundUtilization() {
  const { fiscalYear } = useFilters();
  const [show, setShow] = useState<'ACTIVE' | 'ALL'>('ACTIVE');

  const programs = useTrustPrograms();
  // Trust Fund commitments for the year, to show the movement beside the
  // life-to-date figures. A programme does not end with the budget year, so
  // both are needed: the source asks about the programme, the auditor about
  // the year.
  const obligations = useObligations(fiscalYear, 'TF');

  const utilisedThisYear = useMemo(() => {
    const out = new Map<string, Centavos>();
    for (const o of obligations.data) {
      /*
       * The server's rule, not a looser one.
       *
       * This used to skip only CANCELLED and DRAFT, which let a SUBMITTED, a
       * BUDGET_REVIEWED and even a RETURNED request count as utilised. None of
       * those has committed anything: `applyTrustDelta` adds to the
       * programme's `utilised` when a request is CERTIFIED and takes it back
       * when one is cancelled, and nowhere else.
       *
       * The consequence was visible on this very screen - "utilised this year"
       * could come out larger than the life-to-date "utilised" beside it,
       * which cannot be true - and a returned request, one the budget office
       * had sent back, was being reported to the source agency as money
       * committed to its programme.
       */
      if (!UTILISED.has(o.status)) continue;
      for (const line of o.lines ?? []) {
        if (!line.trustProgramId) continue;
        out.set(line.trustProgramId, (out.get(line.trustProgramId) ?? 0) + line.amount);
      }
    }
    return out;
  }, [obligations.data]);

  const rows = useMemo<Row[]>(
    () =>
      programs.data
        .filter((p) => show === 'ALL' || p.status === 'ACTIVE')
        .map((p) => ({ ...p, utilisedThisYear: utilisedThisYear.get(p.id) ?? 0 })),
    [programs.data, show, utilisedThisYear],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          programmed: acc.programmed + r.programmed,
          received: acc.received + r.received,
          utilised: acc.utilised + r.utilised,
          utilisedThisYear: acc.utilisedThisYear + r.utilisedThisYear,
          disbursed: acc.disbursed + r.disbursed,
          available: acc.available + r.availableToUtilise,
        }),
        {
          programmed: 0,
          received: 0,
          utilised: 0,
          utilisedThisYear: 0,
          disbursed: 0,
          available: 0,
        },
      ),
    [rows],
  );

  /** Programmes committed beyond what the source has actually sent. */
  const overdrawn = useMemo(
    () => rows.filter((r) => r.utilised > r.received),
    [rows],
  );

  const exportColumns: ExportColumn<Row>[] = [
    { key: 'code', header: 'Programme Code', value: (r) => r.programCode },
    { key: 'name', header: 'Programme', value: (r) => r.programName },
    { key: 'source', header: 'Source', value: (r) => r.sourceAgency },
    { key: 'reference', header: 'Reference', value: (r) => r.reference },
    { key: 'programmed', header: 'Programmed', kind: 'amount', value: (r) => r.programmed },
    { key: 'received', header: 'Received (stated)', kind: 'amount', value: (r) => r.received },
    {
      key: 'utilisedYear',
      header: `Utilised ${fiscalYear}`,
      kind: 'amount',
      value: (r) => r.utilisedThisYear,
    },
    { key: 'utilised', header: 'Utilised to date', kind: 'amount', value: (r) => r.utilised },
    { key: 'disbursed', header: 'Disbursed to date', kind: 'amount', value: (r) => r.disbursed },
    {
      key: 'unpaid',
      header: 'Utilised not yet paid',
      kind: 'amount',
      value: (r) => r.unpaidUtilisations,
    },
    { key: 'available', header: 'Available', kind: 'amount', value: (r) => r.availableToUtilise },
    { key: 'status', header: 'Status', value: (r) => r.status },
  ];

  const loading = programs.loading || obligations.loading;
  const error = programs.error ?? obligations.error;

  return (
    <ReportShell
      meta={{
        title: 'Fund Utilization Report',
        fundLabel: 'Trust Fund',
        periodLabel: `Life of each programme, with ${fiscalYear} movement`,
      }}
      breadcrumbs={[{ label: 'Accounting' }, { label: 'Fund Utilization Report' }]}
      rows={rows}
      exportColumns={exportColumns}
      filters={
        <Field label="Programmes" className="w-56">
          <Select value={show} onChange={(e) => setShow(e.target.value as 'ACTIVE' | 'ALL')}>
            <option value="ACTIVE">Active only</option>
            <option value="ALL">Active and closed</option>
          </Select>
        </Field>
      }
      footnote={
        <>
          The programmed amount is the ceiling each Funding Utilization Request is checked
          against. <strong>Utilised</strong> is what certified utilisations have committed and{' '}
          <strong>disbursed</strong> what approved vouchers have paid; both are maintained inside
          the transactions that wrote those documents. <strong>Received</strong> is stated by the
          Accountant and is not derived from the ledger &mdash; CBO does not yet tie a Trust Fund
          collection to a programme &mdash; so it is the one column here that nothing in the
          system verifies. A programme is not tied to a fiscal year, so the figures are the life
          of the programme; the {fiscalYear} column is the movement within the year.
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : error ? (
        <Alert tone="error" title="The report could not be built">
          {error}
        </Alert>
      ) : (
        <>
          {overdrawn.length > 0 && (
            <Alert
              tone="warning"
              title={`${overdrawn.length} programme${
                overdrawn.length === 1 ? ' has' : 's have'
              } been committed beyond what has been received`}
              className="mb-4 no-print"
            >
              {overdrawn.map((r) => r.programCode).join(', ')}. This is not refused &mdash; a
              programme is commonly spent against before the last tranche arrives, and stopping it
              would stop work the source agency expects done. It is shown because the difference is
              money the municipality has committed and does not yet hold.
            </Alert>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="cbo-th">Programme</th>
                  <th className="cbo-th text-right">Programmed</th>
                  <th className="cbo-th text-right">
                    Received
                    <span className="block text-2xs font-normal normal-case text-slate-400">
                      stated
                    </span>
                  </th>
                  <th className="cbo-th text-right">Utilised {fiscalYear}</th>
                  <th className="cbo-th text-right">Utilised to date</th>
                  <th className="cbo-th text-right">Disbursed</th>
                  <th className="cbo-th text-right">Not yet paid</th>
                  <th className="cbo-th text-right">Available</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.status === 'CLOSED' ? 'text-slate-400' : undefined}>
                    <td className="cbo-td">
                      <span className="font-mono text-2xs text-slate-500">{r.programCode}</span>{' '}
                      <span className="text-sm">{r.programName}</span>
                      <span className="block text-2xs text-slate-500">
                        {r.sourceAgency} &middot; {r.reference}
                        {r.startYear ? ` · from ${r.startYear}` : ''}
                        {r.status === 'CLOSED' ? ' · closed' : ''}
                      </span>
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.programmed, { symbol: false })}
                    </td>
                    <td
                      className={`cbo-td cbo-amount ${
                        r.received < r.utilised ? 'text-amber-800' : ''
                      }`}
                    >
                      {formatPeso(r.received, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.utilisedThisYear, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.utilised, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.disbursed, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.unpaidUtilisations, { symbol: false, dash: true })}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(r.availableToUtilise, { symbol: false, dash: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy-800 font-semibold">
                  <td className="cbo-td border-b-0">TOTAL</td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(totals.programmed, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(totals.received, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(totals.utilisedThisYear, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(totals.utilised, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(totals.disbursed, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(totals.utilised - totals.disbursed, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount border-b-0">
                    {formatPeso(totals.available, { symbol: false })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {rows.length === 0 && (
            <Alert tone="info" title="No trust programme to report on" className="mt-4">
              {show === 'ACTIVE'
                ? 'No active trust programme has been recorded. Record one on Accounting › Trust Fund Programmes.'
                : 'No trust programme has been recorded at all. Until one exists, no Funding Utilization Request in the Trust Fund can be certified.'}
            </Alert>
          )}

          <p className="mt-6 text-2xs text-slate-500">
            Prepared as of {formatShortDate(new Date().toISOString().slice(0, 10))}.
          </p>
        </>
      )}
    </ReportShell>
  );
}
