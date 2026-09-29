import type { GridLine } from '@/components/journal/JournalEntryGrid';
import type { Centavos } from '@/types/common';

/**
 * Proposes the accounting entry for a disbursement voucher.
 *
 * The specification asks that data entered once flows into succeeding
 * documents rather than being re-keyed, and this is where most of that value
 * sits: an encoder who has chosen an OBR and typed a gross amount should not
 * also have to build the journal entry by hand. CBO proposes it and lets them
 * adjust.
 *
 * The shape is the standard LGU disbursement:
 *
 *   Dr  expense accounts            (from the obligation's budget lines,
 *                                    apportioned to the voucher amount)
 *       Cr  Due to BIR / other payables   (each deduction withheld)
 *       Cr  Cash in Bank / Accounts Payable  (the net actually payable)
 *
 * Two details worth stating. First, the apportionment gives the last line the
 * rounding remainder, so the debits sum exactly to the gross rather than being
 * a centavo out.
 *
 * Second, and more important: the voucher ALWAYS credits Accounts Payable, and
 * never cash. The voucher is the municipality admitting it owes the money; the
 * cash leaves later, when the Treasurer draws the check or the ADA, and that
 * document carries its own JEV clearing the payable:
 *
 *   Voucher       Dr  expense          Cr  Due to BIR, Cr  Accounts Payable
 *   Check / ADA   Dr  Accounts Payable                 Cr  Cash in Bank
 *
 * Two separate offices, two separate documents, two separate journal entries.
 * Collapsing them into one entry at the voucher would have Accounting credit a
 * bank account before the Treasurer has drawn on it, and would leave the check
 * register with no entry of its own to agree against the Check Disbursements
 * Journal. It would also make the payables schedule wrong, since a voucher
 * approved in December and paid in January would never appear as outstanding.
 */

export interface ObligationLineLite {
  accountCode: string;
  accountName: string;
  /**
   * The budget line this obligation line was charged to, carried onto the
   * voucher's debit so the spending can be matched back to the appropriation.
   */
  fppCode?: string;
  fppName?: string;
  amount: Centavos;
}

export interface DeductionLite {
  code: string;
  description: string;
  accountCode: string;
  accountName: string;
  amount: Centavos;
}

/** Cash in Bank - Local Currency, Current Account (COA Revised Chart for LGUs). */
export const CASH_IN_BANK_LCCA = { code: '10102020', name: 'Cash in Bank - Local Currency, Current Account' };
export const ACCOUNTS_PAYABLE = { code: '20101010', name: 'Accounts Payable' };

export function proposeDvEntry(input: {
  grossAmount: Centavos;
  deductions: DeductionLite[];
  netAmount: Centavos;
  obligationLines: ObligationLineLite[];
  /**
   * Override the credit account. Left unset - which is the normal case and what
   * every screen in CBO does - the net is credited to Accounts Payable. This
   * exists only for the rare voucher whose liability account is not the general
   * payable, and it must never be pointed at a cash account: cash is credited
   * by the check or ADA, not by the voucher.
   */
  creditAccount?: { code: string; name: string };
  particulars?: string;
}): GridLine[] {
  const lines: GridLine[] = [];
  let lineNo = 1;

  // --- Debits: the expenses, apportioned across the obligation's lines -----

  const obligationTotal = input.obligationLines.reduce((s, l) => s + l.amount, 0);

  if (input.obligationLines.length === 0 || obligationTotal === 0) {
    // No obligation chosen yet: a single placeholder debit the encoder fills.
    lines.push({
      lineNo: lineNo++,
      accountCode: '',
      accountName: '',
      debit: input.grossAmount,
      credit: 0,
      particulars: input.particulars,
    });
  } else {
    let allocated = 0;
    input.obligationLines.forEach((line, index) => {
      const isLast = index === input.obligationLines.length - 1;
      // The last line absorbs the rounding remainder, so the debits sum
      // exactly to the gross amount.
      const share = isLast
        ? input.grossAmount - allocated
        : Math.round((line.amount / obligationTotal) * input.grossAmount);
      allocated += share;

      if (share === 0) return;

      lines.push({
        lineNo: lineNo++,
        accountCode: line.accountCode,
        accountName: line.accountName,
        // Carried from the obligation line this share came out of. The
        // apportionment is per line, so each debit keeps its own budget line
        // rather than the voucher taking one FPP for the lot.
        fppCode: line.fppCode,
        fppName: line.fppName,
        debit: share,
        credit: 0,
        particulars: input.particulars,
      });
    });
  }

  // --- Credits: the deductions withheld ------------------------------------

  for (const deduction of input.deductions) {
    if (deduction.amount <= 0) continue;
    lines.push({
      lineNo: lineNo++,
      accountCode: deduction.accountCode,
      accountName: deduction.accountName,
      debit: 0,
      credit: deduction.amount,
      particulars: deduction.description,
    });
  }

  // --- Credit: the net payable ---------------------------------------------

  const credit = input.creditAccount ?? ACCOUNTS_PAYABLE;
  lines.push({
    lineNo: lineNo++,
    accountCode: credit.code,
    accountName: credit.name,
    debit: 0,
    credit: input.netAmount,
    particulars: input.particulars,
  });

  return lines;
}

/**
 * Computes a deduction from a tax code and a base.
 *
 * Expanded withholding tax applies to the gross for a non-VAT supplier and to
 * the VAT-exclusive amount for a VAT-registered one, which is why the tax code
 * carries its own `base`. Getting this wrong understates the withholding and
 * the municipality becomes liable for the shortfall, so the base is part of
 * the tax code's definition rather than something a clerk decides each time.
 */
export function computeDeduction(
  taxCode: { code: string; description: string; rate: number; base: 'GROSS' | 'NET_OF_VAT'; accountCode: string },
  accountName: string,
  grossAmount: Centavos,
  vatRate = 0.12,
): DeductionLite & { base: Centavos; rate: number } {
  const base =
    taxCode.base === 'NET_OF_VAT' ? Math.round(grossAmount / (1 + vatRate)) : grossAmount;
  const raw = base * taxCode.rate;
  const amount = raw < 0 ? -Math.round(Math.abs(raw)) : Math.round(raw);

  return {
    code: taxCode.code,
    description: taxCode.description,
    accountCode: taxCode.accountCode,
    accountName,
    base,
    rate: taxCode.rate,
    amount,
  };
}
