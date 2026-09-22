import { Link } from 'react-router-dom';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { useFilters } from '@/context/FilterContext';
import { fundLabel } from '../budget/Obligations';

/**
 * The report index.
 *
 * Organised into the four categories the specification sets out. Every report
 * in the first three categories is derived from posted journal entries -
 * there is no screen anywhere in CBO where a financial statement balance can
 * be typed in, and that is the single most important property of the
 * reporting engine.
 */

interface ReportLink {
  to: string;
  title: string;
  description: string;
  available: boolean;
}

const GENERAL: ReportLink[] = [
  {
    to: '/reports/trial-balance',
    title: 'Trial Balance',
    description: 'Monthly, annual, pre-closing and post-closing, from posted ledger entries.',
    available: true,
  },
  {
    to: '/reports/financial-statements',
    title: 'Financial Statements',
    description:
      'Statement of Financial Position, Financial Performance, Cash Flows, Changes in Net Assets/Equity, and Comparison of Budget and Actual Amounts.',
    available: true,
  },
];

const BUDGET: ReportLink[] = [
  {
    to: '/reports/saob',
    title: 'Statement of Appropriations, Obligations and Balances',
    description: 'Appropriations, allotments, obligations, disbursements and the balances remaining.',
    available: true,
  },
  {
    to: '/budget/registry',
    title: 'Registry of Appropriations, Allotments and Obligations',
    description: 'The full budget registry, by office, programme and account.',
    available: true,
  },
  {
    to: '/budget/appropriations',
    title: 'Appropriation Ledger',
    description: 'Every appropriation, supplemental, realignment and adjustment, with its authority.',
    available: true,
  },
  {
    to: '/budget/allotments',
    title: 'Allotment Ledger',
    description: 'Allotment releases and withdrawals by office and account.',
    available: true,
  },
];

const ACCOUNTING: ReportLink[] = [
  {
    to: '/reports/general-ledger',
    title: 'General Ledger',
    description: 'Every posted entry by account, with running balance.',
    available: true,
  },
  {
    to: '/reports/subsidiary-ledger',
    title: 'Subsidiary Ledger',
    description: 'Movement on a control account by payee, employee or bank account.',
    available: true,
  },
  {
    to: '/reports/journals',
    title: 'Journals',
    description:
      'General Journal, Cash Disbursements, Check Disbursements, ADA Disbursements, Cash Receipts and Procurement Received.',
    available: true,
  },
  {
    to: '/reports/registers',
    title: 'Registers',
    description: 'DV, JEV, check, ADA and RCD registers, and the schedules of payables and receivables.',
    available: true,
  },
  {
    to: '/accounting/index-of-payments',
    title: 'Index of Payments',
    description: 'Everything paid to a given payee, searchable by date and amount.',
    available: true,
  },
  {
    to: '/accounting/cash-advances',
    title: 'Cash Advance Ageing',
    description: 'Outstanding advances by officer and days overdue.',
    available: true,
  },
  {
    to: '/accounting/liquidation',
    title: 'Liquidation Monitoring',
    description: 'Liquidation reports and the balances they settle.',
    available: true,
  },
];

const TREASURY: ReportLink[] = [
  {
    to: '/reports/treasury',
    title: 'Treasury Reports',
    description:
      'Collections by day and month, cashbook, deposit register, revenue collection report and undeposited collections.',
    available: true,
  },
  {
    to: '/treasury/cash-position',
    title: 'Cash Position Report',
    description: 'Book balance, deposits in transit and outstanding checks per bank account.',
    available: true,
  },
  {
    to: '/treasury/accountable-forms',
    title: 'Statement of Accountability for Accountable Forms',
    description: 'Official receipts and other controlled forms by accountable officer.',
    available: true,
  },
];

export default function ReportsHome() {
  const { fiscalYear, fundCode } = useFilters();

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Reports' }]}
      />

      <Alert tone="info" className="mb-5">
        Every financial report in CBO is derived from posted journal entries in the General Ledger.
        No statement balance is stored or entered anywhere, so a report run today and the same
        report run next year will agree unless an entry was posted or reversed in between.
      </Alert>

      <div className="space-y-5">
        <Section title="General financial reports" links={GENERAL} />
        <Section title="Budget reports" links={BUDGET} />
        <Section title="Accounting reports" links={ACCOUNTING} />
        <Section title="Treasury reports" links={TREASURY} />
      </div>
    </div>
  );
}

function Section({ title, links }: { title: string; links: ReportLink[] }) {
  return (
    <section>
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className="cbo-card px-4 py-3.5 transition-colors hover:border-brand-300 hover:bg-brand-50/30"
          >
            <p className="text-sm font-medium text-navy-900">{link.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{link.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
