import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useCollections } from '@/data/queries';
import { formatPeso, amountInWords } from '@/lib/money';
import { formatShortDate, formatLongDate } from '@/lib/dates';
import {
  OR_FIELDS,
  OR_LINES_PER_SHEET,
  OR_SHEET,
  defaultCalibration,
  loadCalibration,
  splitWords,
  type Calibration,
} from '@/lib/printCalibration';
import {
  AlignmentGuide,
  CalibrationSheet,
  SheetPrintStyle,
  SheetPrintPortal,
  type SheetValue,
} from '@/components/print/CalibrationSheet';
import { CalibrationPanel } from '@/components/print/CalibrationPanel';
import type { Collection } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { PRINTING_TABS } from '@/layout/sections';

/**
 * Printing an Official Receipt onto Accountable Form No. 51.
 *
 * ---------------------------------------------------------------------------
 * THE RECEIPT IS PRINTED AFTER THE COLLECTION, NEVER INSTEAD OF IT
 * ---------------------------------------------------------------------------
 * The OR number on the paper was assigned when the collection was recorded,
 * out of the booklet issued to that collecting officer, and it is the same
 * number the RAAF accounts for. This screen never draws a number and never
 * chooses one: it reads the collection and lays it onto the form that already
 * carries that number in print.
 *
 * The consequence is worth stating plainly, because it is the opposite of how
 * the office works by hand. On paper, the receipt is written first and the
 * cash book after. Here the collection is recorded first and the receipt is
 * the printout of it. Anything else would let a receipt exist that the RCD
 * has never heard of - which is the single most common way an accountable
 * form goes missing without anybody noticing until the RAAF is prepared.
 *
 * ---------------------------------------------------------------------------
 * WHY A COLLECTION WITH TOO MANY LINES IS REFUSED RATHER THAN SPLIT
 * ---------------------------------------------------------------------------
 * Accountable Form No. 51 has a fixed number of ruled lines. A collection with
 * more revenue accounts than that cannot be printed onto one, and splitting it
 * across two forms would consume a second accountable serial for a single
 * receipt - a serial the RAAF would then have to explain. So the screen says
 * so and leaves it to the office, which can either issue two collections or
 * write that one by hand.
 * ---------------------------------------------------------------------------
 */

const FORM_KEY = 'or';

export default function PrintReceipt() {
  const { fiscalYear, fundCode } = useFilters();
  const { can } = useAuth();

  const [mode, setMode] = useState<'print' | 'calibrate'>('print');
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  const [calibration, setCalibration] = useState<Calibration>(() =>
    defaultCalibration(OR_FIELDS, 9),
  );

  useEffect(() => {
    setCalibration(loadCalibration(FORM_KEY, OR_FIELDS, 9));
  }, []);

  const { data, loading, error } = useCollections(fiscalYear, fundCode);

  const rows = useMemo(
    () =>
      data
        .filter((c) => c.status !== 'CANCELLED')
        .filter((c) => !statusFilter || c.status === statusFilter)
        .sort((a, b) => b.orDate.localeCompare(a.orDate) || b.orNumber.localeCompare(a.orNumber)),
    [data, statusFilter],
  );

  useEffect(() => {
    setSelected((prev) => prev.filter((id) => rows.some((r) => r.id === id)));
  }, [rows]);

  const queue = useMemo(
    () =>
      selected.map((id) => rows.find((r) => r.id === id)).filter((c): c is Collection => Boolean(c)),
    [selected, rows],
  );

  const tooLong = queue.filter((c) => c.lines.length > OR_LINES_PER_SHEET);

  const toSheet = (col: Collection): SheetValue => {
    const [words1] = splitWords(amountInWords(col.totalAmount), 96);
    return {
      values: {
        date: formatLongDate(col.orDate),
        payor: col.payorName,
        payorTin: col.payorTin ?? '',
        totalFigures: formatPeso(col.totalAmount, { symbol: false }),
        totalWords: words1,
        collectingOfficer: col.collectingOfficerName,
      },
      rows: col.lines.slice(0, OR_LINES_PER_SHEET).map((l) => ({
        description: l.particulars || l.accountName,
        amount: formatPeso(l.amount, { symbol: false }),
      })),
    };
  };

  const specimen: SheetValue = queue[0]
    ? toSheet(queue[0])
    : {
        values: {
          date: formatLongDate('2026-09-28'),
          payor: 'JUAN DELA CRUZ',
          payorTin: '123-456-789-000',
          totalFigures: '1,500.00',
          totalWords: 'ONE THOUSAND FIVE HUNDRED PESOS AND 00/100 ONLY',
          collectingOfficer: 'COLLECTING OFFICER',
        },
        rows: [
          { description: 'Business permit fee', amount: '1,000.00' },
          { description: "Mayor's permit", amount: '500.00' },
        ],
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
      <SheetPrintStyle sheet={OR_SHEET} />
      {mode === 'print' && queue.length > 0 && (
        <SheetPrintPortal>
          {queue.map((c) => (
            <div key={c.id} className="cbo-print-sheet">
              <CalibrationSheet
                sheet={OR_SHEET}
                fields={OR_FIELDS}
                calibration={calibration}
                value={toSheet(c)}
                mode="print"
              />
              {showGuide && <AlignmentGuide sheet={OR_SHEET} />}
            </div>
          ))}
        </SheetPrintPortal>
      )}

      <PageHeader
        title="Print receipts"
        subtitle={`${fundLabel(fundCode)} · onto Accountable Form No. 51, ${OR_SHEET.width} × ${OR_SHEET.height} mm`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'Print receipts' }]}
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
              disabled={queue.length === 0 || tooLong.length > 0 || mode === 'calibrate'}
              onClick={() => window.print()}
            >
              Print {queue.length > 0 ? `${queue.length} receipt${queue.length === 1 ? '' : 's'}` : ''}
            </Button>
          </>
        }
      />

      <SectionTabs tabs={PRINTING_TABS} />

      <Alert tone="info" title="The form already carries its number" className="mb-4 no-print">
        Put the booklet in the printer at the serial shown beside the collection. CFMS prints the
        entries only — it never prints an OR number, because the number is on the form and is what
        the RAAF accounts for. Print the alignment guide onto plain paper first and hold it against
        a blank form.
      </Alert>

      {error && (
        <Alert tone="error" title="The collections could not be read" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card title="Which receipts" bodyClassName="p-0" className="no-print">
            <div className="border-b border-slate-200 px-4 py-3">
              <Field label="Status" className="max-w-xs">
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">All but cancelled</option>
                  <option value="ISSUED">Issued</option>
                  <option value="IN_RCD">In an RCD</option>
                  <option value="DEPOSITED">Deposited</option>
                </Select>
              </Field>
            </div>

            <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
              {loading && (
                <p className="px-4 py-6 text-sm text-slate-500">Reading the collections&hellip;</p>
              )}
              {!loading && rows.length === 0 && (
                <p className="px-4 py-6 text-sm text-slate-500">
                  No collections in {fiscalYear} for this fund. Record the collection first; the
                  receipt is the printout of it.
                </p>
              )}
              {rows.map((c) => {
                const on = selected.includes(c.id);
                const over = c.lines.length > OR_LINES_PER_SHEET;
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
                    <span className="w-24 font-mono text-xs">{c.orNumber}</span>
                    <span className="w-24 text-xs text-slate-500">{formatShortDate(c.orDate)}</span>
                    <span className="min-w-0 flex-1 truncate">{c.payorName}</span>
                    <span className="font-mono text-xs tabular">{formatPeso(c.totalAmount)}</span>
                    <span className={`w-16 text-right text-2xs ${over ? 'text-rose-600' : 'text-slate-400'}`}>
                      {c.lines.length} line{c.lines.length === 1 ? '' : 's'}
                    </span>
                  </label>
                );
              })}
            </div>
          </Card>

          {tooLong.length > 0 && (
            <Alert tone="error" title="These will not fit on one form" className="no-print">
              {tooLong.map((c) => c.orNumber).join(', ')} — Accountable Form No. 51 has{' '}
              {OR_LINES_PER_SHEET} ruled lines and these have more. Splitting one receipt over two
              forms would consume a second accountable serial that the RAAF would then have to
              explain, so CFMS will not do it. Either record the collection as two, or write this one
              by hand.
            </Alert>
          )}

          <Card
            title={mode === 'calibrate' ? 'Drag a field to where it belongs' : 'What will be printed'}
            subtitle={
              mode === 'calibrate'
                ? 'Move the first line item only — the rest follow it by the row spacing.'
                : queue.length === 0
                  ? 'Tick a receipt above.'
                  : `${queue.length} form${queue.length === 1 ? '' : 's'}, one receipt each.`
            }
            className="overflow-x-auto"
          >
            {mode === 'calibrate' ? (
              <div className="relative inline-block">
                <CalibrationSheet
                  sheet={OR_SHEET}
                  fields={OR_FIELDS}
                  calibration={calibration}
                  value={specimen}
                  mode="calibrate"
                  onMoveField={moveField}
                  selectedKey={selectedField}
                  onSelectField={setSelectedField}
                />
              </div>
            ) : queue.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing selected.</p>
            ) : (
              <div className="space-y-4">
                {queue.map((c) => (
                  <div
                    key={c.id}
                    className="relative inline-block border border-slate-200"
                  >
                    <CalibrationSheet
                      sheet={OR_SHEET}
                      fields={OR_FIELDS}
                      calibration={calibration}
                      value={toSheet(c)}
                      mode="print"
                    />
                    {showGuide && <AlignmentGuide sheet={OR_SHEET} />}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <CalibrationPanel
          form={FORM_KEY}
          fields={OR_FIELDS}
          calibration={calibration}
          onChange={setCalibration}
          selectedKey={selectedField}
          onSelectField={(k) => {
            setSelectedField(k);
            setMode('calibrate');
          }}
          showGuide={showGuide}
          onShowGuide={setShowGuide}
          hasRowSpacing
        />
      </div>
    </div>
  );
}
