import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, Alert, DetailField, Spinner, Tabs } from '@/components/ui/Layout';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { WorkflowTimeline } from '@/components/WorkflowTimeline';
import { SignedTotalNote } from '@/components/SignedTotalNote';
import { JournalEntryGrid, type GridLine } from '@/components/journal/JournalEntryGrid';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useAttachments, usePayees, useEmployees, useAda } from '@/data/queries';
import { buildBankPayrollFile } from '@/lib/bankUpload';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { attachmentTypesFor } from '@/lib/attachmentTypes';
import { hasDocumentNumber } from '@/lib/jevNumbers';
import { formatPeso } from '@/lib/money';
import { formatShortDate, formatInstant, monthName } from '@/lib/dates';
import { TREASURY_REPORT_LABELS, TREASURY_REPORT_SHORT } from '@/types/enums';
import type { TreasuryReport } from '@/types/treasury';
import type { JournalEntryVoucher } from '@/types/accounting';
import { SECTION_TABS } from './sections';
import { CoveredDocument } from './CoveredDocument';

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
  /*
   * The signed form. Certifying is refused without it by the engine, so the
   * button is disabled rather than offered and then refused - and the count
   * on the tab is taken from the attachments themselves, so it stays right
   * after the report is certified and the browser can no longer write to it.
   */
  const attachments = useAttachments(COL.treasuryReports, id ?? null);
  /*
   * The entry this report raised, read only so that the report can say when
   * the Accountant's correction has left the two disagreeing. Nothing on this
   * screen writes it.
   */
  const { data: jev } = useDocument<JournalEntryVoucher>(COL.jevs, report?.jevId ?? undefined);

  /*
   * The payees and employees behind an ADA report, read only to find each
   * one's account at the bank for the upload file below. Loaded only for a
   * RADAI - every other report type has no use for them and would be paying
   * for two master queries it never reads.
   */
  const isRadai = report?.reportType === 'RADAI';
  const payees = usePayees();
  const employees = useEmployees();
  /*
   * The advices this report covers, read to find out WHO each line was paid
   * to - see the note on `bankRows` below for why the report line is not
   * always enough on its own.
   */
  const ada = useAda(isRadai ? (report?.bankAccountId ?? undefined) : undefined);

  /**
   * The rows of the file the bank's application reads.
   *
   * The account number comes from the EMPLOYEE record where the payee is one,
   * and from the payee record otherwise. That order is deliberate: a payroll
   * ADA pays staff, the employee record is the one the HR office keeps current,
   * and a payee record created for somebody who is also an employee is the
   * copy more likely to be stale.
   */
  const bankRows = useMemo(() => {
    if (!isRadai || !report) return [];
    const payeeById = new Map(payees.data.map((p) => [p.id, p]));
    const employeeById = new Map(employees.data.map((e) => [e.id, e]));
    const adaById = new Map(ada.data.map((a) => [a.id, a]));

    return report.lines
      .filter((l) => !l.excluded)
      .map((l) => {
        /*
         * ---- WHICH PAYEE RECORD THIS LINE WAS PAID TO --------------------
         *
         * Two ways to find out, and the second is why this was broken.
         *
         * The report line carries `payeeId` - but only on a report prepared
         * AFTER patch 85, which is where that field was added. A report
         * prepared before it has the payee's NAME and no id, so the lookup
         * found nothing and the screen reported a payee with no account
         * number while the payee record plainly had one. That is what
         * happened to RADAI 2.
         *
         * So where the line has no id, the ADVICE it covers is asked instead.
         * `sourceId` is the advice's document id and the advice has carried
         * `payeeId` since it was first issued, so this is a join through a
         * real reference - not a guess from the name. Guessing from the name
         * is still refused, here as in the journal entry: two suppliers with
         * similar names merged into one is worse than a blank.
         */
        const advice = adaById.get(l.sourceId);
        const payeeId = l.payeeId ?? advice?.payeeId;
        const payee = payeeId ? payeeById.get(payeeId) : undefined;
        const employee = payee?.employeeId ? employeeById.get(payee.employeeId) : undefined;
        return {
          accountNumber: employee?.bankAccountNumber || payee?.bankAccountNumber || '',
          name: l.payeeName ?? payee?.name ?? '',
          amount: l.amount,
        };
      });
  }, [isRadai, report, payees.data, employees.data, ada.data]);

  const bankFile = useMemo(() => buildBankPayrollFile(bankRows), [bankRows]);
  /** Everything the account-number lookup depends on being here. */
  const lookupsLoading = payees.loading || employees.loading || ada.loading;

  /**
   * Hands the file over.
   *
   * Named for the report so a folder of them is readable, and `.csv` because
   * that is what the bank application takes. If it will not build, the screen
   * says who is missing an account number rather than producing a file that
   * the bank rejects after the upload.
   */
  const downloadBankFile = () => {
    if (!bankFile.content || !report) return;
    const blob = new Blob([bankFile.content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RADAI-${(report.reportNo ?? 'draft').replace(/[^\w.-]+/g, '-')}-bank.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const [tab, setTab] = useState<'coverage' | 'entry' | 'attachments' | 'history'>('coverage');
  const [confirm, setConfirm] = useState<
    null | 'certify' | 'withdraw' | 'journalize' | 'amend'
  >(null);
  /** The Accountant's working copy, once they start adjusting the entry. */
  const [draftEntry, setDraftEntry] = useState<GridLine[] | null>(null);
  /** Correcting the entry of a report that has already been journalized. */
  const [amendingEntry, setAmendingEntry] = useState(false);
  const [certifyNo, setCertifyNo] = useState('');
  /* The covered document whose line was clicked, if any. */
  const [opened, setOpened] = useState<{ sourceId: string; sourceNo?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const canCertify = hasRole('SUPER_ADMIN', 'MUNICIPAL_TREASURER');
  /*
   * Accounting's half of the same page.
   *
   * There were two screens for one document - this, and a pop-up in the
   * Accounting menu - and the pop-up was the only place the entry could be
   * adjusted and posted. Two screens for one report means two certify
   * dialogs, two sets of totals and two places to keep in step; and it meant
   * the Accountant could not see the signed form while deciding the entry,
   * because the form lives here.
   *
   * So one page, and the actions follow the officer: the Treasurer certifies
   * and withdraws, the Accountant adjusts the entry and journalizes.
   */
  const canJournalize = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

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

  /** What the grid shows: the Accountant's working copy, or what is stored. */
  const lines = draftEntry ?? entryLines;

  const totals = useMemo(() => {
    const debit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
    const credit = lines.reduce((sum, l) => sum + (l.credit || 0), 0);
    return { debit, credit };
  }, [lines]);

  const balanced = totals.debit === totals.credit;
  const agreesWithReport = totals.debit === (report?.totalAmount ?? 0);
  const postable = balanced && agreesWithReport && lines.every((l) => l.accountCode);

  /*
   * Who may change the entry, and when.
   *
   * BEFORE IT IS POSTED - the report is certified and waiting - the Accountant
   * adjusts the proposal and posts it.
   *
   * AFTER IT IS POSTED, the entry is in the General Ledger, and a posted entry
   * is corrected rather than edited. While the month is open CFMS does that in
   * place (patch 80); once the month is closed it is a reversing entry. Both
   * answers live on the entry, and the server decides which applies - so the
   * screen offers the correction and lets a closed month come back as a
   * refusal naming the month.
   *
   * The TOTAL is locked either way. A treasury report is a figure the
   * Treasurer signed; if that is wrong the report is withdrawn and redone.
   */
  const awaitingEntry = canJournalize && report?.status === 'CERTIFIED';
  const correctable = canJournalize && report?.status === 'JOURNALIZED' && Boolean(report?.jevId);
  const entryEditable = awaitingEntry || (correctable && amendingEntry);

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
  const hasSignedForm = attachments.data.length > 0;
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

  const journalize = async () => {
    setBusy(true);
    try {
      const res = await engine.journalizeTreasuryReport({
        reportId: report.id,
        entry: lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.debit || 0,
          credit: l.credit || 0,
          particulars: l.particulars,
          subsidiaryType: l.subsidiaryType,
          subsidiaryId: l.subsidiaryId,
          subsidiaryName: l.subsidiaryName,
        })),
      });
      toast.success(
        `JEV ${res.jevNo} posted`,
        `${short} ${res.reportNo} is journalized and in the General Ledger.`,
      );
      setDraftEntry(null);
      setConfirm(null);
    } catch (err) {
      toast.error('Could not journalize', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const amend = async (reason?: string) => {
    if (!report.jevId || !reason?.trim()) return;
    setBusy(true);
    try {
      const res = await engine.amendPostedJev({
        jevId: report.jevId,
        jevDate: report.reportDate,
        particulars: `${short} ${report.reportNo ?? ''}`.trim(),
        lines: lines.map((l, i) => ({
          lineNo: i + 1,
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.debit || 0,
          credit: l.credit || 0,
          particulars: l.particulars ?? null,
          subsidiaryType: l.subsidiaryType ?? null,
          subsidiaryId: l.subsidiaryId ?? null,
          subsidiaryName: l.subsidiaryName ?? null,
        })),
        reason: reason.trim(),
      });
      toast.success(
        `JEV ${res.jevNo} corrected`,
        `${res.replaced} ledger ${res.replaced === 1 ? 'line' : 'lines'} replaced with ${res.ledgerEntryCount}.`,
      );
      setAmendingEntry(false);
      setDraftEntry(null);
      setConfirm(null);
    } catch (err) {
      toast.error('The entry was not corrected', err instanceof Error ? err.message : String(err));
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
                disabled={!hasSignedForm}
                onClick={() => {
                  setCertifyNo(hasDocumentNumber(report.reportNo) ? (report.reportNo as string) : '');
                  setConfirm('certify');
                }}
              >
                Certify and forward
              </Button>
            )}
            {/*
              The prescribed form. Offered on the report's own page rather than
              on a row of the register, for the same reason Certify is: the form
              is what the Treasurer SIGNS, and signing a report nobody has
              opened is the thing these pages exist to stop.

              OFFERED ON EVERY TYPE, including the RCD, and on a DRAFT.

              The RCD was excluded here and sent to a register that reads the
              `rcds` collection - which stopped being written to when the RCD
              became a treasury report. So the one report the Treasurer
              certifies most often had no printable form at all, and nothing
              failed to say so. It is Appendix 34 and it renders on this
              address like the rest.

              A draft prints too. Checking the figures on paper before signing
              is how the work is done, and the printed copy carries a band on
              every page saying it is not certified, so a checking copy cannot
              become the filed one.
            */}
            <Button
              variant="secondary"
              onClick={() => navigate(`/treasury/reports/${report.id}/form`)}
            >
              Print the form
            </Button>
            {isRadai && bankRows.length > 0 && (
              <Button
                variant="secondary"
                disabled={!bankFile.content || lookupsLoading}
                title={
                  bankFile.content
                    ? 'ATM number, name and amount, for the bank application'
                    : `${bankFile.missing.length} ${
                        bankFile.missing.length === 1 ? 'payee has' : 'payees have'
                      } no account number on file`
                }
                onClick={downloadBankFile}
              >
                Download for the bank
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

      {isDraft && !hasSignedForm && (
        <Alert tone="warning" className="mb-4" title="Attach the signed form before certifying">
          <p>
            What CFMS holds is an encoding of the {short}. Certifying forwards it to Accounting,
            locks the documents it covers to it and reserves its number; the signed copy is the
            evidence that the encoding is true, and it belongs on the record before the
            certificate, not after it.
          </p>
          <p className="mt-2">
            <button
              type="button"
              onClick={() => setTab('attachments')}
              className="font-medium underline"
            >
              Attach it on the Supporting documents tab
            </button>
            . Certify and forward is refused until then, by the server as well as by this screen.
          </p>
        </Alert>
      )}

      {/*
        Held back until the advices and the master data have loaded. Shown
        while they were still arriving, this said a payee had no account
        number on the strength of a lookup that had not happened yet - which
        is how a screen tells somebody to go and fix something that is not
        broken.
      */}
      {isRadai && bankRows.length > 0 && bankFile.missing.length > 0 && !lookupsLoading && (
        <Alert
          tone="warning"
          className="mb-4"
          title={`${bankFile.missing.length} ${
            bankFile.missing.length === 1 ? 'payee has' : 'payees have'
          } no account number on file`}
        >
          <p>
            The file for the bank cannot be produced until every row has one. A blank account
            number is either rejected by the bank after the upload - which the office finds out
            about from the bank, afterwards - or, on a less careful bank application, paid into
            the account on the line above.
          </p>
          <p className="mt-2">
            Add the number under <strong>Master Data &gt; Payees</strong>, or on the employee
            record where the payee is a member of staff:{' '}
            <span className="font-medium">{bankFile.missing.join(', ')}</span>.
          </p>
        </Alert>
      )}

      <SignedTotalNote jev={jev} from="document" />

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
          { id: 'attachments', label: 'Supporting documents', count: attachments.data.length },
          { id: 'history', label: 'Approval history' },
        ]}
        active={tab}
        onChange={(next) => setTab(next as typeof tab)}
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
                  /*
                    CLICK A LINE TO OPEN WHAT IT COVERS. The four columns are
                    what the printed report shows and they are not enough to
                    journalize against: a check's voucher, the obligation
                    behind it and what was withheld from it are all in CFMS and
                    were four screens away. See CoveredDocument.
                  */
                  <tr
                    key={line.sourceId}
                    onClick={() =>
                      setOpened({ sourceId: line.sourceId, sourceNo: line.sourceNo })
                    }
                    className={`cursor-pointer hover:bg-slate-50 ${
                      line.excluded ? 'opacity-50' : ''
                    }`}
                    title="Open this document"
                  >
                    <td className="cbo-td font-mono text-xs text-brand-700 underline decoration-dotted underline-offset-2">
                      {line.sourceNo}
                    </td>
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

        <CoveredDocument
          reportType={report.reportType}
          sourceId={opened?.sourceId ?? null}
          sourceNo={opened?.sourceNo}
          onClose={() => setOpened(null)}
        />

        {tab === 'entry' && (
          <Card
            title={
              report.status === 'JOURNALIZED'
                ? 'The entry this report posted'
                : 'The entry this report proposes'
            }
          >
            <p className="mb-3 text-xs text-slate-500">
              {entryEditable
                ? 'The accounts are yours to adjust. The TOTAL is not: it must equal the amount the Treasurer certified, because the journal has to agree with the report that was signed. If the report itself is wrong, send it back rather than adjusting the figure here.'
                : report.status === 'JOURNALIZED'
                  ? 'This entry is in the General Ledger. A posted entry is never edited silently - while the month is open it can be corrected here in place, and the correction is recorded against the entry.'
                  : 'The Municipal Accountant owns this entry and may adjust the accounts before posting it. The amount is a statement of fact the Treasurer has signed.'}
            </p>

            <JournalEntryGrid
              lines={lines}
              onChange={setDraftEntry}
              fundCode={report.fundCode}
              readOnly={!entryEditable}
            />

            {correctable && !amendingEntry && (
              <div className="mt-4">
                <Button variant="secondary" onClick={() => setAmendingEntry(true)}>
                  Correct this entry
                </Button>
                <p className="mt-2 text-xs text-slate-500">
                  Allowed while {report.period ? monthName(report.period) : 'the month'} is open.
                  The ledger lines are rewritten in place and the correction is recorded against
                  the entry; once the month is closed the only correction is a reversing entry.
                </p>
              </div>
            )}

            {entryEditable && (
              <>
                {!balanced && (
                  <Alert tone="warning" className="mt-3">
                    The entry does not balance. Debits {formatPeso(totals.debit)}, credits{' '}
                    {formatPeso(totals.credit)}.
                  </Alert>
                )}
                {balanced && !agreesWithReport && (
                  <Alert tone="warning" className="mt-3">
                    The entry comes to {formatPeso(totals.debit)} but {short} {report.reportNo} was
                    certified at {formatPeso(report.totalAmount)}. The journal entry must agree
                    with the report the Treasurer signed.
                  </Alert>
                )}
                <div className="mt-4 flex gap-2">
                  {amendingEntry ? (
                    <Button
                      variant="primary"
                      onClick={() => setConfirm('amend')}
                      disabled={!postable}
                    >
                      Save the correction
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => setConfirm('journalize')}
                      disabled={!postable}
                    >
                      Post journal entry
                    </Button>
                  )}
                  {(draftEntry || amendingEntry) && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setDraftEntry(null);
                        setAmendingEntry(false);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </>
            )}
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Approval history">
            <WorkflowTimeline entityType={COL.treasuryReports} entityId={report.id} />
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
        open={confirm === 'journalize'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void journalize()}
        loading={busy}
        title={`Post the entry for ${short} ${report.reportNo ?? ''}`}
        confirmLabel="Post journal entry"
        variant="success"
        message={
          <>
            <p>
              {formatPeso(report.totalAmount)} is written to the General Ledger against the
              accounts shown. From that moment the entry is in the Trial Balance and every report
              drawn from the ledger.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The entry takes its JEV number now. A posted entry is never deleted - while the month
              is open it can be corrected on the entry itself, and after that by a reversing entry.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirm === 'amend'}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) => void amend(reason)}
        loading={busy}
        title={`Correct the entry for ${short} ${report.reportNo ?? ''}`}
        confirmLabel="Rewrite the ledger"
        variant="danger"
        requireReason
        minReasonLength={15}
        reasonLabel="What was wrong with it"
        reasonHint="Recorded against the entry, shown on the entry afterwards, and recorded as a critical audit event."
        message={
          <>
            <p>
              The ledger lines for this report's entry are replaced with what is on screen. The
              General Ledger, the Trial Balance and every report drawn from them change with it,
              and no reversing entry is made.
            </p>
            <p className="mt-2">
              The total stays at {formatPeso(report.totalAmount)} - that is the figure the
              Treasurer certified, and the journal has to agree with the report that was signed.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Allowed only while the month is open. If the server finds it closed it will refuse
              and say so, and the correction is then a reversing entry.
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
