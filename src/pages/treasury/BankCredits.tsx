import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAda, useEmployees, usePayees } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { fundLabel } from '../budget/Obligations';
import { PAYMENT_TAB_GROUPS } from './sections';
import {
  buildBankCredits,
  CREDIT_STATUS_LABEL,
  type BankCredit,
  type CreditStatus,
} from './bankCreditRows';

/**
 * Treasury > Checks and ADA > Reports > RADAI > Bank Credits. Patch 144.
 *
 * Every credit the advices asked the bank to make - one line per payee - and
 * whether the bank posted it online, as recorded on the RADAI. A credit not
 * posted is a trust liability until a new voucher repays it; its adjusting
 * entry is linked.
 */
export default function BankCredits() {
  const { fiscalYear, fundCode } = useFilters();
  const { data, loading, error } = useAda();
  const payees = usePayees();
  const employees = useEmployees();
  const [status, setStatus] = useState<'' | CreditStatus>('');

  const rows = useMemo(() => {
    const payeeById = new Map(payees.data.map((p) => [p.id, p]));
    const empById = new Map(employees.data.map((e) => [e.id, e]));
    const accountOf = (id: string | null | undefined) => {
      const p = id ? payeeById.get(id) : undefined;
      const e = p?.employeeId ? empById.get(p.employeeId) : undefined;
      return e?.bankAccountNumber || p?.bankAccountNumber || '';
    };
    const all = buildBankCredits(
      data.filter((a) => a.fiscalYear === fiscalYear && a.fundCode === fundCode),
      accountOf,
    ).sort((a, b) => b.adaNo.localeCompare(a.adaNo) || a.lineNo - b.lineNo);
    return status ? all.filter((r) => r.status === status) : all;
  }, [data, payees.data, employees.data, fiscalYear, fundCode, status]);

  const notPosted = rows.filter((r) => r.status === 'NOT_POSTED').reduce((t, r) => t + r.amount, 0);

  const columns: Column<BankCredit>[] = [
    {
      key: 'adaNo',
      header: 'ADA No.',
      width: '9rem',
      value: (r) => r.adaNo,
      cell: (r) => <span className="font-mono text-xs">{r.adaNo}</span>,
    },
    {
      key: 'radaiNo',
      header: 'RADAI No.',
      width: '8rem',
      value: (r) => r.radaiNo,
      cell: (r) => <span className="font-mono text-xs">{r.radaiNo || '-'}</span>,
    },
    {
      key: 'account',
      header: 'ATM / account no.',
      width: '10rem',
      value: (r) => r.accountNumber,
      cell: (r) => <span className="font-mono text-xs">{r.accountNumber || '-'}</span>,
    },
    {
      key: 'payee',
      header: 'Payee',
      value: (r) => r.payeeName,
      cell: (r) => <span className="text-sm">{r.payeeName}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (r) => r.amount,
      cell: (r) => formatPeso(r.amount, { symbol: false }),
    },
    {
      key: 'posted',
      header: 'Posted online',
      kind: 'date',
      width: '8rem',
      value: (r) => r.postedDate,
      cell: (r) => (
        <span className="text-xs">{r.postedDate ? formatShortDate(r.postedDate) : '-'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '16rem',
      value: (r) => CREDIT_STATUS_LABEL[r.status],
      cell: (r) => (
        <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
          <Badge tone={r.status === 'POSTED' ? 'emerald' : r.status === 'NOT_POSTED' ? 'amber' : 'slate'}>
            {CREDIT_STATUS_LABEL[r.status]}
          </Badge>
          {r.notPostedJevId && (
            <Link
              to={`/accounting/general-transactions/${r.notPostedJevId}`}
              className="text-2xs text-brand-700 underline"
              onClick={(e) => e.stopPropagation()}
            >
              Entry
            </Link>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Bank Credits"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${
          notPosted > 0 ? ` - ${formatPeso(notPosted)} not posted` : ''
        }`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'RADAI', to: '/treasury/ada/radai' }, { label: 'Bank Credits' }]}
      />
      <GroupedSectionTabs groups={PAYMENT_TAB_GROUPS} />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.key}
        loading={loading || payees.loading || employees.loading}
        error={error}
        searchPlaceholder="ADA, RADAI, ATM number or payee"
        emptyTitle="No bank credits"
        emptyMessage="Every advice to debit account lists its credits here once it is prepared."
        filters={
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | CreditStatus)}
            className="w-auto py-1.5 text-sm"
            aria-label="Filter by status"
          >
            <option value="">All credits</option>
            <option value="POSTED">Posted</option>
            <option value="NOT_POSTED">Not posted</option>
            <option value="AWAITING">Awaiting posting</option>
          </Select>
        }
        exportMeta={{
          title: 'Bank Credits',
          fundLabel: fundLabel(fundCode),
          periodLabel: `For the fiscal year ${fiscalYear}`,
        }}
      />
    </div>
  );
}
