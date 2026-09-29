import { useMemo, useState } from 'react';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ReportShell } from '@/components/ReportShell';
import { Field, DateInput, Select } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Layout';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useChecks } from '@/data/queries';
import { formatAmount } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { toNumber } from '@/lib/serials';
import { fundLabel } from '../budget/Obligations';
import { CHECK_TABS, CHECK_CRUMBS } from './sections';

/**
 * Check Release / Claim Sheet.
 *
 * ---------------------------------------------------------------------------
 * A FORM THAT IS ONLY USEFUL ON PAPER
 * ---------------------------------------------------------------------------
 * Everything else CBO prints is a record of something that has happened. This
 * one is the opposite: it is printed empty on purpose, carried to the counter,
 * and filled in by hand as each payee collects their check. The signature is
 * the whole document - it is what the municipality produces when a supplier
 * says they were never paid.
 *
 * So the rows are tall enough to sign in, the columns stop where a person's
 * pen begins, and nothing on it is pre-filled that a claimant should be writing
 * themselves. Once the sheet comes back, the releases are recorded in the check
 * register, where the name and the date become part of the record.
 * ---------------------------------------------------------------------------
 */

type Scope = 'SIGNED' | 'FOR_SIGNATURE' | 'RELEASED' | 'ALL';

const SCOPES: Array<{ value: Scope; label: string; hint: string }> = [
  { value: 'SIGNED', label: 'Signed, ready to release', hint: 'The usual sheet: checks waiting at the counter.' },
  { value: 'FOR_SIGNATURE', label: 'With the signatories', hint: 'Checks not yet signed.' },
  { value: 'RELEASED', label: 'Already released', hint: 'A copy of a sheet already worked through.' },
  { value: 'ALL', label: 'Everything outstanding', hint: 'Prepared, signed and released together.' },
];

export default function ClaimSheet() {
  const { fiscalYear, fundCode } = useFilters();
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('SIGNED');
  const [from, setFrom] = useState(`${fiscalYear}-01-01`);
  const [to, setTo] = useState(`${fiscalYear}-12-31`);

  const { data: checks, loading } = useChecks(bankAccountId ?? undefined);

  const rows = useMemo(() => {
    const wanted =
      scope === 'ALL' ? ['PREPARED', 'FOR_SIGNATURE', 'SIGNED', 'RELEASED'] : [scope];
    return checks
      .filter(
        (c) =>
          c.fiscalYear === fiscalYear &&
          c.fundCode === fundCode &&
          wanted.includes(c.status) &&
          c.checkDate >= from &&
          c.checkDate <= to,
      )
      .sort((a, b) => {
        const na = toNumber(a.checkNo);
        const nb = toNumber(b.checkNo);
        if (na !== null && nb !== null) return na - nb;
        return a.checkNo.localeCompare(b.checkNo);
      });
  }, [checks, fiscalYear, fundCode, scope, from, to]);

  const total = rows.reduce((s, c) => s + c.netAmount, 0);

  if (loading) return <Spinner label="Reading the check register" />;

  return (
    <ReportShell
      meta={{
        title: 'Check Release / Claim Sheet',
        fundLabel: fundLabel(fundCode),
        periodLabel: `Checks dated ${formatShortDate(from)} to ${formatShortDate(to)}`,
      }}
      breadcrumbs={[...CHECK_CRUMBS, { label: 'Claim Sheet' }]}
      tabs={<SectionTabs tabs={CHECK_TABS} />}
      filters={
        <>
          <Field label="Bank account" className="w-64">
            <BankAccountPicker value={bankAccountId} onChange={setBankAccountId} fundCode={fundCode} />
          </Field>
          <Field label="Which checks" className="w-56" hint={SCOPES.find((s) => s.value === scope)?.hint}>
            <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={setFrom} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={setTo} />
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            A claimant who is not the payee must present an authorisation letter and identification,
            and the person who actually collected the check is the name recorded &mdash; not the
            payee&rsquo;s.
          </p>
          <p className="mt-1">
            When the sheet comes back, record each release in{' '}
            <strong>Treasury &rsaquo; Checks</strong> so the register carries the name and the date.
            The signed sheet is the evidence; the register is the record.
          </p>
        </>
      }
    >
      {rows.length === 0 ? (
        <Alert tone="info" title="No checks match">
          Nothing in this bank account and period is at that stage.
        </Alert>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '3rem' }}>
                No.
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left" style={{ width: '8rem' }}>
                Check No.
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">Payee</th>
              <th className="border border-slate-400 px-2 py-1.5 text-right" style={{ width: '8rem' }}>
                Amount
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-center" style={{ width: '15rem' }}>
                Claimed by
                <span className="block text-2xs font-normal text-slate-500">
                  Signature over printed name
                </span>
              </th>
              <th className="border border-slate-400 px-2 py-1.5 text-center" style={{ width: '7rem' }}>
                Date claimed
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={c.id} style={{ height: '13mm' }}>
                <td className="border border-slate-400 px-2 text-right align-top">{i + 1}</td>
                <td className="border border-slate-400 px-2 align-top font-mono">{c.checkNo}</td>
                <td className="border border-slate-400 px-2 align-top">
                  {c.payeeName}
                  <span className="block text-2xs text-slate-500">
                    {c.dvNo} &middot; {c.particulars}
                  </span>
                </td>
                <td className="border border-slate-400 px-2 text-right align-top tabular-nums">
                  {formatAmount(c.netAmount, false)}
                </td>
                {/* Deliberately empty: this is what the claimant writes. */}
                <td className="border border-slate-400" />
                <td className="border border-slate-400" />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold">
              <td className="border border-slate-400 px-2 py-1.5 text-right" colSpan={3}>
                T O T A L &nbsp;&mdash;&nbsp; {rows.length} check{rows.length === 1 ? '' : 's'}
              </td>
              <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                {formatAmount(total, false)}
              </td>
              <td className="border border-slate-400" colSpan={2} />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportShell>
  );
}
