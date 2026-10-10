import { useMemo, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Alert, Tabs } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ReportPrintStyle } from '@/components/print/ReportPrintStyle';
import { Seal } from '@/components/ui/Seal';
import { useFilters } from '@/context/FilterContext';
import { useEntity } from '@/data/useEntity';
import { useAdvances } from '@/data/useAdvances';
import {
  useBudgetBalances,
  useDisbursementVouchers,
  useLedgerEntries,
  useTrustPrograms,
} from '@/data/queries';
import { ACCOUNTING_MONITORING_TABS } from '@/layout/sections';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { isCashAccount } from '@/lib/cashFlowLines';
import { buildCashFlows, type CashFlowStatement } from '@/pages/reports/cashFlows';
import {
  FDP_CERTIFICATION,
  FDP_PLACE,
  FORM12_BUCKETS,
  FORM9_LINES,
  buildForm11,
  buildForm12,
  buildForm6,
  buildForm8,
  buildForm9,
  quarterOfDate,
  quarterRange,
  type Form8Amounts,
  type Quarter,
} from '@/lib/fdpp';
import { downloadFdp, type FdpSheetSpec, type XCell } from '@/lib/fdppXlsx';

/**
 * Patch 163 - Accounting > Monitoring > FDPP Reports.
 *
 * The five quarterly forms the municipality posts on the Full Disclosure
 * Policy Portal, prepared from the books (src/lib/fdpp.ts):
 *
 *   Form 6   Trust Fund Utilization      Trust Fund - national / LGU programmes
 *   Form 8   LDRRMF Utilization          General Fund budget and Trust Fund
 *   Form 9   Statement of Cash Flows     General Fund, SEF and Trust Fund
 *   Form 11  SEF Utilization             SEF
 *   Form 12  Unliquidated Cash Advances  General Fund, SEF and Trust Fund
 *
 * Each prints on its own (A4, landscape where the form is wide) and downloads
 * as an Excel sheet in the portal's layout.
 */

type FormId = 'f6' | 'f8' | 'f9' | 'f11' | 'f12';

const FORMS: Array<{ id: FormId; label: string }> = [
  { id: 'f6', label: 'Form 6 - Trust Fund' },
  { id: 'f8', label: 'Form 8 - LDRRMF' },
  { id: 'f9', label: 'Form 9 - Cash Flows' },
  { id: 'f11', label: 'Form 11 - SEF' },
  { id: 'f12', label: 'Form 12 - Cash Advances' },
];

const ORD = ['', '1st', '2nd', '3rd', '4th'];

/** Pesos as the FDP forms print them: negatives in brackets, nil as a dash. */
const fig = (v: number) =>
  v === 0
    ? '-'
    : v < 0
      ? `(${formatPeso(-v, { symbol: false })})`
      : formatPeso(v, { symbol: false });
const px = (v: number) => Math.round(v) / 100;
const mdy = (d: string) =>
  d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}` : '';

const TH = 'border border-slate-500 bg-slate-100 px-1.5 py-1 text-center font-semibold';
const TD = 'border border-slate-500 px-1.5 py-1 align-top';
const NUM = `${TD} text-right tabular-nums whitespace-nowrap`;

interface Ctx {
  year: number;
  quarter: Quarter;
  ytd: boolean;
}

export default function FdppReports() {
  const { fiscalYear } = useFilters();
  const [params, setParams] = useSearchParams();
  const today = todayPh();
  const defaultQ: Quarter =
    Number(today.slice(0, 4)) === fiscalYear ? quarterOfDate(today) : (4 as Quarter);

  const tab = (FORMS.find((f) => f.id === params.get('form'))?.id ?? 'f6') as FormId;
  const quarter = (Number(params.get('q')) || defaultQ) as Quarter;
  const ytd = params.get('basis') !== 'quarter';
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set(k, v);
        return n;
      },
      { replace: true },
    );

  const ctx: Ctx = { year: fiscalYear, quarter, ytd };

  return (
    <div>
      <PageHeader
        title="FDPP Reports"
        subtitle={`Full Disclosure Policy Portal - calendar year ${fiscalYear}, ${ORD[quarter]} quarter`}
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Monitoring' }, { label: 'FDPP Reports' }]}
      />
      <SectionTabs tabs={ACCOUNTING_MONITORING_TABS} />

      <Card className="mb-4 no-print" bodyClassName="py-3">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Quarter">
            <Select value={String(quarter)} onChange={(e) => set('q', e.target.value)}>
              {[1, 2, 3, 4].map((q) => (
                <option key={q} value={q}>
                  {ORD[q]} quarter
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Cash flows and SEF figures"
            hint="Forms 9 and 11: the year to the end of the quarter, or the quarter alone."
          >
            <Select value={ytd ? 'ytd' : 'quarter'} onChange={(e) => set('basis', e.target.value)}>
              <option value="ytd">Year to date</option>
              <option value="quarter">This quarter only</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Tabs
        tabs={FORMS.map((f) => ({ id: f.id, label: f.label }))}
        active={tab}
        onChange={(id) => set('form', id)}
      />
      <div className="mt-4">
        {tab === 'f6' && <Form6 ctx={ctx} />}
        {tab === 'f8' && <Form8View ctx={ctx} />}
        {tab === 'f9' && <Form9View ctx={ctx} />}
        {tab === 'f11' && <Form11View ctx={ctx} />}
        {tab === 'f12' && <Form12View ctx={ctx} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The frame every form shares: heading, signatures, Print and Excel.
// ---------------------------------------------------------------------------

interface Signatory {
  name: string;
  position: string;
}

function useSignatories(withBudgetOfficer = false): Signatory[] {
  const entity = useEntity();
  return [
    ...(withBudgetOfficer
      ? [{ name: entity.budgetOfficer.name, position: 'Municipal Budget Officer' }]
      : []),
    { name: entity.municipalAccountant.name, position: 'Chief Accountant' },
    { name: entity.municipalMayor.name, position: 'Mayor' },
  ];
}

function FdpFrame({
  ctx,
  form,
  legalBasis,
  title,
  orientation,
  signatories,
  note,
  excel,
  loading,
  warnings,
  children,
}: {
  ctx: Ctx;
  form: string;
  legalBasis?: string;
  title: string;
  orientation: 'portrait' | 'landscape';
  signatories: Signatory[];
  note?: string;
  excel: Omit<
    FdpSheetSpec,
    'form' | 'legalBasis' | 'title' | 'year' | 'quarter' | 'signatories' | 'note'
  >;
  loading?: boolean;
  warnings?: ReactNode;
  children: ReactNode;
}) {
  const [printing, setPrinting] = useState(false);
  const print = () => {
    flushSync(() => setPrinting(true));
    const done = () => {
      setPrinting(false);
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };

  const sheet = (
    <div className="cbo-report-sheet text-xs text-navy-900">
      <header className="mb-3 text-center">
        <Seal className="mx-auto mb-1 h-16 w-16" />
        <p className="font-semibold">{form}</p>
        {legalBasis && <p className="text-[8pt]">{legalBasis}</p>}
        <p className="mt-1 text-sm font-bold uppercase">{title}</p>
      </header>
      <table className="mb-3 w-full">
        <tbody>
          <tr>
            <td className="w-36 py-0.5">REGION:</td>
            <td className="py-0.5 font-semibold">{FDP_PLACE.region}</td>
            <td className="w-32 py-0.5">CALENDAR YEAR:</td>
            <td className="w-16 py-0.5 font-semibold">{ctx.year}</td>
          </tr>
          <tr>
            <td className="py-0.5">PROVINCE:</td>
            <td className="py-0.5 font-semibold">{FDP_PLACE.province}</td>
            <td className="py-0.5">QUARTER:</td>
            <td className="py-0.5 font-semibold">{ctx.quarter}</td>
          </tr>
          <tr>
            <td className="py-0.5">CITY/MUNICIPALITY:</td>
            <td className="py-0.5 font-semibold">{FDP_PLACE.municipality}</td>
            <td />
            <td />
          </tr>
        </tbody>
      </table>
      {children}
      <p className="mt-4">{FDP_CERTIFICATION}</p>
      <div
        className="mt-10 grid gap-10"
        style={{ gridTemplateColumns: `repeat(${signatories.length}, minmax(0, 1fr))` }}
      >
        {signatories.map((s) => (
          <div key={s.position} className="text-center">
            <p className="border-t border-navy-900 pt-1 font-semibold uppercase">{s.name}</p>
            <p>{s.position}</p>
          </div>
        ))}
      </div>
      {note && <p className="mt-4 text-[8pt] italic">{note}</p>}
    </div>
  );

  const only = `
@media print {
  body > *:not(.cbo-fdp-print) { display: none !important; }
  body > .cbo-fdp-print { display: block !important; }
}`;

  return (
    <>
      {warnings}
      <Card
        title={title}
        subtitle={`${form} - ${ORD[ctx.quarter]} quarter ${ctx.year}`}
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={loading}
              onClick={() =>
                downloadFdp({
                  ...excel,
                  form,
                  legalBasis,
                  title,
                  year: ctx.year,
                  quarter: ctx.quarter,
                  signatories,
                  note,
                })
              }
            >
              Excel
            </Button>
            <Button size="sm" variant="primary" disabled={loading} onClick={print}>
              Print
            </Button>
          </div>
        }
      >
        {loading ? (
          <p className="py-6 text-sm text-slate-500">Reading the books&hellip;</p>
        ) : (
          <div className="overflow-x-auto">{sheet}</div>
        )}
      </Card>
      {printing &&
        createPortal(
          <div className="cbo-fdp-print hidden">
            <style>{only}</style>
            <ReportPrintStyle orientation={orientation} />
            {sheet}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form 6 - Trust Fund Utilization
// ---------------------------------------------------------------------------

function Form6({ ctx }: { ctx: Ctx }) {
  const programs = useTrustPrograms();
  const signatories = useSignatories(true);
  const rows = useMemo(() => buildForm6(programs.data, ctx.year), [programs.data, ctx.year]);
  const inferred = rows.filter((r) => r.inferred);
  const totalCost = rows.reduce((t, r) => t + r.totalCost, 0);
  const incurred = rows.reduce((t, r) => t + r.costIncurred, 0);

  const head: XCell[][] = [
    [
      'Program or Project',
      'Location',
      'Total Cost',
      'Date Started',
      'Target Completion Date',
      'Project Status',
      '',
      'No. of Extensions, if any',
      'Remarks',
    ],
    ['', '', '', '', '', '% of Completion', 'Total Cost Incurred to Date', '', ''],
  ];
  const body: XCell[][] = rows.map((r) => [
    r.program,
    r.location,
    px(r.totalCost),
    mdy(r.dateStarted) || 'N/a',
    mdy(r.targetCompletion),
    `${r.percentComplete.toFixed(2)}%`,
    px(r.costIncurred),
    r.extensions,
    r.remarks,
  ]);
  body.push(['TOTAL', '', px(totalCost), '', '', '', px(incurred), '', '']);

  return (
    <FdpFrame
      ctx={ctx}
      form="FDP Form 6 - Trust Fund Utilization"
      title="Consolidated Quarterly Report on Government Projects, Programs or Activities"
      orientation="landscape"
      signatories={signatories}
      note="Note: Not included are the Trust Fund which are not funded by other Agencies - BAC, Fiesta/Tourism, SK Training and Trust fund that do not require liquidation such as Philhealth Hospital Charges and Prof fee."
      loading={programs.loading}
      excel={{ head, body, moneyColumns: [2, 6], widths: [48, 18, 16, 12, 14, 12, 18, 12, 30] }}
      warnings={
        inferred.length > 0 && (
          <Alert tone="info" className="mb-3 no-print">
            The source of {inferred.length} programme{inferred.length === 1 ? ' is' : 's are'} not
            set and {inferred.length === 1 ? 'was' : 'were'} read from the name (
            {inferred.map((r) => r.program.split(' - ')[0]).join(', ')}). Set &ldquo;Source of the
            fund&rdquo; on Trust Accounts &gt; Trust Fund Programmes, with the location, dates and
            completion Form 6 prints.
          </Alert>
        )
      }
    >
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: '27%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '14%' }} />
        </colgroup>
        <thead>
          <tr>
            <th className={TH} rowSpan={2}>
              Program or Project
            </th>
            <th className={TH} rowSpan={2}>
              Location
            </th>
            <th className={TH} rowSpan={2}>
              Total Cost
            </th>
            <th className={TH} rowSpan={2}>
              Date Started
            </th>
            <th className={TH} rowSpan={2}>
              Target Completion Date
            </th>
            <th className={TH} colSpan={2}>
              Project Status
            </th>
            <th className={TH} rowSpan={2}>
              No. of Extensions, if any
            </th>
            <th className={TH} rowSpan={2}>
              Remarks
            </th>
          </tr>
          <tr>
            <th className={TH}>% of Completion</th>
            <th className={TH}>Total Cost Incurred to Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className={TD} colSpan={9}>
                No Trust Fund programme funded by a national agency or another LGU.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={TD}>{r.program}</td>
              <td className={TD}>{r.location}</td>
              <td className={NUM}>{fig(r.totalCost)}</td>
              <td className={TD}>{mdy(r.dateStarted) || 'N/a'}</td>
              <td className={TD}>{mdy(r.targetCompletion)}</td>
              <td className={NUM}>{r.percentComplete.toFixed(2)}%</td>
              <td className={NUM}>{fig(r.costIncurred)}</td>
              <td className={`${TD} text-center`}>{r.extensions}</td>
              <td className={TD}>{r.remarks}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className={TD} colSpan={2}>
              TOTAL
            </td>
            <td className={NUM}>{fig(totalCost)}</td>
            <td className={TD} colSpan={3} />
            <td className={NUM}>{fig(incurred)}</td>
            <td className={TD} colSpan={2} />
          </tr>
        </tbody>
      </table>
    </FdpFrame>
  );
}

// ---------------------------------------------------------------------------
// Form 8 - LDRRMF Utilization
// ---------------------------------------------------------------------------

function Form8View({ ctx }: { ctx: Ctx }) {
  const balances = useBudgetBalances(ctx.year, 'GF');
  const programs = useTrustPrograms();
  const signatories = useSignatories().filter((s) => s.position === 'Chief Accountant');
  const f = useMemo(
    () => buildForm8({ balances: balances.data, trustPrograms: programs.data, year: ctx.year }),
    [balances.data, programs.data, ctx.year],
  );

  type Row = {
    label: string;
    level: number;
    bold?: boolean;
    amounts?: Form8Amounts;
    budget?: number;
    remaining?: number;
  };
  const rows: Row[] = [];
  rows.push({ label: 'A. Sources of Funds', level: 0, bold: true });
  for (const s of f.sources) rows.push({ label: s.label, level: s.indent ? 2 : 1, amounts: s });
  rows.push({ label: 'Total Funds Available', level: 0, bold: true, amounts: f.totalAvailable });
  rows.push({ label: 'B. Utilization', level: 0, bold: true });
  for (const sec of f.utilization) {
    rows.push({ label: `${sec.code} ${sec.label}`, level: 1, bold: true });
    for (const g of sec.groups) {
      rows.push({ label: g.label, level: 2 });
      for (const it of g.items)
        rows.push({
          label: it.label,
          level: 3,
          amounts: it,
          budget: it.budget,
          remaining: it.remaining,
        });
    }
    rows.push({ label: `Sub-total ${sec.code}`, level: 1, amounts: sec.total });
  }
  rows.push({ label: 'Total Utilization', level: 0, bold: true, amounts: f.totalUtilization });
  rows.push({ label: 'Unutilized Balance', level: 0, bold: true, amounts: f.unutilized });

  const head: XCell[][] = [
    [
      'Particulars',
      'LDRRMF',
      '',
      'NDRRMF',
      'From Other LGUs',
      'From Other Sources',
      'Total',
      'Program Budget',
      'Remaining Balance',
      'Remarks',
    ],
    ['', 'QRF (30%)', '70% of 5%', '', '', '', '', '', '', ''],
  ];
  const body: XCell[][] = rows.map((r) => [
    `${'   '.repeat(r.level)}${r.label}`,
    r.amounts ? px(r.amounts.qrf) : null,
    r.amounts ? px(r.amounts.seventy) : null,
    r.amounts ? 0 : null,
    r.amounts ? 0 : null,
    r.amounts ? 0 : null,
    r.amounts ? px(r.amounts.qrf + r.amounts.seventy) : null,
    r.budget !== undefined ? px(r.budget) : null,
    r.remaining !== undefined ? px(r.remaining) : null,
    '',
  ]);

  return (
    <FdpFrame
      ctx={ctx}
      form="FDP Form 8 - LDRRMF Utilization"
      title="Local Disaster Risk Reduction and Management Fund Utilization"
      orientation="landscape"
      signatories={signatories}
      loading={balances.loading || programs.loading}
      excel={{
        head,
        body,
        moneyColumns: [1, 2, 3, 4, 5, 6, 7, 8],
        widths: [50, 14, 14, 10, 10, 10, 14, 14, 14, 20],
      }}
      warnings={
        <Alert tone="info" className="mb-3 no-print">
          The General Fund lines of sector LDRRMF (a line naming the Quick Response Fund or QRF goes
          in the 30% column) and the Trust Fund programmes whose source is the unexpended LDRRMF.
          Utilization is what has been obligated; the figures are the budget&rsquo;s current
          balances.
        </Alert>
      }
    >
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: '30%' }} />
          {Array.from({ length: 8 }, (_, i) => (
            <col key={i} style={{ width: '8.75%' }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className={TH} rowSpan={2}>
              Particulars
            </th>
            <th className={TH} colSpan={2}>
              LDRRMF
            </th>
            <th className={TH} rowSpan={2}>
              NDRRMF
            </th>
            <th className={TH} rowSpan={2}>
              From Other LGUs
            </th>
            <th className={TH} rowSpan={2}>
              From Other Sources
            </th>
            <th className={TH} rowSpan={2}>
              Total
            </th>
            <th className={TH} rowSpan={2}>
              Program Budget
            </th>
            <th className={TH} rowSpan={2}>
              Remaining Balance
            </th>
          </tr>
          <tr>
            <th className={TH}>QRF (30%)</th>
            <th className={TH}>70% of 5%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.bold ? 'font-semibold' : ''}>
              <td className={TD} style={{ paddingLeft: `${0.4 + r.level * 0.9}rem` }}>
                {r.label}
              </td>
              <td className={NUM}>{r.amounts ? fig(r.amounts.qrf) : ''}</td>
              <td className={NUM}>{r.amounts ? fig(r.amounts.seventy) : ''}</td>
              <td className={NUM}>{r.amounts ? '-' : ''}</td>
              <td className={NUM}>{r.amounts ? '-' : ''}</td>
              <td className={NUM}>{r.amounts ? '-' : ''}</td>
              <td className={NUM}>{r.amounts ? fig(r.amounts.qrf + r.amounts.seventy) : ''}</td>
              <td className={NUM}>{r.budget !== undefined ? fig(r.budget) : ''}</td>
              <td className={NUM}>{r.remaining !== undefined ? fig(r.remaining) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </FdpFrame>
  );
}

// ---------------------------------------------------------------------------
// Form 9 - Statement of Cash Flows; Form 11 - SEF Utilization
// ---------------------------------------------------------------------------

/** One fund's cash flow statements through the quarter and through the one before. */
function useFundCashFlows(year: number, fundCode: string, quarter: Quarter) {
  const through = quarter * 3;
  const ledger = useLedgerEntries(year, fundCode, { throughPeriod: through });
  const prior = useLedgerEntries(year - 1, fundCode, { throughPeriod: 12 });
  return useMemo(() => {
    const priorClosingCash = prior.data
      .filter((e) => isCashAccount(e.accountCode))
      .reduce((s, e) => s + (e.signedAmount ?? 0), 0);
    const make = (p: number): CashFlowStatement =>
      buildCashFlows({ entries: ledger.data, throughPeriod: p, priorClosingCash, fundCode });
    return {
      current: make(through),
      previous: quarter > 1 ? make(through - 3) : null,
      loading: ledger.loading || prior.loading,
    };
  }, [ledger.data, ledger.loading, prior.data, prior.loading, through, quarter, fundCode]);
}

function Form9View({ ctx }: { ctx: Ctx }) {
  const gf = useFundCashFlows(ctx.year, 'GF', ctx.quarter);
  const sef = useFundCashFlows(ctx.year, 'SEF', ctx.quarter);
  const tf = useFundCashFlows(ctx.year, 'TF', ctx.quarter);
  const signatories = useSignatories();
  const funds = [gf, sef, tf];
  const quarterOnly = !ctx.ytd && ctx.quarter > 1;
  const f = useMemo(
    () =>
      buildForm9(
        funds.map((x) => x.current),
        quarterOnly ? funds.map((x) => x.previous as CashFlowStatement) : undefined,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gf, sef, tf, quarterOnly],
  );
  const loading = funds.some((x) => x.loading);

  type Row = { label: string; level: number; amount?: number; bold?: boolean };
  const rows: Row[] = [];
  const SECTION_TITLE = {
    OPERATING: 'Cash Flows From Operating Activities:',
    INVESTING: 'Cash Flows from Investing Activities:',
    FINANCING: 'Cash Flows from Financing Activities:',
  } as const;
  for (const s of ['OPERATING', 'INVESTING', 'FINANCING'] as const) {
    rows.push({ label: SECTION_TITLE[s], level: 0, bold: true });
    for (const dir of ['IN', 'OUT'] as const) {
      rows.push({ label: dir === 'IN' ? 'Cash Inflows:' : 'Cash Outflows:', level: 1 });
      if (s === 'OPERATING' && dir === 'OUT') rows.push({ label: 'Payments:', level: 2 });
      for (const l of FORM9_LINES.filter((x) => x.section === s && x.dir === dir)) {
        const indent = s === 'OPERATING' && dir === 'OUT' && l.label.startsWith('To ') ? 3 : 2;
        rows.push({ label: l.label, level: indent, amount: f.amounts[l.key] });
      }
      rows.push({
        label: dir === 'IN' ? 'Total Cash Inflow' : 'Total Cash Outflow',
        level: 2,
        amount: dir === 'IN' ? f.totals[s].in : f.totals[s].out,
      });
    }
    rows.push({
      label: `Net Cash from ${s[0] + s.slice(1).toLowerCase()} Activities`,
      level: 1,
      amount: f.totals[s].net,
      bold: true,
    });
  }
  rows.push({ label: 'Net Increase in Cash', level: 0, amount: f.netIncrease, bold: true });
  rows.push({ label: 'Cash at Beginning of the Period', level: 0, amount: f.opening, bold: true });
  rows.push({ label: 'Cash at the End of the Period', level: 0, amount: f.closing, bold: true });

  return (
    <FdpFrame
      ctx={ctx}
      form="FDP Form 9 - Statement of Cash Flows"
      legalBasis="(BLGF Memorandum Circular No. 09 - 2012 dated February 21, 2012, Annex 2)"
      title="Statement of Cash Flows"
      orientation="portrait"
      signatories={signatories}
      loading={loading}
      excel={{
        head: [['Particulars', 'Amount']],
        body: rows.map((r) => [
          `${'   '.repeat(r.level)}${r.label}`,
          r.amount === undefined ? null : px(r.amount),
        ]),
        moneyColumns: [1],
        widths: [60, 20],
      }}
      warnings={
        !loading && !f.tiesOut ? (
          <Alert tone="warning" className="mb-3 no-print">
            A fund&rsquo;s statement does not agree with its cash accounts in the ledger. Open
            Reports &gt; Financial Statements &gt; Cash Flows for that fund to see the entries.
          </Alert>
        ) : null
      }
    >
      <p className="mb-2 text-center">
        General Fund, Special Education Fund and Trust Fund -{' '}
        {quarterOnly
          ? `${ORD[ctx.quarter]} quarter`
          : `January to the end of the ${ORD[ctx.quarter]} quarter`}
      </p>
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: '72%' }} />
          <col style={{ width: '28%' }} />
        </colgroup>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.bold ? 'font-semibold' : ''}>
              <td
                className="px-1.5 py-px leading-tight"
                style={{ paddingLeft: `${0.4 + r.level * 1.1}rem` }}
              >
                {r.label}
              </td>
              <td className="px-1.5 py-px leading-tight text-right tabular-nums">
                {r.amount === undefined ? '' : fig(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </FdpFrame>
  );
}

function Form11View({ ctx }: { ctx: Ctx }) {
  const sef = useFundCashFlows(ctx.year, 'SEF', ctx.quarter);
  const dvs = useDisbursementVouchers(ctx.year, 'SEF');
  const signatories = useSignatories();
  const quarterOnly = !ctx.ytd;
  const range = quarterRange(ctx.year, ctx.quarter);
  const from = quarterOnly ? range.from : `${ctx.year}-01-01`;

  const f = useMemo(() => {
    const inflows = (s: CashFlowStatement | null) =>
      (s?.blocks ?? []).reduce((t, b) => t + b.totalIn, 0);
    const receipts =
      inflows(sef.current) - (quarterOnly && sef.previous ? inflows(sef.previous) : 0);
    const paid = dvs.data.filter(
      (d) =>
        (d.status === 'PAID' || d.status === 'CLOSED') && d.dvDate >= from && d.dvDate <= range.to,
    );
    return buildForm11({ receipts, vouchers: paid.map((d) => ({ lines: d.accountLines ?? [] })) });
  }, [sef, dvs.data, quarterOnly, from, range.to]);

  type Row = { label: string; level: number; amount?: number; bold?: boolean };
  const rows: Row[] = [{ label: 'Receipt from SEF', level: 0, amount: f.receipts, bold: true }];
  rows.push({
    label: 'Less: DISBURSEMENTS (broken down by expense class and by object of expenditures)',
    level: 0,
  });
  for (const c of f.classes) {
    rows.push({ label: c.label, level: 1, bold: true });
    for (const o of c.objects) rows.push({ label: o.name, level: 2, amount: -o.amount });
  }
  rows.push({ label: 'Sub-total', level: 0, amount: -f.subtotal, bold: true });
  rows.push({ label: 'Balance', level: 0, amount: f.balance, bold: true });

  return (
    <FdpFrame
      ctx={ctx}
      form="FDP Form 11 - SEF Utilization"
      legalBasis="(DepEd-DBM-DILG Joint Circular No. 1 s. 2017, SEF Budget Accountability Form No. 1)"
      title="Special Education Fund Utilization"
      orientation="portrait"
      signatories={signatories}
      loading={sef.loading || dvs.loading}
      excel={{
        head: [['Particulars', 'Amount']],
        body: rows.map((r) => [
          `${'   '.repeat(r.level)}${r.label}`,
          r.amount === undefined ? null : px(Math.abs(r.amount)),
        ]),
        moneyColumns: [1],
        widths: [70, 20],
      }}
      warnings={
        <Alert tone="info" className="mb-3 no-print">
          Receipts are the SEF&rsquo;s cash inflows per the ledger; disbursements are the SEF
          vouchers paid from {formatShortDate(from)} to {formatShortDate(range.to)}, by the expense
          and asset accounts they charge.
        </Alert>
      }
    >
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: '75%' }} />
          <col style={{ width: '25%' }} />
        </colgroup>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.bold ? 'font-semibold' : ''}>
              <td
                className="px-1.5 py-px leading-tight"
                style={{ paddingLeft: `${0.4 + r.level * 1.1}rem` }}
              >
                {r.label}
              </td>
              <td className="px-1.5 py-px leading-tight text-right tabular-nums">
                {r.amount === undefined ? '' : fig(Math.abs(r.amount))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </FdpFrame>
  );
}

// ---------------------------------------------------------------------------
// Form 12 - Unliquidated Cash Advances
// ---------------------------------------------------------------------------

function Form12View({ ctx }: { ctx: Ctx }) {
  const gf = useAdvances(ctx.year, 'GF');
  const sef = useAdvances(ctx.year, 'SEF');
  const tf = useAdvances(ctx.year, 'TF');
  const signatories = useSignatories();
  const asOf = quarterRange(ctx.year, ctx.quarter).to;
  const f = useMemo(
    () => buildForm12([...gf.data, ...sef.data, ...tf.data], asOf),
    [gf.data, sef.data, tf.data, asOf],
  );

  const head: XCell[][] = [
    [
      'Name of Debtor (in alphabetical order)',
      'Amount Balance',
      'Date Granted',
      'Purpose',
      'Amount Due',
      '',
      '',
      '',
      '',
      '',
    ],
    ['', '', '', '', 'Current', '', '', 'Past Due', '', ''],
    ['', '', '', '', ...FORM12_BUCKETS],
  ];
  const body: XCell[][] = f.rows.map((r) => [
    r.name,
    px(r.balance),
    mdy(r.dateGranted),
    r.purpose,
    ...FORM12_BUCKETS.map((_, i) => (r.bucket === i ? px(r.balance) : null)),
  ]);
  body.push(['TOTAL', px(f.total), '', '', ...f.buckets.map(px)]);

  return (
    <FdpFrame
      ctx={ctx}
      form="FDP Form 12 - Unliquidated Cash Advances"
      title="Unliquidated Cash Advances"
      orientation="landscape"
      signatories={signatories}
      loading={gf.loading || sef.loading || tf.loading}
      excel={{
        head,
        body,
        moneyColumns: [1, 4, 5, 6, 7, 8, 9],
        widths: [30, 14, 12, 60, 13, 13, 13, 13, 13, 13],
      }}
      warnings={
        <Alert tone="info" className="mb-3 no-print">
          The advances of the General Fund, the SEF and the Trust Fund still outstanding, as the
          Cash Advance Summary shows them, aged from the date granted to {formatShortDate(asOf)}.
        </Alert>
      }
    >
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: '14%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: '29%' }} />
          {FORM12_BUCKETS.map((b) => (
            <col key={b} style={{ width: '7%' }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className={TH} rowSpan={3}>
              Name of Debtor (in alphabetical order)
            </th>
            <th className={TH} rowSpan={3}>
              Amount Balance
            </th>
            <th className={TH} rowSpan={3}>
              Date Granted
            </th>
            <th className={TH} rowSpan={3}>
              Purpose
            </th>
            <th className={TH} colSpan={6}>
              Amount Due
            </th>
          </tr>
          <tr>
            <th className={TH} colSpan={3}>
              Current
            </th>
            <th className={TH} colSpan={3}>
              Past Due
            </th>
          </tr>
          <tr>
            {FORM12_BUCKETS.map((b) => (
              <th key={b} className={TH}>
                {b}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {f.rows.length === 0 && (
            <tr>
              <td className={TD} colSpan={10}>
                No cash advance is outstanding.
              </td>
            </tr>
          )}
          {f.rows.map((r) => (
            <tr key={`${r.fundCode}-${r.id}`}>
              <td className={TD}>{r.name}</td>
              <td className={NUM}>{fig(r.balance)}</td>
              <td className={TD}>{mdy(r.dateGranted)}</td>
              <td className={TD}>{r.purpose}</td>
              {FORM12_BUCKETS.map((b, i) => (
                <td key={b} className={NUM}>
                  {r.bucket === i ? fig(r.balance) : ''}
                </td>
              ))}
            </tr>
          ))}
          <tr className="font-semibold">
            <td className={TD}>TOTAL</td>
            <td className={NUM}>{fig(f.total)}</td>
            <td className={TD} colSpan={2} />
            {f.buckets.map((v, i) => (
              <td key={i} className={NUM}>
                {fig(v)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </FdpFrame>
  );
}
