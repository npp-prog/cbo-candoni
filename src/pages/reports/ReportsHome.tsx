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

/**
 * One signpost rather than a second copy of the treasury list.
 *
 * The treasury reports now live in the Treasury menu, beside the registers
 * they are drawn from. Listing them here as well would put two doors on every
 * report, and the two lists would drift apart the first time one of them was
 * added to. But removing them with nothing in their place would leave whoever
 * has been finding the RCD here for months with no idea where it went, so the
 * section stays and says so.
 */
const TREASURY: ReportLink[] = [
  {
    to: '/treasury',
    title: 'The treasury reports are in the Treasury menu',
    description:
      'RCD, RCI, RADAI, RCDisb, cancelled checks, the abstract and summary of collections, the cashbook, ' +
      'cash in local treasury and the RAAF are grouped there beside the registers they come from.',
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
