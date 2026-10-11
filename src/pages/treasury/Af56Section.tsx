import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, AmountInput, DateInput } from '@/components/ui/Field';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { useBarangays, usePayees } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import {
  AMOUNT_KEYS,
  ZERO_AMOUNTS,
  af56Lines,
  af56Total,
  amountsOf,
  findBarangayName,
  findProvinceName,
  totalsOf,
  type Af56Amounts,
  type Af56Detail,
  type Af56Property,
  type Af56Subsidiary,
} from '@/lib/af56';
import type { SystemSettings } from '@/types/system';
import { AF56_MAX_PROPERTIES } from '@/lib/af56Print';

/**
 * Patch 175 - the real property tax on an Accountable Form No. 56 receipt.
 *
 * Shown in place of the Accounts table when the accountable form is AF 56.
 * The officer types, for each property, what was paid: the tax for prior
 * years, the current year and in advance, the penalties, and the discounts -
 * for the basic tax and for the Special Education Tax. CFMS works out the
 * shares (35/40/25 and 50/50) and the receipt's account lines from them
 * (src/lib/af56.ts); the lines are shown below so the officer sees exactly
 * what the RCD will carry.
 */

const COLUMN_LABELS: Record<keyof Af56Amounts, string> = {
  prior: 'Immediate & prior years',
  current: 'Current year',
  advance: 'Advance',
  penaltyPrior: 'Penalty - prior years',
  penaltyCurrent: 'Penalty - current year',
  discountCurrent: 'Discount - current year',
  discountAdvance: 'Discount - advance',
};

const blankProperty = (owner: string): Af56Property => ({
  declaredOwner: owner,
  barangayId: '',
  barangayName: '',
  location: '',
  lotBlock: '',
  tdNo: '',
  assessedLand: null,
  assessedImprovement: null,
  period: '',
  installmentNo: '',
  basic: { ...ZERO_AMOUNTS },
  sef: { ...ZERO_AMOUNTS },
  barangaySubsidiary: null,
});

const sameAmounts = (a: Af56Amounts, b: Af56Amounts) => AMOUNT_KEYS.every((k) => a[k] === b[k]);

/** Up to four properties: the form has six ruled rows, two go to Basic and SEF. */
export { AF56_MAX_PROPERTIES };

export function Af56Section({
  initial,
  payorName,
  orDate,
  onChange,
}: {
  initial?: Af56Detail | null;
  payorName: string;
  orDate: string;
  onChange: (detail: Af56Detail) => void;
}) {
  const barangays = useBarangays();
  const payees = usePayees();
  const settings = useDocument<SystemSettings>(COL.settings, 'general');
  const province = (settings.data?.province || 'Negros Occidental').trim();

  const [calendarYear, setCalendarYear] = useState(initial?.calendarYear ?? orDate.slice(0, 4));
  const [payment, setPayment] = useState<'FULL' | 'INSTALLMENT'>(initial?.payment ?? 'FULL');
  const [previousReceiptNo, setPrevNo] = useState(initial?.previousReceiptNo ?? '');
  const [previousReceiptDate, setPrevDate] = useState(initial?.previousReceiptDate ?? '');
  const [previousReceiptYear, setPrevYear] = useState(initial?.previousReceiptYear ?? '');
  const [properties, setProperties] = useState<Af56Property[]>(
    initial?.properties?.length
      ? initial.properties.map((p) => ({ ...p }))
      : [blankProperty(payorName)],
  );
  /** Per property: is the SEF typed separately? Off means "same as basic". */
  const [sefOwn, setSefOwn] = useState<boolean[]>(() =>
    (initial?.properties ?? []).map((p) => !sameAmounts(amountsOf(p.basic), amountsOf(p.sef))),
  );

  // The declared owner follows the payor until somebody types one.
  useEffect(() => {
    setProperties((ps) =>
      ps.map((p, i) =>
        i === 0 && !p.declaredOwner.trim() ? { ...p, declaredOwner: payorName } : p,
      ),
    );
  }, [payorName]);

  const provinceSub: Af56Subsidiary | null = useMemo(() => {
    const hit = findProvinceName(province, payees.data);
    return hit ? { subsidiaryType: 'PAYEE', subsidiaryId: hit.id, subsidiaryName: hit.name } : null;
  }, [province, payees.data]);

  const detail: Af56Detail = useMemo(
    () => ({
      calendarYear: calendarYear.trim(),
      payment,
      previousReceiptNo: previousReceiptNo.trim() || null,
      previousReceiptDate: previousReceiptDate || null,
      previousReceiptYear: previousReceiptYear.trim() || null,
      provinceSubsidiary: provinceSub,
      properties: properties.map((p, i) => {
        const brgy = barangays.data.find((b) => b.id === p.barangayId);
        const name = brgy ? findBarangayName(brgy.name, payees.data) : null;
        const basic = amountsOf(p.basic);
        return {
          ...p,
          barangayName: brgy?.name ?? p.barangayName,
          barangaySubsidiary: name
            ? { subsidiaryType: 'PAYEE', subsidiaryId: name.id, subsidiaryName: name.name }
            : null,
          basic,
          sef: sefOwn[i] ? amountsOf(p.sef) : { ...basic },
          installmentNo: payment === 'INSTALLMENT' ? (p.installmentNo ?? '') : '',
        };
      }),
    }),
    [
      calendarYear,
      payment,
      previousReceiptNo,
      previousReceiptDate,
      previousReceiptYear,
      provinceSub,
      properties,
      sefOwn,
      barangays.data,
      payees.data,
    ],
  );

  useEffect(() => {
    onChange(detail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  const lines = useMemo(() => af56Lines(detail), [detail]);
  const totals = af56Total(detail);

  const setProp = (i: number, patch: Partial<Af56Property>) =>
    setProperties((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const setAmount = (i: number, tax: 'basic' | 'sef', k: keyof Af56Amounts, v: number) =>
    setProperties((ps) =>
      ps.map((p, j) => (j === i ? { ...p, [tax]: { ...amountsOf(p[tax]), [k]: v } } : p)),
    );

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-md border border-brand-200 bg-brand-50/50 px-3 py-2 text-xs text-slate-700">
        <strong>Accountable Form No. 56 - Real Property Tax.</strong> Type what was paid; CFMS
        shares it: basic tax 35% Province, 25% Barangay (Due to LGUs), 40% Municipality (RPT,
        Deferred RPT for advances, Penalties, Discounts); SEF 50% Province (Due to LGUs), 50%
        Municipality (Due to Other Funds, for the SEF books).
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Calendar Year" required htmlFor="af56Year">
          <TextInput
            id="af56Year"
            value={calendarYear}
            onChange={(e) => setCalendarYear(e.target.value)}
          />
        </Field>
        <Field label="Payment" htmlFor="af56Pay">
          <Select
            id="af56Pay"
            value={payment}
            onChange={(e) => setPayment(e.target.value as 'FULL' | 'INSTALLMENT')}
          >
            <option value="FULL">Full</option>
            <option value="INSTALLMENT">Installment</option>
          </Select>
        </Field>
        <Field label="Previous tax receipt no." htmlFor="af56Prev">
          <TextInput
            id="af56Prev"
            value={previousReceiptNo}
            onChange={(e) => setPrevNo(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Dated" htmlFor="af56PrevDate">
            <DateInput id="af56PrevDate" value={previousReceiptDate} onChange={setPrevDate} />
          </Field>
          <Field label="For the year" htmlFor="af56PrevYear">
            <TextInput
              id="af56PrevYear"
              value={previousReceiptYear}
              onChange={(e) => setPrevYear(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {properties.map((p, i) => {
        const basic = amountsOf(p.basic);
        const sef = sefOwn[i] ? amountsOf(p.sef) : basic;
        const resolved = detail.properties[i];
        return (
          <div key={i} className="rounded-md border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-navy-900">Property {i + 1}</p>
              {properties.length > 1 && (
                <button
                  type="button"
                  className="text-xs text-rose-600 hover:underline"
                  onClick={() => {
                    setProperties((ps) => ps.filter((_, j) => j !== i));
                    setSefOwn((s) => s.filter((_, j) => j !== i));
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field
                label="Name of declared owner"
                required
                className="sm:col-span-2"
                htmlFor={`af56Own${i}`}
              >
                <TextInput
                  id={`af56Own${i}`}
                  value={p.declaredOwner}
                  onChange={(e) => setProp(i, { declaredOwner: e.target.value })}
                />
              </Field>
              <Field label="Barangay (where the property is)" required htmlFor={`af56Brgy${i}`}>
                <Select
                  id={`af56Brgy${i}`}
                  value={p.barangayId}
                  invalid={Boolean(p.barangayId) && !resolved?.barangaySubsidiary}
                  onChange={(e) => {
                    const b = barangays.data.find((x) => x.id === e.target.value);
                    setProp(i, { barangayId: e.target.value, barangayName: b?.name ?? '' });
                  }}
                >
                  <option value="">Which barangay?</option>
                  {barangays.data.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="No./Street" htmlFor={`af56Loc${i}`}>
                <TextInput
                  id={`af56Loc${i}`}
                  value={p.location ?? ''}
                  onChange={(e) => setProp(i, { location: e.target.value })}
                />
              </Field>
              <Field label="Lot No. / Block" htmlFor={`af56Lot${i}`}>
                <TextInput
                  id={`af56Lot${i}`}
                  value={p.lotBlock ?? ''}
                  onChange={(e) => setProp(i, { lotBlock: e.target.value })}
                />
              </Field>
              <Field label="Tax Dec. No." htmlFor={`af56Td${i}`}>
                <TextInput
                  id={`af56Td${i}`}
                  value={p.tdNo ?? ''}
                  onChange={(e) => setProp(i, { tdNo: e.target.value })}
                  className="font-mono"
                />
              </Field>
              <Field label="Assessed value - land" htmlFor={`af56AvL${i}`}>
                <AmountInput
                  id={`af56AvL${i}`}
                  value={p.assessedLand ?? null}
                  onChange={(v) => setProp(i, { assessedLand: v })}
                />
              </Field>
              <Field label="Assessed value - improvement" htmlFor={`af56AvI${i}`}>
                <AmountInput
                  id={`af56AvI${i}`}
                  value={p.assessedImprovement ?? null}
                  onChange={(v) => setProp(i, { assessedImprovement: v })}
                />
              </Field>
              <Field label="Period (e.g. 2012(1-3))" htmlFor={`af56Per${i}`}>
                <TextInput
                  id={`af56Per${i}`}
                  value={p.period ?? ''}
                  onChange={(e) => setProp(i, { period: e.target.value })}
                />
              </Field>
              {payment === 'INSTALLMENT' && (
                <Field label="Installment No." htmlFor={`af56Inst${i}`}>
                  <TextInput
                    id={`af56Inst${i}`}
                    value={p.installmentNo ?? ''}
                    onChange={(e) => setProp(i, { installmentNo: e.target.value })}
                  />
                </Field>
              )}
            </div>
            {p.barangayId && !resolved?.barangaySubsidiary && (
              <p className="mt-1 text-xs text-rose-600">
                Barangay {p.barangayName} has no subsidiary ledger: add it under Master Data &gt;
                Names with Type Barangay (e.g. BARANGAY {p.barangayName.toUpperCase()}).
              </p>
            )}

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="cbo-th w-20" />
                    {AMOUNT_KEYS.map((k) => (
                      <th key={k} className="cbo-th text-right">
                        {COLUMN_LABELS[k]}
                      </th>
                    ))}
                    <th className="cbo-th text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(['basic', 'sef'] as const).map((tax) => {
                    const a = tax === 'basic' ? basic : sef;
                    const editable = tax === 'basic' || sefOwn[i];
                    return (
                      <tr key={tax}>
                        <td className="cbo-td font-medium">
                          {tax === 'basic' ? 'Basic tax' : 'SEF'}
                        </td>
                        {AMOUNT_KEYS.map((k) => (
                          <td key={k} className="cbo-td min-w-[6.5rem]">
                            {editable ? (
                              <AmountInput
                                value={a[k] || null}
                                onChange={(v) => setAmount(i, tax, k, v ?? 0)}
                                className="py-1"
                              />
                            ) : (
                              <span className="block text-right text-slate-500">
                                {a[k] ? formatPeso(a[k], { symbol: false }) : '-'}
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="cbo-td cbo-amount font-semibold">
                          {formatPeso(totalsOf(a).net, { symbol: false })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={Boolean(sefOwn[i])}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setSefOwn((s) => {
                      const next = [...s];
                      next[i] = on;
                      return next;
                    });
                    if (on) setProp(i, { sef: { ...basic } });
                  }}
                />
                The SEF is different from the basic tax (otherwise the SEF is the same figures)
              </label>
            </div>
          </div>
        );
      })}

      <Button
        size="sm"
        disabled={properties.length >= AF56_MAX_PROPERTIES}
        onClick={() => {
          setProperties((ps) => [...ps, blankProperty(payorName)]);
          setSefOwn((s) => [...s, false]);
        }}
      >
        Add property
      </Button>

      {!provinceSub && (
        <Alert tone="warning" title="The province has no subsidiary ledger">
          Add the province under Master Data &gt; Names (for example PROVINCE OF{' '}
          {province.toUpperCase()}, Type Government Agency). Its 35% of the basic tax and 50% of the
          SEF are recorded as Due to LGUs under that name.
        </Alert>
      )}

      <div>
        <p className="cbo-label">How the receipt is recorded</p>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="cbo-th">Account</th>
              <th className="cbo-th">Subsidiary ledger</th>
              <th className="cbo-th">Particulars</th>
              <th className="cbo-th text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="cbo-td">
                  <span className="font-mono">{l.accountCode}</span> {l.accountName}
                </td>
                <td className="cbo-td">{l.subsidiaryName ?? ''}</td>
                <td className="cbo-td text-slate-600">{l.particulars}</td>
                <td className={`cbo-td cbo-amount ${l.amount < 0 ? 'text-rose-700' : ''}`}>
                  {l.amount < 0
                    ? `(${formatPeso(-l.amount, { symbol: false })})`
                    : formatPeso(l.amount, { symbol: false })}
                </td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td className="cbo-td text-slate-500" colSpan={4}>
                  Type the amounts above.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-medium">
              <td className="cbo-td" colSpan={3}>
                Total collected - basic {formatPeso(totals.basic, { symbol: false })}, SEF{' '}
                {formatPeso(totals.sef, { symbol: false })}
              </td>
              <td className="cbo-td cbo-amount font-semibold">
                {formatPeso(totals.total, { symbol: false })}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="mt-1 text-2xs text-slate-500">
          A figure in brackets is a discount, debited to the municipality&rsquo;s discount account.
        </p>
      </div>
    </div>
  );
}
