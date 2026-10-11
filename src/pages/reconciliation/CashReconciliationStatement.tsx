import { createPortal } from 'react-dom';
import { Card, Alert } from '@/components/ui/Layout';
import { Badge } from '@/components/ui/Badge';
import { ReportHeading } from '@/components/ReportShell';
import { ReportPrintStyle } from '@/components/print/ReportPrintStyle';
import { formatLongDate, formatShortDate } from '@/lib/dates';
import type { ReconItem, ReconResult } from '@/lib/cashReconciliation';
import type { Official } from '@/data/useEntity';

/**
 * Patch 178 - the reconciliation statement, on screen and on paper.
 *
 * Laid out as the Accountant writes one by hand: the Treasury's balance at the
 * top, every reconciling item under the heading that says which record holds
 * it, the balance that arrives at, and the General Ledger's own balance under
 * it - with the difference between those two, which must be nil, printed
 * rather than assumed.
 */

export interface StatementSpec {
  title: string;
  subtitle: string;
  fundLabel: string;
  /** Extra heading lines - the bank account, for Cash in Bank. */
  lines?: string[];
  treasuryLabel: string;
  booksLabel: string;
  preparedBy: Official;
  treasurer: Official;
  accountant: Official;
}

const SECTIONS: Array<{ side: ReconItem['side']; title: string; hint: string }> = [
  {
    side: 'TREASURY_ONLY',
    title: 'In the Treasury records, not yet in the Accounting records',
    hint: 'The books have not got these yet, so the Treasury figure is reversed.',
  },
  {
    side: 'BOOKS_ONLY',
    title: 'In the Accounting records, not in the Treasury records',
    hint: 'The Treasury records do not have these, so the figure in the books is carried.',
  },
  {
    side: 'DIFFERENT',
    title: 'In both records, at different amounts',
    hint: 'The difference, books less Treasury.',
  },
];

/** Centavos as the office writes them: 1,234.50 and (1,234.50) for less. */
export function fig(v: number, dash = true): string {
  if (v === 0) return dash ? '-' : '0.00';
  const s = (Math.abs(v) / 100).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `(${s})` : s;
}

function subtotal(r: ReconResult, side: ReconItem['side']): number {
  return side === 'PAIRED' ? 0 : r.subtotals[side];
}

// ---------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------

export function ReconciliationSummary({ result }: { result: ReconResult }) {
  const diff = result.bookBalance - result.treasuryBalance;
  const reconciled = result.unexplained === 0;
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-4">
      <Stat label="Per Treasury records" value={fig(result.treasuryBalance, false)} />
      <Stat label="Per Accounting records" value={fig(result.bookBalance, false)} />
      <Stat label="Difference to explain" value={fig(diff, false)} />
      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
        <p className="text-2xs uppercase tracking-wide text-slate-500">Status</p>
        <p className="mt-1">
          {reconciled ? (
            <Badge tone="emerald">Reconciled</Badge>
          ) : (
            <Badge tone="rose">Unexplained {fig(result.unexplained, false)}</Badge>
          )}
        </p>
        <p className="mt-1 text-2xs text-slate-500">
          {result.items.filter((i) => i.side !== 'PAIRED').length} reconciling item(s);{' '}
          {result.agreed.count} document(s) agree.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-navy-900">{value}</p>
    </div>
  );
}

export function ReconciliationOnScreen({
  result,
  spec,
}: {
  result: ReconResult;
  spec: StatementSpec;
}) {
  const paired = result.items.filter((i) => i.side === 'PAIRED');
  return (
    <>
      <Card title="Reconciliation statement" bodyClassName="p-0 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left text-2xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 pl-6">Date</th>
              <th className="px-3 py-2">Reference</th>
              <th className="px-3 py-2">Particulars and reason</th>
              <th className="px-3 py-2 text-right">Add / (Less)</th>
            </tr>
          </thead>
          <tbody>
            <BalanceRow label={spec.treasuryLabel} value={result.treasuryBalance} strong />
            {SECTIONS.map((sec) => {
              const list = result.items.filter((i) => i.side === sec.side);
              return (
                <SectionRows key={sec.side} title={sec.title} hint={sec.hint} list={list}>
                  {list.length > 0 && (
                    <tr className="border-b border-slate-200 bg-slate-50/60">
                      <td className="px-3 py-1.5 text-right italic text-slate-600" colSpan={3}>
                        Total
                      </td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                        {fig(subtotal(result, sec.side), false)}
                      </td>
                    </tr>
                  )}
                </SectionRows>
              );
            })}
            <BalanceRow
              label="Balance per Accounting records, as reconciled"
              value={result.bridged}
              strong
            />
            <BalanceRow label={spec.booksLabel} value={result.bookBalance} />
            <tr className={result.unexplained === 0 ? 'bg-emerald-50' : 'bg-rose-50'}>
              <td className="px-3 py-2 font-semibold" colSpan={3}>
                Unexplained difference
              </td>
              <td className="px-3 py-2 text-right font-bold tabular-nums">
                {fig(result.unexplained, false)}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {paired.length > 0 && (
        <Card
          title="Recorded in both, under different references"
          subtitle="Same amount, same direction, within 45 days. No effect on the statement - confirm each is one event."
          className="mt-4"
          bodyClassName="p-0"
        >
          <ItemTable list={paired} showAmounts />
        </Card>
      )}

      {result.unexplained !== 0 && (
        <Alert tone="error" title="Part of the difference is not explained" className="mt-4">
          The General Ledger holds a line no document on either side accounts for. Open the General
          Ledger on this account for the period and look for an entry with no source.
        </Alert>
      )}
    </>
  );
}

function BalanceRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <tr className={`border-b border-slate-200 ${strong ? 'bg-slate-100 font-semibold' : ''}`}>
      <td className="px-3 py-2" colSpan={3}>
        {label}
      </td>
      <td className="w-36 px-3 py-2 text-right tabular-nums">{fig(value, false)}</td>
    </tr>
  );
}

function SectionRows({
  title,
  hint,
  list,
  children,
}: {
  title: string;
  hint: string;
  list: ReconItem[];
  children?: React.ReactNode;
}) {
  return (
    <>
      <tr className="border-b border-slate-100">
        <td className="px-3 pb-1 pt-3" colSpan={4}>
          <p className="font-semibold text-navy-900">{title}</p>
          <p className="text-2xs text-slate-500">{list.length === 0 ? 'None.' : hint}</p>
        </td>
      </tr>
      {list.map((i) => (
        <tr key={i.key} className="border-b border-slate-100 align-top">
          <td className="w-24 whitespace-nowrap px-3 py-1.5 pl-6">{formatShortDate(i.date)}</td>
          <td className="w-40 px-3 py-1.5 font-mono text-2xs">{i.reference}</td>
          <td className="px-3 py-1.5">
            <p>{i.description}</p>
            <p className="text-2xs text-slate-500">{i.cause}</p>
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums">{fig(i.effect, false)}</td>
        </tr>
      ))}
      {children}
    </>
  );
}

function ItemTable({ list, showAmounts }: { list: ReconItem[]; showAmounts?: boolean }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {list.map((i) => (
          <tr key={i.key} className="border-b border-slate-100 align-top">
            <td className="w-24 whitespace-nowrap px-3 py-1.5">{formatShortDate(i.date)}</td>
            <td className="w-56 px-3 py-1.5 font-mono text-2xs">{i.reference}</td>
            <td className="px-3 py-1.5">
              <p>{i.description}</p>
              <p className="text-2xs text-slate-500">{i.cause}</p>
            </td>
            {showAmounts && (
              <td className="w-32 px-3 py-1.5 text-right tabular-nums">
                {fig(Math.abs(i.treasury), false)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// On paper - A4 portrait, the seal at the left of the heading, black.
// ---------------------------------------------------------------------------

const TD = 'border border-black px-1.5 py-1 align-top';
const NUM = `${TD} text-right tabular-nums whitespace-nowrap`;

export function ReconciliationPrintSheet({
  result,
  spec,
}: {
  result: ReconResult;
  spec: StatementSpec;
}) {
  const only = `
@media print {
  body > *:not(.cbo-recon-print) { display: none !important; }
  body > .cbo-recon-print { display: block !important; }
}`;
  const paired = result.items.filter((i) => i.side === 'PAIRED');

  const sheet = (
    <div className="cbo-recon-print hidden">
      <style>{only}</style>
      <ReportPrintStyle orientation="portrait" />
      <div className="cbo-report-sheet text-[8.5pt] text-black">
        <ReportHeading
          seal="left"
          meta={{
            title: spec.title,
            fundLabel: [spec.subtitle, spec.fundLabel].filter(Boolean).join(' - '),
            periodLabel: `As of ${formatLongDate(result.asOf)}`,
          }}
        />
        {spec.lines?.map((l) => (
          <p key={l} className="mb-1 text-center">
            {l}
          </p>
        ))}

        <table className="mt-2 w-full border-collapse">
          <colgroup>
            <col style={{ width: '13%' }} />
            <col style={{ width: '20%' }} />
            <col />
            <col style={{ width: '17%' }} />
          </colgroup>
          <thead>
            <tr>
              {['Date', 'Reference', 'Particulars and reason', 'Add / (Less)'].map((h) => (
                <th key={h} className={`${TD} text-center font-semibold`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${TD} font-bold`} colSpan={3}>
                {spec.treasuryLabel}
              </td>
              <td className={`${NUM} font-bold`}>{fig(result.treasuryBalance, false)}</td>
            </tr>
            {SECTIONS.map((sec) => {
              const list = result.items.filter((i) => i.side === sec.side);
              return [
                <tr key={`${sec.side}-h`}>
                  <td className={`${TD} font-semibold`} colSpan={4}>
                    {sec.title}
                    {list.length === 0 ? ' - none' : ''}
                  </td>
                </tr>,
                ...list.map((i) => (
                  <tr key={i.key}>
                    <td className={TD}>{formatShortDate(i.date)}</td>
                    <td className={TD}>{i.reference}</td>
                    <td className={TD}>
                      {i.description}
                      <div className="text-[7pt]">{i.cause}</div>
                    </td>
                    <td className={NUM}>{fig(i.effect, false)}</td>
                  </tr>
                )),
                ...(list.length
                  ? [
                      <tr key={`${sec.side}-t`}>
                        <td className={`${TD} text-right italic`} colSpan={3}>
                          Total
                        </td>
                        <td className={`${NUM} font-semibold`}>
                          {fig(subtotal(result, sec.side), false)}
                        </td>
                      </tr>,
                    ]
                  : []),
              ];
            })}
            <tr>
              <td className={`${TD} font-bold`} colSpan={3}>
                Balance per Accounting records, as reconciled
              </td>
              <td className={`${NUM} font-bold`}>{fig(result.bridged, false)}</td>
            </tr>
            <tr>
              <td className={TD} colSpan={3}>
                {spec.booksLabel}
              </td>
              <td className={NUM}>{fig(result.bookBalance, false)}</td>
            </tr>
            <tr>
              <td className={`${TD} font-bold`} colSpan={3}>
                Unexplained difference
              </td>
              <td className={`${NUM} font-bold`}>{fig(result.unexplained, false)}</td>
            </tr>
          </tbody>
        </table>

        {paired.length > 0 && (
          <>
            <p className="mb-1 mt-3 font-semibold">
              Recorded in both, under different references (no effect on the statement)
            </p>
            <table className="w-full border-collapse">
              <tbody>
                {paired.map((i) => (
                  <tr key={i.key}>
                    <td className={TD} style={{ width: '13%' }}>
                      {formatShortDate(i.date)}
                    </td>
                    <td className={TD}>
                      {i.reference}
                      <div className="text-[7pt]">{i.cause}</div>
                    </td>
                    <td className={NUM} style={{ width: '17%' }}>
                      {fig(Math.abs(i.treasury), false)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <p className="mt-3 text-[7.5pt]">
          {result.agreed.count} document(s) agree on both records and are not listed.
        </p>

        <div className="mt-8 grid grid-cols-3 gap-8">
          {[
            { label: 'Prepared by:', o: spec.preparedBy },
            { label: 'Certified correct (Treasury records):', o: spec.treasurer },
            { label: 'Certified correct (Accounting records):', o: spec.accountant },
          ].map(({ label, o }) => (
            <div key={label}>
              <p className="text-[7.5pt]">{label}</p>
              <p className="mt-8 border-t border-black pt-1 text-center font-semibold uppercase">
                {o.name}
              </p>
              <p className="text-center text-[7.5pt]">{o.position}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}
