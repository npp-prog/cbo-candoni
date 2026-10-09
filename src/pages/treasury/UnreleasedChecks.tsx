import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { Field, DateInput, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useBankAccounts, useChecks, useDisbursementVouchers } from '@/data/queries';
import { formatAmount, formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import { buildUnreleasedChecks, totalUnreleased, type SucRow } from './unreleasedChecksReport';
import { PAYMENT_TAB_GROUPS } from './sections';
import { fundLabel } from '@/pages/budget/Obligations';

/* Patch 150: the ruled cells, as on the Claim Sheet. */
const TH = 'border border-slate-400 px-2 py-1.5 text-left font-semibold';
const TD = 'border border-slate-400 px-2 py-1 align-top';

/**
 * Schedule of Unreleased Checks. GAM for LGUs, Appendix 42.
 *
 * One sheet per bank account, because instruction 1 says each sheet is the
 * basis of one journal voucher: at year end the cash behind a check that was
 * never handed over has to be restored and the payable put back.
 */
export default function UnreleasedChecks() {
  const { fiscalYear, fundCode } = useFilters();

  // The report is struck at the year end by default, which is what instruction
  // 1 asks for. Any other date is allowed - a treasurer checking during the
  // year should not have to wait until December to see the list.
  const [asOf, setAsOf] = useState(`${fiscalYear}-12-31`);
  const [bankAccountId, setBankAccountId] = useState<string>('');

  const checks = useChecks();
  const banks = useBankAccounts(fundCode);
  const dvs = useDisbursementVouchers(fiscalYear, fundCode);

  /**
   * The manual heads a column "CAFOA No.". The CAFOA is suspended, so the
   * obligation number off the voucher goes there instead - and where the
   * voucher carried none (a trust liability voucher raises no obligation) the
   * column stays empty rather than being filled with something else.
   */
  const obrByDv = useMemo(() => {
    const out: Record<string, string> = {};
    for (const dv of dvs.data) if (dv.obrNo) out[dv.id] = dv.obrNo;
    return out;
  }, [dvs.data]);

  const sheets = useMemo(
    () =>
      buildUnreleasedChecks({
        checks: checks.data
          .filter((c) => c.fundCode === fundCode)
          // The cancellation stamp carries a full timestamp; the schedule
          // compares plain dates, so only the day is taken.
          .map((c) => ({ ...c, cancelledAt: c.cancelledBy?.at?.slice(0, 10) })),
        asOf,
        obrByDv,
        bankAccountId: bankAccountId || null,
      }),
    [checks.data, fundCode, asOf, obrByDv, bankAccountId],
  );

  const grandTotal = totalUnreleased(sheets);
  const loading = checks.loading || dvs.loading;
  const exportRows = sheets.flatMap((s) => s.rows.map((r) => ({ sheet: s, r })));

  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: 'bank', header: 'Bank', value: (x) => x.sheet.bankName },
    { key: 'account', header: 'Account No.', value: (x) => x.sheet.bankAccountNumber },
    { key: 'date', header: 'Check Date', value: (x) => x.r.checkDate },
    { key: 'serial', header: 'Check Serial No.', value: (x) => x.r.checkNo },
    { key: 'dv', header: 'DV/Payroll No.', value: (x) => x.r.dvNo },
    { key: 'obr', header: 'OBR No.', value: (x) => x.r.obrNo },
    { key: 'payee', header: 'Payee', value: (x) => x.r.payeeName },
    { key: 'nature', header: 'Nature of Payment', value: (x) => x.r.natureOfPayment },
    { key: 'amount', header: 'Amount', kind: 'amount', value: (x) => x.r.amount },
  ];

  return (
    <ReportShell
      /* Patch 150: A4 landscape, fitted to the width, the seal at the left. */
      printLayout="landscape"
      meta={{
        title: 'Schedule of Unreleased Checks',
        fundLabel: fundLabel(fundCode),
        periodLabel: `As at ${formatShortDate(asOf)}`,
        preparedBy: '',
      }}
      breadcrumbs={[{ label: 'Treasury' }, { label: 'Checks', to: '/treasury/checks' }]}
      tabs={<GroupedSectionTabs groups={PAYMENT_TAB_GROUPS} />}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={
        <>
          <Field label="As at" className="w-48">
            <DateInput value={asOf} onChange={setAsOf} />
          </Field>
          <Field label="Bank account" className="w-72">
            <Select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              <option value="">Every account</option>
              {banks.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.bankName} - {b.accountNumber}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
      footnote={
        <>
          <p>
            <strong>SUC</strong> - GAM for Local Government Units. Prepared by the
            Treasurer and submitted to the Accounting Unit, which raises the journal voucher that
            restores the cash and recognises the payable. One sheet per bank account, one voucher
            per sheet.
          </p>
          <p className="mt-1">
            A check counts here when it was drawn on or before the date and was still in the
            Treasury then - including one handed over afterwards, which is marked. The reference
            column holds the OBR number.
          </p>
          {/*
            What was said here in patch 45 was wrong, and the corrected rule is
            worth spelling out because it changes the figure the journal
            voucher restores.
          */}
          <p className="mt-1">
            A check cancelled <em>after</em> the date was a live unreleased check on it, and is
            listed. One already cancelled by the date is not. A stale check that was never released
            is listed too — going stale does not hand it to the payee, and the money is still in the
            bank.
          </p>
          <p className="mt-1">
            A replaced check is left out on purpose: its replacement stands in its place and is on
            this schedule itself if it is unreleased, so counting both would restore the same money
            twice.
          </p>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : sheets.length === 0 ? (
        <Alert tone="info" title="No unreleased checks">
          Every check drawn on or before {formatShortDate(asOf)} had reached its payee by that date.
        </Alert>
      ) : (
        <>
          <p className="mb-4 text-sm">
            <span className="text-slate-600">Cash to be restored by journal voucher: </span>
            <span className="tabular font-mono font-semibold text-navy-900">
              {formatPeso(grandTotal)}
            </span>
            <span className="text-slate-500">
              {' '}
              across {sheets.length} {sheets.length === 1 ? 'bank account' : 'bank accounts'}
            </span>
          </p>

          {sheets.map((s) => (
            <section key={s.bankAccountId} className="mb-8 break-inside-avoid">
              <header className="mb-2 border-b border-slate-300 pb-1.5">
                <p className="text-sm font-semibold text-navy-900">
                  {s.bankName} - {s.bankAccountNumber}
                </p>
              </header>
              {/*
                Patch 150: ruled and shaded like the Claim Sheet, the Bank
                Credits and the RCC - the heading row and the total shaded, on
                paper too.
              */}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100">
                      <th className={TH} style={{ width: '6.5rem' }}>
                        Check Date
                      </th>
                      <th className={TH} style={{ width: '6.5rem' }}>
                        Serial No.
                      </th>
                      <th className={TH} style={{ width: '8rem' }}>
                        DV/Payroll No.
                      </th>
                      <th className={TH} style={{ width: '8rem' }}>
                        OBR No.
                      </th>
                      <th className={TH} style={{ width: '22%' }}>
                        Payee
                      </th>
                      <th className={TH}>Nature of Payment</th>
                      <th className={`${TH} text-right`} style={{ width: '7.5rem' }}>
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.rows.map((r) => (
                      <Row key={`${r.checkNo}-${r.checkDate}`} row={r} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-100 font-bold">
                      <td className={`${TD} text-right`} colSpan={6}>
                        Total for this account
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>
                        {formatAmount(s.total, false)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </ReportShell>
  );
}

function Row({ row }: { row: SucRow }) {
  return (
    <tr style={{ breakInside: 'avoid' }}>
      <td className={`${TD} whitespace-nowrap font-mono`}>{row.checkDate}</td>
      <td className={`${TD} font-mono`}>{row.checkNo}</td>
      <td className={`${TD} font-mono`}>{row.dvNo}</td>
      <td className={`${TD} font-mono`}>{row.obrNo || '-'}</td>
      <td className={TD}>{row.payeeName}</td>
      <td className={TD}>
        {row.natureOfPayment}
        {/*
          Shown, because a reader checking this line against the register today
          would find the check released and wonder why it is here.
        */}
        {row.releasedLater && row.dateReleased && (
          <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-2xs text-slate-600">
            released {formatShortDate(row.dateReleased)}
          </span>
        )}
        {row.cancelledLater && (
          <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-2xs text-amber-800">
            cancelled since
          </span>
        )}
        {row.staleUnreleased && (
          <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-2xs text-amber-800">
            stale, never released
          </span>
        )}
      </td>
      <td className={`${TD} text-right tabular-nums`}>{formatAmount(row.amount, false)}</td>
    </tr>
  );
}
