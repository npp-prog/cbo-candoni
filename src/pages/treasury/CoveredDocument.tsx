import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { DetailField, Spinner, Alert } from '@/components/ui/Layout';
import { StatusBadge } from '@/components/ui/Badge';
import { useDocument } from '@/hooks/useFirestore';
import { sourceCollectionFor } from '@/lib/treasurySources';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { InstrumentDetail } from './InstrumentDetail';
import type { Instrument } from './InstrumentDetail';
import { CollectionDetail } from './CollectionDetail';
import type { TreasuryReportType } from '@/types/enums';
import type { Collection } from '@/types/treasury';
import type { Payroll } from '@/types/accounting';

/**
 * The document a line of a treasury report covers, opened from the report.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINE NEEDED TO BE CLICKABLE
 * ---------------------------------------------------------------------------
 * A treasury report's Documents Covered tab lists the number, the date, the
 * payee and the amount - four columns, because four is what the report itself
 * prints. That is enough to certify against, and it is not enough to answer
 * the question an Accountant actually has when a report arrives.
 *
 * "Check 123459, 4,955.36 to ABC Trading" does not say which voucher it paid,
 * which obligation that voucher drew on, what was withheld from it, or whether
 * the check has since been cancelled. Every one of those is already in CFMS,
 * one click away on the Checks register - but getting there meant leaving the
 * report, finding the register, filtering it to the right month, and finding
 * the serial by eye. So in practice nobody looked, and a report was journalized
 * on four columns.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT IS THE SAME PANEL, NOT A NEW ONE
 * ---------------------------------------------------------------------------
 * The panels already exist: a clerk on the Checks register opens exactly this
 * for a check, and on Collections exactly this for a receipt. Writing a second
 * one here would be a second answer to "what does CFMS know about this check",
 * and the second answer is the one that falls behind - a field added to the
 * register's panel next year would simply be missing from the report's.
 *
 * So this component is only a dispatcher. It works out which collection the
 * report's lines point into, fetches the ONE document, and hands it to the
 * panel that already knows how to show it.
 *
 * ---------------------------------------------------------------------------
 * ONE DOCUMENT, NOT A LIST
 * ---------------------------------------------------------------------------
 * The registers load a year of records because they are lists. This is not: it
 * reads the single document whose line was clicked, and reads nothing at all
 * until one is. A report with two hundred lines costs exactly as much to open
 * as a report with two.
 */

export function CoveredDocument({
  reportType,
  sourceId,
  sourceNo,
  onClose,
}: {
  reportType: TreasuryReportType;
  /** The document the clicked line covers, or null when nothing is open. */
  sourceId: string | null;
  sourceNo?: string;
  onClose: () => void;
}) {
  /*
    Which register to look in. From the file the ENGINE reads too - it is the
    same question, and a second copy here would not fail loudly if it drifted.
    See src/lib/treasurySources.ts.
  */
  const path = sourceId ? sourceCollectionFor(reportType) : null;
  const { data, loading, exists } = useDocument<Record<string, unknown>>(path ?? null, sourceId);

  if (!sourceId) return null;

  /*
   * Loading and missing are shown in a dialog of their own rather than by
   * rendering nothing. A click that appears to do nothing reads as a broken
   * screen, and a covered document that has been deleted is worth saying out
   * loud - it means a certified report names something that is no longer there.
   */
  if (loading) {
    return (
      <Modal open onClose={onClose} title={sourceNo ?? 'Document'} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
        <Spinner label="Reading the document" />
      </Modal>
    );
  }

  if (!exists || !data) {
    return (
      <Modal
        open
        onClose={onClose}
        title={sourceNo ?? 'Document'}
        size="lg"
        footer={<Button onClick={onClose}>Close</Button>}
      >
        <Alert tone="warning" title="That document is no longer in CFMS">
          The report still names {sourceNo ? <strong>{sourceNo}</strong> : 'it'} and still counts
          its amount in the total. If the report has been certified, this is worth raising: a
          certified report should not name a record that has been removed.
        </Alert>
      </Modal>
    );
  }

  if (reportType === 'RCI' || reportType === 'RADAI') {
    /*
      `kind` is not stored on the document - it is how the panel tells a check
      from an advice, and the register that opens it supplies it. The report
      type is the same fact said another way, so it supplies it here.
    */
    const instrument = {
      kind: reportType === 'RCI' ? 'CHECK' : 'ADA',
      ...data,
    } as unknown as Instrument;
    return <InstrumentDetail instrument={instrument} onClose={onClose} />;
  }

  if (reportType === 'RCDISB') {
    return <PayrollDetail payroll={data as unknown as Payroll} onClose={onClose} />;
  }

  /*
   * A receipt covered by a report is never correctable from here, and that is
   * not a limitation of this screen: a receipt any report has claimed is frozen
   * until the report releases it, which is what `collectionEditable` enforces
   * and what the panel prints in place of the button. Correcting one is done on
   * the Collections register, after the report that holds it is withdrawn.
   */
  return (
    <CollectionDetail
      collection={data as unknown as Collection}
      canEdit={false}
      onEdit={() => {}}
      onClose={onClose}
    />
  );
}

/**
 * A payroll, read-only.
 *
 * The one covered document with no panel of its own, because the Payroll
 * screen only ever needed a form for making one. It is a short record and the
 * figures that matter are the three totals: what was earned, what was withheld,
 * and what was actually paid out - which is the figure the RCDisb reports and
 * the only one of the three that is cash.
 */
function PayrollDetail({ payroll, onClose }: { payroll: Payroll; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={`Payroll ${payroll.payrollNo}`}
      description={`${formatPeso(payroll.totalNet)} paid out${
        payroll.officeName ? ` - ${payroll.officeName}` : ''
      }`}
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <DetailField label="Period covered">
          {formatShortDate(payroll.periodFrom)} to {formatShortDate(payroll.periodTo)}
        </DetailField>
        <DetailField label="Office">{payroll.officeName || '-'}</DetailField>
        <DetailField label="Status">
          <StatusBadge status={String((payroll as { status?: string }).status ?? 'RECORDED')} />
        </DetailField>

        <DetailField label="Gross">{formatPeso(payroll.totalGross)}</DetailField>
        <DetailField label="Deductions withheld">
          {formatPeso(payroll.totalDeductions)}
        </DetailField>
        <DetailField label="Net paid">{formatPeso(payroll.totalNet)}</DetailField>

        <DetailField label="Voucher" mono>
          {payroll.dvNo ?? '-'}
        </DetailField>
        <DetailField label="Obligation" mono>
          {payroll.obrNo ?? '-'}
        </DetailField>
        <DetailField label="Employees">
          {payroll.employeesCovered ||
            (payroll.employeeCount != null ? String(payroll.employeeCount) : '-')}
        </DetailField>
      </div>

      {payroll.particulars && (
        <div className="mt-4">
          <DetailField label="Particulars">{payroll.particulars}</DetailField>
        </div>
      )}
    </Modal>
  );
}
