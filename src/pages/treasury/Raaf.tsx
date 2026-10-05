import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ACCOUNTABLE_FORM_TABS } from './sections';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, Select, DateInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useRaafReports } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatShortDate } from '@/lib/dates';
import type { Raaf as RaafRecord, RaafBasis, RaafLine, RaafSerialRange } from '@/types/accountableForms';

/**
 * Report of Accountability for Accountable Forms.
 *
 * One officer, one month, and not a single figure typed by hand. The report is
 * generated from the movement ledger and - for a collecting officer - from the
 * Official Receipts actually encoded in Collections, which is the join that
 * makes it worth anything: the serials the officer reports as issued are the
 * same serials the revenue accounts were credited from.
 *
 * The consequence is a screen with one unusual property. An officer cannot
 * produce a RAAF that agrees with their own recollection and disagrees with the
 * receipts; if the two differ, the report says so and refuses to be certified
 * until a movement is recorded that explains the difference. That refusal is
 * the feature.
 */

const BASIS_LABEL: Record<RaafBasis, string> = {
  CUSTODIAN: 'Custodian of stock (the Treasurer)',
  COLLECTING_OFFICER: 'Collecting officer',
};

const BASIS_HINT: Record<RaafBasis, string> = {
  CUSTODIAN:
    'Issued means handed to a collecting officer. Read from the movement ledger.',
  COLLECTING_OFFICER:
    'Issued means written out to a payor. Read from the receipts encoded in Collections, so the report and the revenue accounts cannot disagree.',
};

/** The first and last day of the month a date falls in, in Philippine time. */
function monthBounds(anchor: string): { from: string; to: string } {
  const [y, m] = anchor.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${anchor.slice(0, 7)}-01`, to: `${anchor.slice(0, 7)}-${String(last).padStart(2, '0')}` };
}

export default function Raaf() {
  const { fiscalYear } = useFilters();
  const { can, hasRole } = useAuth();
  const toast = useToast();

  const { data, loading, error } = useRaafReports(fiscalYear);

  const [showForm, setShowForm] = useState(false);
  const [viewing, setViewing] = useState<RaafRecord | null>(null);
  const [certifying, setCertifying] = useState<RaafRecord | null>(null);
  const [cancelling, setCancelling] = useState<RaafRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const canPrepare = can('treasury', 'create');
  const canCertify = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER');

  const unexplained = useMemo(
    () => data.filter((r) => r.status === 'DRAFT' && r.hasDiscrepancy),
    [data],
  );

  const columns: Column<RaafRecord>[] = [
    {
      key: 'raafNo',
      header: 'RAAF No.',
      width: '9rem',
      value: (r) => r.raafNo ?? '',
      cell: (r) =>
        r.raafNo ? (
          <span className="font-mono text-xs">{r.raafNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Draft</span>
        ),
    },
    {
      key: 'officer',
      header: 'Accountable officer',
      value: (r) => r.officerName,
      cell: (r) => (
        <div>
          <p className="text-xs font-medium text-navy-900">{r.officerName}</p>
          <p className="text-2xs text-slate-500">{BASIS_LABEL[r.basis]}</p>
        </div>
      ),
    },
    {
      key: 'period',
      header: 'Period',
      width: '11rem',
      value: (r) => r.periodTo,
      cell: (r) => (
        <div>
          <p className="text-xs">{r.periodLabel}</p>
          <p className="text-2xs text-slate-500">
            {formatShortDate(r.periodFrom)} &ndash; {formatShortDate(r.periodTo)}
          </p>
        </div>
      ),
    },
    {
      key: 'forms',
      header: 'Forms',
      kind: 'number',
      width: '5rem',
      value: (r) => r.lines.length,
      cell: (r) => r.lines.length,
    },
    {
      key: 'issued',
      header: 'Issued',
      kind: 'number',
      width: '6rem',
      value: (r) => r.lines.reduce((s, l) => s + l.issuedQty, 0),
      cell: (r) => r.lines.reduce((s, l) => s + l.issuedQty, 0).toLocaleString('en-PH'),
    },
    {
      key: 'ending',
      header: 'On hand',
      kind: 'number',
      width: '6rem',
      value: (r) => r.lines.reduce((s, l) => s + l.endingQty, 0),
      cell: (r) => r.lines.reduce((s, l) => s + l.endingQty, 0).toLocaleString('en-PH'),
    },
    {
      key: 'status',
      header: 'Status',
      fixed: true,
      width: '15rem',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {r.hasDiscrepancy && r.status === 'DRAFT' && <Badge tone="rose">Does not foot</Badge>}
          <StatusBadge status={r.status} />
          {r.status === 'DRAFT' && canCertify && !r.hasDiscrepancy && (
            <Button size="sm" variant="secondary" onClick={() => setCertifying(r)}>
              Certify
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Report of Accountability for Accountable Forms"
        subtitle={`Fiscal year ${fiscalYear} — one report per accountable officer per month`}
        breadcrumbs={[
          { label: 'Treasury', to: '/treasury' },
          { label: 'Accountable Forms', to: '/treasury/accountable-forms' },
          { label: 'RAAF' },
        ]}
        actions={
          canPrepare ? (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              Prepare RAAF
            </Button>
          ) : null
        }
      />

      <SectionTabs tabs={ACCOUNTABLE_FORM_TABS} />

      {unexplained.length > 0 && (
        <Alert tone="warning" title="Reports that do not foot" className="mb-4">
          {unexplained.length} draft report{unexplained.length === 1 ? '' : 's'} show serials issued
          that the officer was never recorded as receiving. Open the report to see which, then record
          the missing issue under <strong>Accountable Forms</strong>. Until then they cannot be
          certified &mdash; certifying is the officer&rsquo;s own statement that every serial is
          accounted for.
        </Alert>
      )}

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRowClick={(r) => setViewing(r)}
        searchPlaceholder="Officer, report number or period"
        emptyTitle="No reports of accountability yet"
        emptyMessage="Prepare one for a collecting officer at the end of the month."
        emptyAction={
          canPrepare ? (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              Prepare the first RAAF
            </Button>
          ) : undefined
        }
        exportMeta={{
          title: 'Reports of Accountability for Accountable Forms',
          periodLabel: `Fiscal year ${fiscalYear}`,
        }}
      />

      {showForm && (
        <PrepareForm
          fiscalYear={fiscalYear}
          onClose={() => setShowForm(false)}
          onPrepared={(hasDiscrepancy) => {
            setShowForm(false);
            if (hasDiscrepancy) {
              toast.error(
                'Prepared, but it does not foot',
                'Open the report: some serials were issued that the officer was never given.',
              );
            } else {
              toast.success('Report prepared', 'Read it, then certify it.');
            }
          }}
        />
      )}

      {viewing && <RaafDetail raaf={viewing} onClose={() => setViewing(null)} />}

      <ConfirmDialog
        open={Boolean(certifying)}
        onCancel={() => setCertifying(null)}
        title="Certify the report of accountability"
        confirmLabel="Certify"
        loading={busy}
        message={
          <>
            <p>
              This draws the RAAF number and closes the report. It is{' '}
              {certifying?.officerName}&rsquo;s statement that every serial on it is accounted for,
              and it is what COA reads.
            </p>
            <p className="mt-2">
              The server re-checks that each line foots before it signs. The ending balance becomes
              next month&rsquo;s beginning balance automatically, so a certified report that is later
              found wrong is cancelled and prepared again, not edited.
            </p>
          </>
        }
        onConfirm={async () => {
          if (!certifying) return;
          setBusy(true);
          try {
            const r = await engine.certifyRaaf({ raafId: certifying.id });
            toast.success(`RAAF ${r.raafNo} certified`);
            setCertifying(null);
          } catch (err) {
            toast.error('The report was not certified', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(cancelling)}
        onCancel={() => setCancelling(null)}
        title={cancelling ? `Cancel RAAF ${cancelling.raafNo ?? '(draft)'}` : ''}
        confirmLabel="Cancel the report"
        variant="danger"
        requireReason
        reasonLabel="Why this report should be withdrawn"
        loading={busy}
        message="The report is kept with a status of Cancelled and its number is not reused. A replacement is prepared afresh from the ledger."
        onConfirm={async (reason) => {
          if (!cancelling) return;
          setBusy(true);
          try {
            await engine.cancelRaaf({ raafId: cancelling.id, reason: reason ?? '' });
            toast.success('Report cancelled');
            setCancelling(null);
          } catch (err) {
            toast.error('Could not cancel the report', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

function PrepareForm({
  fiscalYear,
  onClose,
  onPrepared,
}: {
  fiscalYear: number;
  onClose: () => void;
  onPrepared: (hasDiscrepancy: boolean) => void;
}) {
  const toast = useToast();
  const [basis, setBasis] = useState<RaafBasis>('COLLECTING_OFFICER');
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [officerName, setOfficerName] = useState('');
  const [anchor, setAnchor] = useState(() => `${fiscalYear}-01-01`);
  const [busy, setBusy] = useState(false);

  const bounds = monthBounds(anchor);

  const prepare = async () => {
    if (!officerId || !officerName) {
      return toast.error('Incomplete', 'Choose the accountable officer.');
    }
    setBusy(true);
    try {
      const r = await engine.prepareRaaf({
        fiscalYear,
        officerId,
        officerName,
        basis,
        periodFrom: bounds.from,
        periodTo: bounds.to,
      });
      onPrepared(r.hasDiscrepancy);
    } catch (err) {
      toast.error('The report was not prepared', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Prepare a report of accountability"
      description="Every figure is read from the ledger and from the receipts on file. Nothing here is typed."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={prepare} loading={busy}>
            Prepare
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="This officer is a" required hint={BASIS_HINT[basis]}>
          <Select value={basis} onChange={(e) => setBasis(e.target.value as RaafBasis)}>
            <option value="COLLECTING_OFFICER">{BASIS_LABEL.COLLECTING_OFFICER}</option>
            <option value="CUSTODIAN">{BASIS_LABEL.CUSTODIAN}</option>
          </Select>
        </Field>

        <Field label="Accountable officer" required>
          <EmployeePicker
            value={officerId}
            onChange={(id, emp) => {
              setOfficerId(id);
              setOfficerName(emp?.name ?? '');
            }}
          />
        </Field>

        <Field
          label="Month"
          required
          hint={`Covers ${bounds.from} to ${bounds.to}. Any date inside the month will do.`}
        >
          <DateInput value={anchor} onChange={setAnchor} />
        </Field>

        <Alert tone="info" title="Re-preparing is safe">
          If more receipts are encoded after this is generated, prepare it again: the draft is
          rebuilt from scratch. A report that has already been certified is never overwritten.
        </Alert>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The report itself
// ---------------------------------------------------------------------------

function ranges(list: RaafSerialRange[]): string {
  if (!list || list.length === 0) return '—';
  return list.map((r) => (r.from === r.to ? r.from : `${r.from} – ${r.to}`)).join(', ');
}

function Section({ qty, list }: { qty: number; list: RaafSerialRange[] }) {
  return (
    <>
      <td className="px-2 py-1.5 text-right tabular-nums">{qty ? qty.toLocaleString('en-PH') : '—'}</td>
      <td className="px-2 py-1.5 font-mono text-2xs text-slate-600">{ranges(list)}</td>
    </>
  );
}

function RaafDetail({ raaf, onClose }: { raaf: RaafRecord; onClose: () => void }) {
  const findings = raaf.lines.filter(
    (l) => l.discrepancy || (l.gaps?.length ?? 0) > 0 || (l.duplicates?.length ?? 0) > 0,
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={raaf.raafNo ? `RAAF ${raaf.raafNo}` : 'Report of accountability (draft)'}
      description={`${raaf.officerName} — ${raaf.periodLabel}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => window.print()}>
            Print
          </Button>
        </>
      }
    >
      <Card bodyClassName="p-0" className="mb-4">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-2xs uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2 text-left" rowSpan={2}>
                  Form
                </th>
                <th className="border-l border-slate-200 px-2 py-1 text-center" colSpan={2}>
                  Beginning balance
                </th>
                <th className="border-l border-slate-200 px-2 py-1 text-center" colSpan={2}>
                  Receipt
                </th>
                <th className="border-l border-slate-200 px-2 py-1 text-center" colSpan={2}>
                  Issued
                </th>
                <th className="border-l border-slate-200 px-2 py-1 text-center" colSpan={2}>
                  Ending balance
                </th>
              </tr>
              <tr className="border-b border-slate-200 bg-slate-50 text-2xs text-slate-400">
                {['Qty', 'Serial nos.', 'Qty', 'Serial nos.', 'Qty', 'Serial nos.', 'Qty', 'Serial nos.'].map(
                  (h, i) => (
                    <th
                      key={`${h}-${i}`}
                      className={`px-2 pb-1.5 ${i % 2 === 0 ? 'border-l border-slate-200 text-right' : 'text-left'}`}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {raaf.lines.map((l: RaafLine) => (
                <tr key={l.formCode} className={l.discrepancy ? 'bg-rose-50/60' : undefined}>
                  <td className="px-2 py-1.5">
                    <p className="font-medium text-navy-900">{l.printedAs}</p>
                    {l.withdrawnQty > 0 && (
                      <p className="text-2xs text-amber-700">
                        {l.withdrawnQty} spoiled or cancelled: {ranges(l.withdrawnRanges)}
                      </p>
                    )}
                  </td>
                  <Section qty={l.beginningQty} list={l.beginningRanges} />
                  <Section qty={l.receiptQty} list={l.receiptRanges} />
                  <Section qty={l.issuedQty} list={l.issuedRanges} />
                  <Section qty={l.endingQty} list={l.endingRanges} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {findings.length > 0 && (
        <div className="space-y-3">
          {findings.map((l) => (
            <div key={l.formCode}>
              {l.discrepancy && (
                <Alert tone="error" title={`${l.printedAs} does not foot`}>
                  {l.discrepancy} Record the issue that put these serials in the officer&rsquo;s hands,
                  then prepare the report again.
                </Alert>
              )}
              {(l.gaps?.length ?? 0) > 0 && (
                <Alert tone="warning" title={`${l.printedAs}: serials not accounted for`} className="mt-2">
                  <p>
                    {l.gaps!.length} hole{l.gaps!.length === 1 ? '' : 's'} in the run of receipts
                    issued. A cancelled receipt leaves one, and so does a missing one &mdash; the
                    officer has to say which.
                  </p>
                  <ul className="mt-1.5 space-y-0.5 font-mono text-2xs">
                    {l.gaps!.slice(0, 8).map((g) => (
                      <li key={`${g.after}-${g.before}`}>
                        after {g.after}: {g.missing} missing, next is {g.before}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
              {(l.duplicates?.length ?? 0) > 0 && (
                <Alert tone="warning" title={`${l.printedAs}: serials used more than once`} className="mt-2">
                  <span className="font-mono text-2xs">
                    {l.duplicates!.map((d) => `${d.serial} (${d.times}×)`).join(', ')}
                  </span>
                </Alert>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 grid gap-6 border-t border-slate-200 pt-4 text-xs sm:grid-cols-2">
        <div>
          <p className="text-2xs uppercase tracking-wide text-slate-400">Prepared by</p>
          <p className="mt-6 border-t border-slate-400 pt-1 font-medium text-navy-900">
            {raaf.preparedBy?.name ?? ''}
          </p>
        </div>
        <div>
          <p className="text-2xs uppercase tracking-wide text-slate-400">Certified correct</p>
          <p className="mt-6 border-t border-slate-400 pt-1 font-medium text-navy-900">
            {raaf.certifiedBy?.name ?? raaf.officerName}
          </p>
          <p className="text-2xs text-slate-500">{raaf.officerPosition ?? 'Accountable Officer'}</p>
        </div>
      </div>
    </Modal>
  );
}
