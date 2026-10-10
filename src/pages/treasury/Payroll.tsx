import { PageHeader, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useOpenWithReturn } from '@/components/ui/BackButton';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { usePayrolls } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { PayrollType } from '@/types/enums';
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
  const { data, loading, error } = usePayrolls(fiscalYear, fundCode);
  /* Patch 155: a payroll opens on its own page, new or existing. */
  const open = useOpenWithReturn();

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
      key: 'dvNo',
      header: 'Advance (DV No.)',
      width: '10rem',
      value: (p) => p.dvNo ?? '',
      cell: (p) => <span className="font-mono text-xs">{p.dvNo ?? '-'}</span>,
    },
    {
      key: 'officer',
      header: 'Disbursing officer',
      value: (p) => p.disbursingOfficer?.name ?? p.officeName ?? '',
      cell: (p) => (
        <div className="text-xs text-slate-700">
          {p.disbursingOfficer?.name ?? p.officeName ?? '-'}
          {p.particulars ? <span className="block text-slate-400">{p.particulars}</span> : null}
        </div>
      ),
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
            <Button variant="primary" size="sm" onClick={() => open('/treasury/payroll/new')}>
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
        onRowClick={(p) => open(`/treasury/payroll/${p.id}`)}
        searchPlaceholder="Payroll number, DV number or officer"
        emptyTitle="No payrolls recorded"
        emptyMessage="Record each payroll against the advance for payroll it liquidates, then report the net paid on an RCDisb."
        exportMeta={{
          title: 'Payroll Register',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />

    </div>
  );
}
