import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useFunds, useRevenueCodes } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from './sections';
import { parseAbstractFile, revenueCodesUsed, type AbstractReceipt } from './parseAbstract';

/**
 * Uploading the Abstract of Collections.
 *
 * Three things this screen does before anything is sent, because each one is a
 * question the file cannot answer by itself.
 *
 * It groups the rows into receipts. The abstract writes a line per revenue
 * account, so a receipt for two things appears twice; 823 rows are 694
 * receipts, and the count is shown so the office can see that.
 *
 * It asks which CFMS fund each of the file's fund labels means. The file says
 * "GF Proper" and "TF"; CFMS has fund codes. Guessing at that mapping is how a
 * month of trust-fund collections quietly lands in the General Fund, so the
 * screen asks instead - two dropdowns, once.
 *
 * And it checks every revenue code against the mapping, and names the ones that
 * are missing. That check is repeated on the server, which is the one that
 * counts; doing it here means the office sees all twelve at once rather than
 * finding them one upload at a time.
 */

/** Receipts per call to the engine. Matches the server's own ceiling. */
const CHUNK = 300;

export default function AbstractUpload() {
  const { fiscalYear } = useFilters();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const funds = useFunds();
  const revenueCodes = useRevenueCodes();

  const [receipts, setReceipts] = useState<AbstractReceipt[]>([]);
  const [fileName, setFileName] = useState('');
  const [fundMap, setFundMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  /*
   * Patch 156: the same upload for e-collections. "?kind=EOR" or "?kind=AR"
   * (the e-Collections screen's Bulk upload) opens it on that kind.
   */
  const [params] = useSearchParams();
  const [kind, setKind] = useState<'' | 'EOR' | 'AR'>(() => {
    const k = (params.get('kind') ?? '').toUpperCase();
    return k === 'EOR' || k === 'AR' ? k : '';
  });

  /** The fund labels the file itself uses, in the order they first appear. */
  const fileFunds = useMemo(() => {
    const seen: string[] = [];
    for (const r of receipts) if (r.fund && !seen.includes(r.fund)) seen.push(r.fund);
    return seen;
  }, [receipts]);

  const mapped = useMemo(() => {
    const known = new Set(revenueCodes.data.map((c) => (c.code ?? c.id).trim().toUpperCase()));
    const used = revenueCodesUsed(receipts);
    const missing = [...used.entries()].filter(([code]) => !known.has(code.trim().toUpperCase()));
    return { used, missing };
  }, [receipts, revenueCodes.data]);

  const broken = receipts.filter((r) => r.problem);
  const cancelled = receipts.filter((r) => r.cancelled);
  const total = receipts.reduce((s, r) => s + r.totalAmount, 0);
  const unassignedFunds = fileFunds.filter((f) => !fundMap[f]);

  const ready =
    receipts.length > 0 &&
    broken.length === 0 &&
    mapped.missing.length === 0 &&
    unassignedFunds.length === 0;

  const read = async (file: File) => {
    try {
      const parsed = (await parseAbstractFile(file)).map((r) => {
        // An e-collection file need not carry a report reference.
        if (!kind || !r.problem) return r;
        const rest = r.problem
          .split(', ')
          .filter((p) => p !== 'no report reference')
          .join(', ');
        return { ...r, problem: rest || undefined };
      });
      if (!parsed.length) {
        toast.error('Nothing to read', 'No receipts were found in the first sheet of that file.');
        return;
      }
      setReceipts(parsed);
      setFileName(file.name);
      setFundMap({});
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : String(err));
    }
  };

  const post = async () => {
    if (!ready) return;
    setBusy(true);
    let posted = 0;
    let skipped = 0;
    let amount = 0;
    const officers = new Set<string>();

    try {
      // One call per fund: the receipts of a fund go into that fund's books,
      // and the server checks the period and the caller's scope per fund.
      for (const label of fileFunds) {
        const code = fundMap[label];
        const forFund = receipts.filter((r) => r.fund === label);

        for (let i = 0; i < forFund.length; i += CHUNK) {
          const chunk = forFund.slice(i, i + CHUNK);
          setProgress(`${label}: ${i + 1} to ${i + chunk.length} of ${forFund.length}`);

          const res = await engine.importCollections({
            fiscalYear,
            fundCode: code,
            fileName,
            ...(kind ? { eCollectionKind: kind } : {}),
            receipts: chunk.map((r) => ({
              lineNo: r.lineNo,
              date: r.date,
              reportRef: r.reportRef,
              accountableForm: r.accountableForm || undefined,
              orNumber: r.orNumber,
              payor: r.payor || undefined,
              collector: r.collector || undefined,
              cancelled: r.cancelled,
              remarks: r.remarks || undefined,
              lines: r.lines.map((l) => ({
                revenueCode: l.revenueCode,
                description: l.description || undefined,
                amount: l.amount,
              })),
            })),
          });
          posted += res.posted;
          skipped += res.skipped;
          amount += res.total;
          for (const o of res.unknownOfficers) officers.add(o);
        }
      }

      toast.success(
        `${posted} receipt${posted === 1 ? '' : 's'} recorded`,
        `${formatPeso(amount)}${skipped ? `, ${skipped} already in the books and left alone` : ''}.` +
          (officers.size
            ? ` ${officers.size} collecting officer${officers.size === 1 ? ' is' : 's are'} not in Employees; ${officers.size === 1 ? 'the name was' : 'their names were'} kept as written.`
            : ''),
      );
      setReceipts([]);
      setFileName('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      toast.error(
        posted > 0 ? `Stopped after ${posted} receipts` : 'Nothing was posted',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div>
      <PageHeader
        title={kind ? 'Bulk upload of e-Collections' : 'Bulk upload of Collections'}
        subtitle="One row per revenue account, grouped into the receipts that were issued - the Abstract of Collections as the Treasurer's office produces it."
        breadcrumbs={[...COLLECTION_CRUMBS, { label: 'Upload' }]}
      />

      <GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />

      <Card title="New upload">
        <Field label="What the file holds" className="mb-4 max-w-md">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as '' | 'EOR' | 'AR');
              setReceipts([]);
              setFileName('');
              if (fileInput.current) fileInput.current.value = '';
            }}
          >
            <option value="">Collections - official receipts (cash, check)</option>
            <option value="EOR">e-Collections - Electronic Official Receipts (eOR)</option>
            <option value="AR">e-Collections - Intermediary Acknowledgement Receipts (AR)</option>
          </Select>
        </Field>
        <Field
          label="The file"
          hint="A .csv, .xls or .xlsx. Column headings are matched loosely; a receipt that collected two things may appear on two rows and is read as one receipt."
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

        {receipts.length > 0 && (
          <div className="mt-4 space-y-3">
            <Alert tone="info">
              <strong>{receipts.length}</strong> official receipt
              {receipts.length === 1 ? '' : 's'} totalling{' '}
              <strong className="cbo-amount">{formatPeso(total)}</strong>, across{' '}
              {new Set(receipts.map((r) => r.reportRef)).size} report reference
              {new Set(receipts.map((r) => r.reportRef)).size === 1 ? '' : 's'}
              {cancelled.length > 0 && (
                <> · {cancelled.length} cancelled, recorded at nil so the serial run stays whole</>
              )}
            </Alert>

            {fileFunds.length > 0 && (
              <Card title="Which fund is which">
                <p className="mb-3 text-sm text-slate-600">
                  The file names its own funds. Say which CFMS fund each one is - a month of trust
                  fund collections landing in the General Fund is not something the books would
                  flag afterwards.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {fileFunds.map((label) => (
                    <Field key={label} label={`"${label}" in the file`} required>
                      <Select
                        value={fundMap[label] ?? ''}
                        onChange={(e) => setFundMap((m) => ({ ...m, [label]: e.target.value }))}
                      >
                        <option value="">Choose the fund</option>
                        {funds.data.map((f) => (
                          <option key={f.code} value={f.code}>
                            {f.code} - {f.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </div>
              </Card>
            )}

            {mapped.missing.length > 0 && (
              <Alert
                tone="error"
                title={`${mapped.missing.length} revenue code${mapped.missing.length === 1 ? '' : 's'} not yet mapped`}
              >
                <p>
                  Nothing will be sent until each has a COA account against it. A collection posted
                  to a guessed account misstates the revenue, and the cash still foots - which is
                  what would make it hard to find later.
                </p>
                <p className="mt-2">
                  Add them under <strong>Master Data &rsaquo; Revenue Codes</strong>:
                </p>
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto font-mono text-xs">
                  {mapped.missing.map(([code, description]) => (
                    <li key={code}>
                      {code}
                      {description ? ` - ${description}` : ''}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            {broken.length > 0 && (
              <Alert tone="error" title={`${broken.length} receipts cannot be read`}>
                {broken
                  .slice(0, 6)
                  .map((r) => `${r.orNumber || 'row ' + r.lineNo}: ${r.problem}`)
                  .join('; ')}
                {broken.length > 6 ? `; and ${broken.length - 6} more.` : '.'}
              </Alert>
            )}

            {mapped.missing.length === 0 && broken.length === 0 && (
              <Alert tone="success">
                All {mapped.used.size} revenue codes in this file are mapped to a COA account.
              </Alert>
            )}

            <ReceiptPreview receipts={receipts} />

            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <p className="text-sm text-slate-600">
                {progress ??
                  (unassignedFunds.length
                    ? `Choose a fund for ${unassignedFunds.map((f) => `"${f}"`).join(' and ')}.`
                    : `${receipts.length} receipts ready.`)}
              </p>
              <Button variant="primary" loading={busy} disabled={!ready || busy} onClick={() => void post()}>
                Record {receipts.length} receipt{receipts.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function ReceiptPreview({ receipts }: { receipts: AbstractReceipt[] }) {
  const shown = receipts.slice(0, 200);
  return (
    <div>
      <div className="max-h-80 overflow-auto rounded border border-slate-200">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-2 py-1.5 font-medium">Date</th>
              <th className="px-2 py-1.5 font-medium">Report</th>
              <th className="px-2 py-1.5 font-medium">O.R. No.</th>
              <th className="px-2 py-1.5 font-medium">Payor</th>
              <th className="px-2 py-1.5 font-medium">Fund</th>
              <th className="px-2 py-1.5 font-medium">Lines</th>
              <th className="px-2 py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r) => (
              <tr
                key={`${r.reportRef}__${r.orNumber}`}
                className={r.problem ? 'bg-rose-50' : r.cancelled ? 'bg-slate-50 text-slate-500' : undefined}
              >
                <td className="px-2 py-1.5">{r.date ? formatShortDate(r.date) : '-'}</td>
                <td className="px-2 py-1.5 font-mono text-slate-500">{r.reportRef}</td>
                <td className="px-2 py-1.5 font-mono">{r.orNumber}</td>
                <td className="px-2 py-1.5">
                  {r.payor}
                  {r.problem && <span className="block text-[11px] text-rose-700">{r.problem}</span>}
                </td>
                <td className="px-2 py-1.5 text-slate-500">{r.fund}</td>
                <td className="px-2 py-1.5 text-slate-500">
                  {r.cancelled ? 'cancelled' : r.lines.length}
                </td>
                <td className="cbo-amount px-2 py-1.5 text-right">
                  {formatPeso(r.totalAmount, { symbol: false })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {receipts.length > shown.length && (
        <p className="mt-1 text-xs text-slate-500">
          Showing the first {shown.length} of {receipts.length}. All of them are checked and all of
          them are uploaded.
        </p>
      )}
    </div>
  );
}
