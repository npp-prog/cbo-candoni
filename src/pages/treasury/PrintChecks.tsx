import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { BankAccountPicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useChecks } from '@/data/queries';
import { formatPeso, amountInWords } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import {
  CHECK_FIELDS,
  CHECK_SHEET,
  defaultCalibration,
  loadCalibration,
  splitWords,
  type Calibration,
} from '@/lib/printCalibration';
import {
  AlignmentGuide,
  CalibrationSheet,
  CheckSpecimen,
  SheetPrintStyle,
  type SheetValue,
} from '@/components/print/CalibrationSheet';
import { CalibrationPanel } from '@/components/print/CalibrationPanel';
import type { Check } from '@/types/accounting';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { PRINTING_TABS } from '@/layout/sections';

/**
 * Printing a check onto LANDBANK stock.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not create a check, number one, change one, or mark one released.
 * The check already exists in the register with its number and its face value
 * settled by `issueCheck`; this screen only puts that same figure onto paper.
 *
 * That separation is the entire safety of the thing. A screen that both
 * printed and amended would let the paper and the register disagree without
 * anyone deciding they should - the amount corrected at the printer, the
 * register untouched, and the difference found in March by whoever reconciles
 * the account. So the fields here are read, and there is nowhere to type over
 * them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CHECK MUST BE SIGNED-OR-LATER BEFORE IT PRINTS
 * ---------------------------------------------------------------------------
 * The stock is accountable. Printing a check that is still PREPARED means
 * committing a physical, numbered form to a payment that has not yet been
 * approved by the signatories, and a spoiled one has to be cancelled and
 * accounted for. So the queue offers PREPARED checks only with a warning, and
 * the office prints them knowing that.
 * ---------------------------------------------------------------------------
 */

const FORM_KEY = 'check';

/** The date as the boxes on the stock want it: two digits, two digits, four. */
function boxDate(date: string): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return date;
  return `${m}  ${d}  ${y}`;
}

/**
 * The figures with leading asterisks.
 *
 * Not decoration. The fill closes the gap between the peso sign and the first
 * digit, which is where a figure gets a digit added to it after it leaves the
 * office. Every bank's own cheque writer does this and so does this one.
 */
function protectedFigures(amount: number): string {
  const body = formatPeso(amount, { symbol: false });
  const fill = '*'.repeat(Math.max(3, 16 - body.length));
  return `${fill}${body}`;
}

const PRINTABLE = ['SIGNED', 'RELEASED'];

export default function PrintChecks() {
  const { fiscalYear, fundCode } = useFilters();
  const { can } = useAuth();

  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [mode, setMode] = useState<'print' | 'calibrate'>('print');
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  const [calibration, setCalibration] = useState<Calibration>(() =>
    defaultCalibration(CHECK_FIELDS),
  );

  // Read the saved calibration after mount rather than in the initialiser:
  // the initialiser runs during render, and touching storage there is what
  // makes a screen throw in a browser profile that blocks it.
  useEffect(() => {
    setCalibration(loadCalibration(FORM_KEY, CHECK_FIELDS));
  }, []);

  const { data, loading, error } = useChecks(bankAccountId ?? undefined, statusFilter || undefined);

  const rows = useMemo(
    () =>
      data
        .filter((c) => c.fiscalYear === fiscalYear && c.status !== 'CANCELLED')
        .sort((a, b) => a.checkNo.localeCompare(b.checkNo)),
    [data, fiscalYear],
  );

  // A check that leaves the list - the bank account changed, it was cancelled
  // elsewhere - must leave the print queue with it, or the queue would print a
  // check nobody can see any more.
  useEffect(() => {
    setSelected((prev) => prev.filter((id) => rows.some((r) => r.id === id)));
  }, [rows]);

  const queue = useMemo(
    () => selected.map((id) => rows.find((r) => r.id === id)).filter((c): c is Check => Boolean(c)),
    [selected, rows],
  );

  const unsigned = queue.filter((c) => !PRINTABLE.includes(c.status));

  const toSheet = (check: Check): SheetValue => {
    const [line1, line2] = splitWords(amountInWords(check.netAmount), 62);
    return {
      values: {
        date: boxDate(check.checkDate),
        payee: check.payeeName,
        amountFigures: protectedFigures(check.netAmount),
        amountWords1: line1,
        amountWords2: line2,
        memo: check.dvNo ? `DV ${check.dvNo}` : '',
      },
    };
  };

  /** What the calibration screen shows: a real check if one is picked, or a specimen. */
  const specimen: SheetValue = queue[0]
    ? toSheet(queue[0])
    : {
        values: {
          date: boxDate('2026-09-28'),
          payee: 'JUAN DELA CRUZ',
          amountFigures: protectedFigures(1234567),
          amountWords1: 'TWELVE THOUSAND THREE HUNDRED FORTY FIVE PESOS AND 67/100',
          amountWords2: 'ONLY',
          memo: 'DV 2026-09-0123',
        },
      };

  const moveField = (key: string, dx: number, dy: number) =>
    setCalibration((c) => {
      const pos = c.fields[key];
      if (!pos) return c;
      return { ...c, fields: { ...c.fields, [key]: { ...pos, x: pos.x + dx, y: pos.y + dy } } };
    });

  if (!can('treasury', 'view')) {
    return <Alert tone="warning" title="This screen is for the Treasurer's office." />;
  }

  return (
    <div>
      <SheetPrintStyle sheet={CHECK_SHEET} />

      <PageHeader
        title="Print checks"
        subtitle={`${fundLabel(fundCode)} · onto LANDBANK stock, ${CHECK_SHEET.width} × ${CHECK_SHEET.height} mm`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'Print checks' }]}
        actions={
          <>
            <Button
              variant={mode === 'calibrate' ? 'primary' : 'secondary'}
              onClick={() => setMode((m) => (m === 'calibrate' ? 'print' : 'calibrate'))}
            >
              {mode === 'calibrate' ? 'Done calibrating' : 'Calibrate'}
            </Button>
            <Button
              variant="primary"
              disabled={queue.length === 0 || mode === 'calibrate'}
              onClick={() => window.print()}
            >
              Print {queue.length > 0 ? `${queue.length} check${queue.length === 1 ? '' : 's'}` : ''}
            </Button>
          </>
        }
      />

      <SectionTabs tabs={PRINTING_TABS} />

      <Alert tone="info" title="Before the first real check" className="mb-4 no-print">
        Tick <strong>Print the alignment guide</strong>, print onto a sheet of plain paper, and hold
        it against a real check under a light. Move the whole sheet with the arrows until the guide
        sits over the boxes. Only then print a live one. Nobody has to spoil an accountable form to
        find out where the printer puts the ink.
      </Alert>

      {error && <Alert tone="error" title="The checks could not be read" className="mb-4">{error}</Alert>}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card title="Which checks" bodyClassName="p-0" className="no-print">
            <div className="grid gap-3 border-b border-slate-200 px-4 py-3 sm:grid-cols-2">
              <Field label="Bank account">
                <BankAccountPicker
                  fundCode={fundCode}
                  value={bankAccountId}
                  onChange={setBankAccountId}
                />
              </Field>
              <Field label="Status">
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">All but cancelled</option>
                  <option value="PREPARED">Prepared</option>
                  <option value="SIGNED">Signed</option>
                  <option value="RELEASED">Released</option>
                </Select>
              </Field>
            </div>

            <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
              {loading && <p className="px-4 py-6 text-sm text-slate-500">Reading the register&hellip;</p>}
              {!loading && rows.length === 0 && (
                <p className="px-4 py-6 text-sm text-slate-500">
                  No checks in {fiscalYear} for this account. Checks are numbered on the Checks
                  screen; this one only prints them.
                </p>
              )}
              {rows.map((c) => {
                const on = selected.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                        )
                      }
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="w-24 font-mono text-xs">{c.checkNo}</span>
                    <span className="w-24 text-xs text-slate-500">{formatShortDate(c.checkDate)}</span>
                    <span className="min-w-0 flex-1 truncate">{c.payeeName}</span>
                    <span className="font-mono text-xs tabular">{formatPeso(c.netAmount)}</span>
                    <span
                      className={`w-20 text-right text-2xs uppercase ${
                        PRINTABLE.includes(c.status) ? 'text-emerald-600' : 'text-amber-600'
                      }`}
                    >
                      {c.status.toLowerCase()}
                    </span>
                  </label>
                );
              })}
            </div>
          </Card>

          {unsigned.length > 0 && (
            <Alert tone="warning" title="Some of these are not signed yet" className="no-print">
              {unsigned.map((c) => c.checkNo).join(', ')} — printing commits a numbered accountable
              form to a payment the signatories have not approved. A spoiled one has to be cancelled
              and accounted for on the RAAF.
            </Alert>
          )}

          <Card
            title={mode === 'calibrate' ? 'Drag a field to where it belongs' : 'What will be printed'}
            subtitle={
              mode === 'calibrate'
                ? 'The dashed boxes are where the stock already has printing. Keep out of them.'
                : queue.length === 0
                  ? 'Tick a check above.'
                  : `${queue.length} sheet${queue.length === 1 ? '' : 's'}, one check each.`
            }
            className="overflow-x-auto"
          >
            {mode === 'calibrate' ? (
              <div className="relative inline-block">
                <CalibrationSheet
                  sheet={CHECK_SHEET}
                  fields={CHECK_FIELDS}
                  calibration={calibration}
                  value={specimen}
                  mode="calibrate"
                  onMoveField={moveField}
                  selectedKey={selectedField}
                  onSelectField={setSelectedField}
                >
                  <CheckSpecimen />
                </CalibrationSheet>
              </div>
            ) : queue.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing selected.</p>
            ) : (
              <div className="space-y-4">
                {queue.map((c) => (
                  <div key={c.id} className="cbo-print-sheet relative inline-block border border-slate-200">
                    <CalibrationSheet
                      sheet={CHECK_SHEET}
                      fields={CHECK_FIELDS}
                      calibration={calibration}
                      value={toSheet(c)}
                      mode="print"
                    />
                    {showGuide && <AlignmentGuide sheet={CHECK_SHEET} />}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <CalibrationPanel
          form={FORM_KEY}
          fields={CHECK_FIELDS}
          calibration={calibration}
          onChange={setCalibration}
          selectedKey={selectedField}
          onSelectField={(k) => {
            setSelectedField(k);
            setMode('calibrate');
          }}
          showGuide={showGuide}
          onShowGuide={setShowGuide}
        />
      </div>
    </div>
  );
}
