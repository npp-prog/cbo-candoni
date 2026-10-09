import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { actKindLabel } from '@/lib/budgetActs';
import { useOpenWithReturn } from '@/components/ui/BackButton';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAppropriations, useAugmentationDrafts, useOrdinances } from '@/data/queries';
import { actorStamp } from '@/data/mutations';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { AppropriationTabs } from './appropriationTabs';
import { RecordOrdinanceDialog } from './RecordOrdinanceDialog';
import {
  STAGE_LABELS,
  summariseOrdinance,
  type OrdinanceSummary,
} from './ordinanceModel';
import { fundLabel } from './Obligations';

/**
 * The ordinances of the year, each a document of its own. Patch 119.
 *
 * Click one to open it: its lines, the scanned ordinance, LBP Form No. 2, and
 * its approval. The amounts are read from the lines - an ordinance record
 * holds none of its own.
 */
export default function Ordinances() {
  const { fiscalYear, fundCode } = useFilters();
  const { can, user, profile } = useAuth();
  const open = useOpenWithReturn();

  const ordinances = useOrdinances(fiscalYear, fundCode);
  const appropriations = useAppropriations(fiscalYear, fundCode);
  const sets = useAugmentationDrafts(fiscalYear, fundCode);
  const [recording, setRecording] = useState(false);

  const rows = useMemo(
    () =>
      ordinances.data
        .map((o) => summariseOrdinance(o, appropriations.data, sets.data))
        .sort(
          (a, b) =>
            b.ordinance.date.localeCompare(a.ordinance.date) ||
            b.ordinance.reference.localeCompare(a.ordinance.reference),
        ),
    [ordinances.data, appropriations.data, sets.data],
  );

  const actor = user
    ? actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      })
    : null;

  const columns: Column<OrdinanceSummary>[] = [
    {
      key: 'reference',
      header: 'Number',
      width: '14rem',
      value: (r) => `${r.ordinance.reference} ${r.ordinance.title ?? ''}`,
      cell: (r) => (
        <div>
          <span className="font-mono text-xs">{r.ordinance.reference}</span>
          {r.ordinance.title && (
            <span className="block text-2xs text-slate-500">{r.ordinance.title}</span>
          )}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: '12rem',
      value: (r) => r.ordinance.kind,
      cell: (r) => (
        <span className="text-xs">
          {actKindLabel(r.ordinance.kind)}
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (r) => r.ordinance.date,
      cell: (r) => <span className="text-xs">{formatShortDate(r.ordinance.date)}</span>,
    },
    {
      key: 'lines',
      header: 'Lines',
      kind: 'number',
      width: '6rem',
      value: (r) => r.approvedCount + r.waitingCount,
      cell: (r) => (
        <span className="text-xs">
          {r.approvedCount + r.waitingCount}
          {r.waitingCount > 0 && r.approvedCount > 0 && (
            <span className="block text-2xs text-slate-500">{r.waitingCount} waiting</span>
          )}
        </span>
      ),
    },
    {
      key: 'approved',
      header: 'Approved',
      kind: 'amount',
      width: '10rem',
      value: (r) => r.approvedTotal,
      cell: (r) => (
        <span>{r.approvedTotal ? formatPeso(r.approvedTotal, { symbol: false }) : '-'}</span>
      ),
    },
    {
      key: 'waiting',
      header: 'Not yet approved',
      kind: 'amount',
      width: '10rem',
      value: (r) => r.draftTotal,
      cell: (r) => (
        <span className={r.draftTotal ? 'text-amber-700' : 'text-slate-400'}>
          {r.draftTotal ? formatPeso(r.draftTotal, { symbol: false }) : '-'}
        </span>
      ),
    },
    {
      key: 'stage',
      header: 'Status',
      width: '11rem',
      value: (r) => r.stage,
      cell: (r) => (
        <Badge tone={r.stage === 'APPROVED' ? 'emerald' : r.stage === 'EMPTY' ? 'slate' : 'amber'}>
          {STAGE_LABELS[r.stage]}
        </Badge>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Authorities"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Appropriations' }, { label: 'Authorities' }]}
        actions={
          can('budget', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setRecording(true)}>
              Record an authority
            </Button>
          )
        }
      />

      <AppropriationTabs active="ordinances" />

      <div className="my-4" />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.ordinance.id}
        onRowClick={(r) => open(`/budget/appropriations/ordinances/${r.ordinance.id}`)}
        loading={ordinances.loading}
        error={ordinances.error}
        searchPlaceholder="Number or title"
        emptyTitle="Nothing recorded"
        emptyMessage="Record the ordinance, augmentation order or continuing appropriations here first; its lines and sources are recorded inside it."
      />

      {recording && (
        <RecordOrdinanceDialog
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          actor={actor}
          onClose={() => setRecording(false)}
          onRecorded={(id) => {
            setRecording(false);
            open(`/budget/appropriations/ordinances/${id}`);
          }}
        />
      )}
    </div>
  );
}
