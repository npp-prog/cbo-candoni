import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, Alert, DetailField, Spinner, Tabs } from '@/components/ui/Layout';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { JournalEntryGrid, type GridLine } from '@/components/journal/JournalEntryGrid';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { attachmentTypesFor } from '@/lib/attachmentTypes';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import { formatPeso } from '@/lib/money';
import { formatShortDate, formatInstant } from '@/lib/dates';
import { TREASURY_REPORT_LABELS, TREASURY_REPORT_SHORT } from '@/types/enums';
import type { TreasuryReport } from '@/types/treasury';
import { SECTION_TABS } from './sections';

/**
 * One treasury report, on a page of its own.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A PAGE AND NOT THE POP-UP IT USED TO BE
 * ---------------------------------------------------------------------------
 * The report could only be looked at in a dialog over the register, and a
 * dialog cannot carry an attachment. That is not a cosmetic limit: the RCI the
 * Treasurer actually submits is a SIGNED FORM, and CFMS held an encoding of it
 * with nowhere to put the signed copy. The obligation request and the voucher
 * have carried their scans since the beginning; the report that moves the same
 * money between two offices did not.
 *
 * It also fixes the order of work. The signed form is attached, THEN the
 * report is certified - which is the order the office does it in, and the
 * order that makes the certificate mean something. In the dialog, certifying
 * was the only thing you could do.
 *
 * ---------------------------------------------------------------------------
 * THE ACTIONS LIVE HERE, NOT ON THE REGISTER
 * ---------------------------------------------------------------------------
 * Certify and Withdraw were buttons on the row. They are here instead, in one
 * place, beside the documents the report covers and the entry it proposes -
 * which are the two things a Treasurer should have read before certifying.
 * Two copies of the certify dialog, one on the row and one here, would be two
 * copies to keep in step.
 */
export default function TreasuryReportDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasRole, can } = useAuth();
  const toast = useToast();

  const { data: report, loading } = useDocument<TreasuryReport>(COL.treasuryReports, id);

  const [tab, setTab] = useState<'coverage' | 'entry' | 'attachments'>('coverage');
  const [confirm, setConfirm] = useState<null | 'certify' | 'withdraw'>(null);
  const [certifyNo, setCertifyNo] = useState('');
  const [busy, setBusy] = useState(false);

  const canCertify = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER');

  const entryLines = useMemo<GridLine[]>(
    () =>
      (report?.entry ?? []).map((l, i) => ({
        lineNo: i + 1,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        particulars: l.particulars,
        subsidiaryType: l.subsidiaryType,
        subsidiaryId: l.subsidiaryId,
        subsidiaryName: l.subsidiaryName,
      })),
    [report],
  );

  if (loading) return <Spinner label="Loading the report" />;

  if (!report) {
    return (
      <Alert tone="error" title="Report not found">
        That report does not exist, or it has been deleted. It may have been a draft somebody
        discarded.
      </Alert>
    );
  }

  const short = TREASURY_REPORT_SHORT[report.reportType];
  const label = TREASURY_REPORT_LABELS[report.reportType];
  const isDraft = report.status === 'DRAFT';
  const finished = report.status === 'JOURNALIZED' || report.status === 'CANCELLED';

  const certify = async () => {
    if (!certifyNo.trim()) {
      toast.error(`The ${short} number is missing`, "Assign it from the office's own book.");
      return;
    }
    setBusy(true);
    try {
      const res = await engine.certifyTreasuryReport({
        reportId: report.id,
        reportNo: certifyNo.trim(),
      });
      toast.success(
        `${short} ${res.reportNo} certified`,
        `${res.documentCount} document${res.documentCount === 1 ? '' : 's'}, ${formatPeso(res.totalAmount)}. Accounting has been notified.`,
      );
      setConfirm(null);
    } catch (err) {
      toast.error('Could not certify', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (reason?: string) => {
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      await engine.cancelTreasuryReport({ reportId: report.id, reason: reason.trim() });
      toast.success(
        `${short} withdrawn`,
        'The documents it covered are released and can be reported again.',
      );
      setConfirm(null);
      navigate(-1);
    } catch (err) {
      toast.error('Could not withdraw it', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={hasDocumentNumber(report.reportNo) ? `${short} ${report.reportNo}` : `${short} draft`}
        subtitle={label}
        breadcrumbs={[
          { label: 'Treasury' },
          { label: short, to: SECTION_TABS[report.reportType]?.[0]?.to },
          { label: report.reportNo ?? 'Draft' },
        ]}
        actions={
          <>
            <StatusBadge status={report.status} className="mr-1" />
            {isDraft && canCertify && (
              <Button
                variant="primary"
                onClick={() => {
                  setCertifyNo(hasDocumentNumber(report.reportNo) ? (report.reportNo as string) : '');
                  setConfirm('certify');
                }}
              >
                Certify and forward
              </Button>
            )}
            {!finished && canCertify && (
              <Button variant="secondary" onClick={() => setConfirm('withdraw')}>
                Withdraw
              </Button>
            )}
          </>
        }
      />

      {isDraft && (
        <Alert tone="warning" className="mb-4" title="Attach the signed form before certifying">
          What CFMS holds is an encoding of the {short}. Certifying forwards it to Accounting and
          locks the documents it covers; the signed copy is the evidence that the encoding is true,
          and it belongs on the record before the certificate, not after it.
        </Alert>
      )}

      {report.status === 'JOURNALIZED' && (
        <Alert tone="success" className="mb-4">
          Journalized{report.jevNo ? ` as JEV ${report.jevNo}` : ''}
          {report.journalizedAt ? ` on ${formatInstant(report.journalizedAt)}` : ''}. A posted entry
          is never edited - a correction is a reversing entry in General Transactions.
        </Alert>
      )}

      {report.status === 'CANCELLED' && (
        <Alert tone="error" className="mb-4" title="Withdrawn">
          {report.cancelledReason ?? 'See the audit trail for the reason.'}
        </Alert>
      )}

      <Card className="mb-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DetailField label={`${short} number`} mono>
            {hasDocumentNumber(report.reportNo) ? report.reportNo : 'Not yet assigned'}
          </DetailField>
          <DetailField label="Report date">{formatShortDate(report.reportDate)}</DetailField>
          <DetailField label="Fund">{report.fundCode}</DetailField>
          <DetailField label={report.reportType === 'RCDISB' ? 'Cash paid' : 'Total'}>
            <span className="cbo-amount font-semibold">{formatPeso(report.totalAmount)}</span>
          </DetailField>

          {report.bankName && (
            <DetailField label="Drawn on">
              {report.bankName} {report.bankAccountNumber}
            </DetailField>
          )}
          {report.accountableOfficerName && (
            <DetailField label="Accountable officer">{report.accountableOfficerName}</DetailField>
          )}
          {report.serialFrom && (
            <DetailField label="Serials covered" mono>
              {report.serialFrom}
              {report.serialTo && report.serialTo !== report.serialFrom
                ? ` - ${report.serialTo}`
                : ''}
            </DetailField>
          )}
          {report.certifiedBy?.name && (
            <DetailField label="Certified by">
              {report.certifiedBy.name}
              {report.certifiedAt ? ` - ${formatShortDate(report.certifiedAt.slice(0, 10))}` : ''}
            </DetailField>
          )}
        </dl>
      </Card>

      <Tabs
        tabs={[
          { id: 'coverage', label: 'Documents covered', count: report.lines.length },
          { id: 'entry', label: 'Journal entry' },
          { id: 'attachments', label: 'Supporting documents' },
        ]}
        active={tab}
        onChange={(next) => setTab(next as 'coverage' | 'entry' | 'attachments')}
      />

      <div className="mt-4">
        {tab === 'coverage' && (
          <Card>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="cbo-th w-32">No.</th>
                  <th className="cbo-th w-28">Date</th>
                  <th className="cbo-th">Payee or payor</th>
                  <th className="cbo-th cbo-amount-col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {report.lines.map((line) => (
                  <tr key={line.sourceId} className={line.excluded ? 'opacity-50' : undefined}>
                    <td className="cbo-td font-mono text-xs">{line.sourceNo}</td>
                    <td className="cbo-td text-xs">{formatShortDate(line.date)}</td>
                    <td className="cbo-td">
                      {line.payeeName ?? ''}
                      {line.particulars && (
                        <span className="block text-xs text-slate-500">{line.particulars}</span>
                      )}
                      {line.excluded && (
                        <span className="block text-xs italic text-slate-500">
                          Cancelled - excluded from the total
                        </span>
                      )}
                    </td>
                    <td className="cbo-td cbo-amount">
                      {formatPeso(line.amount, { symbol: false })}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <td className="cbo-td" colSpan={3}>
                    {report.reportType === 'RCDISB' ? 'Cash paid per report' : 'Total per report'}
                  </td>
                  <td className="cbo-td cbo-amount">
                    {formatPeso(report.totalAmount, { symbol: false })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </Card>
        )}

        {tab === 'entry' && (
          <Card title="The entry this report proposes">
            <p className="mb-3 text-xs text-slate-500">
              Read-only here. The Municipal Accountant owns the entry and may adjust the accounts
              before posting it, under Accounting &gt; Treasury Reports - but not the amount, which
              is a statement of fact the Treasurer has signed.
            </p>
            <JournalEntryGrid
              lines={entryLines}
              onChange={() => undefined}
              fundCode={report.fundCode}
              readOnly
            />
          </Card>
        )}

        {tab === 'attachments' && (
          <Card title="Supporting documents">
            <AttachmentsPanel
              entityType={COL.treasuryReports}
              allowedTypes={attachmentTypesFor(COL.treasuryReports, report.reportType)}
              entityId={report.id}
              entityRef={`${short} ${report.reportNo ?? 'draft'}`}
              fiscalYear={report.fiscalYear}
              fundCode={report.fundCode}
              storageDocType={short}
              storageDocId={report.reportNo ?? report.id}
              readOnly={!can('treasury', 'edit')}
              lockedAt={report.attachmentsLockedAt ?? null}
              lockedByName={report.attachmentsLockedBy?.name ?? null}
            />
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'certify'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void certify()}
        loading={busy}
        title={`Certify ${short}`}
        confirmLabel="Certify and forward"
        message={
          <>
            <p>
              This certifies {report.lines.length}{' '}
              {report.reportType === 'RCDISB' ? 'payroll' : 'document'}
              {report.lines.length === 1 ? '' : 's'} totalling{' '}
              <strong>{formatPeso(report.totalAmount)}</strong>
              {report.reportType === 'RCDISB' ? ' paid in cash' : ''} and forwards the report to the
              Municipal Accounting Office.
            </p>
            <div className="mt-3">
              <Field label={`${short} number`} required hint="From the Treasurer's own book.">
                <TextInput
                  value={certifyNo}
                  onChange={(e) => setCertifyNo(e.target.value)}
                  placeholder="100-26-10-0001"
                  className="font-mono"
                />
              </Field>
            </div>
            <p className="mt-2">
              Once certified, the documents it covers are locked to this report and cannot be
              cancelled without withdrawing it, and this number is reserved against the report.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'withdraw'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) => void withdraw(reason)}
        loading={busy}
        title={`Withdraw ${short} ${report.reportNo ?? 'draft'}`}
        confirmLabel="Withdraw"
        variant="danger"
        requireReason
        message={
          <p>
            The report is withdrawn and the documents it covers are released, so they can be
            reported again on another one. The report itself is kept with a status of Cancelled; it
            is never deleted.
          </p>
        }
      />
    </div>
  );
}
