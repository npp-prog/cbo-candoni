import type { ReactNode } from 'react';
import { Button } from './ui/Button';
import { PageHeader } from './ui/Layout';
import { exportCsv, exportXlsx, printReport, type ExportColumn, type ReportMeta } from '@/lib/export';
import { formatLongDate, todayPh } from '@/lib/dates';
import { Seal } from './ui/Seal';
import { ReportPrintStyle } from './print/ReportPrintStyle';

/**
 * The frame every report is printed in.
 *
 * On screen it is a normal page with a filter bar and export buttons. On
 * paper - and in a PDF saved from the print dialogue - the chrome disappears
 * and what remains is the official heading COA expects:
 *
 *   Republic of the Philippines
 *   Province of Negros Occidental
 *   Municipality of Candoni
 *   <report title>
 *   <fund>
 *   <period covered>
 *
 * with the signature block at the foot. The heading is rendered in the normal
 * flow rather than being injected at print time, so what is on screen is what
 * comes out of the printer.
 */

export function ReportShell<T>({
  meta,
  breadcrumbs,
  tabs,
  filters,
  rows,
  exportColumns,
  children,
  footnote,
  actions,
  printLayout,
}: {
  meta: ReportMeta;
  breadcrumbs?: Array<{ label: string; to?: string }>;
  /**
   * The tab strip of the section this report belongs to.
   *
   * A report that lives inside a section needs the strip for the same reason
   * its register does: without it the report is a dead end, and the only way
   * back to the collections it was drawn from is the browser's back button.
   */
  tabs?: ReactNode;
  filters?: ReactNode;
  /** Rows and columns for export; omit to hide the export buttons. */
  rows?: T[];
  exportColumns?: ExportColumn<T>[];
  children: ReactNode;
  footnote?: ReactNode;
  actions?: ReactNode;
  /**
   * Print on A4 fitted to the width of the sheet, with the municipal seal at
   * the left of the heading. Patch 117 - the budget registries and reports.
   * Omitted, a report prints as it always has.
   */
  printLayout?: 'portrait' | 'landscape';
}) {
  const canExport = Boolean(rows && exportColumns);

  return (
    <div>
      <PageHeader
        title={meta.title}
        subtitle={[meta.fundLabel, meta.periodLabel].filter(Boolean).join(' - ')}
        breadcrumbs={breadcrumbs}
        actions={
          <>
            {actions}
            {canExport && (
              <>
                <Button size="sm" onClick={() => exportXlsx(rows!, exportColumns!, meta)}>
                  Excel
                </Button>
                <Button size="sm" onClick={() => exportCsv(rows!, exportColumns!, meta)}>
                  CSV
                </Button>
              </>
            )}
            <Button size="sm" variant="primary" onClick={() => printReport(meta)}>
              Print
            </Button>
          </>
        }
      />

      {tabs}

      {/*
        items-START, not items-end.

        Aligning the bottoms meant a field carrying a hint pushed its own
        control UP and left the field beside it sitting low - so the two
        controls never lined up, and the row jumped every time a hint appeared
        or went away. Aligning the tops puts every label on one line and every
        control on the line below it, whatever is underneath them.
      */}
      {filters && (
        <div className="cbo-filter-row mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3 no-print">
          {filters}
        </div>
      )}

      {printLayout && <ReportPrintStyle orientation={printLayout} />}
      <div
        className={`cbo-card px-6 py-6 print:border-0 print:px-0 print:py-0${
          printLayout ? ' cbo-report-sheet' : ''
        }`}
      >
        <ReportHeading meta={meta} seal={Boolean(printLayout)} />
        {children}
        {footnote && <div className="mt-4 text-xs text-slate-500">{footnote}</div>}
        <SignatureBlock meta={meta} />
      </div>
    </div>
  );
}

export function ReportHeading({ meta, seal }: { meta: ReportMeta; seal?: boolean }) {
  /*
    With the seal: at the far left of the heading, the heading itself still
    centred on the page - the seal's column is matched by an empty one on the
    right, so the title does not drift off centre to make room for it.
  */
  if (seal) {
    return (
      <header className="report-header mb-5 grid grid-cols-[5rem_1fr_5rem] items-center gap-2">
        <Seal className="h-16 w-16 justify-self-start" />
        <HeadingText meta={meta} />
        <span aria-hidden="true" />
      </header>
    );
  }
  return (
    <header className="report-header mb-5 text-center">
      <HeadingText meta={meta} />
    </header>
  );
}

function HeadingText({ meta }: { meta: ReportMeta }) {
  return (
    <div className="text-center">
      <p className="text-xs text-navy-700">Republic of the Philippines</p>
      <p className="text-xs text-navy-700">{meta.province ?? 'Province of Negros Occidental'}</p>
      <p className="text-sm font-semibold uppercase tracking-wide text-navy-900">
        {meta.municipality ?? 'Municipality of Candoni'}
      </p>

      <h2 className="mt-3 text-base font-bold uppercase tracking-wide text-navy-900">{meta.title}</h2>
      {meta.fundLabel && <p className="text-sm text-navy-700">{meta.fundLabel}</p>}
      {meta.periodLabel && <p className="text-sm text-navy-700">{meta.periodLabel}</p>}

      <p className="mt-2 text-2xs text-slate-400">
        Generated from CFMS on {formatLongDate(todayPh())}
      </p>
    </div>
  );
}

function SignatureBlock({ meta }: { meta: ReportMeta }) {
  if (!meta.preparedBy && !meta.reviewedBy && !meta.approvedBy) return null;

  const blocks = [
    { label: 'Prepared by', name: meta.preparedBy },
    { label: 'Reviewed by', name: meta.reviewedBy },
    { label: 'Approved by', name: meta.approvedBy },
  ].filter((b) => b.name);

  return (
    <div className="mt-10 grid gap-8 sm:grid-cols-3">
      {blocks.map((block) => (
        <div key={block.label}>
          <p className="text-xs text-slate-600">{block.label}:</p>
          <div className="mt-8 border-t border-navy-900 pt-1">
            <p className="text-sm font-medium uppercase text-navy-900">{block.name}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A totals row for report tables. Double-ruled above the figure, as on a
 * printed statement.
 */
export function TotalRow({
  label,
  values,
  emphasis = true,
}: {
  label: string;
  values: ReactNode[];
  emphasis?: boolean;
}) {
  return (
    <tr className={emphasis ? 'border-t-2 border-navy-800 font-semibold' : 'border-t border-slate-300 font-medium'}>
      <td className="cbo-td border-b-0 text-navy-900">{label}</td>
      {values.map((v, i) => (
        <td key={i} className="cbo-td cbo-amount border-b-0 text-navy-900">
          {v}
        </td>
      ))}
    </tr>
  );
}
