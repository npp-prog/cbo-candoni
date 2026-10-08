import { HttpsError } from 'firebase-functions/v2/https';

/**
 * Augmentations and realignments, prepared before they are posted. Patch 112.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED
 * ---------------------------------------------------------------------------
 * Since patch 103 an AUGMENTATION was prepared on screen and posted when the
 * Budget Officer approved it - but the approval sent the set's LINES from the
 * browser, so what was posted was whatever the browser sent, not necessarily
 * what had been prepared. A REALIGNMENT was not prepared at all: it posted the
 * moment the form was submitted, or the moment a file was uploaded.
 *
 * Now both are prepared, and both are posted the same way:
 *
 *   PREPARING writes one document per set to `augmentationDrafts` (the name is
 *   older than the change; it holds realignments too). Typed on the screen, the
 *   browser writes it. Uploaded from a file, the engine writes it, after every
 *   check it would run on posting - so a file that could never post is refused
 *   at upload, not discovered at approval.
 *
 *   APPROVING sends only the set's id. The engine reads the lines from the
 *   stored set, reads it again inside the transaction that posts it, refuses if
 *   it changed in between, and deletes it in that same transaction. What is
 *   posted is what was prepared - the lesson of patch 110, applied here.
 */

export type PreparedInstrument = 'AUGMENTATION' | 'REALIGNMENT';

export interface PreparedSetLine {
  lineNo?: number;
  officeId?: string | null;
  officeName?: string;
  lineId?: string | null;
  fppCode?: string;
  fppName?: string;
  sector?: string;
  serviceSector?: string | null;
  accountCode?: string;
  accountName?: string;
  expenseClass?: string;
  amount?: number;
  particulars?: string | null;
}

export interface PreparedSet {
  fiscalYear?: number;
  fundCode?: string;
  instrument?: string;
  authorityReference?: string;
  authorityDate?: string;
  importFileName?: string | null;
  status?: string;
  lines?: PreparedSetLine[];
}

/** The id an UPLOADED set is stored under, so the same file cannot be prepared twice. */
export function preparedSetId(
  fiscalYear: number,
  fundCode: string,
  instrument: string,
  refSlug: string,
): string {
  return `${fiscalYear}__${fundCode}__${instrument}__${refSlug}`;
}

/**
 * The posting a stored set asks for, read from the set alone.
 *
 * Every field the posting needs comes from here and none from the request.
 * A set that is not in a state to post is refused with the reason.
 */
export function postingFromPreparedSet(set: PreparedSet): {
  fiscalYear: number;
  fundCode: string;
  appropriationKind: 'REALIGNMENT';
  instrument: PreparedInstrument;
  reference: string;
  date: string;
  fileName: string;
  rows: Array<{
    lineNo: number;
    office: string;
    fpp: string;
    fppName?: string;
    sector?: string;
    serviceSector?: string;
    accountCode?: string;
    expenseClass?: string;
    amount: number;
    particulars?: string;
  }>;
} {
  if (set.status !== 'DRAFT') {
    throw new HttpsError(
      'failed-precondition',
      'That prepared set is not waiting for approval any more. Nothing was posted.',
    );
  }
  const instrument = String(set.instrument ?? '').toUpperCase();
  if (instrument !== 'AUGMENTATION' && instrument !== 'REALIGNMENT') {
    throw new HttpsError(
      'failed-precondition',
      'That prepared set does not say whether it is an augmentation or a realignment. ' +
        'Discard it and prepare it again.',
    );
  }
  const reference = String(set.authorityReference ?? '').trim();
  if (!reference) {
    throw new HttpsError(
      'failed-precondition',
      'That prepared set has no authority reference. Edit it and add the ordinance or office ' +
        'order it was made under - it is also what stops it being posted twice.',
    );
  }
  const lines = set.lines ?? [];
  if (lines.length === 0) {
    throw new HttpsError('failed-precondition', 'That prepared set has no lines on it.');
  }

  return {
    fiscalYear: Number(set.fiscalYear),
    fundCode: String(set.fundCode ?? ''),
    appropriationKind: 'REALIGNMENT',
    instrument,
    reference,
    date: String(set.authorityDate ?? ''),
    fileName: set.importFileName || 'Prepared on screen',
    rows: lines.map((l, i) => ({
      lineNo: i + 1,
      office: String(l.officeName ?? ''),
      fpp: String(l.fppCode ?? ''),
      fppName: l.fppName || undefined,
      sector: l.sector || undefined,
      serviceSector: l.serviceSector || undefined,
      accountCode: l.accountCode || undefined,
      expenseClass: l.expenseClass || undefined,
      amount: Number(l.amount ?? 0),
      particulars: l.particulars?.trim() || undefined,
    })),
  };
}
