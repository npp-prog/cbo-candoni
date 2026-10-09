/**
 * Patch 151 - reversing ONE check (or a few) of an RCI's journal entry.
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
 * When ONE of those checks has to be undone - it is cancelled, or replaced by
 * another - reversing the whole entry would also undo every check that was
 * properly paid, and they would all have to be booked again. So the reversal
 * picks the lines of the chosen check only and mirrors them:
 *
 *     Dr Cash in Bank - LBP 1172-1020-22      1,200  Reversal of: Payment of RCI ... 1234
 *       Cr Accounts Payable - Negros Hardware 1,200  Reversal of: Payment of Check No. 1234
 *
 * The payable is owed again (to the same payee, in its subsidiary ledger) and
 * the cash is back in the same bank account.
 *
 * ---------------------------------------------------------------------------
 * HOW THE LINES OF A CHECK ARE FOUND
 * ---------------------------------------------------------------------------
 * Every payable line names its check ("Payment of Check No. 1234 - ..."),
 * since the payable became one line per document. From patch 147 so does every
 * Cash in Bank line. An older entry has ONE Cash in Bank credit for the whole
 * report; then the check's share of it is reversed - the same account and
 * bank-account subsidiary, for the check's amount.
 *
 * If the lines cannot be told apart - the Accountant reworded them, or split
 * a check across lines that no longer add up to it - nothing is guessed: the
 * reversal is refused with the reason, and the entry can still be corrected
 * by hand.
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

export interface CheckToReverse {
  checkNo: string;
  /** The amount of the check, from the check itself - never from the browser. */
  amount: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when a line's particulars name this check ("Check No. 1234", not 12345). */
export function namesCheck(particulars: string | null | undefined, checkNo: string): boolean {
  if (!particulars || !checkNo.trim()) return false;
  const re = new RegExp(`Check No\\.\\s*${escapeRegExp(checkNo.trim())}(?![\\w-])`, 'i');
  return re.test(particulars);
}

function mirror<L extends ReversibleLine>(l: L, amount?: number): L {
  const debit = amount !== undefined ? (l.credit > 0 ? amount : 0) : l.credit;
  const credit = amount !== undefined ? (l.debit > 0 ? amount : 0) : l.debit;
  return {
    ...l,
    debit,
    credit,
    particulars: l.particulars ? `Reversal of: ${l.particulars}` : 'Reversal',
  };
}

const sum = (ls: ReversibleLine[], k: 'debit' | 'credit') =>
  ls.reduce((s, l) => s + (l[k] || 0), 0);

/**
 * The reversing lines for the chosen checks of an RCI entry. Throws, with a
 * sentence the Accountant can act on, when a check's lines cannot be found.
 */
export function rciCheckReversalLines<L extends ReversibleLine>(
  lines: L[],
  checks: CheckToReverse[],
): L[] {
  if (checks.length === 0) throw new Error('Choose at least one check to reverse.');

  const creditLines = lines.filter((l) => (l.credit || 0) > 0);
  const out: L[] = [];

  for (const c of checks) {
    const debits = lines.filter((l) => (l.debit || 0) > 0 && namesCheck(l.particulars, c.checkNo));
    if (debits.length === 0) {
      throw new Error(
        `The entry has no payable line naming Check No. ${c.checkNo}. Its lines may have been reworded; correct the entry by hand instead.`,
      );
    }
    if (sum(debits, 'debit') !== c.amount) {
      throw new Error(
        `The payable lines naming Check No. ${c.checkNo} come to ${(sum(debits, 'debit') / 100).toFixed(2)}, but the check is for ${(c.amount / 100).toFixed(2)}. Correct the entry by hand instead.`,
      );
    }

    const credits = creditLines.filter((l) => namesCheck(l.particulars, c.checkNo));
    let cashSide: L[];
    if (credits.length > 0) {
      if (sum(credits, 'credit') !== c.amount) {
        throw new Error(
          `The Cash in Bank lines naming Check No. ${c.checkNo} come to ${(sum(credits, 'credit') / 100).toFixed(2)}, but the check is for ${(c.amount / 100).toFixed(2)}. Correct the entry by hand instead.`,
        );
      }
      cashSide = credits.map((l) => mirror(l));
    } else {
      /*
       * The older shape: one credit for the whole report. It must be one
       * account and one bank account, or there is no telling which the check
       * was drawn on.
       */
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
          `The entry does not show which Cash in Bank line paid Check No. ${c.checkNo}. Correct the entry by hand instead.`,
        );
      }
      cashSide = [
        {
          ...mirror(first, c.amount),
          particulars: `Reversal of: Check No. ${c.checkNo} - ${first.particulars ?? 'Cash in Bank'}`,
        },
      ];
    }

    out.push(...cashSide, ...debits.map((l) => mirror(l)));
  }

  return out.map((l, i) => ({ ...l, lineNo: i + 1 }));
}
