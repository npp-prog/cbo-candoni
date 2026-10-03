/**
 * A check is not handed over, and an advice is not sent to the bank, until the
 * Treasurer has reported it.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL
 * ---------------------------------------------------------------------------
 * A check is an accountable form. Once it leaves the office it can be
 * presented, and from that moment the municipality's cash has gone whether or
 * not anybody in Accounting knows the check exists.
 *
 * The Report of Checks Issued is what tells Accounting. Until a check is on a
 * CERTIFIED RCI it is a payment the General Ledger has never heard of - and a
 * check released before that is exactly the shape of the loss that is only
 * discovered at the bank reconciliation, weeks later, with the payee long
 * gone.
 *
 * So the order is fixed: draw the check, report it, then release it. The same
 * for an advice to debit and the RADAI.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS IS ENFORCED
 * ---------------------------------------------------------------------------
 * In firestore.rules, which is the only place a client cannot get around - the
 * check register writes the status change directly, so a rule is what has to
 * refuse it. This module is the SAME rule for the screen, so the button and
 * the refusal cannot disagree, and so the reason can be said in words before
 * anybody presses anything.
 *
 * `treasuryReportId` is stamped on the document when the report is CERTIFIED,
 * not when it is drafted. Putting a check on a draft RCI is therefore not
 * enough, and should not be: a draft is still being changed.
 */

export interface ReportableDocument {
  status: string;
  /** Set by certifyTreasuryReport. Absent until the report is certified. */
  treasuryReportId?: string | null;
  treasuryReportNo?: string | null;
}

/** Has a certified treasury report claimed this document? */
export function isReported(doc: ReportableDocument): boolean {
  return typeof doc.treasuryReportId === 'string' && doc.treasuryReportId.length > 0;
}

export interface Refusal {
  ok: false;
  message: string;
}
export type ReleaseCheckResult = { ok: true } | Refusal;

/** May this check be handed to the payee? */
export function canReleaseCheck(check: ReportableDocument): ReleaseCheckResult {
  if (check.status === 'CANCELLED') {
    return { ok: false, message: 'This check is cancelled. It cannot be released.' };
  }
  if (!isReported(check)) {
    return {
      ok: false,
      message:
        'This check is not on a certified Report of Checks Issued yet. Accounting has no record of it, so releasing it would put the municipality out of pocket on a payment the General Ledger has never seen. Prepare the RCI, have it certified, then release.',
    };
  }
  return { ok: true };
}

/** May this advice go to the bank? */
export function canSubmitAda(ada: ReportableDocument): ReleaseCheckResult {
  if (ada.status === 'CANCELLED') {
    return { ok: false, message: 'This advice is cancelled. It cannot be submitted.' };
  }
  if (!isReported(ada)) {
    return {
      ok: false,
      message:
        'This advice is not on a certified Report of ADA Issued yet. The bank would debit the account on a payment Accounting has no record of. Prepare the RADAI, have it certified, then submit.',
    };
  }
  return { ok: true };
}

/**
 * Can this be undone outright, rather than cancelled as a spoiled form?
 *
 * Only before it has gone anywhere. A check still sitting PREPARED has not
 * been signed, has not left the office and has not been reported, so undoing
 * it harms nothing and returns the voucher to the payment queue.
 *
 * The NUMBER is never returned to the pool, whichever route is taken. The
 * check record stays, marked cancelled, with the reason on it - because a
 * serial that simply disappears is indistinguishable from one drawn and never
 * reported, which is the one thing an auditor cannot let pass.
 */
export function canUndoOutright(doc: ReportableDocument): boolean {
  return doc.status === 'PREPARED' && !isReported(doc);
}
