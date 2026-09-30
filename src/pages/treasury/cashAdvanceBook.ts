import type { Centavos, IsoDate } from '@/types/common';

/**
 * Cash Book - Cash Advances.
 *
 * GAM for LGUs, Appendix 26. "This record shall be maintained by the local
 * treasurer or disbursing officers performing disbursement functions thru cash
 * advances."
 *
 * One book per disbursing officer, and the column that matters is the last
 * one. Instruction 9: "Balance - the difference between the Debit and Credit
 * columns WHICH SHALL BE EQUAL TO THE AMOUNT OF CASH IN HAND of Disbursing
 * Officers."
 *
 * That is the point of the form. It is not a report about cash advances; it is
 * the record an officer is held to when somebody counts the money in the
 * drawer.
 *
 * ---------------------------------------------------------------------------
 * WHAT GOES IN EACH COLUMN, FROM INSTRUCTIONS 6 TO 8
 * ---------------------------------------------------------------------------
 *   Ref.    "the number of the Check for the cash advance granted and
 *            Disbursement Voucher (DV)/payroll for the payments"
 *   Debit   "the amount advanced by the Disbursing Officer based on the Check
 *            issued"
 *   Credit  "the amount disbursed out of the cash advances based on the
 *            DVs/payrolls"
 *
 * So the debit is the advance, referenced by the CHECK that paid it - not by
 * the voucher, which is why this computation is given the checks and looks the
 * number up. Where no check is found the voucher number is used rather than
 * leaving the column blank, and nothing is invented.
 *
 * A refund is a credit. The officer handing money back reduces the cash in his
 * drawer exactly as spending it does, and instruction 9's balance would be
 * wrong without it.
 *
 * A REIMBURSEMENT is not in this book at all. That is the case where the
 * officer spent more than he was advanced and is owed the difference: it is
 * his own money, not the LGU's cash in his hands, and putting it here would
 * make the balance disagree with a count of the drawer.
 *
 * ---------------------------------------------------------------------------
 * ONLY A POSTED LIQUIDATION IS A CREDIT
 * ---------------------------------------------------------------------------
 * The server's rule, taken from `postLiquidation`: it is that function, and
 * only that function, which moves a cash advance's `amountLiquidated` and
 * `amountRefunded`. A submitted or approved liquidation has not yet reduced
 * anything, and counting one here would show an officer clear when the record
 * still holds him accountable.
 *
 * ---------------------------------------------------------------------------
 * THE TIE-UP, AND WHEN IT CAN HONESTLY BE CHECKED
 * ---------------------------------------------------------------------------
 * Instruction 10: "The difference of the totals of Debit and Credit columns
 * should tie-up with the running balance column."
 *
 * CBO can go further than that, because each cash advance already carries an
 * `outstandingBalance` maintained inside the transaction that posts a
 * liquidation. The book's closing balance and the sum of those figures are
 * arrived at by different means and must agree.
 *
 * They must agree ONLY when the book covers every document, though. Struck at
 * a date in the past, the book has not yet reached liquidations the stored
 * figure already includes, and a difference is expected rather than wrong. So
 * the comparison is made only when the period reaches everything, and
 * `coversEverything` says whether it did. A check that reports a discrepancy
 * it cannot distinguish from normal is a check nobody believes.
 */

/** The server moves a cash advance only when the liquidation is posted. */
export const POSTED_LIQUIDATION = new Set(['POSTED']);

export interface CbcaAdvance {
  id: string;
  fundCode: string;
  accountableOfficerId: string;
  accountableOfficerName: string;
  dvId: string;
  dvNo: string;
  dateGranted: IsoDate;
  amountGranted: Centavos;
  purpose: string;
  outstandingBalance: Centavos;
}

export interface CbcaLiquidation {
  id: string;
  cashAdvanceId: string;
  liquidationNo: string;
  liquidationDate: IsoDate;
  amountLiquidated: Centavos;
  refundAmount: Centavos;
  status: string;
}

/** Just enough of a check to fill the reference column of a debit. */
export interface CbcaCheck {
  dvId: string;
  checkNo: string;
}

export interface CbcaEntry {
  date: IsoDate;
  particulars: string;
  reference: string;
  debit: Centavos;
  credit: Centavos;
  /** The running balance after this line: cash that should be in hand. */
  balance: Centavos;
}

export interface CbcaBook {
  officerId: string;
  officerName: string;
  fundCode: string;

  /** Carried forward as the opening balance, per instruction 5. */
  broughtForward: Centavos;
  entries: CbcaEntry[];
  totalDebit: Centavos;
  totalCredit: Centavos;
  /** broughtForward + debits - credits: the cash in hand at the closing date. */
  closingBalance: Centavos;

  /** The sum of `outstandingBalance` across this officer's advances. */
  outstandingRecorded: Centavos;
  /**
   * True when the period reached every document, so the two figures above are
   * comparable. False means the book stops short of what the stored figure
   * already knows, and a difference means nothing.
   */
  coversEverything: boolean;
  /** closingBalance - outstandingRecorded. Only meaningful when it covers everything. */
  drift: Centavos;
}

interface Movement {
  date: IsoDate;
  particulars: string;
  reference: string;
  debit: Centavos;
  credit: Centavos;
}

export function buildCashAdvanceBook(input: {
  advances: CbcaAdvance[];
  liquidations: CbcaLiquidation[];
  checks?: CbcaCheck[];
  from: IsoDate;
  to: IsoDate;
  officerId?: string | null;
  fundCode?: string | null;
}): CbcaBook[] {
  const checkByDv = new Map((input.checks ?? []).map((c) => [c.dvId, c.checkNo]));
  const advanceById = new Map(input.advances.map((a) => [a.id, a]));

  const movements = new Map<string, Movement[]>();
  const covered = new Map<string, boolean>();
  const push = (key: string, m: Movement, withinRange: boolean) => {
    if (!withinRange) covered.set(key, false);
    const list = movements.get(key) ?? [];
    list.push(m);
    movements.set(key, list);
  };

  const key = (officerId: string, fundCode: string) => `${officerId}__${fundCode}`;

  const wanted = (officerId: string, fundCode: string) =>
    (!input.officerId || officerId === input.officerId) &&
    (!input.fundCode || fundCode === input.fundCode);

  for (const a of input.advances) {
    if (!wanted(a.accountableOfficerId, a.fundCode)) continue;
    const k = key(a.accountableOfficerId, a.fundCode);
    if (!covered.has(k)) covered.set(k, true);
    push(
      k,
      {
        date: a.dateGranted,
        particulars: `Cash advance granted: ${a.purpose}`,
        // Instruction 6 wants the check, not the voucher. The voucher number
        // is the fallback so the column is never blank, and never invented.
        reference: checkByDv.get(a.dvId) || a.dvNo,
        debit: a.amountGranted,
        credit: 0,
      },
      a.dateGranted <= input.to,
    );
  }

  for (const l of input.liquidations) {
    if (!POSTED_LIQUIDATION.has(l.status)) continue;
    const a = advanceById.get(l.cashAdvanceId);
    if (!a) continue;
    if (!wanted(a.accountableOfficerId, a.fundCode)) continue;
    const k = key(a.accountableOfficerId, a.fundCode);
    if (!covered.has(k)) covered.set(k, true);

    if (l.amountLiquidated !== 0) {
      push(
        k,
        {
          date: l.liquidationDate,
          particulars: `Liquidation of cash advance: ${a.purpose}`,
          reference: l.liquidationNo,
          debit: 0,
          credit: l.amountLiquidated,
        },
        l.liquidationDate <= input.to,
      );
    }
    if (l.refundAmount !== 0) {
      push(
        k,
        {
          date: l.liquidationDate,
          particulars: 'Cash returned by the accountable officer',
          reference: l.liquidationNo,
          debit: 0,
          credit: l.refundAmount,
        },
        l.liquidationDate <= input.to,
      );
    }
  }

  const outstanding = new Map<string, Centavos>();
  const names = new Map<string, { officerId: string; officerName: string; fundCode: string }>();
  for (const a of input.advances) {
    if (!wanted(a.accountableOfficerId, a.fundCode)) continue;
    const k = key(a.accountableOfficerId, a.fundCode);
    outstanding.set(k, (outstanding.get(k) ?? 0) + a.outstandingBalance);
    names.set(k, {
      officerId: a.accountableOfficerId,
      officerName: a.accountableOfficerName,
      fundCode: a.fundCode,
    });
  }

  const books: CbcaBook[] = [];
  for (const [k, list] of movements) {
    const who = names.get(k)!;

    let broughtForward = 0;
    const inPeriod: Movement[] = [];
    for (const m of list) {
      if (m.date > input.to) continue;
      if (m.date < input.from) {
        broughtForward += m.debit - m.credit;
        continue;
      }
      inPeriod.push(m);
    }

    inPeriod.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        // A debit before a credit on the same day: an officer cannot spend an
        // advance before it reaches him, and a balance that dips negative for
        // one line would be read as a shortage.
        b.debit - a.debit ||
        a.reference.localeCompare(b.reference),
    );

    let balance = broughtForward;
    let totalDebit = 0;
    let totalCredit = 0;
    const entries: CbcaEntry[] = inPeriod.map((m) => {
      balance += m.debit - m.credit;
      totalDebit += m.debit;
      totalCredit += m.credit;
      return { ...m, balance };
    });

    const outstandingRecorded = outstanding.get(k) ?? 0;
    const coversEverything = covered.get(k) !== false;

    books.push({
      officerId: who.officerId,
      officerName: who.officerName,
      fundCode: who.fundCode,
      broughtForward,
      entries,
      totalDebit,
      totalCredit,
      closingBalance: balance,
      outstandingRecorded,
      coversEverything,
      drift: balance - outstandingRecorded,
    });
  }

  return books.sort(
    (a, b) => a.officerName.localeCompare(b.officerName) || a.fundCode.localeCompare(b.fundCode),
  );
}
