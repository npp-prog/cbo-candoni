import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useCollections } from '@/data/queries';
import { formatPeso, amountInWords } from '@/lib/money';
import { formatShortDate, formatLongDate } from '@/lib/dates';
import {
  AF56_FIELDS,
  AF56_ROW_SPACING,
  AF56_SHEET,
  OR_FIELDS,
  OR_LINES_PER_SHEET,
  OR_SHEET,
  defaultCalibration,
  loadCalibration,
  loadSheetSize,
  saveSheetSize,
  splitWords,
  type Calibration,
  type SheetSize,
} from '@/lib/printCalibration';
import { AF56_MAX_PROPERTIES, af56SheetValues } from '@/lib/af56Print';
import { useDocument } from '@/hooks/useFirestore';
import { useEntity } from '@/data/useEntity';
import { COL } from '@/lib/collections';
import type { SystemSettings } from '@/types/system';
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

/*
 * Patch 175: two forms. The AF 51 (general collections) as before, and the
 * AF 56 (real property tax) in landscape. Each keeps its own calibration on
 * this machine; the AF 56 also its measured paper size.
 */
type FormKind = 'af51' | 'af56';
const FORMS: Record<FormKind, { key: string; label: string; spacing: number }> = {
  af51: { key: 'or', label: 'Accountable Form No. 51', spacing: 9 },
  af56: {
    key: 'af56',
    label: 'Accountable Form No. 56 (Real Property Tax)',
    spacing: AF56_ROW_SPACING,
  },
};

export default function PrintReceipt() {
  const { fiscalYear, fundCode } = useFilters();
  const { can } = useAuth();
  const entity = useEntity();
  const settings = useDocument<SystemSettings>(COL.settings, 'general');
  const [form, setForm] = useState<FormKind>('af51');
  const FORM_KEY = FORMS[form].key;
  const FIELDS = form === 'af56' ? AF56_FIELDS : OR_FIELDS;
  const [af56Sheet, setAf56Sheet] = useState<SheetSize>(AF56_SHEET);
  useEffect(() => {
    setAf56Sheet(loadSheetSize('af56', AF56_SHEET));
  }, []);
  const SHEET = form === 'af56' ? af56Sheet : OR_SHEET;

  const [mode, setMode] = useState<'print' | 'calibrate'>('print');
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  const [calibration, setCalibration] = useState<Calibration>(() =>
    defaultCalibration(OR_FIELDS, 9),
  );

  useEffect(() => {
    setCalibration(
      loadCalibration(
        FORMS[form].key,
        form === 'af56' ? AF56_FIELDS : OR_FIELDS,
        FORMS[form].spacing,
      ),
    );
    setSelected([]);
  }, [form]);

  const { data, loading, error } = useCollections(fiscalYear, fundCode);

  const rows = useMemo(
    () =>
      data
        .filter((c) => c.status !== 'CANCELLED')
        // Patch 175: a real property tax receipt is on the AF 56, everything else on the AF 51.
        .filter((c) => (form === 'af56' ? Boolean(c.rpt) : !c.rpt))
        .filter((c) => !statusFilter || c.status === statusFilter)
        .sort((a, b) => b.orDate.localeCompare(a.orDate) || b.orNumber.localeCompare(a.orNumber)),
    [data, statusFilter, form],
  );

  useEffect(() => {
    setSelected((prev) => {
      const kept = prev.filter((id) => rows.some((r) => r.id === id));
      return kept.length === prev.length ? prev : kept;
    });
  }, [rows]);

  const queue = useMemo(
    () =>
      selected
        .map((id) => rows.find((r) => r.id === id))
        .filter((c): c is Collection => Boolean(c)),
    [selected, rows],
  );

  const tooLong = queue.filter((c) =>
    form === 'af56'
      ? (c.rpt?.properties.length ?? 0) > AF56_MAX_PROPERTIES
      : c.lines.length > OR_LINES_PER_SHEET,
  );

  /** Patch 175/176: an AF 56 receipt laid onto the form - see lib/af56Print.ts. */
  const toAf56Sheet = (col: Collection): SheetValue =>
    af56SheetValues(
      {
        rpt: col.rpt!,
        orDate: col.orDate,
        payorName: col.payorName,
        totalAmount: col.totalAmount,
        paymentForm: col.paymentForm,
        checkNo: col.checkNo ?? null,
        collectingOfficerName: col.collectingOfficerName,
      },
      {
        municipality: (settings.data?.municipality || 'Candoni').trim(),
        treasurer: entity.localTreasurer.name,
        longDate: formatLongDate,
        shortDate: formatShortDate,
      },
    );

  const toSheet = (col: Collection): SheetValue => {
    if (form === 'af56' && col.rpt) return toAf56Sheet(col);
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
    : form === 'af56'
      ? {
          values: {
            municipality: 'Candoni',
            prevReceiptNo: '1159046',
            prevDated: '2/18/2025',
            prevYear: '2025',
            date: formatLongDate('2026-09-24'),
            payor: 'MONSERATE, IRENEO',
            amountWords1: 'TEN THOUSAND PESOS',
            amountWords2: 'AND 00/100 ONLY',
            amountFigures: '10,000.00',
            fullMark: 'X',
            installmentMark: '',
            calendarYear: '2026',
            basicMark: 'X',
            sefMark: 'X',
            totalFigures: '10,000.00',
            cashAmount: '10,000.00',
            checkNo: '',
            bankDate: '',
            modeTotal: '10,000.00',
            collectingOfficer: 'COLLECTING OFFICER',
            treasurer: 'MUNICIPAL TREASURER',
          },
          rows: [
            {
              owner: 'MONSERATE, IRENEO',
              location: 'Poblacion',
              lotBlock: '123',
              tdNo: '09-0001',
              avLand: '28,976',
              avImprovement: '',
              avTotal: '28,976',
              taxDue: '2,897.60',
              instNo: '',
              instPayment: '',
              fullPayment: '2,897.60',
              penalty: '2,102.40',
              total: '5,000.00',
            },
            { penalty: 'BASIC', total: '5,000.00' },
            { penalty: 'SEF', total: '5,000.00' },
          ],
        }
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
      <SheetPrintStyle sheet={SHEET} />
      {mode === 'print' && queue.length > 0 && (
        <SheetPrintPortal>
          {queue.map((c) => (
            <div key={c.id} className="cbo-print-sheet">
              <CalibrationSheet
                sheet={SHEET}
                fields={FIELDS}
                calibration={calibration}
                value={toSheet(c)}
                mode="print"
              />
              {showGuide && <AlignmentGuide sheet={SHEET} />}
            </div>
          ))}
        </SheetPrintPortal>
      )}

      <PageHeader
        title="Print receipts"
        subtitle={`${fundLabel(fundCode)} · onto ${FORMS[form].label}, ${SHEET.width} × ${SHEET.height} mm${form === 'af56' ? ', landscape' : ''}`}
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
              Print{' '}
              {queue.length > 0 ? `${queue.length} receipt${queue.length === 1 ? '' : 's'}` : ''}
            </Button>
          </>
        }
      />

      <SectionTabs tabs={PRINTING_TABS} />

      {/* Patch 175: which accountable form is in the printer. */}
      <div className="no-print mb-4 flex flex-wrap items-end gap-4">
        <Field label="Form in the printer" className="w-80">
          <Select value={form} onChange={(e) => setForm(e.target.value as FormKind)}>
            <option value="af51">Accountable Form No. 51 (Official Receipt)</option>
            <option value="af56">Accountable Form No. 56 (Real Property Tax)</option>
          </Select>
        </Field>
        {form === 'af56' && (
          <>
            <Field label="Paper width (mm)" className="w-36">
              <TextInput
                type="number"
                step="0.5"
                value={af56Sheet.width}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 50 && v <= 400) {
                    const next = { ...af56Sheet, width: v };
                    setAf56Sheet(next);
                    saveSheetSize('af56', next);
                  }
                }}
              />
            </Field>
            <Field label="Paper height (mm)" className="w-36">
              <TextInput
                type="number"
                step="0.5"
                value={af56Sheet.height}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 50 && v <= 400) {
                    const next = { ...af56Sheet, height: v };
                    setAf56Sheet(next);
                    saveSheetSize('af56', next);
                  }
                }}
              />
            </Field>
            <p className="max-w-md pb-2 text-xs text-slate-500">
              Measure a blank AF 56 with a ruler (landscape: width is the long side) and type it
              once - it is kept on this computer. Then calibrate on plain paper.
            </p>
          </>
        )}
      </div>

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
                const count = form === 'af56' ? (c.rpt?.properties.length ?? 0) : c.lines.length;
                const over =
                  form === 'af56' ? count > AF56_MAX_PROPERTIES : count > OR_LINES_PER_SHEET;
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
                    <span
                      className={`w-16 text-right text-2xs ${over ? 'text-rose-600' : 'text-slate-400'}`}
                    >
                      {count} {form === 'af56' ? 'propert' : 'line'}
                      {form === 'af56' ? (count === 1 ? 'y' : 'ies') : count === 1 ? '' : 's'}
                    </span>
                  </label>
                );
              })}
            </div>
          </Card>

          {tooLong.length > 0 && (
            <Alert tone="error" title="These will not fit on one form" className="no-print">
              {tooLong.map((c) => c.orNumber).join(', ')} —{' '}
              {form === 'af56'
                ? `Accountable Form No. 56 has room for ${AF56_MAX_PROPERTIES} properties (and the Basic and SEF lines) and these have more.`
                : `Accountable Form No. 51 has ${OR_LINES_PER_SHEET} ruled lines and these have more.`}{' '}
              Splitting one receipt over two forms would consume a second accountable serial that
              the RAAF would then have to explain, so CFMS will not do it. Either record the
              collection as two, or write this one by hand.
            </Alert>
          )}

          <Card
            title={
              mode === 'calibrate' ? 'Drag a field to where it belongs' : 'What will be printed'
            }
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
                  sheet={SHEET}
                  fields={FIELDS}
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
                  <div key={c.id} className="relative inline-block border border-slate-200">
                    <CalibrationSheet
                      sheet={SHEET}
                      fields={FIELDS}
                      calibration={calibration}
                      value={toSheet(c)}
                      mode="print"
                    />
                    {showGuide && <AlignmentGuide sheet={SHEET} />}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <CalibrationPanel
          form={FORM_KEY}
          fields={FIELDS}
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
