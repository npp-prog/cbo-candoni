import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, Alert, Tabs } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useReportsAwaitingJev } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import {
  TREASURY_REPORT_LABELS,
  TREASURY_REPORT_SHORT,
  TREASURY_REPORT_TYPES,
} from '@/types/enums';
import type { TreasuryReport } from '@/types/treasury';
import { newestFirst } from '@/lib/registerOrder';
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
  const navigate = useNavigate();

  const { data, loading, error } = useReportsAwaitingJev(fiscalYear);

  const [tab, setTab] = useState('');
  const [status, setStatus] = useState('');

  const canPost = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  /*
   * Newest report number first, like every other register in CFMS.
   *
   * This list used to be sorted oldest-first, on the reasoning that a report
   * which has sat for a week is the one that matters. That was right while
   * this screen was only a queue. It is now also where a journalized report is
   * found again, and a history read bottom-up is a history nobody reads. What
   * is waiting is in the status filter instead.
   */
  const rows = useMemo(() => {
    let out = tab ? data.filter((r) => r.reportType === tab) : data;
    if (status) out = out.filter((r) => r.status === status);
    return newestFirst(out, (r) => ({ ref: r.reportNo, date: r.reportDate }));
  }, [data, tab, status]);

  /*
   * The tabs carry no count.
   *
   * ---------------------------------------------------------------------------
   * WHY THE NUMBER CAME OFF
   * ---------------------------------------------------------------------------
   * It counted the reports still AWAITING an entry, while the tab it sat on
   * holds every report received - journalized ones included, which is the
   * whole reason this screen stopped being only a queue. So "RCI (0)" sat
   * above a tab with a year of journalized RCIs in it, and the only reading a
   * number in that position has is "there is nothing here".
   *
   * Showing the total instead would have been no better: it would duplicate
   * the row count the table prints at its foot, and it would move every time
   * the status filter beside it moved.
   *
   * What is still waiting is a question the STATUS FILTER answers, exactly and
   * without ambiguity. One control for it, not two that disagree.
   */
  const tabs = useMemo(
    () => [
      { id: '', label: 'All reports' },
      ...TREASURY_REPORT_TYPES.map((t) => ({
        id: t,
        label: TREASURY_REPORT_SHORT[t],
      })),
    ],
    [],
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
          {/*
            Opens the report's own page rather than a pop-up. The entry is
            adjusted and posted there, beside the documents the report covers
            and the signed form the Treasurer attached to it - which a pop-up
            over this list could not show, and which is the thing an Accountant
            should have read before posting the entry.
          */}
          <Button
            size="sm"
            variant={r.status === 'CERTIFIED' ? 'primary' : 'secondary'}
            onClick={() => navigate(`/treasury/reports/${r.id}`)}
          >
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
          filters={
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-auto py-1.5 text-sm"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="CERTIFIED">Awaiting journal entry</option>
              <option value="JOURNALIZED">Journalized</option>
            </Select>
          }
          emptyTitle={tab ? `No ${TREASURY_REPORT_SHORT[tab as TreasuryReportType]} received` : 'Nothing received'}
          emptyMessage={`No ${
            tab ? TREASURY_REPORT_LABELS[tab as TreasuryReportType] : 'treasury report'
          } for fiscal year ${fiscalYear} has reached Accounting. A report appears here the moment the Treasurer certifies it, and stays here after it is journalized.`}
        />
      </Card>

    </>
  );
}
