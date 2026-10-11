/**
 * Printing onto paper that is already printed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DIFFERENT FROM EVERY OTHER PRINT IN CFMS
 * ---------------------------------------------------------------------------
 * Every other report in CFMS puts ink on blank paper, so the layout only has to
 * be readable. These two put ink on a form that already exists - an
 * Accountable Form No. 51 with its boxes, a LANDBANK check with its barcode
 * and MICR band - and the layout has to land inside boxes drawn by somebody
 * else, on a printer whose feed is out by a millimetre or two in a direction
 * nobody can predict.
 *
 * No amount of care in the code fixes that. The only thing that fixes it is
 * one afternoon with a ruler and a sheet of plain paper, and a way to save the
 * result. That is what this file is: positions in MILLIMETRES, adjustable by
 * the person at the printer, stored per machine.
 *
 * ---------------------------------------------------------------------------
 * WHY MILLIMETRES AND NOT PIXELS
 * ---------------------------------------------------------------------------
 * A pixel means nothing on paper. CSS understands `mm` natively and browsers
 * honour it when the print dialogue is set to 100% with no page scaling, so a
 * field at `x: 42mm` lands 42 mm from the left edge of the sheet - which is a
 * number somebody can measure with a ruler and correct. Working in pixels
 * would mean the office could see the error and not be able to say what it was.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CALIBRATION IS PER MACHINE
 * ---------------------------------------------------------------------------
 * It is a property of the printer, not of the municipality. The Treasurer's
 * printer and the cashier's printer are out by different amounts, and storing
 * one figure for both would make each of them wrong half the time. So it lives
 * in the browser's own storage on that workstation - and because that is easy
 * to lose, the calibration can be exported as text and pasted into another
 * machine rather than measured again.
 * ---------------------------------------------------------------------------
 */

/** A field printed onto pre-printed stock. All measurements in millimetres. */
export interface PrintField {
  key: string;
  /** What the person calibrating sees in the field list. */
  label: string;
  /** Distance from the left edge of the sheet. */
  x: number;
  /** Distance from the top edge of the sheet, to the TOP of the text. */
  y: number;
  /** Font size in points. */
  size: number;
  align?: 'left' | 'right' | 'center';
  bold?: boolean;
  /** Maximum width before the text is allowed to shrink, in millimetres. */
  maxWidth?: number;
  /** Set on fields that are optional on the form, so they can be moved away. */
  optional?: boolean;
  /**
   * Patch 175: a column of a repeating block - the key it reads from each
   * row. The AF 56 has thirteen columns per property; the AF 51's two line
   * item anchors read 'description' and 'amount'.
   */
  row?: string;
}

export interface SheetSize {
  /** Width in millimetres. */
  width: number;
  /** Height in millimetres. */
  height: number;
}

export interface Calibration {
  /** Per-field positions, keyed by field key. */
  fields: Record<string, { x: number; y: number; size: number }>;
  /** Whole-sheet nudge, for a printer whose feed is out. */
  offsetX: number;
  offsetY: number;
  /** Multiplies every font size, for a printer that renders heavy or light. */
  fontScale: number;
  /** Millimetres between rows in a repeating block. */
  rowSpacing: number;
}

// ---------------------------------------------------------------------------
// The two forms
// ---------------------------------------------------------------------------

/**
 * LANDBANK check, 8 inches by 3 inches.
 *
 * The positions below are a starting point measured from a specimen, NOT a
 * guarantee. Every office calibrates once against its own stock and its own
 * printer; that is the expected first use of the screen, not a fault.
 */
export const CHECK_SHEET: SheetSize = { width: 203.2, height: 76.2 };

export const CHECK_FIELDS: PrintField[] = [
  { key: 'date', label: 'Date', x: 148, y: 18, size: 10, align: 'left' },
  { key: 'payee', label: 'Pay to the order of', x: 22, y: 30, size: 10, maxWidth: 120 },
  {
    key: 'amountFigures',
    label: 'Amount in figures',
    x: 196,
    y: 30,
    size: 11,
    align: 'right',
    bold: true,
  },
  {
    key: 'amountWords1',
    label: 'Amount in words, first line',
    x: 22,
    y: 41,
    size: 9,
    maxWidth: 170,
  },
  {
    key: 'amountWords2',
    label: 'Amount in words, second line',
    x: 22,
    y: 47,
    size: 9,
    maxWidth: 170,
  },
  { key: 'memo', label: 'DV number (optional)', x: 22, y: 60, size: 7, optional: true },
];

/**
 * Accountable Form No. 51, 105 mm by 215 mm.
 *
 * The line items are not seven separate fields. They are one anchor and a row
 * spacing, because moving seven descriptions one at a time is how a
 * calibration screen becomes something nobody uses twice.
 */
export const OR_SHEET: SheetSize = { width: 105, height: 215 };

export const OR_FIELDS: PrintField[] = [
  { key: 'date', label: 'Date', x: 62, y: 34, size: 9 },
  { key: 'payor', label: 'Payor', x: 18, y: 45, size: 9, maxWidth: 80 },
  { key: 'payorTin', label: 'TIN (optional)', x: 18, y: 52, size: 8, optional: true },
  {
    key: 'lineDescription',
    label: 'Line items — first description',
    x: 14,
    y: 68,
    size: 8,
    maxWidth: 55,
    row: 'description',
  },
  {
    key: 'lineAmount',
    label: 'Line items — first amount',
    x: 95,
    y: 68,
    size: 8,
    align: 'right',
    row: 'amount',
  },
  {
    key: 'totalFigures',
    label: 'Total in figures',
    x: 95,
    y: 138,
    size: 10,
    align: 'right',
    bold: true,
  },
  { key: 'totalWords', label: 'Total in words', x: 14, y: 148, size: 8, maxWidth: 85 },
  {
    key: 'collectingOfficer',
    label: 'Collecting officer',
    x: 55,
    y: 178,
    size: 8,
    align: 'center',
  },
];

/** Line items that fit on one receipt before it continues onto another. */
export const OR_LINES_PER_SHEET = 7;

/**
 * Patch 175 - Accountable Form No. 56 (Revised 1994), the real property tax
 * receipt, printed LANDSCAPE.
 *
 * The size is not published anywhere CFMS could check. 216 by 108 mm (8.5 by
 * 4.25 inches) is the proportion of the office's own specimen, and the
 * positions below were measured from that specimen on that size. The paper
 * size can be changed on the Print receipts screen: measure a blank AF 56 with
 * a ruler once, type its width and height, then calibrate as for the AF 51.
 */
export const AF56_SHEET: SheetSize = { width: 216, height: 108 };

/** The ruled rows on the form: up to four properties, then Basic and SEF. */
export const AF56_ROWS_PER_SHEET = 6;
export const AF56_ROW_SPACING = 5.3;

export const AF56_FIELDS: PrintField[] = [
  { key: 'municipality', label: 'Municipality', x: 82, y: 15.2, size: 9, align: 'center' },
  {
    key: 'prevReceiptNo',
    label: 'Previous tax receipt no. (optional)',
    x: 133,
    y: 8.8,
    size: 8,
    optional: true,
  },
  {
    key: 'prevDated',
    label: 'Previous receipt - dated (optional)',
    x: 133,
    y: 18,
    size: 8,
    optional: true,
  },
  {
    key: 'prevYear',
    label: 'Previous receipt - for the year (optional)',
    x: 160,
    y: 18,
    size: 8,
    optional: true,
  },
  { key: 'date', label: 'Date', x: 180, y: 18, size: 8 },
  { key: 'payor', label: 'Received from', x: 15, y: 26.5, size: 9, maxWidth: 52 },
  { key: 'amountWords1', label: 'The sum of - first line', x: 88, y: 25, size: 7, maxWidth: 90 },
  { key: 'amountWords2', label: 'The sum of - second line', x: 88, y: 29, size: 7, maxWidth: 90 },
  {
    key: 'amountFigures',
    label: 'Amount in figures',
    x: 212,
    y: 28.3,
    size: 9,
    align: 'right',
    bold: true,
  },
  { key: 'fullMark', label: 'Full (X)', x: 33.6, y: 32.8, size: 9, bold: true },
  { key: 'installmentMark', label: 'Installment (X)', x: 33.6, y: 37.8, size: 9, bold: true },
  { key: 'calendarYear', label: 'Calendar Year', x: 149, y: 35.5, size: 10, bold: true },
  { key: 'basicMark', label: 'Basic Tax (X)', x: 179.2, y: 34, size: 9, bold: true },
  { key: 'sefMark', label: 'Special Education Fund (X)', x: 179.2, y: 38.8, size: 9, bold: true },
  {
    key: 'rowOwner',
    label: 'Rows - name of declared owner',
    x: 2,
    y: 53.2,
    size: 6.5,
    maxWidth: 32,
    row: 'owner',
  },
  {
    key: 'rowLocation',
    label: 'Rows - location',
    x: 36,
    y: 53.2,
    size: 6.5,
    maxWidth: 22,
    row: 'location',
  },
  {
    key: 'rowLotBlock',
    label: 'Rows - lot no. / block',
    x: 60,
    y: 53.2,
    size: 6,
    maxWidth: 11,
    row: 'lotBlock',
  },
  {
    key: 'rowTdNo',
    label: 'Rows - tax dec. no.',
    x: 72,
    y: 53.2,
    size: 6,
    maxWidth: 12,
    row: 'tdNo',
  },
  {
    key: 'rowAvLand',
    label: 'Rows - assessed value, land',
    x: 94.5,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'avLand',
  },
  {
    key: 'rowAvImprovement',
    label: 'Rows - assessed value, improvement',
    x: 108.5,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'avImprovement',
  },
  {
    key: 'rowAvTotal',
    label: 'Rows - assessed value, total',
    x: 119,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'avTotal',
  },
  {
    key: 'rowTaxDue',
    label: 'Rows - tax due',
    x: 134,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'taxDue',
  },
  { key: 'rowInstNo', label: 'Rows - installment no.', x: 136.5, y: 53.2, size: 6, row: 'instNo' },
  {
    key: 'rowInstPayment',
    label: 'Rows - installment payment',
    x: 160,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'instPayment',
  },
  {
    key: 'rowFullPayment',
    label: 'Rows - full payment',
    x: 181,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'fullPayment',
  },
  {
    key: 'rowPenalty',
    label: 'Rows - penalty',
    x: 192.5,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'penalty',
  },
  {
    key: 'rowTotal',
    label: 'Rows - total',
    x: 213.5,
    y: 53.2,
    size: 6,
    align: 'right',
    row: 'total',
  },
  { key: 'totalFigures', label: 'TOTAL', x: 210, y: 86, size: 10, align: 'right', bold: true },
  { key: 'cashAmount', label: 'Mode of payment - cash', x: 99, y: 90, size: 8, align: 'right' },
  {
    key: 'checkNo',
    label: 'Mode of payment - check no. (optional)',
    x: 62,
    y: 93.5,
    size: 7,
    optional: true,
  },
  {
    key: 'bankDate',
    label: 'Mode of payment - bank/date (optional)',
    x: 62,
    y: 96.6,
    size: 7,
    optional: true,
  },
  { key: 'modeTotal', label: 'Mode of payment - total', x: 99, y: 104.2, size: 8, align: 'right' },
  {
    key: 'collectingOfficer',
    label: 'Deputy / collecting agent',
    x: 131.5,
    y: 100.5,
    size: 8,
    align: 'center',
  },
  { key: 'treasurer', label: 'Municipal Treasurer', x: 187.5, y: 100.5, size: 8, align: 'center' },
];

const SHEET_PREFIX = 'cbo.print.sheet.';

/** Patch 175: the paper size measured on this machine, for a form whose size varies. */
export function loadSheetSize(form: string, fallback: SheetSize): SheetSize {
  try {
    const raw = window.localStorage.getItem(SHEET_PREFIX + form);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Partial<SheetSize>;
    const ok = (v: unknown) => typeof v === 'number' && v >= 50 && v <= 400;
    return ok(s.width) && ok(s.height) ? { width: s.width!, height: s.height! } : fallback;
  } catch {
    return fallback;
  }
}

export function saveSheetSize(form: string, sheet: SheetSize): void {
  try {
    window.localStorage.setItem(SHEET_PREFIX + form, JSON.stringify(sheet));
  } catch {
    /* The default applies. */
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'cbo.print.calibration.';

export function defaultCalibration(fields: PrintField[], rowSpacing = 6): Calibration {
  return {
    fields: Object.fromEntries(fields.map((f) => [f.key, { x: f.x, y: f.y, size: f.size }])),
    offsetX: 0,
    offsetY: 0,
    fontScale: 1,
    rowSpacing,
  };
}

/**
 * Reads this machine's calibration, falling back to the measured defaults.
 *
 * Storage can be unavailable - a locked-down browser profile, a private
 * window - and the form still has to print. So every read is guarded and a
 * failure simply means the defaults, not an error on screen.
 */
export function loadCalibration(
  form: string,
  fields: PrintField[],
  rowSpacing?: number,
): Calibration {
  const fallback = defaultCalibration(fields, rowSpacing);
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + form);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Calibration>;
    return {
      // A field added to the form after a calibration was saved takes its
      // default, rather than vanishing from the printout.
      fields: { ...fallback.fields, ...(saved.fields ?? {}) },
      offsetX: Number.isFinite(saved.offsetX) ? (saved.offsetX as number) : 0,
      offsetY: Number.isFinite(saved.offsetY) ? (saved.offsetY as number) : 0,
      fontScale: Number.isFinite(saved.fontScale) ? (saved.fontScale as number) : 1,
      rowSpacing: Number.isFinite(saved.rowSpacing)
        ? (saved.rowSpacing as number)
        : fallback.rowSpacing,
    };
  } catch {
    return fallback;
  }
}

export function saveCalibration(form: string, calibration: Calibration): boolean {
  try {
    window.localStorage.setItem(KEY_PREFIX + form, JSON.stringify(calibration));
    return true;
  } catch {
    return false;
  }
}

export function clearCalibration(form: string): void {
  try {
    window.localStorage.removeItem(KEY_PREFIX + form);
  } catch {
    /* Nothing to do: the defaults apply either way. */
  }
}

/** The calibration as text, to carry to another workstation. */
export function exportCalibration(calibration: Calibration): string {
  return JSON.stringify(calibration, null, 2);
}

/** Reads a pasted calibration. Returns null rather than throwing on rubbish. */
export function importCalibration(text: string, fields: PrintField[]): Calibration | null {
  try {
    const parsed = JSON.parse(text) as Partial<Calibration>;
    if (!parsed || typeof parsed !== 'object' || !parsed.fields) return null;
    const base = defaultCalibration(fields);
    return {
      fields: { ...base.fields, ...parsed.fields },
      offsetX: Number(parsed.offsetX) || 0,
      offsetY: Number(parsed.offsetY) || 0,
      fontScale: Number(parsed.fontScale) || 1,
      rowSpacing: Number(parsed.rowSpacing) || base.rowSpacing,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * The CSS for one field, with the sheet offset and font scale applied.
 *
 * The sheet is passed in rather than held in a module variable: two print
 * screens can be mounted at once - a check preview behind a receipt dialog -
 * and a shared mutable width would silently put one of them on the other's
 * paper.
 */
export function fieldStyle(
  field: PrintField,
  calibration: Calibration,
  sheet: SheetSize,
  rowIndex = 0,
): React.CSSProperties {
  const pos = calibration.fields[field.key] ?? { x: field.x, y: field.y, size: field.size };
  const top = pos.y + calibration.offsetY + rowIndex * calibration.rowSpacing;
  const left = pos.x + calibration.offsetX;

  const base: React.CSSProperties = {
    position: 'absolute',
    top: `${top}mm`,
    fontSize: `${(pos.size * calibration.fontScale).toFixed(2)}pt`,
    fontWeight: field.bold ? 700 : 400,
    whiteSpace: 'nowrap',
    lineHeight: 1,
  };

  if (field.align === 'right') {
    // A right-aligned field is anchored at its RIGHT edge, because that is
    // what the box on the form is: the peso column ends where it ends.
    return { ...base, right: `${sheet.width - left}mm`, textAlign: 'right' };
  }
  if (field.align === 'center') {
    return { ...base, left: `${left}mm`, transform: 'translateX(-50%)', textAlign: 'center' };
  }
  return {
    ...base,
    left: `${left}mm`,
    maxWidth: field.maxWidth ? `${field.maxWidth}mm` : undefined,
  };
}

/**
 * Splits an amount in words across two lines of a given character budget.
 *
 * The break is on a space, and when there is no space to break on the split is
 * hard - but not lossy. Skipping the character at the break point is right
 * only when that character IS the space being consumed; doing it
 * unconditionally would drop a letter out of the middle of an amount in words
 * on the face of a check, silently, and only on the one line long enough to
 * need breaking.
 */
export function splitWords(text: string, perLine = 62): [string, string] {
  if (text.length <= perLine) return [text, ''];
  const cut = text.lastIndexOf(' ', perLine);
  if (cut > 0) return [text.slice(0, cut), text.slice(cut + 1)];
  return [text.slice(0, perLine), text.slice(perLine)];
}
