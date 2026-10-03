import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert, Tabs } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { JournalEntryGrid, type GridLine } from '@/components/journal/JournalEntryGrid';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useReportsAwaitingJev } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import {
  TREASURY_REPORT_LABELS,
  TREASURY_REPORT_SHORT,
  TREASURY_REPORT_TYPES,
} from '@/types/enums';
import type { TreasuryReport } from '@/types/treasury';
import type { TreasuryReportType } from '@/types/enums';

/**
 * Treasury reports received from the Treasurer.
 *
 * ---------------------------------------------------------------------------
 * ONE TAB PER REPORT, AND WHY
 * ---------------------------------------------------------------------------
 * Four different documents arrive here - the RCI of the day's checks, the
 * RADAI, the RCD of collections, the RCDisb of cash paid out - and they used
 * to arrive into one undifferentiated list that emptied itself as the entries
 * were posted. A report that had been journalized was then not visible in
 * Accounting at all, so "show me the RCDs we received in March" had no answer
 * on this screen, and the obvious place to look next was Treasury's own
 * register, which is another office's book.
 *
 * So the list keeps the journalized ones, and there is a tab per report type
 * for finding one again. The count on each tab is what is still waiting, not
 * how many there are, because that is the number anybody is acting on.
 *
 *
 * Accounting's side of the handover. The Treasurer certifies a report - an RCI
 * of the day's checks, a RADAI, an RCD, an RCDisb - and it lands here. The
 * Accountant checks the entry the report proposes, adjusts the accounts if the
 * proposal is wrong, and posts. That posting is the moment the transaction
 * reaches the General Ledger.
 *
 * The one thing the Accountant cannot change is the amount. The entry must
 * foot to the total the Treasurer certified, and the engine refuses it
 * otherwise. Accounts are an accounting judgement; the amount is a statement
 * of fact that another officer has already signed, and if it is wrong the
 * report goes back rather than being quietly adjusted here.
 *
 * Sorted oldest first on purpose. A report that has sat for a week is the one
 * that matters, and newest-first would bury it.
 */
export default function TreasuryReportJev() {
  const { fiscalYear } = useFilters();
  const { hasRole } = useAuth();
  const toast = useToast();

  const { data, loading, error } = useReportsAwaitingJev(fiscalYear);

  const [reviewing, setReviewing] = useState<TreasuryReport | null>(null);
  const [tab, setTab] = useState('');

  const canPost = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const rows = useMemo(() => (tab ? data.filter((r) => r.reportType === tab) : data), [data, tab]);

  const waitingIn = (type: string) =>
    data.filter((r) => r.status === 'CERTIFIED' && (!type || r.reportType === type)).length;

  const tabs = useMemo(
    () => [
      { id: '', label: 'All reports', count: waitingIn('') },
      ...TREASURY_REPORT_TYPES.map((t) => ({
        id: t,
        label: TREASURY_REPORT_SHORT[t],
        count: waitingIn(t),
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  const columns: Column<TreasuryReport>[] = [
    {
      key: 'reportType',
      header: 'Report',
      width: '8rem',
      value: (r) => r.reportType,
      cell: (r) => (
        <span className="text-sm font-semibold text-navy-900">
          {TREASURY_REPORT_SHORT[r.reportType]}
        </span>
      ),
    },
    {
      key: 'reportNo',
      header: 'Number',
      width: '11rem',
      value: (r) => r.reportNo ?? '',
      cell: (r) => <span className="font-mono text-xs">{r.reportNo}</span>,
    },
    {
      key: 'reportDate',
      header: 'Date',
      width: '8rem',
      value: (r) => r.reportDate,
      cell: (r) => <span className="text-sm">{formatShortDate(r.reportDate)}</span>,
    },
    {
      // The answer to "was this one booked, and under what number". Without it
      // the only way back from a report to its entry was to search the journal
      // for the amount.
      key: 'jevNo',
      header: 'JEV No.',
      width: '10rem',
      value: (r) => r.jevNo ?? '',
      cell: (r) =>
        r.jevNo ? (
          <span className="font-mono text-xs text-navy-900">{r.jevNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">not yet journalized</span>
        ),
    },
    {
      key: 'fundCode',
      header: 'Fund',
      width: '6rem',
      value: (r) => r.fundCode,
      cell: (r) => <span className="text-sm">{r.fundCode}</span>,
    },
    {
      key: 'coverage',
      header: 'Covering',
      value: (r) => r.lines.length,
      cell: (r) => (
        <span className="text-sm">
          {r.lines.length} document{r.lines.length === 1 ? '' : 's'}
          {r.serialFrom ? (
            <span className="ml-2 font-mono text-xs text-slate-500">
              {r.serialFrom}
              {r.serialTo && r.serialTo !== r.serialFrom ? ` - ${r.serialTo}` : ''}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'totalAmount',
      header: 'Total',
      width: '11rem',
      align: 'right',
      value: (r) => r.totalAmount,
      cell: (r) => <span className="cbo-amount block">{formatPeso(r.totalAmount)}</span>,
    },
    {
      key: 'action',
      header: '',
      width: '10rem',
      sortable: false,
      fixed: true,
      value: (r) => r.status,
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <StatusBadge status={r.status} />
          <Button size="sm" variant={r.status === 'CERTIFIED' ? 'primary' : 'secondary'} onClick={() => setReviewing(r)}>
            {r.status === 'CERTIFIED' && canPost ? 'Journalize' : 'View'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Treasury reports for journalizing"
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Treasury reports' }]}
        subtitle="Reports the Treasurer has certified and forwarded. Each one is journalized as a single entry that foots to the report total, so the journals agree with the registers. The ones already journalized stay on the list, under their own tab, so a received report can be found again."
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {!canPost && (
        <Alert tone="info">
          Only the Municipal Accountant may post these entries. You can open a report to see what it
          covers and what entry it proposes.
        </Alert>
      )}

      <Card>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          loading={loading}
          error={error}
          searchPlaceholder="Report number or serial"
          emptyTitle={tab ? `No ${TREASURY_REPORT_SHORT[tab as TreasuryReportType]} received` : 'Nothing received'}
          emptyMessage={`No ${
            tab ? TREASURY_REPORT_LABELS[tab as TreasuryReportType] : 'treasury report'
          } for fiscal year ${fiscalYear} has reached Accounting. A report appears here the moment the Treasurer certifies it, and stays here after it is journalized.`}
        />
      </Card>

      {reviewing && (
        <JournalizeReport
          report={reviewing}
          readOnly={!canPost || reviewing.status !== 'CERTIFIED'}
          onClose={() => setReviewing(null)}
          onPosted={() => setReviewing(null)}
          toastError={(t, m) => toast.error(t, m)}
          toastSuccess={(t, m) => toast.success(t, m)}
        />
      )}
    </>
  );
}

function JournalizeReport({
  report,
  readOnly,
  onClose,
  onPosted,
  toastError,
  toastSuccess,
}: {
  report: TreasuryReport;
  readOnly?: boolean;
  onClose: () => void;
  onPosted: () => void;
  toastError: (title: string, message: string) => void;
  toastSuccess: (title: string, message: string) => void;
}) {
  const short = TREASURY_REPORT_SHORT[report.reportType];
  const label = TREASURY_REPORT_LABELS[report.reportType];

  const [lines, setLines] = useState<GridLine[]>(() =>
    (report.entry ?? []).map((l, i) => ({
      lineNo: i + 1,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.debit,
      credit: l.credit,
      particulars: l.particulars,
    })),
  );
  const [posting, setPosting] = useState(false);

  const totals = useMemo(() => {
    const debit = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const credit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    return { debit, credit };
  }, [lines]);

  const balanced = totals.debit === totals.credit;
  const agreesWithReport = totals.debit === report.totalAmount;
  const postable = balanced && agreesWithReport && lines.every((l) => l.accountCode);

  const post = async () => {
    setPosting(true);
    try {
      const res = await engine.journalizeTreasuryReport({
        reportId: report.id,
        entry: lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.debit || 0,
          credit: l.credit || 0,
          particulars: l.particulars,
        })),
      });
      toastSuccess(
        `JEV ${res.jevNo} posted`,
        `${short} ${res.reportNo} is journalized and in the General Ledger.`,
      );
      onPosted();
    } catch (err) {
      toastError('Could not journalize', err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal
      open
      size="xl"
      title={`${short} ${report.reportNo}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {!readOnly && (
            <Button onClick={post} loading={posting} disabled={!postable}>
              Post journal entry
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs uppercase text-slate-500">Report</div>
          <div className="font-medium text-navy-900">{label}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Date</div>
          <div className="font-medium text-navy-900">{formatShortDate(report.reportDate)}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Fund</div>
          <div className="font-medium text-navy-900">{report.fundCode}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Certified total</div>
          <div className="cbo-amount font-semibold text-navy-900">
            {formatPeso(report.totalAmount)}
          </div>
        </div>
      </div>

      {report.jevNo && (
        <Alert tone="success" className="mt-3">
          Journalized as JEV {report.jevNo}. The entry below is the one that was posted, and a
          posted entry is never edited - a correction is a reversing entry in Other Transactions.
        </Alert>
      )}

      {report.bankName && (
        <p className="mt-3 text-sm text-slate-600">
          Drawn on {report.bankName} {report.bankAccountNumber}
        </p>
      )}
      {report.accountableOfficerName && (
        <p className="mt-1 text-sm text-slate-600">
          Accountable officer: {report.accountableOfficerName}
        </p>
      )}

      <h3 className="mt-5 mb-2 text-sm font-semibold text-navy-900">
        Documents covered ({report.lines.length})
      </h3>
      <div className="max-h-56 overflow-y-auto rounded border border-slate-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">No.</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Payee / particulars</th>
              <th className="px-3 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((line) => (
              <tr key={line.sourceId} className="border-t border-slate-100">
                <td className="px-3 py-1.5 font-mono text-xs">{line.sourceNo}</td>
                <td className="px-3 py-1.5">{formatShortDate(line.date)}</td>
                <td className="px-3 py-1.5">
                  {line.payeeName ?? ''}
                  {line.particulars ? (
                    <span className="block text-xs text-slate-500">{line.particulars}</span>
                  ) : null}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <span className="cbo-amount">{formatPeso(line.amount)}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
              <td className="px-3 py-2" colSpan={3}>
                {report.reportType === 'RCDISB' ? 'Cash paid per report' : 'Total per report'}
              </td>
              <td className="px-3 py-2 text-right">
                <span className="cbo-amount">{formatPeso(report.totalAmount)}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <h3 className="mt-5 mb-2 text-sm font-semibold text-navy-900">Journal entry</h3>
      <p className="mb-2 text-xs text-slate-500">
        Adjust the accounts if the proposal is wrong. The entry must still foot to{' '}
        {formatPeso(report.totalAmount)} — if the report itself is wrong, send it back to the
        Treasurer rather than changing the amount here.
      </p>

      <JournalEntryGrid lines={lines} onChange={setLines} readOnly={readOnly} />

      {!balanced && (
        <Alert tone="warning" className="mt-3">
          The entry does not balance. Debits {formatPeso(totals.debit)}, credits{' '}
          {formatPeso(totals.credit)}.
        </Alert>
      )}
      {balanced && !agreesWithReport && (
        <Alert tone="warning" className="mt-3">
          The entry is for {formatPeso(totals.debit)} but {short} {report.reportNo} was certified at{' '}
          {formatPeso(report.totalAmount)}. The journal entry must agree with the report the
          Treasurer signed.
        </Alert>
      )}
    </Modal>
  );
}
