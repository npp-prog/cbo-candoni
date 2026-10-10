import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, Alert, Spinner, DetailField } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { BackButton, ReturnLink, keepReturn } from '@/components/ui/BackButton';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, DateInput, AmountInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useDisbursementVouchers, usePayrolls } from '@/data/queries';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso, formatAmount } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { ADVANCES_FOR_PAYROLL, DUE_TO_OFFICERS_AND_EMPLOYEES } from '@/lib/chartOfAccounts';
import {
  openPayrollAdvances,
  payrollParticulars,
  payrollProformaEntry,
  type OpenAdvance,
} from '@/lib/payrollAdvances';
import type { Payroll as PayrollRecord } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { PAYROLL_TABS } from './sections';

/**
 * Patch 155. A payroll on a page of its own - new and existing - instead of a
 * pop-up window.
 *
 * A new payroll starts from the ADVANCE FOR PAYROLL it liquidates: the open
 * advances are listed (approved or paid vouchers debiting Advances for
 * Payroll, less the payrolls already recorded against them), and choosing one
 * copies its details:
 *
 *   - the voucher (DV No.), the disbursing officer (the subsidiary the advance
 *     was booked to, else the voucher's payee) and the office;
 *   - the particulars: "Liquidation of payroll - <the voucher's particulars>";
 *   - the net paid, up to what is still outstanding on the advance.
 *
 * No payroll type, no office, no gross and no deductions: those belong to the
 * payroll's own voucher in Accounting. The liquidation needs the net paid.
 *
 * Its pro-forma entry - the one the RCDisb journalizes - names the disbursing
 * officer on both lines:
 *
 *     Dr Due to Officers and Employees - <officer>
 *       Cr Advances for Payroll - <officer>
 */
export default function PayrollDetail() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const { search } = useLocation();
  const toast = useToast();
  const { fiscalYear, fundCode } = useFilters();
  const { user, profile, can } = useAuth();

  const { data: existing, loading } = useDocument<PayrollRecord>(isNew ? null : COL.payrolls, id);
  const dvs = useDisbursementVouchers(fiscalYear, fundCode);
  const payrolls = usePayrolls(fiscalYear, fundCode);

  const [advance, setAdvance] = useState<OpenAdvance | null>(null);
  const [payrollNo, setPayrollNo] = useState('');
  const [periodFrom, setPeriodFrom] = useState(todayPh().slice(0, 8) + '01');
  const [periodTo, setPeriodTo] = useState(todayPh());
  const [employeeCount, setEmployeeCount] = useState('');
  const [particulars, setParticulars] = useState('');
  const [net, setNet] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const open = useMemo(
    () =>
      openPayrollAdvances(
        dvs.data as never,
        payrolls.data as never,
        ADVANCES_FOR_PAYROLL.code,
        isNew ? null : id,
      ),
    [dvs.data, payrolls.data, isNew, id],
  );

  // An existing payroll: its own figures, and the advance it was drawn on.
  useEffect(() => {
    if (isNew || !existing || loaded) return;
    setPayrollNo(existing.payrollNo);
    setPeriodFrom(existing.periodFrom);
    setPeriodTo(existing.periodTo);
    setEmployeeCount(existing.employeeCount ? String(existing.employeeCount) : '');
    setParticulars(existing.particulars ?? '');
    setNet(existing.totalNet);
    setLoaded(true);
  }, [isNew, existing, loaded]);
  useEffect(() => {
    if (isNew || !existing?.dvId || advance) return;
    const a = open.find((x) => x.dvId === existing.dvId);
    if (a) setAdvance(a);
  }, [isNew, existing, open, advance]);

  const editable =
    can('treasury', 'edit') &&
    (isNew || (existing?.status === 'DRAFT' && !existing.treasuryReportId));

  const officer =
    advance?.officer ??
    (existing?.disbursingOfficer
      ? {
          type: existing.disbursingOfficer.type,
          id: existing.disbursingOfficer.id,
          name: existing.disbursingOfficer.name,
        }
      : null);
  const outstanding = advance?.outstanding ?? null;
  const entry = payrollProformaEntry({
    net: net ?? 0,
    officer,
    particulars: particulars.trim() || payrollParticulars(advance?.particulars),
    dueToOfficers: DUE_TO_OFFICERS_AND_EMPLOYEES,
    advancesForPayroll: ADVANCES_FOR_PAYROLL,
  });

  const choose = (a: OpenAdvance) => {
    setAdvance(a);
    setParticulars(payrollParticulars(a.particulars));
    setNet(a.outstanding);
  };

  const save = async () => {
    if (!user) return;
    if (isNew && !advance) {
      toast.error('Choose the advance', 'Pick the advance for payroll this payroll liquidates.');
      return;
    }
    if (!payrollNo.trim() || !net || net <= 0) {
      toast.error('Incomplete', 'The payroll number and the net amount paid are required.');
      return;
    }
    if (periodTo < periodFrom) {
      toast.error('Period reversed', 'The period ends before it begins.');
      return;
    }
    if (outstanding !== null && net > outstanding) {
      toast.error(
        'More than the advance',
        `The net paid, ${formatPeso(net)}, is more than is outstanding on DV ${advance?.dvNo}: ${formatPeso(outstanding)}. A payroll cannot liquidate more than was advanced.`,
      );
      return;
    }

    const actor = actorStamp({
      uid: user.uid,
      name: profile?.displayName ?? user.email ?? user.uid,
      position: profile?.position,
    });
    const figures = {
      periodFrom,
      periodTo,
      period: Number(periodTo.slice(5, 7)),
      employeeCount: employeeCount ? Number(employeeCount) : null,
      particulars: particulars.trim() || payrollParticulars(advance?.particulars),
      // Only the net is asked for. Gross equals net and deductions are nil, so
      // the RCDisb (which prints all three) still foots.
      totalNet: net,
      totalGross: net,
      totalDeductions: 0,
    };

    setSaving(true);
    try {
      if (isNew && advance) {
        const newId = await createDraft(
          COL.payrolls,
          {
            payrollNo: payrollNo.trim().toUpperCase(),
            fiscalYear,
            fundCode,
            ...figures,
            dvId: advance.dvId,
            dvNo: advance.dvNo,
            disbursingOfficer: advance.officer,
            officeId: advance.officeId ?? '',
            officeName: advance.officeName ?? '',
            status: 'DRAFT',
          },
          actor,
        );
        toast.success(
          `Payroll ${payrollNo.trim().toUpperCase()} recorded`,
          'Report the net paid on an RCDisb so Accounting can journalize it.',
        );
        navigate(keepReturn(`/treasury/payroll/${newId}`, search), { replace: true });
      } else if (existing) {
        await updateDraft(COL.payrolls, existing.id, figures, actor);
        toast.success(`Payroll ${existing.payrollNo} saved`, 'The changes are recorded.');
      }
    } catch (err) {
      toast.error('Could not save the payroll', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && loading) return <Spinner label="Loading the payroll" />;
  if (!isNew && !existing) {
    return <Alert tone="error" title="Payroll not found" />;
  }

  return (
    <div>
      <PageHeader
        title={isNew ? 'New payroll' : `Payroll ${existing?.payrollNo ?? ''}`}
        subtitle={`${fundLabel(fundCode)} - liquidation of an advance for payroll`}
        breadcrumbs={[
          { label: 'Treasury' },
          { label: 'Payroll', to: '/treasury/payroll' },
          { label: isNew ? 'New' : (existing?.payrollNo ?? '') },
        ]}
        actions={
          <>
            <BackButton list={{ to: '/treasury/payroll', label: 'Payroll' }} />
            {!isNew && existing && <StatusBadge status={existing.status} className="mr-1" />}
            {editable && (
              <Button
                size="sm"
                variant="primary"
                loading={saving}
                disabled={isNew && !advance}
                onClick={() => void save()}
              >
                {isNew ? 'Save payroll' : 'Save changes'}
              </Button>
            )}
          </>
        }
      />

      <SectionTabs tabs={PAYROLL_TABS} />

      {/* ---- 1. the advance ------------------------------------------------ */}
      {isNew && (
        <Card
          className="mb-4"
          title="1. The advance for payroll it liquidates"
          subtitle="Approved or paid vouchers debiting Advances for Payroll, with what is still to be liquidated."
        >
          {dvs.loading || payrolls.loading ? (
            <Spinner label="Reading the advances" />
          ) : open.length === 0 ? (
            <Alert tone="info" title="No advance for payroll is outstanding">
              A payroll is recorded against the cash advance that paid it. There is no approved
              voucher for {fundLabel(fundCode)} {fiscalYear} debiting Advances for Payroll with
              anything left to liquidate.
            </Alert>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="px-2 py-2">DV No.</th>
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">Disbursing officer</th>
                    <th className="px-2 py-2">Particulars</th>
                    <th className="px-2 py-2 text-right">Advance</th>
                    <th className="px-2 py-2 text-right">Liquidated</th>
                    <th className="px-2 py-2 text-right">Outstanding</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {open.map((a) => {
                    const picked = advance?.dvId === a.dvId;
                    return (
                      <tr
                        key={a.dvId}
                        onClick={() => choose(a)}
                        className={`cursor-pointer border-b border-slate-100 hover:bg-brand-50/50 ${picked ? 'bg-brand-50' : ''}`}
                      >
                        <td className="px-2 py-2 font-mono text-xs">{a.dvNo}</td>
                        <td className="px-2 py-2 text-xs">{formatShortDate(a.dvDate)}</td>
                        <td className="px-2 py-2">{a.officer?.name ?? '-'}</td>
                        <td className="px-2 py-2 text-xs text-slate-600">{a.particulars}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatAmount(a.advance, false)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatAmount(a.liquidated, false)}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold tabular-nums">
                          {formatAmount(a.outstanding, false)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <Button
                            size="sm"
                            variant={picked ? 'primary' : 'secondary'}
                            onClick={(e) => {
                              e.stopPropagation();
                              choose(a);
                            }}
                          >
                            {picked ? 'Chosen' : 'Use'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---- 2. the payroll ------------------------------------------------ */}
      {(advance || !isNew) && (
        <Card className="mb-4" title={isNew ? '2. The payroll' : 'Payroll'}>
          <dl className="mb-4 grid gap-4 sm:grid-cols-3">
            <DetailField label="Advance (DV No.)" mono>
              {(advance?.dvId ?? existing?.dvId) ? (
                <ReturnLink
                  to={`/accounting/disbursements/${advance?.dvId ?? existing?.dvId}`}
                  className="text-brand-700 underline"
                >
                  {advance?.dvNo ?? existing?.dvNo}
                </ReturnLink>
              ) : (
                (existing?.dvNo ?? '-')
              )}
            </DetailField>
            <DetailField label="Disbursing officer">{officer?.name ?? '-'}</DetailField>
            <DetailField label="Outstanding on the advance">
              {outstanding !== null ? (
                <span className="cbo-amount">{formatPeso(outstanding)}</span>
              ) : (
                '-'
              )}
            </DetailField>
          </dl>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Payroll number" required htmlFor="prNo">
              <TextInput
                id="prNo"
                value={payrollNo}
                onChange={(e) => setPayrollNo(e.target.value)}
                className="font-mono"
                placeholder="PR-2026-10-001"
                disabled={!isNew}
              />
            </Field>
            <Field
              label="Employees covered"
              htmlFor="prCount"
              hint="For the report heading. Optional."
            >
              <TextInput
                id="prCount"
                value={employeeCount}
                onChange={(e) => setEmployeeCount(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                className="font-mono"
                disabled={!editable}
              />
            </Field>
            <Field label="Period from" required htmlFor="prFrom">
              <DateInput
                id="prFrom"
                value={periodFrom}
                onChange={setPeriodFrom}
                disabled={!editable}
              />
            </Field>
            <Field label="Period to" required htmlFor="prTo">
              <DateInput id="prTo" value={periodTo} onChange={setPeriodTo} disabled={!editable} />
            </Field>
            <Field
              label="Particulars"
              htmlFor="prParticulars"
              className="sm:col-span-2"
              hint="Copied from the advance's voucher."
            >
              <TextInput
                id="prParticulars"
                value={particulars}
                onChange={(e) => setParticulars(e.target.value)}
                disabled={!editable}
              />
            </Field>
            <Field label="Net amount paid" required htmlFor="prNet">
              <AmountInput id="prNet" value={net} onChange={setNet} disabled={!editable} />
            </Field>
          </div>
        </Card>
      )}

      {/* ---- 3. the entry -------------------------------------------------- */}
      {entry.length > 0 && (
        <Card
          title="Pro-forma entry"
          subtitle="What the RCDisb reporting this payroll journalizes."
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2">Subsidiary ledger</th>
                <th className="px-2 py-2 text-right">Debit</th>
                <th className="px-2 py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {entry.map((l) => (
                <tr key={l.accountCode} className="border-b border-slate-100">
                  <td className={`px-2 py-2 ${l.credit ? 'pl-8' : ''}`}>
                    <span className="font-mono text-xs text-slate-500">{l.accountCode}</span>{' '}
                    {l.accountName}
                  </td>
                  <td className="px-2 py-2">{l.subsidiaryName ?? '-'}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {l.debit ? formatAmount(l.debit, false) : ''}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {l.credit ? formatAmount(l.credit, false) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs italic text-slate-500">{entry[0].particulars}</p>
        </Card>
      )}
    </div>
  );
}
