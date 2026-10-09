/**
 * The journal entry a Report of Checks Issued or of ADA Issued proposes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * It was written twice: once in the browser, for a report prepared by hand,
 * and once in the engine, for one loaded from a bank file. The two agreed, by
 * inspection, on the day they were written. Nothing made them keep agreeing,
 * and the entry a report posts is the entry the Check Disbursements Journal is
 * built from - two versions of it is two versions of that journal.
 *
 * So it lives here, and is vendored into the engine by `scripts/sync-rules.mjs`
 * with the build failing on drift.
 *
 * It imports NOTHING, which is the condition of being vendored. The cash line
 * is passed in rather than derived, because deriving it needs the Chart of
 * Accounts and the bank record, and those are the caller's to read.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAYABLE IS ONE LINE PER DOCUMENT
 * ---------------------------------------------------------------------------
 * It used to be a single debit for the whole report:
 *
 *     Dr  Accounts Payable       480,000.00   "Payments per RCI"
 *       Cr  Cash in Bank                        480,000.00
 *
 * which is arithmetically right and tells a reader nothing. The office asked
 * for the check number and the voucher's own particulars on the entry, and the
 * reason that request is worth more than its wording suggests is the
 * SUBSIDIARY LEDGER.
 *
 * Accounts Payable is a control account. The General Ledger carries one figure
 * for it; the subsidiary ledger carries whom it is owed to. A single lump debit
 * clears the control account by 480,000 and clears NOBODY's subsidiary account,
 * so the two stop agreeing the first time a report is posted - and the Aging of
 * Payables goes on showing suppliers who were paid last month.
 *
 * One line per check, each carrying its payee, settles each creditor by name:
 *
 *     Dr  Accounts Payable        120,000.00   "Payment of Check No. 1234 -
 *         Negros Hardware                       purchase of office supplies"
 *     Dr  Accounts Payable        360,000.00   "Payment of Check No. 1235 - ..."
 *         Candoni Builders
 *       Cr  Cash in Bank                        480,000.00
 *
 * ---------------------------------------------------------------------------
 * WHY THE RCI'S CASH IS ALSO ONE LINE PER CHECK (patch 147)
 * ---------------------------------------------------------------------------
 * The credit used to be one line for the report. The office asked for it per
 * check, and on an RCI that is how the bank sees it: each check is paid, and
 * appears on the statement, on its own day, when the payee presents it.
 *
 *       Cr  Cash in Bank                        120,000.00   "Payment of RCI
 *           Land Bank 1172-1020-22                2026-10-0005 Check No. 1234 -
 *                                                 purchase of office supplies"
 *       Cr  Cash in Bank                        360,000.00   "Payment of RCI ..."
 *
 * A RADAI keeps one credit: the bank debits the whole advice list at once,
 * and the reconciliation matches it as that one debit (patch 146).
 */

/** A check or an advice, as the report records it. */
export interface PaidDocument {
  /** Check number or ADA number. */
  sourceNo: string;
  payeeId?: string | null;
  payeeName?: string | null;
  /** The voucher's own particulars, carried onto the instrument. */
  particulars?: string | null;
  amount: number;
  /** A cancelled check: reported, footed around, and not an entry line. */
  excluded?: boolean;
  /**
   * Patch 138 - an ADA paying a voucher of several payees ("Payee, et al.").
   * The voucher credited Accounts Payable per payee, so the payment debits it
   * per payee too: one line each, naming them. Without this the payable
   * would be credited to forty people and cleared against one.
   */
  payees?: Array<{ payeeId?: string | null; payeeName: string; amount: number }> | null;
}

/** The credit side, worked out by the caller from the bank account. */
export interface CashLine {
  accountCode: string;
  accountName: string;
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
}

export interface ProposedEntryLine {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
  particulars?: string;
}

/**
 * How the instrument is named in the particulars.
 *
 * "Check No." and "ADA No." are what the office writes on the paper, so they
 * are what the entry says. Not "RCI"/"RADAI" - those name the REPORT, and the
 * reader of a ledger line wants the instrument they can go and find.
 */
export const INSTRUMENT_LABEL: Record<string, string> = {
  RCI: 'Check No.',
  RADAI: 'ADA No.',
};

/**
 * "Payment of Check No. 1234 - purchase of office supplies".
 *
 * The number first, because that is what a line is looked up by, and the
 * voucher's particulars after it. A document with no particulars gets the
 * number alone rather than a dangling dash.
 */
export function paymentParticulars(
  kind: string,
  sourceNo: string,
  particulars?: string | null,
): string {
  const label = INSTRUMENT_LABEL[kind] ?? 'No.';
  const head = `Payment of ${label} ${String(sourceNo ?? '').trim()}`.trim();
  const tail = String(particulars ?? '').trim();
  return tail ? `${head} - ${tail}` : head;
}

/**
 * The proposed entry for an RCI or a RADAI.
 *
 * Returns an empty array when there is nothing to post, which is the caller's
 * signal to refuse rather than to post an empty entry: a report with no
 * reportable documents is a report that should not have been prepared.
 */
export function proposePaymentEntry(input: {
  /** 'RCI' or 'RADAI'. */
  kind: string;
  payable: { code: string; name: string };
  cash: CashLine;
  documents: PaidDocument[];
  /** Patch 147: the report's number, for the RCI's cash lines. */
  reportNo?: string | null;
}): ProposedEntryLine[] {
  const live = input.documents.filter((d) => !d.excluded && (d.amount ?? 0) !== 0);
  if (live.length === 0) return [];

  const total = live.reduce((sum, d) => sum + (d.amount ?? 0), 0);

  const debits: ProposedEntryLine[] = live.flatMap((d) =>
    d.payees && d.payees.length > 0
      ? d.payees.map((p) => ({
          accountCode: input.payable.code,
          accountName: input.payable.name,
          debit: p.amount,
          credit: 0,
          subsidiaryType: p.payeeId ? 'PAYEE' : null,
          subsidiaryId: p.payeeId ?? null,
          subsidiaryName: p.payeeId ? p.payeeName : null,
          particulars: paymentParticulars(input.kind, d.sourceNo, d.particulars),
        }))
      : [single(d)],
  );

  function single(d: PaidDocument): ProposedEntryLine {
    return {
    accountCode: input.payable.code,
    accountName: input.payable.name,
    debit: d.amount,
    credit: 0,
    /*
     * The payee, where the report knows which payee record it was. A report
     * loaded from a bank file carries a NAME and no id - the subsidiary is
     * then left empty rather than guessed from the name, because two suppliers
     * with similar names would be merged into one subsidiary account by a
     * guess, and nothing would say so.
     */
    subsidiaryType: d.payeeId ? 'PAYEE' : null,
    subsidiaryId: d.payeeId ?? null,
    subsidiaryName: d.payeeId ? (d.payeeName ?? null) : null,
    particulars: paymentParticulars(input.kind, d.sourceNo, d.particulars),
    };
  }

  /*
   * Patch 147. On an RCI the bank pays each CHECK on its own, when it is
   * presented - so Cash in Bank is credited per check, each line saying
   * "Payment of RCI <no> Check No. <no> - <the voucher's particulars>", and
   * every line agrees with one line of the bank statement.
   *
   * A RADAI is posted by the bank as one debit (patch 146 reconciles it so),
   * and keeps one credit for the whole report.
   */
  if (input.kind === 'RCI') {
    return [
      ...debits,
      ...live.map((d) => ({
        ...input.cash,
        debit: 0,
        credit: d.amount,
        particulars: reportCashParticulars(input.kind, input.reportNo, d.sourceNo, d.particulars),
      })),
    ];
  }

  return [
    ...debits,
    {
      ...input.cash,
      debit: 0,
      credit: total,
      particulars: `Payments per ${input.kind}`,
    },
  ];
}

/**
 * Patch 147: "Payment of RCI 2026-10-0005 Check No. 123462 - supplies".
 * The report's number is left out while the report has none yet; it is put
 * in when the report is certified (renumberPaymentEntry).
 */
export function reportCashParticulars(
  kind: string,
  reportNo: string | null | undefined,
  sourceNo: string,
  particulars?: string | null,
): string {
  const no = String(reportNo ?? '').trim();
  const label = INSTRUMENT_LABEL[kind] ?? 'No.';
  const head = `Payment of ${kind}${no ? ` ${no}` : ''} ${label} ${String(sourceNo ?? '').trim()}`;
  const tail = String(particulars ?? '').trim();
  return tail ? `${head} - ${tail}` : head;
}

/**
 * Patch 147: writes the report's (final) number into the cash lines of its
 * entry - at certification, when the number is fixed. Lines that do not read
 * "Payment of RCI ... Check No." are left exactly as they are, so an entry the
 * Accountant reworded keeps its wording.
 */
export function renumberPaymentEntry<L extends { credit: number; particulars?: string | null }>(
  entry: L[] | undefined,
  kind: string,
  reportNo: string,
): L[] {
  const label = INSTRUMENT_LABEL[kind];
  if (!entry || !label) return entry ?? [];
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^Payment of ${kind}(?: \\S+)? (${escaped})`);
  return entry.map((l) =>
    (l.credit ?? 0) > 0 && typeof l.particulars === 'string' && pattern.test(l.particulars)
      ? { ...l, particulars: l.particulars.replace(pattern, `Payment of ${kind} ${reportNo} $1`) }
      : l,
  );
}

/**
 * The entry again, after a held row has been resolved onto the report.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST RESCALE IT
 * ---------------------------------------------------------------------------
 * The upload used to stretch the existing entry to the new total: every debit
 * became the total, every credit became the total. That was right while the
 * entry was two lines footing to one figure.
 *
 * It is wrong now. The resolved row is a NEW document with its own creditor,
 * and stretching the existing debits to cover it would spread one supplier's
 * payment across everybody else's subsidiary accounts - arithmetically correct
 * and factually nonsense, which is the worst combination a ledger can offer.
 *
 * The CASH line is carried over rather than recomputed, because working it out
 * needs the bank record and the Chart of Accounts, and the path that resolves a
 * held row has neither to hand. Carrying it is also the more faithful answer:
 * it is the same bank account it was when the report was created, and if the
 * Accountant has already adjusted that line, their version survives.
 */
export function rebuildPaymentEntry(input: {
  kind: string;
  payable: { code: string; name: string };
  /** The entry as it stands, which is where the cash line comes from. */
  existing: ProposedEntryLine[] | undefined;
  documents: PaidDocument[];
  reportNo?: string | null;
}): ProposedEntryLine[] {
  const cash = (input.existing ?? []).find((l) => (l.credit ?? 0) > 0);
  if (!cash) return input.existing ?? [];

  return proposePaymentEntry({
    kind: input.kind,
    payable: input.payable,
    cash: {
      accountCode: cash.accountCode,
      accountName: cash.accountName,
      subsidiaryType: cash.subsidiaryType ?? null,
      subsidiaryId: cash.subsidiaryId ?? null,
      subsidiaryName: cash.subsidiaryName ?? null,
    },
    documents: input.documents,
    reportNo: input.reportNo,
  });
}

// ---------------------------------------------------------------------------
// Patch 143 - an ADA "posted online" with some credits not posted
// ---------------------------------------------------------------------------

/** One payee of an ADA as the bank's online posting reported it. */
export interface UnpostedCredit {
  payeeId?: string | null;
  payeeName: string;
  accountNumber?: string | null;
  amount: number;
  /** Patch 144: the advice it was on, when the entry covers a whole RADAI. */
  adaNo?: string;
}

/**
 * The adjusting entry for the credits the bank did not post.
 *
 * The RADAI's entry paid the whole advice out of Cash in Bank (Dr payable per
 * payee, Cr Cash). A credit the bank did not post never left the account, and
 * the municipality still owes that payee - but no longer as an ordinary
 * payable: it is money held for them until a new voucher repays it. So:
 *
 *   Dr  Cash in Bank (the advice's account)          the total not posted
 *       Cr  Trust Liabilities - <payee>              each payee's amount
 *
 * The new voucher (category "Trust liability") then debits Trust Liabilities
 * for that payee when it is paid again.
 */
export function proposeNotPostedEntry(input: {
  adaNo: string;
  cash: CashLine;
  trustLiability: { code: string; name: string };
  credits: UnpostedCredit[];
}): ProposedEntryLine[] {
  const credits = input.credits.filter((c) => c.amount > 0);
  const total = credits.reduce((t, c) => t + c.amount, 0);
  if (total <= 0) return [];
  return [
    {
      accountCode: input.cash.accountCode,
      accountName: input.cash.accountName,
      debit: total,
      credit: 0,
      subsidiaryType: input.cash.subsidiaryType ?? null,
      subsidiaryId: input.cash.subsidiaryId ?? null,
      subsidiaryName: input.cash.subsidiaryName ?? null,
      particulars: `ADA ${input.adaNo} - credits not posted online by the bank`,
    },
    ...credits.map((c) => ({
      accountCode: input.trustLiability.code,
      accountName: input.trustLiability.name,
      debit: 0,
      credit: c.amount,
      subsidiaryType: c.payeeId ? 'PAYEE' : null,
      subsidiaryId: c.payeeId ?? null,
      subsidiaryName: c.payeeName,
      particulars: `ADA ${c.adaNo ?? input.adaNo} not posted to ${c.payeeName}${
        c.accountNumber ? ` (ATM ${c.accountNumber})` : ''
      } - to be repaid by a new voucher`,
    })),
  ];
}
