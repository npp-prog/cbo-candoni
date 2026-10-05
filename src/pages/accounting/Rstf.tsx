import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { TrustTabs } from './trustTabs';
import { PeriodPicker } from '@/components/PeriodPicker';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useCollections, useObligations, useTrustPrograms } from '@/data/queries';
import { periodHeading, periodRange, type ReportPeriod } from '@/lib/reportPeriods';
import { formatPeso } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import { buildRstf, totalRstf, type RstfSheet } from '@/pages/budget/rstf';
import { TRUST_FUND_CODE } from '@/lib/trustPrograms';

/**
 * Registry of Special Trust Fund.
 * GAM for LGUs, Appendix 18.
 *
 * One sheet per trust programme: what the source remitted, and every Funding
 * Utilization Request drawn against it.
 *
 * Under Accounting and not Budget, deliberately. The Trust Fund is the
 * Accountant's book - trust money was never appropriated - which is the same
 * reason the programmes themselves live here.
 */
export default function Rstf() {
  const { fiscalYear } = useFilters();
  const [show, setShow] = useState<'ACTIVE' | 'ALL'>('ACTIVE');
  const [period, setPeriod] = useState<ReportPeriod>(() => ({
    mode: 'MONTHLY',
    index: Number(todayPh().slice(0, 4)) === fiscalYear ? Number(todayPh().slice(5, 7)) : 1,
  }));

  const programs = useTrustPrograms();
  const obligations = useObligations(fiscalYear, 'TF');

  const range = periodRange(period, fiscalYear);

  /*
   * The receipts the register is now struck on. Trust Fund collections for the
   * year, read here rather than summed on the programme, because the register
   * wants the dated lines and not only the total.
   */
  const collections = useCollections(fiscalYear, TRUST_FUND_CODE);

  const registry = useMemo(
    () =>
      buildRstf({
        programs: programs.data,
        obligations: obligations.data,
        collections: collections.data,
        from: range.from,
        to: range.to,
        activeOnly: show === 'ACTIVE',
      }),
    [programs.data, obligations.data, collections.data, range.from, range.to, show],
  );
  const sheets = registry.sheets;

  const totals = useMemo(() => totalRstf(sheets), [sheets]);
  const loading = programs.loading || obligations.loading || collections.loading;

  const exportRows = sheets.flatMap((s) =>
    s.utilisations.map((u) => ({ sheet: s, u })),
  );

  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: 'agency', header: 'Source Agency', value: (r) => r.sheet.program.sourceAgency },
    { key: 'purpose', header: 'Purpose', value: (r) => r.sheet.program.programName },
    { key: 'account', header: 'Account', value: (r) => r.sheet.program.accountCode ?? '' },
    { key: 'date', header: 'Date', value: (r) => r.u.date },
    { key: 'ref', header: 'Ref.', value: (r) => r.u.reference },
    { key: 'particulars', header: 'Particulars', value: (r) => r.u.particulars },
    { key: 'amount', header: 'Utilization', kind: 'amount', value: (r) => r.u.amount },
  ];

  return (
    <ReportShell
      meta={{
        title: 'Registry of Special Trust Fund',
        fundLabel: 'Trust Fund',
        periodLabel: periodHeading(period, fiscalYear),
      }}
      breadcrumbs={[{ label: 'Accounting' }, { label: 'Trust Accounts' }]}
      tabs={<TrustTabs active="registry" />}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={
        <>
          <PeriodPicker value={period} onChange={setPeriod} />
          <Field label="Programmes" className="w-56">
            <Select value={show} onChange={(e) => setShow(e.target.value as 'ACTIVE' | 'ALL')}>
              <option value="ACTIVE">Still running</option>
              <option value="ALL">Every programme</option>
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            <strong>RSTF</strong> - GAM for Local Government Units, Appendix 18. One sheet per trust
            receipt for a specific purpose.
          </p>
          {/*
            Instruction 3, and the reason this screen does not behave like
            every other register in CFMS.
          */}
          <p className="mt-1">
            Instruction 3: <em>the ledger is not closed at the end of the year</em>. The lines
            listed are the requests of the period on the filter; the balances beneath them are the
            programme&apos;s whole life, which is what a trust balance means. The two are labelled
            separately and are not netted against one another.
          </p>
          {/*
            The honest caveat, repeated from the Fund Utilization Report. It is
            the same gap and it must not be quieter here just because this form
            is statutory.
          */}
          <p className="mt-1">
            The Receipt column is the Accountant&apos;s statement of what the source has remitted,
            not a worked figure: CFMS does not yet tie a Trust Fund collection to a programme, so
            there is one amount rather than the dated receipts the manual asks for. Everything on
            the Utilization side is worked from certified Funding Utilization Requests.
          </p>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : sheets.length === 0 ? (
        <Alert tone="info" title="No trust programme to report">
          {show === 'ACTIVE'
            ? 'No trust programme is currently running. Choose "Every programme" to include closed ones.'
            : 'No trust programme has been recorded yet. They are set up under Trust Fund Programmes.'}
        </Alert>
      ) : (
        <>
          {registry.unattributed.length > 0 && (
            <Alert
              tone="warning"
              title={`${registry.unattributed.length} reported receipt${
                registry.unattributed.length === 1 ? '' : 's'
              } name no programme`}
              className="mb-4"
            >
              <p>
                {formatPeso(registry.unattributedTotal)} of Trust Fund money has been receipted and
                reported without saying which programme it was received under, so it is on none of
                the sheets below. Every peso of it belongs on one of them.
              </p>
              <p className="mt-1">
                Open each receipt under Treasury &rarr; Collections and set the programme on its
                line. The registry picks it up as soon as the receipt is saved &mdash; the
                programme total catches up when the report it sits on is posted.
              </p>
              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-600">
                    <th className="cbo-th">Date</th>
                    <th className="cbo-th">O.R. No.</th>
                    <th className="cbo-th">Payor</th>
                    <th className="cbo-th text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {registry.unattributed.map((u) => (
                    <tr key={u.orNumber}>
                      <td className="cbo-td font-mono">{u.orDate}</td>
                      <td className="cbo-td font-mono">{u.orNumber}</td>
                      <td className="cbo-td">{u.payorName}</td>
                      <td className="cbo-td cbo-amount">{formatPeso(u.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Alert>
          )}

          <Cover totals={totals} count={sheets.length} />
          {sheets.map((s) => (
            <Sheet key={s.program.id} sheet={s} />
          ))}
        </>
      )}
    </ReportShell>
  );
}

function Cover({ totals, count }: { totals: ReturnType<typeof totalRstf>; count: number }) {
  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        All {count} {count === 1 ? 'programme' : 'programmes'}
      </p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Programmed" value={totals.programmed} />
        <Figure label="Received (stated)" value={totals.received} />
        <Figure label="Utilised to date" value={totals.utilisedToDate} />
        <Figure label="Balance" value={totals.balance} emphasis />
      </dl>
    </div>
  );
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={`tabular font-mono ${
          emphasis ? 'font-semibold text-navy-900' : 'text-navy-800'
        } ${value < 0 ? 'text-rose-600' : ''}`}
      >
        {formatPeso(value)}
      </dd>
    </div>
  );
}

function Sheet({ sheet }: { sheet: RstfSheet }) {
  const p = sheet.program;

  return (
    <section className="mb-8 break-inside-avoid">
      <header className="mb-2 border-b border-slate-300 pb-1.5">
        <p className="text-sm font-semibold text-navy-900">Purpose: {p.programName}</p>
        <div className="mt-0.5 flex flex-wrap gap-x-6 gap-y-0.5 text-xs text-slate-500">
          <span>Source Agency: {p.sourceAgency}</span>
          {/*
            Blank rather than guessed. The manual heads the sheet with an RCA
            code; CFMS cannot derive which trust liability account a programme
            belongs to, so an unset one says so and points at where to set it.
          */}
          <span>
            Account:{' '}
            {p.accountCode ? (
              <span className="font-mono text-navy-800">{p.accountCode}</span>
            ) : (
              <span className="text-amber-700">not set on the programme</span>
            )}
          </span>
          <span>Reference: {p.reference}</span>
          {p.status === 'CLOSED' && <span className="text-slate-400">Closed</span>}
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-300 text-left text-slate-600">
              <th className="cbo-th" style={{ width: '6rem' }}>
                Date
              </th>
              <th className="cbo-th">Particulars</th>
              <th className="cbo-th" style={{ width: '10rem' }}>
                Ref.
              </th>
              <th className="cbo-th text-right" style={{ width: '10rem' }}>
                Receipt
              </th>
              <th className="cbo-th text-right" style={{ width: '5rem' }}>
                Year
              </th>
              <th className="cbo-th text-right" style={{ width: '10rem' }}>
                Utilization
              </th>
            </tr>
          </thead>
          <tbody>
            {/*
              One line per official receipt, which is what instruction 1 asks
              for. These are receipts reported on a posted RCD: a receipt still
              in the drawer is not in the total beside them, so listing it here
              would give the sheet lines that do not add up to its own total.
            */}
            {sheet.receipts.map((r, i) => (
              <tr key={`${r.reference}-${i}`} className="border-b border-slate-100">
                <td className="cbo-td font-mono">{r.date}</td>
                <td className="cbo-td">{r.particulars || `Received from ${p.sourceAgency}`}</td>
                <td className="cbo-td font-mono">O.R. {r.reference}</td>
                <td className="cbo-td cbo-amount">{formatPeso(r.amount)}</td>
                <td className="cbo-td text-right font-mono">{sheet.receiptYear ?? '-'}</td>
                <td className="cbo-td" />
              </tr>
            ))}

            {sheet.receipts.length === 0 && (
              <tr className="border-b border-slate-100 text-slate-500">
                <td className="cbo-td">-</td>
                <td className="cbo-td" colSpan={5}>
                  No official receipt on a posted report names this programme.
                </td>
              </tr>
            )}

            {sheet.utilisations.map((u, i) => (
              <tr key={`${u.reference}-${i}`} className="border-b border-slate-100">
                <td className="cbo-td font-mono">{u.date}</td>
                <td className="cbo-td">{u.particulars}</td>
                <td className="cbo-td font-mono">{u.reference}</td>
                <td className="cbo-td" />
                <td className="cbo-td" />
                <td className="cbo-td cbo-amount">{formatPeso(u.amount)}</td>
              </tr>
            ))}

            <tr className="border-t border-slate-300 text-slate-600">
              <td className="cbo-td" colSpan={5}>
                Total utilised for the period
              </td>
              <td className="cbo-td cbo-amount">{formatPeso(sheet.utilisedThisPeriod)}</td>
            </tr>
            <tr className="border-t border-slate-300 font-semibold text-navy-900">
              <td className="cbo-td" colSpan={3}>
                Programme to date, all years
              </td>
              <td className="cbo-td cbo-amount">{formatPeso(sheet.receiptTotal)}</td>
              <td className="cbo-td" />
              <td className="cbo-td cbo-amount">{formatPeso(sheet.utilisedToDate)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Programmed" value={p.programmed} />
        <Figure label="Still available to utilise" value={sheet.availableToUtilise} />
        <Figure label="Utilised and not yet paid" value={sheet.unpaidUtilisations} />
        <Figure label="Balance of the trust" value={sheet.balance} emphasis />
      </dl>

      {sheet.receiptDrift !== 0 && (
        <Alert tone="warning" className="mt-2">
          The Accountant states {formatPeso(sheet.receiptStated)} received against this programme,
          and the official receipts reported come to {formatPeso(sheet.receiptTotal)} &mdash;{' '}
          {formatPeso(Math.abs(sheet.receiptDrift))}{' '}
          {sheet.receiptDrift > 0 ? 'more stated than receipted' : 'more receipted than stated'}.
          The register above is struck on the receipts, because that is what came in.{' '}
          {sheet.receiptDrift > 0
            ? 'A tranche still expected reads exactly like this, and so does one that arrived before a receipt carried its programme.'
            : 'This usually means the stated figure was not updated after the last tranche arrived.'}
        </Alert>
      )}
    </section>
  );
}
