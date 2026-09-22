import { useState } from 'react';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { usePayrolls } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import { PAYROLL_TYPES, type PayrollType } from '@/types/enums';
import type { Payroll as PayrollRecord } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { PAYROLL_TABS } from './sections';

export const PAYROLL_TYPE_LABELS: Record<PayrollType, string> = {
  REGULAR: 'Regular Payroll',
  JOB_ORDER: 'Job Order',
  CONTRACT_OF_SERVICE: 'Contract of Service',
  HONORARIUM: 'Honorarium',
  OVERTIME: 'Overtime',
  SALARY_DIFFERENTIAL: 'Salary Differential',
  TERMINAL_LEAVE: 'Terminal Leave',
  ALLOWANCES: 'Allowances',
  OTHER: 'Other Payroll',
};

/**
 * Payroll.
 *
 * One payroll, one record, in total: gross, total deductions, net. Not an
 * employee register and not a breakdown of the deductions - the register is
 * prepared in the office that owns it, and the deductions are split by account
 * on the disbursement voucher that recognises the payroll. By the time the cash
 * is disbursed, the only figure that matters is the net.
 *
 * A payroll raises no journal entry by itself. The Payroll Officer disburses
 * the cash and reports it on a Report of Cash Disbursement; Accounting raises
 * one JEV from that report, liquidating the cash advance. If the payroll also
 * posted, the same salaries would reach the General Ledger twice.
 */
export default function Payroll() {
  const { fiscalYear, fundCode } = useFilters();
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error } = usePayrolls(fiscalYear, fundCode);

  const [showForm, setShowForm] = useState(false);

  const unreported = data.filter((p) => !p.treasuryReportId && p.status !== 'CANCELLED');
  const unreportedTotal = unreported.reduce((s, p) => s + p.totalNet, 0);

  const columns: Column<PayrollRecord>[] = [
    {
      key: 'payrollNo',
      header: 'Payroll No.',
      width: '10rem',
      value: (p) => p.payrollNo,
      cell: (p) => <span className="font-mono text-xs">{p.payrollNo}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      width: '11rem',
      value: (p) => PAYROLL_TYPE_LABELS[p.payrollType],
      cell: (p) => <span className="text-xs">{PAYROLL_TYPE_LABELS[p.payrollType]}</span>,
    },
    {
      key: 'period',
      header: 'Period',
      value: (p) => p.periodFrom,
      cell: (p) => (
        <span className="text-xs">
          {formatShortDate(p.periodFrom)} to {formatShortDate(p.periodTo)}
        </span>
      ),
    },
    {
      key: 'office',
      header: 'Office',
      value: (p) => p.officeName,
      cell: (p) => (
        <div className="text-xs text-slate-600">
          {p.officeName}
          {p.particulars ? <span className="block text-slate-400">{p.particulars}</span> : null}
        </div>
      ),
    },
    {
      key: 'gross',
      header: 'Gross',
      kind: 'amount',
      value: (p) => p.totalGross,
      cell: (p) => formatPeso(p.totalGross, { symbol: false }),
    },
    {
      key: 'deductions',
      header: 'Deductions',
      kind: 'amount',
      value: (p) => p.totalDeductions,
      cell: (p) => formatPeso(p.totalDeductions, { symbol: false, dash: true }),
    },
    {
      key: 'net',
      header: 'Net pay',
      kind: 'amount',
      value: (p) => p.totalNet,
      cell: (p) => formatPeso(p.totalNet, { symbol: false }),
    },
    {
      key: 'rcdisb',
      header: 'RCDisb',
      width: '9rem',
      value: (p) => p.treasuryReportNo ?? '',
      cell: (p) => (
        <span className="font-mono text-xs text-slate-500">{p.treasuryReportNo ?? '-'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '8rem',
      value: (p) => p.status,
      cell: (p) => <StatusBadge status={p.status} />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Payroll"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'Payroll' }]}
        actions={
          can('treasury', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              New payroll
            </Button>
          )
        }
      />

      <SectionTabs tabs={PAYROLL_TABS} />

      {unreportedTotal > 0 && (
        <Alert tone="info" className="mb-4" title="Payrolls not yet reported">
          {unreported.length} payroll{unreported.length === 1 ? '' : 's'} totalling{' '}
          {formatPeso(unreportedTotal)} in net pay have not been reported on an RCDisb. Until they
          are, the salaries are not in the General Ledger.
        </Alert>
      )}

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(p) => p.id}
        loading={loading}
        error={error}
        searchPlaceholder="Payroll number or office"
        emptyTitle="No payrolls recorded"
        emptyMessage="Record the gross, the deductions and the net for each payroll, then report the cash paid on an RCDisb."
        exportMeta={{
          title: 'Payroll Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <PayrollForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={(no) => {
            setShowForm(false);
            toast.success(
              `Payroll ${no} recorded`,
              'Report the cash paid on an RCDisb so Accounting can journalize it.',
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * The lumpsum form.
 *
 * Gross and total deductions are entered; the net is computed and cannot be
 * typed. A net that can be typed is a net that can disagree with its own
 * arithmetic, and the disagreement would not surface until the trial balance
 * failed to foot weeks later.
 */
function PayrollForm({
  fiscalYear,
  fundCode,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  onClose: () => void;
  onSaved: (payrollNo: string) => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const [payrollNo, setPayrollNo] = useState('');
  const [payrollType, setPayrollType] = useState<PayrollType>('REGULAR');
  const [periodFrom, setPeriodFrom] = useState(todayPh().slice(0, 8) + '01');
  const [periodTo, setPeriodTo] = useState(todayPh());
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [officeName, setOfficeName] = useState('');
  const [particulars, setParticulars] = useState('');
  const [employeeCount, setEmployeeCount] = useState('');
  const [gross, setGross] = useState<number | null>(null);
  const [deductionTotal, setDeductionTotal] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const net = (gross ?? 0) - (deductionTotal ?? 0);

  const save = async () => {
    if (!payrollNo.trim() || !officeId || !gross || !user) {
      toast.error('Incomplete', 'Payroll number, office and gross amount are required.');
      return;
    }
    if (net < 0) {
      toast.error(
        'Deductions exceed the gross',
        `The deductions total ${formatPeso(deductionTotal ?? 0)} against a gross of ${formatPeso(gross)}. A payroll cannot have a negative net.`,
      );
      return;
    }
    if (periodTo < periodFrom) {
      toast.error('Period reversed', 'The period ends before it begins.');
      return;
    }

    setSaving(true);
    try {
      await createDraft(
        COL.payrolls,
        {
          payrollNo: payrollNo.trim().toUpperCase(),
          payrollType,
          fiscalYear,
          period: Number(periodTo.slice(5, 7)),
          fundCode,
          periodFrom,
          periodTo,
          officeId,
          officeName,
          particulars: particulars.trim() || null,
          employeeCount: employeeCount ? Number(employeeCount) : null,
          totalGross: gross,
          totalDeductions: deductionTotal ?? 0,
          totalNet: net,
          status: 'DRAFT',
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
      );
      onSaved(payrollNo.trim().toUpperCase());
    } catch (err) {
      toast.error('Could not record the payroll', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New payroll"
      description="The payroll in total - gross, deductions withheld, and the net to be paid."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Payroll number" required htmlFor="prNo">
          <TextInput
            id="prNo"
            value={payrollNo}
            onChange={(e) => setPayrollNo(e.target.value)}
            className="font-mono"
            placeholder="PR-2026-09-001"
          />
        </Field>

        <Field label="Payroll type" htmlFor="prType">
          <Select
            id="prType"
            value={payrollType}
            onChange={(e) => setPayrollType(e.target.value as PayrollType)}
          >
            {PAYROLL_TYPES.map((t) => (
              <option key={t} value={t}>
                {PAYROLL_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Period from" required htmlFor="prFrom">
          <DateInput id="prFrom" value={periodFrom} onChange={setPeriodFrom} />
        </Field>

        <Field label="Period to" required htmlFor="prTo">
          <DateInput id="prTo" value={periodTo} onChange={setPeriodTo} />
        </Field>

        <Field label="Office" required htmlFor="prOffice">
          <OfficePicker
            id="prOffice"
            value={officeId}
            onChange={(id, office) => {
              setOfficeId(id);
              setOfficeName(office?.name ?? '');
            }}
          />
        </Field>

        <Field label="Employees covered" htmlFor="prCount" hint="For the report heading. Optional.">
          <TextInput
            id="prCount"
            value={employeeCount}
            onChange={(e) => setEmployeeCount(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            className="font-mono"
          />
        </Field>

        <Field label="Particulars" htmlFor="prParticulars" className="sm:col-span-2">
          <TextInput
            id="prParticulars"
            value={particulars}
            onChange={(e) => setParticulars(e.target.value)}
            placeholder="Regular employees, first half of September 2026"
          />
        </Field>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Gross amount" required htmlFor="prGross">
          <AmountInput id="prGross" value={gross} onChange={setGross} />
        </Field>

        <Field
          label="Total deductions"
          htmlFor="prDeductions"
          hint="All deductions withheld, as one figure. They are split by account on the voucher."
        >
          <AmountInput id="prDeductions" value={deductionTotal} onChange={setDeductionTotal} />
        </Field>
      </div>

      <table className="mt-5 w-full border-collapse text-sm">
        <tbody>
          <tr className="border-t border-slate-200">
            <td className="cbo-td">Gross</td>
            <td className="cbo-td cbo-amount">{formatPeso(gross ?? 0, { symbol: false })}</td>
          </tr>
          <tr className="border-t border-slate-100">
            <td className="cbo-td">Less deductions</td>
            <td className="cbo-td cbo-amount">
              {formatPeso(deductionTotal ?? 0, { symbol: false, dash: true })}
            </td>
          </tr>
          <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
            <td className="cbo-td">Net pay</td>
            <td className="cbo-td cbo-amount">{formatPeso(net, { symbol: false })}</td>
          </tr>
        </tbody>
      </table>

      {net < 0 && (
        <Alert tone="error" className="mt-4">
          The deductions exceed the gross. Check the figures before saving.
        </Alert>
      )}

      <Alert tone="info" className="mt-4">
        Saving records the payroll only. The cash advance is liquidated when the net paid is
        reported on an RCDisb and Accounting journalizes it.
      </Alert>
    </Modal>
  );
}
