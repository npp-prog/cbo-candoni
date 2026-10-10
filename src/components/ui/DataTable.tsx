import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button } from './Button';
import { EmptyState, Spinner } from './Layout';
import { ReportHeading } from '../ReportShell';
import { ReportPrintStyle } from '../print/ReportPrintStyle';
import { exportCsv, exportXlsx, printReport, type ExportColumn, type ReportMeta } from '@/lib/export';
import { totalsLayout } from './totalsRow';

/**
 * The table every register and listing in CFMS is built on.
 *
 * Search, sort, filter, paginate, choose columns, export and print - the
 * specification asks for all of these on every major table, so they live here
 * once rather than being reimplemented per screen.
 *
 * Sorting and filtering are done in memory over the rows handed in. That is
 * the right trade for the volumes a municipality of Candoni's size produces
 * (a few thousand vouchers a year per fund) and it keeps the tables instant.
 * Where a collection genuinely grows without bound - `ledgerEntries` above all
 * - the screen queries Firestore with the fund, year and period already
 * applied, so what reaches this component is a period's worth of rows, not the
 * whole ledger.
 */

export interface Column<T> {
  key: string;
  header: string;
  /** Rendered content. */
  cell: (row: T) => ReactNode;
  /** Raw value used for sorting, searching and export. */
  value?: (row: T) => string | number | null;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** Amount columns are right-aligned, monospaced and exported as numbers. */
  kind?: 'text' | 'amount' | 'number' | 'date';
  width?: string;
  /** Hidden by default; the user can switch it on from the column picker. */
  optional?: boolean;
  /** Never offered in the column picker (row actions, for example). */
  fixed?: boolean;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRowClick?: (row: T) => void;
  /** Search box placeholder; omit to hide the search box. */
  searchPlaceholder?: string;
  /** Extra filter controls rendered beside the search box. */
  filters?: ReactNode;
  emptyTitle?: string;
  emptyMessage?: string;
  emptyAction?: ReactNode;
  pageSize?: number;
  /** Enables the export and print buttons. */
  exportMeta?: ReportMeta;
  /**
   * The totals row. Name the column each total belongs to; the table lays it
   * out against the columns on screen, so it stays aligned when a column is
   * hidden or shown (patch 122). There is no free-form footer any more: a
   * hand-counted colSpan is what put the totals under the wrong columns.
   */
  totals?: {
    label: ReactNode;
    values: Partial<Record<string, ReactNode>>;
    className?: string;
  } | null;
  dense?: boolean;
  className?: string;
  /**
   * Patch 158: printed as a report - A4 in this orientation, fitted to the
   * width of the sheet, under the municipal heading with the seal at its left
   * (`exportMeta` gives the title). Omitted, the table prints as it is.
   */
  printLayout?: 'portrait' | 'landscape';
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  error,
  onRowClick,
  searchPlaceholder,
  filters,
  emptyTitle = 'Nothing to show',
  emptyMessage,
  emptyAction,
  pageSize = 25,
  exportMeta,
  totals,
  dense,
  className,
  printLayout,
}: Props<T>) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  /* Patch 152: rows per page, chosen at the foot of the table. */
  const [perPage, setPerPage] = useState(pageSize);
  const [goTo, setGoTo] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(columns.filter((c) => c.optional).map((c) => c.key)),
  );
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hidden.has(c.key)),
    [columns, hidden],
  );

  const valueOf = (row: T, col: Column<T>): string | number | null => {
    if (col.value) return col.value(row);
    const rendered = col.cell(row);
    return typeof rendered === 'string' || typeof rendered === 'number' ? rendered : null;
  };

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      columns.some((col) => {
        const v = valueOf(row, col);
        return v !== null && String(v).toLowerCase().includes(q);
      }),
    );
  }, [rows, search, columns]);

  const sorted = useMemo(() => {
    if (!sortKey) return searched;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return searched;

    const copy = [...searched];
    copy.sort((a, b) => {
      const av = valueOf(a, col);
      const bv = valueOf(b, col);

      if (av === null && bv === null) return 0;
      if (av === null) return 1; // blanks sort last regardless of direction
      if (bv === null) return -1;

      let result: number;
      if (typeof av === 'number' && typeof bv === 'number') {
        result = av - bv;
      } else {
        result = String(av).localeCompare(String(bv), 'en', { numeric: true, sensitivity: 'base' });
      }
      return sortDir === 'asc' ? result : -result;
    });
    return copy;
  }, [searched, sortKey, sortDir, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const currentPage = Math.min(page, pageCount - 1);
  const paged = useMemo(
    () => sorted.slice(currentPage * perPage, currentPage * perPage + perPage),
    [sorted, currentPage, perPage],
  );
  const sizeOptions = [...new Set([25, 50, 100, pageSize])].sort((a, b) => a - b);
  const jump = () => {
    const n = Number(goTo);
    if (Number.isInteger(n) && n >= 1) setPage(Math.min(n, pageCount) - 1);
    setGoTo('');
  };

  const toggleSort = (col: Column<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
    setPage(0);
  };

  const exportColumns: ExportColumn<T>[] = visibleColumns
    .filter((c) => !c.fixed)
    .map((c) => ({
      key: c.key,
      header: c.header,
      kind: c.kind,
      value: (row) => valueOf(row, c),
    }));

  return (
    <div
      className={clsx(
        'cbo-card overflow-hidden',
        printLayout && exportMeta && 'cbo-report-sheet print:border-0',
        className,
      )}
    >
      {printLayout && exportMeta && (
        <>
          <ReportPrintStyle orientation={printLayout} />
          {/* The screen's notices above the register stay off the printed report. */}
          <style>{'@media print { .cbo-alert:not(.cbo-report-sheet .cbo-alert) { display: none !important; } }'}</style>
          <div className="hidden print:block">
            <ReportHeading meta={exportMeta} seal="left" />
          </div>
        </>
      )}
      {(searchPlaceholder || filters || exportMeta) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2.5 no-print">
          {searchPlaceholder && (
            <div className="relative min-w-[16rem] flex-1">
              <svg
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                  clipRule="evenodd"
                />
              </svg>
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder={searchPlaceholder}
                className="cbo-input pl-8 py-1.5 text-sm"
                aria-label="Search"
              />
            </div>
          )}

          {filters}

          <div className="ml-auto flex items-center gap-1.5">
            <div className="relative">
              <Button size="sm" onClick={() => setShowColumnPicker((s) => !s)}>
                Columns
              </Button>
              {showColumnPicker && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowColumnPicker(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-60 rounded-md border border-slate-200 bg-white p-2 shadow-raised">
                    <p className="px-1 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                      Visible columns
                    </p>
                    <div className="max-h-72 overflow-y-auto">
                      {columns
                        .filter((c) => !c.fixed)
                        .map((col) => (
                          <label
                            key={col.key}
                            className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-slate-50"
                          >
                            <input
                              type="checkbox"
                              checked={!hidden.has(col.key)}
                              onChange={() =>
                                setHidden((h) => {
                                  const next = new Set(h);
                                  if (next.has(col.key)) next.delete(col.key);
                                  else next.add(col.key);
                                  return next;
                                })
                              }
                              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                            />
                            <span className="truncate text-navy-800">{col.header}</span>
                          </label>
                        ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {exportMeta && (
              <>
                <Button size="sm" onClick={() => exportXlsx(sorted, exportColumns, exportMeta)}>
                  Excel
                </Button>
                <Button size="sm" onClick={() => exportCsv(sorted, exportColumns, exportMeta)}>
                  CSV
                </Button>
                <Button size="sm" onClick={() => printReport(exportMeta)}>
                  Print
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : error ? (
        <div className="px-4 py-8 text-center text-sm text-rose-700">{error}</div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title={search ? 'No matching records' : emptyTitle}
          message={search ? `Nothing matches "${search}".` : emptyMessage}
          action={search ? undefined : emptyAction}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    className={clsx(
                      'cbo-th',
                      col.align === 'right' || col.kind === 'amount' ? 'text-right' : col.align === 'center' && 'text-center',
                      col.sortable !== false && 'cursor-pointer select-none hover:text-navy-800',
                    )}
                    style={col.width ? { width: col.width } : undefined}
                    onClick={() => toggleSort(col)}
                    aria-sort={
                      sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header}
                      {sortKey === col.key && (
                        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          {sortDir === 'asc' ? (
                            <path d="M10 5l4 6H6l4-6z" />
                          ) : (
                            <path d="M10 15l-4-6h8l-4 6z" />
                          )}
                        </svg>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={clsx(
                    'transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-brand-50/50',
                  )}
                >
                  {visibleColumns.map((col) => (
                    <td
                      key={col.key}
                      className={clsx(
                        'cbo-td',
                        dense && 'py-1.5',
                        col.kind === 'amount' && 'cbo-amount',
                        col.align === 'right' && 'text-right',
                        col.align === 'center' && 'text-center',
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot className="bg-slate-50 font-medium">
                <TotalsRow columns={visibleColumns} allKeys={columns.map((c) => c.key)} totals={totals} dense={dense} />
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/*
        Patch 152: rows per page (25, 50, 100), and a box to go straight to a
        page by its number, beside First / Previous / Next / Last.
      */}
      {sorted.length > Math.min(...sizeOptions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-3 py-2.5 no-print">
          <div className="flex items-center gap-3">
            <p className="text-xs text-slate-500">
              Showing {currentPage * perPage + 1}-{Math.min((currentPage + 1) * perPage, sorted.length)} of{' '}
              {sorted.length.toLocaleString('en-PH')}
            </p>
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              Show
              <select
                value={perPage}
                onChange={(e) => {
                  setPerPage(Number(e.target.value));
                  setPage(0);
                }}
                className="rounded border-slate-300 py-0.5 pl-2 pr-7 text-xs"
                aria-label="Rows per page"
              >
                {sizeOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              per page
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(0)}>
              First
            </Button>
            <Button size="sm" disabled={currentPage === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span className="flex items-center gap-1 px-1 text-xs text-slate-600">
              Page
              <input
                type="number"
                min={1}
                max={pageCount}
                value={goTo}
                placeholder={String(currentPage + 1)}
                onChange={(e) => setGoTo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jump();
                }}
                onBlur={() => goTo && jump()}
                className="w-14 rounded border-slate-300 px-1.5 py-0.5 text-center text-xs"
                aria-label="Go to page"
                title="Type a page number and press Enter"
              />
              of {pageCount}
            </span>
            <Button size="sm" disabled={currentPage >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
            <Button size="sm" disabled={currentPage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>
              Last
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TotalsRow<T>({
  columns,
  allKeys,
  totals,
  dense,
}: {
  columns: Column<T>[];
  allKeys: string[];
  totals: NonNullable<Props<T>['totals']>;
  dense?: boolean;
}) {
  const keys = Object.keys(totals.values).filter((k) => totals.values[k] !== undefined);
  // A total named after a column that does not exist would simply vanish.
  // Say so where a developer will see it.
  const unknown = keys.filter((k) => !allKeys.includes(k));
  if (unknown.length > 0) {
    console.error(`DataTable totals name columns that do not exist: ${unknown.join(', ')}`);
  }
  const layout = totalsLayout(
    columns.map((c) => c.key),
    keys,
  );
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return (
    <tr className={totals.className}>
      {layout.labelSpan > 0 && (
        <td className={clsx('cbo-td font-medium', dense && 'py-1.5')} colSpan={layout.labelSpan}>
          {totals.label}
        </td>
      )}
      {layout.cells.map((key) => {
        const col = byKey.get(key)!;
        return (
          <td
            key={key}
            className={clsx(
              'cbo-td',
              dense && 'py-1.5',
              (col.kind === 'amount' || col.kind === 'number' || col.align === 'right') && 'text-right',
              col.kind === 'amount' && 'cbo-amount font-semibold',
              col.align === 'center' && 'text-center',
            )}
          >
            {totals.values[key] ?? null}
          </td>
        );
      })}
    </tr>
  );
}
