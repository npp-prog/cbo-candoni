/**
 * Document numbering.
 *
 * Format used by the Municipality of Candoni, e.g. `100-26-09-0001`:
 *   {BOOK} - {YY} - {MM} - {SEQ}
 *   100      26     09     0001
 *   fund     year   month  sequence within fund/year/month
 *
 * The pattern is configurable per document type in `numberingRules`. This
 * module renders a pattern; it never issues a number. Issuing happens inside a
 * Firestore transaction in the Cloud Functions layer, against `counters/`, so
 * two users clicking "Submit" in the same second cannot receive the same DV
 * number. A number rendered here with a placeholder sequence is a *preview*
 * only and is labelled as such in the UI.
 */

export interface NumberParts {
  bookCode: string;
  fiscalYear: number;
  month: number;
  sequence: number;
}

export const DEFAULT_PATTERN = '{BOOK}-{YY}-{MM}-{SEQ}';

/**
 * Render a document number from a pattern.
 *
 * Supported tokens:
 *   {BOOK}  fund book code, e.g. 100
 *   {FUND}  fund short code, e.g. GF
 *   {YYYY}  four-digit fiscal year
 *   {YY}    two-digit fiscal year
 *   {MM}    two-digit month
 *   {SEQ}   zero-padded sequence
 *   {TYPE}  document type, e.g. DV
 */
export function renderDocumentNumber(
  pattern: string,
  parts: NumberParts & { fundCode?: string; docType?: string },
  sequenceLength = 4,
): string {
  const yyyy = String(parts.fiscalYear).padStart(4, '0');
  return pattern
    .replace(/\{BOOK\}/g, parts.bookCode)
    .replace(/\{FUND\}/g, parts.fundCode ?? '')
    .replace(/\{TYPE\}/g, parts.docType ?? '')
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(-2))
    .replace(/\{MM\}/g, String(parts.month).padStart(2, '0'))
    .replace(/\{SEQ\}/g, String(parts.sequence).padStart(sequenceLength, '0'));
}

/**
 * The counter document id a sequence is drawn from. Encodes the reset policy,
 * so changing `resetOn` from MONTH to YEAR starts a new counter rather than
 * corrupting the old one.
 */
export function counterId(input: {
  docType: string;
  fundCode: string;
  fiscalYear: number;
  month: number;
  resetOn: 'YEAR' | 'MONTH' | 'NEVER';
  perFund: boolean;
}): string {
  const fund = input.perFund ? input.fundCode : 'ALL';
  switch (input.resetOn) {
    case 'MONTH':
      return `${input.docType}__${fund}__${input.fiscalYear}__${String(input.month).padStart(2, '0')}`;
    case 'YEAR':
      return `${input.docType}__${fund}__${input.fiscalYear}`;
    case 'NEVER':
      return `${input.docType}__${fund}`;
  }
}

/** A visibly fake number shown before a document is submitted. */
export function previewNumber(
  pattern: string,
  parts: Omit<NumberParts, 'sequence'> & { fundCode?: string; docType?: string },
  sequenceLength = 4,
): string {
  return renderDocumentNumber(
    pattern,
    { ...parts, sequence: 0 },
    sequenceLength,
  ).replace(/0{1,}$/, '·'.repeat(sequenceLength));
}

/** Seeded numbering rules created on first run. */
export const DEFAULT_NUMBERING_RULES = [
  { docType: 'OBR', pattern: DEFAULT_PATTERN, sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'DV', pattern: DEFAULT_PATTERN, sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'JEV', pattern: DEFAULT_PATTERN, sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'RCD', pattern: DEFAULT_PATTERN, sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'LIQ', pattern: DEFAULT_PATTERN, sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'PAYROLL', pattern: DEFAULT_PATTERN, sequenceLength: 4, resetOn: 'MONTH', perFund: true },
  { docType: 'ALLOT', pattern: '{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
  { docType: 'APPROP', pattern: '{BOOK}-{YYYY}-{SEQ}', sequenceLength: 4, resetOn: 'YEAR', perFund: true },
] as const;
