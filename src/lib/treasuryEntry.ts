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
 * The credit stays as one line. It is one withdrawal from one bank account, and
 * splitting it would invent a transaction per check that the bank statement has
 * no counterpart for - which is precisely what bank reconciliation would then
 * fail to match.
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
  });
}
