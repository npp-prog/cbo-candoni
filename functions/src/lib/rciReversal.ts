/**
 * Patch 151 / 153 - taking ONE check (or ADA) out of a journalized RCI (or
 * RADAI), into TRUST LIABILITIES.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT THE WHOLE ENTRY
 * ---------------------------------------------------------------------------
 * An RCI is journalized as one entry covering every check on it:
 *
 *     Dr Accounts Payable - Negros Hardware   1,200  Payment of Check No. 1234 - ...
 *     Dr Accounts Payable - Candoni Builders  3,600  Payment of Check No. 1235 - ...
 *       Cr Cash in Bank - LBP 1172-1020-22    1,200  Payment of RCI ... Check No. 1234 - ...
 *       Cr Cash in Bank - LBP 1172-1020-22    3,600  Payment of RCI ... Check No. 1235 - ...
 *
 * When ONE of those checks has to be undone - it is cancelled, or replaced -
 * reversing the whole entry would also undo every check properly paid. So
 * only the chosen check's lines are taken.
 *
 * ---------------------------------------------------------------------------
 * WHY TRUST LIABILITIES, NOT ACCOUNTS PAYABLE (patch 153)
 * ---------------------------------------------------------------------------
 * The voucher behind a check on a journalized report has been paid and
 * reported; its number cannot be used again. So the cash comes back, and what
 * the municipality still owes the payee is held as a TRUST LIABILITY - the
 * same treatment as an ADA credit the bank did not post (patch 143):
 *
 *     Dr Cash in Bank - LBP 1172-1020-22        1,200  Reversal of: Payment of RCI ... 1234
 *       Cr Trust Liabilities - Negros Hardware  1,200  Check No. 1234 cancelled - ...
 *
 * The payee is repaid by a NEW voucher of the Trust liability kind, which is
 * how the payment is reprocessed. The old voucher stays paid, and never goes
 * back to Disbursements for Payment.
 *
 * ---------------------------------------------------------------------------
 * HOW THE LINES OF A DOCUMENT ARE FOUND
 * ---------------------------------------------------------------------------
 * Every payable line names its check or advice ("Payment of Check No. 1234 -
 * ...", "Payment of ADA No. 2026-10-0003 - ..."); a group ADA has one such line
 * per payee. From patch 147 every Cash in Bank line of an RCI names its check
 * too. Where the cash is ONE credit for the whole report (a RADAI, or an RCI
 * from before patch 147), the document's share of that line is taken - the
 * same account and bank-account subsidiary, for the document's amount.
 *
 * If the lines cannot be told apart - reworded, or no longer adding up -
 * nothing is guessed: it is refused with the reason, and the entry can still
 * be corrected by hand.
 */

export interface ReversibleLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  particulars?: string | null;
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
}

export interface DocumentToReverse {
  /** Check number or ADA number. */
  no: string;
  /** Its amount, from the check or ADA itself - never from the browser. */
  amount: number;
}

/** @deprecated patch 151 name; kept for the tests that use it. */
export type CheckToReverse = { checkNo: string; amount: number };

/** 'Check No.' for an RCI, 'ADA No.' for a RADAI. */
export type DocumentLabel = 'Check No.' | 'ADA No.';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when a line's particulars name this document ("Check No. 1234", not 12345). */
export function namesDocument(
  particulars: string | null | undefined,
  label: DocumentLabel,
  no: string,
): boolean {
  if (!particulars || !no.trim()) return false;
  const re = new RegExp(`${escapeRegExp(label)}\\s*${escapeRegExp(no.trim())}(?![\\w-])`, 'i');
  return re.test(particulars);
}

/** Patch 151 name. */
export function namesCheck(particulars: string | null | undefined, checkNo: string): boolean {
  return namesDocument(particulars, 'Check No.', checkNo);
}

const sum = (ls: ReversibleLine[], k: 'debit' | 'credit') =>
  ls.reduce((s, l) => s + (l[k] || 0), 0);

const peso = (n: number) => (n / 100).toFixed(2);

/**
 * The lines that take the chosen documents out of a payment entry: the cash
 * back to its bank account, the amount owed to each payee into Trust
 * Liabilities. Throws a sentence the Accountant can act on when a document's
 * lines cannot be found.
 */
export function paymentReversalLines<L extends ReversibleLine>(
  lines: L[],
  docs: DocumentToReverse[],
  opts: {
    label: DocumentLabel;
    trustLiability: { code: string; name: string };
  },
): L[] {
  const { label } = opts;
  if (docs.length === 0) {
    throw new Error(`Choose at least one ${label === 'ADA No.' ? 'ADA' : 'check'} to reverse.`);
  }

  const creditLines = lines.filter((l) => (l.credit || 0) > 0);
  const out: L[] = [];

  for (const d of docs) {
    const what = `${label} ${d.no}`;
    const debits = lines.filter(
      (l) => (l.debit || 0) > 0 && namesDocument(l.particulars, label, d.no),
    );
    if (debits.length === 0) {
      throw new Error(
        `The entry has no payable line naming ${what}. Its lines may have been reworded; correct the entry by hand instead.`,
      );
    }
    if (sum(debits, 'debit') !== d.amount) {
      throw new Error(
        `The payable lines naming ${what} come to ${peso(sum(debits, 'debit'))}, but it is for ${peso(d.amount)}. Correct the entry by hand instead.`,
      );
    }

    // ---- the cash side: back into the bank account -----------------------
    const credits = creditLines.filter((l) => namesDocument(l.particulars, label, d.no));
    if (credits.length > 0) {
      if (sum(credits, 'credit') !== d.amount) {
        throw new Error(
          `The Cash in Bank lines naming ${what} come to ${peso(sum(credits, 'credit'))}, but it is for ${peso(d.amount)}. Correct the entry by hand instead.`,
        );
      }
      for (const l of credits) {
        out.push({
          ...l,
          debit: l.credit,
          credit: 0,
          particulars: `Reversal of: ${l.particulars ?? 'Cash in Bank'}`,
        });
      }
    } else {
      const first = creditLines[0];
      const oneAccount =
        first &&
        creditLines.every(
          (l) =>
            l.accountCode === first.accountCode &&
            (l.subsidiaryId ?? null) === (first.subsidiaryId ?? null),
        );
      if (!oneAccount) {
        throw new Error(
          `The entry does not show which Cash in Bank line paid ${what}. Correct the entry by hand instead.`,
        );
      }
      out.push({
        ...first,
        debit: d.amount,
        credit: 0,
        particulars: `Reversal of: ${what} - ${first.particulars ?? 'Cash in Bank'}`,
      });
    }

    // ---- what is still owed: Trust Liabilities, payee by payee -----------
    for (const l of debits) {
      out.push({
        ...l,
        accountCode: opts.trustLiability.code,
        accountName: opts.trustLiability.name,
        debit: 0,
        credit: l.debit,
        particulars:
          `${what} cancelled - held in trust for the payee, to be repaid by a new voucher. Was: ${l.particulars ?? ''}`.trim(),
      });
    }
  }

  return out.map((l, i) => ({ ...l, lineNo: i + 1 }));
}

/** Patch 151 entry point, for an RCI. */
export function rciCheckReversalLines<L extends ReversibleLine>(
  lines: L[],
  checks: CheckToReverse[],
  trustLiability: { code: string; name: string } = {
    code: '20401010',
    name: 'Trust Liabilities',
  },
): L[] {
  return paymentReversalLines(
    lines,
    checks.map((c) => ({ no: c.checkNo, amount: c.amount })),
    { label: 'Check No.', trustLiability },
  );
}
