import { useMemo, useRef, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, DateInput, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useFilters } from '@/context/FilterContext';
import { useOffices, useAccounts } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatPeso } from '@/lib/money';
import { todayPh } from '@/lib/dates';
import { EXPENSE_CLASS_LABELS, type ExpenseClass } from '@/types/enums';
import {
  checkAugmentationExpenseClass,
  checkRealignmentSet,
  type RealignmentInstrument,
} from '@/lib/accounting-rules';
import { findSector } from '@/lib/sectors';
import { TEMPLATE_COLUMNS, downloadBudgetTemplate } from '@/lib/budgetTemplate';
import { fundLabel } from './Obligations';
import { parseBudgetFile, type ParsedBudgetRow } from './parseBudget';

/**
 * Uploading the appropriation ordinance, and allotment releases.
 *
 * One screen for both, because they are the same act on two different figures:
 * a spreadsheet the Budget Office already keeps, read line by line into the
 * budget ledger.
 *
 * The screen checks the whole file against the Chart of Accounts and the office
 * list before anything is sent, and refuses to send while any row is unusable.
 * That is not politeness - the engine applies the same rule and would reject
 * the file anyway. Doing it here means the Budget Officer sees all forty
 * problems at once and fixes them in one pass, rather than learning about them
 * one upload at a time.
 */

const KINDS = [
  { value: 'ORIGINAL', label: 'Original appropriation', hint: 'The annual budget as enacted.' },
  { value: 'SUPPLEMENTAL', label: 'Supplemental', hint: 'Additional authority enacted during the year.' },
  { value: 'CONTINUING', label: 'Continuing', hint: 'Authority carried forward from the previous year.' },
  {
    value: 'REALIGNMENT',
    label: 'Realignment',
    hint: 'Moves authority between lines. Take away with a negative amount, give with a positive one; the file must come to zero.',
  },
  { value: 'ADJUSTMENT', label: 'Adjustment', hint: 'A correction. Amounts may be negative.' },
];

/** Rows per call to the engine. Matches the server's own ceiling. */
const CHUNK = 150;

export default function BudgetUpload({ kind }: { kind: 'APPROPRIATION' | 'ALLOTMENT' }) {
  const { fiscalYear, fundCode } = useFilters();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const offices = useOffices();
  const accounts = useAccounts(false);

  const isAppropriation = kind === 'APPROPRIATION';

  const [appropriationKind, setAppropriationKind] = useState('ORIGINAL');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayPh());
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ParsedBudgetRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [showFormat, setShowFormat] = useState(false);
  const [instrument, setInstrument] = useState<RealignmentInstrument>('AUGMENTATION');

  const signed = ['REALIGNMENT', 'ADJUSTMENT'].includes(appropriationKind);
  const isRealignment = isAppropriation && appropriationKind === 'REALIGNMENT';

  /**
   * The same checks the engine makes, run here so the whole list of problems is
   * visible at once. The engine is still the authority - this only saves a
   * round trip per mistake.
   */
  const checked = useMemo(() => {
    const officeKeys = new Set<string>();
    for (const o of offices.data) {
      for (const alias of [o.code, o.name, o.shortName]) {
        if (alias) officeKeys.add(alias.trim().toUpperCase());
      }
    }
    const byCode = new Map(accounts.data.map((a) => [a.code, a]));

    return rows.map((row) => {
      if (row.problem) return row;
      const problems: string[] = [];

      if (!officeKeys.has(row.office.trim().toUpperCase())) {
        problems.push(`office "${row.office}" is not in Master Data`);
      }

      // An account code is checked only where there is one. A project line
      // carries none, and that is how the ordinance enacted it.
      const account = row.accountCode ? byCode.get(row.accountCode) : undefined;
      if (row.accountCode && !account) {
        problems.push(`account ${row.accountCode} is not in the Chart of Accounts`);
      } else if (account?.postable === false) problems.push('that account is a grouping account');
      else if (account?.active === false) problems.push('that account has been deactivated');

      const ec = row.expenseClass || account?.expenseClass || '';
      if (!['PS', 'MOOE', 'FE', 'CO'].includes(ec)) {
        problems.push('no expense classification');
      }

      // Personnel services are appropriated by object of expenditure, always.
      // A PS line whose FPP is a name rather than a code is a code left out of
      // the spreadsheet, and posting it as a project would put the year-end
      // bonus in the SRE among the capital projects.
      if (ec === 'PS' && !row.accountCode) {
        problems.push(
          `"${row.fpp}" has no account code, and personnel services are appropriated by object of expenditure`,
        );
      }

      const sector = findSector(row.sector);
      if (!row.sector) problems.push('no sector');
      else if (!sector) problems.push(`sector "${row.sector}" is not one CFMS knows`);
      else if (sector.fundingSource) {
        const service = findSector(row.serviceSector);
        if (!row.serviceSector) {
          problems.push(
            `"${sector.name}" is a funding source, not a service - name the service sector this line delivers`,
          );
        } else if (!service || service.fundingSource) {
          problems.push(`"${row.serviceSector}" is not a service sector`);
        }
      }

      if (row.amount < 0 && !(isAppropriation && signed)) {
        problems.push('a negative amount');
      }

      return { ...row, problem: problems.length ? problems.join(', ') : undefined };
    });
  }, [rows, offices.data, accounts.data, isAppropriation, signed]);

  const bad = checked.filter((r) => r.problem);
  const total = checked.reduce((s, r) => s + r.amount, 0);
  // A budget line is the office, the FPP and the object code together. Two
  // projects in one office are two lines however alike their objects.
  const lineCount = new Set(checked.map((r) => `${r.office}__${r.fpp}__${r.accountCode}`)).size;

  /**
   * A realignment is judged as a whole file, never row by row.
   *
   * The same rule runs on the server, which is the authority. Running it here
   * as well means the Budget Officer sees the figure it is out by while the
   * file is still on screen, instead of after a round trip that posts nothing.
   */
  const realignment = useMemo(() => {
    if (!isRealignment || checked.length === 0) return null;
    // `amount` is already integer centavos: parseBudgetFile reads it with
    // parsePeso, which never hands back pesos as a float.
    return checkRealignmentSet(checked.map((r) => ({ lineNo: r.lineNo, amount: r.amount })));
  }, [isRealignment, checked]);

  /**
   * An augmentation may only move savings within one expense class. Section 336
   * limits the omnibus authority to items "within the same expense class"; a
   * realignment, being an ordinance of the Sanggunian, may cross them - which
   * is what a realignment is for.
   */
  const classCheck = useMemo(
    () =>
      isRealignment && instrument === 'AUGMENTATION' && checked.length > 0
        ? checkAugmentationExpenseClass(
            checked.map((r) => ({
              lineNo: r.lineNo,
              expenseClass: r.expenseClass,
              amount: r.amount,
            })),
          )
        : null,
    [isRealignment, instrument, checked],
  );

  // A realignment goes in ONE call so the server can see the whole set. Half a
  // realignment posted and half refused would change the municipality's total
  // appropriation, which is the one thing a realignment must never do.
  /*
    AN ALLOTMENT FILE GOES IN ONE CALL TOO, since patch 110. It no longer
    releases anything: it fills prepared release orders, one per expense
    class, keyed on the release reference. Sent in pieces, the second piece
    would find the first piece's order already prepared and be refused - so
    the file goes whole, or is split by the office into separate releases
    with references of their own.
  */
  const oneCall = isRealignment || !isAppropriation;
  const tooManyForOneCall = oneCall && checked.length > CHUNK;

  const blocked =
    bad.length > 0 ||
    tooManyForOneCall ||
    (realignment !== null && !realignment.ok) ||
    (classCheck !== null && !classCheck.ok) ||
    !reference.trim();

  const read = async (file: File) => {
    try {
      const parsed = await parseBudgetFile(file);
      if (!parsed.length) {
        toast.error('Nothing to read', 'No budget lines were found in the first sheet of that file.');
        return;
      }
      setRows(parsed);
      setFileName(file.name);
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : String(err));
    }
  };

  const post = async () => {
    if (blocked || !checked.length) return;
    setBusy(true);
    let posted = 0;
    let prepared = 0;
    let amount = 0;

    // A realignment is one call; everything else is chunked.
    const step = oneCall ? checked.length : CHUNK;

    try {
      for (let i = 0; i < checked.length; i += step) {
        const chunk = checked.slice(i, i + step);
        setProgress(
          `${isAppropriation ? 'Uploading' : 'Preparing'} ${i + 1} to ${i + chunk.length} of ${checked.length}`,
        );

        const res = await engine.importBudgetLines({
          kind,
          fiscalYear,
          fundCode,
          appropriationKind: isAppropriation ? appropriationKind : undefined,
          instrument: isRealignment ? instrument : undefined,
          reference: reference.trim(),
          date,
          fileName,
          rows: chunk.map((r) => ({
            lineNo: r.lineNo,
            office: r.office,
            fpp: r.fpp,
            fppName: r.fppName || undefined,
            sector: r.sector,
            serviceSector: r.serviceSector || undefined,
            accountCode: r.accountCode || undefined,
            expenseClass: r.expenseClass || undefined,
            amount: r.amount,
            particulars: r.particulars || undefined,
          })),
        });
        // Since patch 112 nothing here posts: an ordinance lands as drafts.
        posted += res.posted + (res.drafted ?? 0);
        amount += res.total;
        prepared += res.preparedOrders ?? 0;
      }

      if (isRealignment) {
        toast.success(
          `${instrument === 'AUGMENTATION' ? 'Augmentation' : 'Realignment'} prepared`,
          'Nothing is posted yet. It is waiting on the Appropriations screen for the Budget Officer to approve.',
        );
      } else if (isAppropriation) {
        toast.success(
          'Ordinance uploaded as drafts',
          `${posted} line${posted === 1 ? '' : 's'}, ${formatPeso(amount)}. None of it is authority yet - ` +
            'read it in the Appropriation Ledger, then approve it there, whole or line by line.',
        );
      } else {
        toast.success(
          `${prepared} release order${prepared === 1 ? '' : 's'} prepared`,
          `${formatPeso(amount)} across ${checked.length} line${checked.length === 1 ? '' : 's'}. ` +
            'Nothing is released yet - the Budget Officer approves each order on the Allotments screen.',
        );
      }
      setRows([]);
      setFileName('');
      setReference('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      toast.error(
        posted > 0 ? `Stopped after ${posted} lines` : 'Nothing was uploaded',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const chosenKind = KINDS.find((k) => k.value === appropriationKind);

  return (
    <div>
      <PageHeader
        title={isAppropriation ? 'Upload appropriations' : 'Upload allotment releases'}
        subtitle={
          isAppropriation
            ? 'The annex to the appropriation ordinance, read line by line into the budget ledger as DRAFTS for the Budget Officer to approve. One row per office per account.'
            : 'A batch of allotment releases, read from the spreadsheet the Budget Office already keeps. It fills prepared release orders - one per expense class - and nothing is released until the Budget Officer approves them on the Allotments screen.'
        }
        breadcrumbs={[
          { label: 'Budget' },
          { label: isAppropriation ? 'Appropriation' : 'Allotments' },
          { label: 'Upload' },
        ]}
      />

      <Card title={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}`}>
        <div className="grid gap-4 md:grid-cols-3">
          {isAppropriation && (
            <Field label="Type" required hint={chosenKind?.hint}>
              <Select
                value={appropriationKind}
                onChange={(e) => setAppropriationKind(e.target.value)}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {isRealignment && (
            <Field
              label="Which act is this"
              required
              hint={
                instrument === 'AUGMENTATION'
                  ? 'Section 336. Savings moved WITHIN one expense class — PS to PS, MOOE to MOOE, CO to CO. Signed by the Local Chief Executive.'
                  : 'Section 321. Authority moved ACROSS expense classes — PS to MOOE and the rest. By ordinance of the Sanggunian.'
              }
            >
              <Select
                value={instrument}
                onChange={(e) => setInstrument(e.target.value as RealignmentInstrument)}
              >
                <option value="AUGMENTATION">Augmentation — within one expense class, by the LCE</option>
                <option value="REALIGNMENT">Realignment — across expense classes, by ordinance</option>
              </Select>
            </Field>
          )}

          <Field
            label={isAppropriation ? 'Ordinance number' : 'Release reference'}
            required
            hint="This is what stops the same file being posted twice. Give each ordinance or release its own."
          >
            <TextInput
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={isAppropriation ? 'Ordinance No. 2026-01' : 'ARO 2026-03'}
            />
          </Field>

          <Field
            label={isAppropriation ? 'Authority date' : 'Release date'}
            required
            hint={isAppropriation ? 'The date the ordinance was enacted.' : undefined}
          >
            <DateInput value={date} onChange={setDate} />
          </Field>
        </div>

        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-navy-900">The format</p>
              <p className="mt-0.5 text-xs text-slate-600">
                Start from the template if you are building a new file. If you already keep the
                annex as a spreadsheet, upload it as it is — the headings below each have several
                accepted spellings, and the order of the columns does not matter.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                downloadBudgetTemplate(
                  isRealignment ? 'REALIGNMENT' : isAppropriation ? 'APPROPRIATION' : 'ALLOTMENT',
                  fiscalYear,
                  fundCode,
                )
              }
            >
              Download the CSV template
            </Button>
          </div>

          <button
            type="button"
            onClick={() => setShowFormat((v) => !v)}
            className="mt-2 text-xs font-medium text-brand-700 hover:text-brand-900"
          >
            {showFormat ? 'Hide the columns' : 'What the columns are'}
          </button>

          {showFormat && (
            <div className="mt-2 overflow-x-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Heading</th>
                    <th className="px-2 py-1.5 font-medium">Also accepted</th>
                    <th className="px-2 py-1.5 font-medium">What goes in it</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {TEMPLATE_COLUMNS.map((c) => (
                    <tr key={c.header}>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <span className="font-medium text-navy-900">{c.header}</span>
                        {c.required && <span className="ml-1 text-rose-600">*</span>}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">
                        {c.alsoAccepts?.join(', ') ?? '-'}
                      </td>
                      <td className="px-2 py-1.5 text-slate-600">{c.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-slate-200 px-2 py-1.5 text-[11px] text-slate-500">
                <span className="text-rose-600">*</span> required. Rows with neither an office nor
                an account code are skipped, which is how the sub-total lines an annex prints under
                each office are ignored rather than doubling that office&rsquo;s budget.
              </p>
            </div>
          )}
        </div>

        <div className="mt-4">
          <Field
            label="The file"
            hint="A .csv, .xls or .xlsx. It needs an office, an account code and an amount on each row; the expense class is taken from the Chart of Accounts when the file does not say."
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

        {checked.length > 0 && (
          <div className="mt-4">
            {tooManyForOneCall && (
              <Alert
                tone="error"
                title={
                  isAppropriation
                    ? 'This realignment is too long to post in one go'
                    : 'This release is too long to prepare in one go'
                }
                className="mb-3"
              >
                {isAppropriation ? (
                  <>
                    A realignment must be sent whole so the server can see that it comes to zero,
                    and one call takes at most {CHUNK} rows. This file has {checked.length}. Split
                    it into separate realignments, each balanced on its own, and give each its own
                    ordinance reference.
                  </>
                ) : (
                  <>
                    An allotment file is prepared whole, as release orders keyed on its reference,
                    and one call takes at most {CHUNK} rows. This file has {checked.length}. Split
                    it into separate releases and give each its own reference.
                  </>
                )}
              </Alert>
            )}

            {classCheck && !classCheck.ok && (
              <Alert
                tone="error"
                title="An augmentation cannot cross an expense class"
                className="mb-3"
              >
                {classCheck.violations[0].message}
              </Alert>
            )}

            {realignment && !realignment.ok && !tooManyForOneCall && (
              <Alert
                tone="error"
                title={
                  realignment.violations[0].code === 'REALIGNMENT_NEEDS_TWO_LINES'
                    ? 'A realignment needs at least two lines'
                    : 'This realignment does not come to zero'
                }
                className="mb-3"
              >
                {realignment.violations[0].message} A realignment moves authority; it never creates
                or destroys any. Take away with a negative amount and give with a positive one, and
                the file must net to nothing.
              </Alert>
            )}

            {realignment?.ok && (
              <Alert tone="success" title="This realignment balances" className="mb-3">
                {checked.filter((r) => r.amount < 0).length} line
                {checked.filter((r) => r.amount < 0).length === 1 ? '' : 's'} give up{' '}
                <strong className="cbo-amount">
                  {formatPeso(Math.abs(checked.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0)))}
                </strong>
                , and {checked.filter((r) => r.amount > 0).length} line
                {checked.filter((r) => r.amount > 0).length === 1 ? '' : 's'} take it up. The total
                appropriation of the fund does not change.
              </Alert>
            )}

            {bad.length > 0 ? (
              <Alert tone="error" title={`${bad.length} of ${checked.length} rows cannot be posted`} className="mb-3">
                Nothing will be sent until these are fixed. An ordinance goes into the books whole or
                not at all - a budget missing a few lines looks complete, foots to a total nobody
                reconciles against the ordinance, and refuses an office its obligation months later
                for no visible reason.
              </Alert>
            ) : (
              <Alert tone="info" className="mb-3">
                {checked.length} rows falling on {lineCount} budget line
                {lineCount === 1 ? '' : 's'}
                {isRealignment ? '.' : (
                  <>
                    , totalling <strong className="cbo-amount">{formatPeso(total)}</strong>.
                  </>
                )}{' '}
                {isRealignment
                  ? 'This prepares the set. Nothing is posted until the Budget Officer approves it on the Appropriations screen, when every check runs again.'
                  : isAppropriation
                    ? 'The lines land as DRAFTS. None of it is authority until the Budget Officer approves it on the Appropriations screen.'
                    : 'Each line is checked against its appropriation now, and again when the Budget Officer approves the order. Nothing is released by this upload.'}
              </Alert>
            )}

            <PreviewTable rows={checked} />

            <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
              <p className="text-sm text-slate-600">
                {progress ?? `${checked.length - bad.length} of ${checked.length} rows ready.`}
              </p>
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || blocked}
                onClick={() => void post()}
              >
                {isAppropriation && !isRealignment ? 'Upload' : 'Prepare'} {checked.length} line
                {checked.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function PreviewTable({ rows }: { rows: ParsedBudgetRow[] }) {
  return (
    <div className="max-h-96 overflow-auto rounded border border-slate-200">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
          <tr>
            <th className="px-2 py-1.5 font-medium">Row</th>
            <th className="px-2 py-1.5 font-medium">Office</th>
            <th className="px-2 py-1.5 font-medium">Account</th>
            <th className="px-2 py-1.5 font-medium">Class</th>
            <th className="px-2 py-1.5 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.lineNo} className={r.problem ? 'bg-rose-50' : undefined}>
              <td className="px-2 py-1.5 text-slate-500">{r.lineNo}</td>
              <td className="px-2 py-1.5">{r.office || '-'}</td>
              <td className="px-2 py-1.5">
                <span className="font-mono text-slate-500">{r.accountCode || '-'}</span>
                {r.accountName && <span className="ml-2">{r.accountName}</span>}
                {r.problem && <span className="block text-[11px] text-rose-700">{r.problem}</span>}
              </td>
              <td className="px-2 py-1.5">
                {r.expenseClass ? (
                  <span title={EXPENSE_CLASS_LABELS[r.expenseClass as ExpenseClass]}>
                    {r.expenseClass}
                  </span>
                ) : (
                  <span className="text-slate-400">-</span>
                )}
              </td>
              <td className="cbo-amount px-2 py-1.5 text-right">
                {formatPeso(r.amount, { symbol: false, parens: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
