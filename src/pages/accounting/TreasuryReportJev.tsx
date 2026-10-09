import { useCallback, useMemo } from 'react';
import { CoveringCell } from '@/pages/treasury/CoveringCell';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { hereAsReturn, withReturn } from '@/lib/returnTo';
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
import { isForwarded } from '@/lib/treasuryForwarding';
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

  /*
    THE TAB AND THE STATUS FILTER LIVE IN THE ADDRESS.

    They were held in memory, so opening a report and coming back always
    landed on "All reports" with no filter - the Accountant working down the
    RCI tab lost their place every time they journalized one. In the address
    they come back with the Back button, with a refresh, and with the return
    path a report carries back here. See src/lib/returnTo.ts.
  */
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? '';
  const status = params.get('status') ?? '';
  const setParam = useCallback(
    (key: string, value: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const setTab = useCallback((v: string) => setParam('tab', v), [setParam]);
  const setStatus = useCallback((v: string) => setParam('status', v), [setParam]);

  /* Where a report opened from here should bring the officer back to. */
  const location = useLocation();
  const here = hereAsReturn(location);
  const openReport = (id: string, suffix = '') =>
    navigate(withReturn(`/treasury/reports/${id}${suffix}`, here));

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
    // Patch 143: a certified report reaches Accounting only once forwarded.
    let out = (tab ? data.filter((r) => r.reportType === tab) : data).filter(isForwarded);
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
      /* The serial opens the document it names. See CoveringCell. */
      cell: (r) => <CoveringCell report={r} />,
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
      width: '18rem',
      sortable: false,
      fixed: true,
      value: (r) => r.status,
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <StatusBadge status={r.status} />
          {/*
            VIEW REPORT opens the prescribed form - Appendix 38 for an RCI,
            Appendix 34 for an RCD, and so on: the document the Treasurer
            signed and sent over. It is the first thing an Accountant wants in
            front of them when a report arrives, and it was two presses away
            through the report's own page.
          */}
          <Button
            size="sm"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              openReport(r.id, '/form');
            }}
          >
            View report
          </Button>
          {/*
            Journalize, where it is waiting. "Open" is gone (patch 143): the
            whole line opens the report.
          */}
          {r.status === 'CERTIFIED' && canPost && (
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => {
                e.stopPropagation();
                openReport(r.id);
              }}
            >
              Journalize
            </Button>
          )}
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
          /*
            THE WHOLE ROW OPENS THE REPORT. It lights under the pointer, which
            is what says it can be clicked - a list whose rows look like
            print is a list whose rows nobody tries. The serial in Covering
            opens the document instead, and the buttons do what they say;
            each stops its own click so the row does not open as well.
          */
          onRowClick={(r) => openReport(r.id)}
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
