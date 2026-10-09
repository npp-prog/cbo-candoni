/**
 * Where a totals row's cells fall, given the columns actually on screen.
 * Patch 122.
 *
 * Every list with a totals row used to write its own `<tr>` with a hand-
 * counted `colSpan`. The count was right for the columns shown by default
 * and wrong the moment one was hidden or shown in Columns - and some were
 * wrong from the start, because an optional column (OBR No. on the voucher
 * list, Office on the obligations) is hidden by default and was counted
 * anyway. The total then sat under the column to its right.
 *
 * Now a page names the column each total belongs to, and the table lays the
 * row out against the columns it is drawing. The label spans every column
 * before the first total.
 */
export interface TotalsLayout {
  /** How many leading columns the label spans; 0 when there is no room for one. */
  labelSpan: number;
  /** The keys of the columns after the label, in order - each gets one cell. */
  cells: string[];
}

export function totalsLayout(
  visibleKeys: readonly string[],
  valueKeys: readonly string[],
): TotalsLayout {
  const has = new Set(valueKeys);
  const first = visibleKeys.findIndex((k) => has.has(k));
  if (first === -1) return { labelSpan: visibleKeys.length, cells: [] };
  return { labelSpan: first, cells: visibleKeys.slice(first) };
}
