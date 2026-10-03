import { useMemo, useRef, useState } from 'react';
import { PageHeader, Card, Alert, EmptyState } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, TextInput, DateInput, Select, TextArea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useTreasuryImports, useUnpaidVouchers } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import {
  IMPORT_ROW_REASON_LABELS,
  type TreasuryImport,
  type TreasuryImportRow,
} from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { PAYMENT_TABS } from './sections';
import { parsePaymentFile, type ParsedRow } from './parsePayments';

/**
 * Uploading the Treasurer's own RCI and RADAI files.
 *
 * The office already produces these reports correctly, in another system. This
 * screen reads one and turns it into a draft report in CFMS, raising a check or
 * an ADA against each voucher the file names.
 *
 * What it does not do is decide anything. The browser splits the file into rows
 * and shows what it read; every judgment about whether a row can be posted is
 * made on the server against CFMS's own records, and the amount that reaches the
 * books is the voucher's, not the file's. If this page and the engine ever
 * disagree, the engine is right - that is the point of it being there.
 *
 * The second half of the screen is the part that will be used most. A row the
 * engine could not place is held, not rejected, and it sits here until somebody
 * links it to the right voucher or sets it aside with a note. The report cannot
 * be certified until that list is empty, so nothing gets lost by being lenient
 * at upload time.
 */

export default function PaymentUploads({ importType }: { importType: 'RCI' | 'RADAI' }) {
  const { fiscalYear, fundCode } = useFilters();
  const { can } = useAuth();

  const isRci = importType === 'RCI';
  const noun = isRci ? 'check' : 'ADA';

  const { data, loading, error } = useTreasuryImports(importType, fiscalYear, fundCode);
  const [open, setOpen] = useState<TreasuryImport | null>(null);

  // Firestore has no live-document hook here, so the open batch is re-read from
  // the list, which the subscription keeps current. Resolving a row updates the
  // document; this is what makes the modal show it.
  const current = open ? (data.find((b) => b.id === open.id) ?? open) : null;

  const canUpload = can('treasury', 'create');

  const columns: Column<TreasuryImport>[] = [
    {
      key: 'uploadedAt',
      header: 'Uploaded',
      width: '10rem',
      value: (b) => b.uploadedAt,
      cell: (b) => (
        <div className="text-xs">
          <span className="block">{formatShortDate(b.uploadedAt.slice(0, 10))}</span>
          <span className="text-slate-500">{b.uploadedByName}</span>
        </div>
      ),
    },
    {
      key: 'fileName',
      header: 'File',
      value: (b) => b.fileName ?? '',
      cell: (b) => (
        <div className="text-sm">
          <span className="block">{b.fileName ?? 'Uploaded file'}</span>
          <span className="text-xs text-slate-500">
            {b.rowCount} row{b.rowCount === 1 ? '' : 's'} for {formatShortDate(b.reportDate)}
            {b.adaNo ? ` - ADA ${b.adaNo}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'matched',
      header: 'Posted',
      align: 'right',
      width: '11rem',
      value: (b) => b.matchedTotal,
      cell: (b) => (
        <div className="text-right text-xs">
          <span className="cbo-amount block">{formatPeso(b.matchedTotal)}</span>
          <span className="text-slate-500">
            {b.matchedCount} {noun}
            {b.matchedCount === 1 ? '' : 's'}
          </span>
        </div>
      ),
    },
    {
      key: 'pending',
      header: 'Held',
      align: 'right',
      width: '11rem',
      value: (b) => b.pendingCount,
      cell: (b) =>
        b.pendingCount > 0 ? (
          <div className="text-right text-xs">
            <span className="cbo-amount block text-amber-700">{formatPeso(b.pendingTotal)}</span>
            <span className="text-amber-700">
              {b.pendingCount} row{b.pendingCount === 1 ? '' : 's'}
            </span>
          </div>
        ) : (
          <span className="block text-right text-xs text-slate-400">-</span>
        ),
    },
    {
      key: 'status',
      header: '',
      width: '12rem',
      sortable: false,
      fixed: true,
      value: (b) => b.status,
      cell: (b) => (
        <div className="flex items-center justify-end gap-1.5">
          <StatusBadge status={b.status} />
          <Button size="sm" onClick={() => setOpen(b)}>
            {b.pendingCount > 0 ? 'Resolve' : 'View'}
          </Button>
        </div>
      ),
    },
  ];

  const held = data.filter((b) => b.status === 'PENDING');

  return (
    <div>
      <PageHeader
        title={`Upload ${isRci ? 'RCI' : 'RADAI'}`}
        subtitle={
          isRci
            ? "The Report of Checks Issued as the Treasurer's office produces it. Each row names the voucher its check paid; CFMS raises the check against that voucher and builds the RCI from what it could place."
            : "The Report of ADA Issued as the Treasurer's office produces it. One ADA number covers the whole batch sent to the bank, and each row names the voucher it paid."
        }
        breadcrumbs={[{ label: 'Treasury' }, { label: isRci ? 'Checks' : 'ADA' }, { label: 'Upload' }]}
      />

      <SectionTabs tabs={PAYMENT_TABS} />

      {held.length > 0 && (
        <Alert tone="warning" title="Rows waiting to be dealt with" className="mb-4">
          {held.reduce((s, b) => s + b.pendingCount, 0)} row
          {held.reduce((s, b) => s + b.pendingCount, 0) === 1 ? '' : 's'} across{' '}
          {held.length} upload{held.length === 1 ? '' : 's'} could not be matched to a voucher. The
          report each belongs to cannot be certified until every one of them is either linked to the
          voucher it paid or set aside with a note.
        </Alert>
      )}

      {canUpload && (
        <UploadForm
          importType={importType}
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onDone={(batchId) => {
            const batch = data.find((b) => b.id === batchId);
            if (batch) setOpen(batch);
          }}
        />
      )}

      <Card title="Uploads" className="mt-4">
        <DataTable
          rows={data}
          columns={columns}
          rowKey={(b) => b.id}
          loading={loading}
          error={error}
          searchPlaceholder="File name"
          emptyTitle="Nothing uploaded yet"
          emptyMessage={`No ${importType} file has been uploaded for ${fundLabel(fundCode)}, fiscal year ${fiscalYear}.`}
        />
      </Card>

      {current && <BatchDialog batch={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The upload form
// ---------------------------------------------------------------------------

function UploadForm({
  importType,
  fiscalYear,
  fundCode,
  onDone,
}: {
  importType: 'RCI' | 'RADAI';
  fiscalYear: number;
  fundCode: string;
  onDone: (batchId: string) => void;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const isRci = importType === 'RCI';

  const [reportDate, setReportDate] = useState(todayPh());
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [adaNo, setAdaNo] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [busy, setBusy] = useState(false);

  const sendable = rows.filter((r) => !r.problem);
  const unreadable = rows.filter((r) => r.problem);
  const willHold = sendable.filter((r) => r.willHold);
  const total = sendable.reduce((s, r) => s + r.amount, 0);

  const read = async (file: File) => {
    try {
      const parsed = await parsePaymentFile(file, importType);
      if (!parsed.length) {
        toast.error('Nothing to read', 'No payment rows were found in the first sheet of that file.');
        return;
      }
      setRows(parsed);
      setFileName(file.name);
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : String(err));
    }
  };

  const upload = async () => {
    if (!bankAccountId || !sendable.length) return;
    setBusy(true);
    try {
      const res = await engine.importTreasuryPayments({
        importType,
        fiscalYear,
        fundCode,
        reportDate,
        bankAccountId,
        adaNo: isRci ? undefined : adaNo.trim(),
        fileName,
        rows: sendable.map((r) => ({
          lineNo: r.lineNo,
          date: r.date,
          serialNo: r.serialNo || undefined,
          dvNo: r.dvNo,
          obrNo: r.obrNo || undefined,
          payeeName: r.payeeName || undefined,
          particulars: r.particulars || undefined,
          responsibilityCenter: r.responsibilityCenter || undefined,
          amount: r.amount,
        })),
      });

      if (res.pendingCount > 0) {
        toast.warning(
          `${res.matchedCount} of ${res.rowCount} rows posted`,
          `${formatPeso(res.matchedTotal)} raised against vouchers. ${res.pendingCount} row${res.pendingCount === 1 ? '' : 's'} totalling ${formatPeso(res.pendingTotal)} could not be matched and ${res.pendingCount === 1 ? 'is' : 'are'} being held. The report cannot be certified until they are dealt with.`,
        );
      } else {
        toast.success(
          `${importType} draft prepared`,
          `${res.matchedCount} ${isRci ? 'check' : 'ADA'}${res.matchedCount === 1 ? '' : 's'} raised, ${formatPeso(res.matchedTotal)}. Certify it when the office is ready to forward it.`,
        );
      }

      setRows([]);
      setFileName('');
      setAdaNo('');
      if (fileInput.current) fileInput.current.value = '';
      onDone(res.importId);
    } catch (err) {
      toast.error('The upload was refused', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`New ${importType} upload`}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field
          label="Report date"
          required
          hint="The date the report covers. It decides the accounting period."
        >
          <DateInput value={reportDate} onChange={setReportDate} />
        </Field>

        <Field label="Bank account" required hint="The account the payments were drawn on.">
          <BankAccountPicker value={bankAccountId} fundCode={fundCode} onChange={setBankAccountId} />
        </Field>

        {isRci ? (
          <Field label="Check numbers" hint="Read from the file, one per row.">
            <div className="rounded border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500">
              From the serial number column
            </div>
          </Field>
        ) : (
          <Field
            label="ADA number"
            required
            hint="One number covers the whole batch sent to the bank, so it is on the report rather than in the rows."
          >
            <TextInput
              value={adaNo}
              onChange={(e) => setAdaNo(e.target.value)}
              placeholder="2026-09-0310"
            />
          </Field>
        )}
      </div>

      <div className="mt-4">
        <Field
          label="The file"
          hint="A .csv, .xls or .xlsx exported from the Treasurer's system. Column headings are matched loosely, and a column still headed CAFOA is read as the obligation number."
        >
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.xls,.xlsx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file);
            }}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-navy-900 file:px-3 file:py-2 file:text-sm file:text-white hover:file:bg-navy-800"
          />
        </Field>
      </div>

      {rows.length > 0 && (
        <div className="mt-4">
          {unreadable.length > 0 && (
            <Alert tone="error" title="Rows that cannot be read" className="mb-3">
              {unreadable.length} row{unreadable.length === 1 ? '' : 's'} have no amount or no
              readable date and will not be sent: row{unreadable.length === 1 ? '' : 's'}{' '}
              {unreadable.map((r) => r.lineNo).join(', ')}. Correct them in the file and upload it
              again, or they will be missing from the report.
            </Alert>
          )}

          {willHold.length > 0 && (
            <Alert tone="warning" title="Rows that will be held" className="mb-3">
              {willHold.length} row{willHold.length === 1 ? '' : 's'} have no DV number
              {isRci ? ' or no check number' : ''} and cannot be matched to a voucher. They will be
              uploaded and held for manual handling rather than dropped.
            </Alert>
          )}

          <PreviewTable rows={rows} isRci={isRci} />

          <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
            <p className="text-sm text-slate-600">
              {sendable.length} row{sendable.length === 1 ? '' : 's'} to upload, totalling{' '}
              <strong className="cbo-amount">{formatPeso(total)}</strong> as the file states it. What
              reaches the books is each voucher&rsquo;s own net amount.
            </p>
            <Button
              variant="primary"
              loading={busy}
              disabled={!bankAccountId || !sendable.length || (!isRci && !adaNo.trim())}
              onClick={() => void upload()}
            >
              Upload {sendable.length} row{sendable.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PreviewTable({ rows, isRci }: { rows: ParsedRow[]; isRci: boolean }) {
  return (
    <div className="max-h-80 overflow-auto rounded border border-slate-200">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
          <tr>
            <th className="px-2 py-1.5 font-medium">Row</th>
            <th className="px-2 py-1.5 font-medium">Date</th>
            {isRci && <th className="px-2 py-1.5 font-medium">Check No.</th>}
            <th className="px-2 py-1.5 font-medium">DV No.</th>
            <th className="px-2 py-1.5 font-medium">OBR No.</th>
            <th className="px-2 py-1.5 font-medium">Payee</th>
            <th className="px-2 py-1.5 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr
              key={r.lineNo}
              className={r.problem ? 'bg-rose-50' : r.willHold ? 'bg-amber-50' : undefined}
            >
              <td className="px-2 py-1.5 text-slate-500">{r.lineNo}</td>
              <td className="px-2 py-1.5">{r.date || <span className="text-rose-600">-</span>}</td>
              {isRci && <td className="px-2 py-1.5 font-mono">{r.serialNo || '-'}</td>}
              <td className="px-2 py-1.5 font-mono">{r.dvNo || '-'}</td>
              <td className="px-2 py-1.5 font-mono text-slate-500">{r.obrNo || '-'}</td>
              <td className="px-2 py-1.5">
                {r.payeeName}
                {(r.problem || r.willHold) && (
                  <span className="ml-2 text-[11px] text-slate-500">({r.problem ?? r.willHold})</span>
                )}
              </td>
              <td className="cbo-amount px-2 py-1.5 text-right">
                {formatPeso(r.amount, { symbol: false })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One upload, and its held rows
// ---------------------------------------------------------------------------

function BatchDialog({ batch, onClose }: { batch: TreasuryImport; onClose: () => void }) {
  const [resolving, setResolving] = useState<TreasuryImportRow | null>(null);
  const pending = batch.rows.filter((r) => r.status === 'PENDING');

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${batch.importType} upload${batch.fileName ? ` - ${batch.fileName}` : ''}`}
      description={`${batch.rowCount} rows for ${formatShortDate(batch.reportDate)}. ${batch.matchedCount} posted, ${batch.pendingCount} held.`}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {batch.pendingCount === 0 ? (
        <Alert tone="success" className="mb-4">
          Every row of this file has been dealt with. The draft {batch.importType} it produced is
          ready to be certified.
        </Alert>
      ) : (
        <Alert tone="warning" className="mb-4">
          {batch.pendingCount} row{batch.pendingCount === 1 ? '' : 's'} totalling{' '}
          {formatPeso(batch.pendingTotal)} have not reached the books. Link each to the voucher it
          paid, or set it aside with a note saying how it was handled. The {batch.importType} cannot
          be certified until this list is empty.
        </Alert>
      )}

      <div className="overflow-auto rounded border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-2 py-1.5 font-medium">Row</th>
              <th className="px-2 py-1.5 font-medium">Date</th>
              <th className="px-2 py-1.5 font-medium">{batch.importType === 'RCI' ? 'Check' : 'ADA'}</th>
              <th className="px-2 py-1.5 font-medium">DV No.</th>
              <th className="px-2 py-1.5 font-medium">Payee</th>
              <th className="px-2 py-1.5 text-right font-medium">Amount</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batch.rows.map((row) => (
              <tr key={row.lineNo} className={row.status === 'PENDING' ? 'bg-amber-50' : undefined}>
                <td className="px-2 py-1.5 text-slate-500">{row.lineNo}</td>
                <td className="px-2 py-1.5">{formatShortDate(row.date)}</td>
                <td className="px-2 py-1.5 font-mono">{row.sourceNo ?? row.serialNo ?? '-'}</td>
                <td className="px-2 py-1.5 font-mono">{row.dvNo || '-'}</td>
                <td className="px-2 py-1.5">{row.payeeName ?? '-'}</td>
                <td className="cbo-amount px-2 py-1.5 text-right">
                  {formatPeso(row.amount, { symbol: false })}
                </td>
                <td className="px-2 py-1.5">
                  {row.status === 'MATCHED' && <span className="text-emerald-700">Posted</span>}
                  {row.status === 'MANUAL' && (
                    <span className="text-slate-500">Set aside - {row.note}</span>
                  )}
                  {row.status === 'PENDING' && (
                    <div className="flex items-center gap-2">
                      <span className="text-amber-800">
                        {row.reason ? IMPORT_ROW_REASON_LABELS[row.reason] : 'Held'}
                      </span>
                      <Button size="sm" onClick={() => setResolving(row)}>
                        Resolve
                      </Button>
                    </div>
                  )}
                  {row.detail && <span className="block text-[11px] text-slate-500">{row.detail}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pending.length === 0 && batch.rows.length === 0 && (
        <EmptyState title="Nothing in this upload" message="The file produced no rows." />
      )}

      {resolving && (
        <ResolveDialog batch={batch} row={resolving} onClose={() => setResolving(null)} />
      )}
    </Modal>
  );
}

/**
 * Dealing with one held row.
 *
 * The two answers are kept visibly different because they mean different
 * things. Linking says the payment belongs in the books and names the voucher
 * it settles; setting aside says it does not belong in this report and records
 * why, which is what somebody reading the report a year later will need.
 *
 * The voucher list offers the ones whose net matches the row first. That is a
 * convenience for the eye only - the engine re-checks the amount, the fund, the
 * approval and whether the voucher has already been paid, and refuses on any of
 * them regardless of what was chosen here.
 */
function ResolveDialog({
  batch,
  row,
  onClose,
}: {
  batch: TreasuryImport;
  row: TreasuryImportRow;
  onClose: () => void;
}) {
  const toast = useToast();
  const vouchers = useUnpaidVouchers(batch.fiscalYear, batch.fundCode);

  const [action, setAction] = useState<'LINK' | 'SET_ASIDE'>('LINK');
  const [dvId, setDvId] = useState('');
  const [serialNo, setSerialNo] = useState(row.serialNo ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const choices = useMemo(() => {
    const unpaid = vouchers.data.filter((dv) => !dv.checkId && !dv.adaId);
    // Same amount first, then the rest by date. The row's own DV number is
    // usually the one that was not found, so matching by figure is the next
    // most useful thing to put in front of somebody.
    return [...unpaid].sort((a, b) => {
      const aMatch = a.netAmount === row.amount ? 0 : 1;
      const bMatch = b.netAmount === row.amount ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return b.dvDate.localeCompare(a.dvDate);
    });
  }, [vouchers.data, row.amount]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await engine.resolveImportRow({
        importId: batch.id,
        lineNo: row.lineNo,
        action,
        dvId: action === 'LINK' ? dvId : undefined,
        serialNo: action === 'LINK' && batch.importType === 'RCI' ? serialNo.trim() : undefined,
        note: note.trim() || undefined,
      });
      toast.success(
        action === 'LINK' ? 'Row linked and posted' : 'Row set aside',
        res.pendingCount > 0
          ? `${res.pendingCount} row${res.pendingCount === 1 ? '' : 's'} still waiting.`
          : `Every row has now been dealt with. The ${batch.importType} can be certified.`,
      );
      onClose();
    } catch (err) {
      toast.error('Could not resolve this row', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    action === 'SET_ASIDE'
      ? note.trim().length > 0
      : Boolean(dvId) && (batch.importType !== 'RCI' || serialNo.trim().length > 0);

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Row ${row.lineNo} - ${formatPeso(row.amount)}`}
      description={
        row.detail ??
        (row.reason ? IMPORT_ROW_REASON_LABELS[row.reason] : 'This row could not be placed.')
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            {action === 'LINK' ? 'Link and post' : 'Set aside'}
          </Button>
        </>
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded bg-slate-50 p-3 text-xs">
        <dt className="text-slate-500">In the file</dt>
        <dd className="text-right font-mono">{row.dvNo || 'no DV number'}</dd>
        <dt className="text-slate-500">Payee</dt>
        <dd className="text-right">{row.payeeName ?? '-'}</dd>
        <dt className="text-slate-500">Date</dt>
        <dd className="text-right">{formatShortDate(row.date)}</dd>
        {row.obrNo && (
          <>
            <dt className="text-slate-500">OBR No.</dt>
            <dd className="text-right font-mono">{row.obrNo}</dd>
          </>
        )}
      </dl>

      <Field label="What should happen to this row" required>
        <Select value={action} onChange={(e) => setAction(e.target.value as 'LINK' | 'SET_ASIDE')}>
          <option value="LINK">Link it to the voucher it paid</option>
          <option value="SET_ASIDE">Set it aside - handled outside CFMS</option>
        </Select>
      </Field>

      {action === 'LINK' ? (
        <>
          <Field
            label="Disbursement voucher"
            required
            className="mt-4"
            hint="Approved vouchers in this fund with no payment recorded yet. Ones whose net matches this row are listed first."
          >
            <Select value={dvId} onChange={(e) => setDvId(e.target.value)}>
              <option value="">Choose the voucher</option>
              {choices.map((dv) => (
                <option key={dv.id} value={dv.id}>
                  {dv.dvNo} - {dv.payeeName} - {formatPeso(dv.netAmount, { symbol: false })}
                  {dv.netAmount === row.amount ? ' (same amount)' : ''}
                </option>
              ))}
            </Select>
          </Field>

          {batch.importType === 'RCI' && (
            <Field
              label="Check number"
              required
              className="mt-4"
              hint="As written on the check. It must not already exist on this bank account."
            >
              <TextInput value={serialNo} onChange={(e) => setSerialNo(e.target.value)} />
            </Field>
          )}

          <Alert tone="info" className="mt-4">
            The amount posted is the voucher&rsquo;s net, not the figure in the file. If the two
            disagree the engine refuses, and the voucher has to be corrected first.
          </Alert>
        </>
      ) : (
        <Field
          label="How this payment was handled"
          required
          className="mt-4"
          hint="Recorded on the upload and in the audit trail. This is what the report is read against when somebody asks why it totals less than the file."
        >
          <TextArea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Posted on the August RCI; the check was drawn in the prior period."
          />
        </Field>
      )}

      {action === 'LINK' && (
        <Field label="Note" className="mt-4" hint="Optional.">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}
