import { findText, type SheetRow } from '@/lib/spreadsheet';
import { parsePeso } from '@/lib/money';
import type { Centavos } from '@/types/common';

/**
 * The list of payees on a "Payee, et al." voucher. Patch 138.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN, IN ONE PLACE
 * ---------------------------------------------------------------------------
 * Candoni pays some vouchers to several people at once - a payroll, an
 * honorarium list, a group of claimants - by ONE ADA that the bank splits into
 * each person's own ATM account. The office writes the first payee and
 * "et al." on the papers.
 *
 *   OBR / FURS   a tick, "Several payees (et al.)". The payee becomes
 *                "Juan Dela Cruz, et al." and nothing else changes: the
 *                obligation is charged against the budget as one request.
 *   VOUCHER      the list - uploaded from a sheet, or keyed - of each payee,
 *                their ATM / account number and their share of the NET. The
 *                shares must add up to the net. A name not on the payee
 *                master list is added from the list, in a window, without
 *                leaving the voucher.
 *   ENTRY        Accounts Payable is credited PER PAYEE, each line naming its
 *                payee - so the payables ledger knows who is owed what, the
 *                same as for any other voucher.
 *   ADA          carries the list; the RADAI debits Accounts Payable per
 *                payee (clearing exactly what the voucher credited), and the
 *                bank file has one row per payee, with their own account.
 *
 * A check cannot pay several people, so a group voucher is paid by ADA only.
 *
 * This file reads the uploaded sheet and matches each row to the master list.
 */

export interface UploadedPayee {
  lineNo: number;
  name: string;
  accountNumber: string;
  tin: string;
  amount: Centavos;
}

export interface MasterPayeeLike {
  id: string;
  name: string;
  tin?: string | null;
  bankAccountNumber?: string | null;
  employeeId?: string | null;
}

export interface MasterEmployeeLike {
  id: string;
  bankAccountNumber?: string | null;
}

export interface MatchedPayee extends UploadedPayee {
  payeeId: string | null;
  /** The name on the master record where matched; the sheet's otherwise. */
  payeeName: string;
  /** The account number on the master record (employee's first), if any. */
  masterAccount: string;
  /** The sheet and the master record name different accounts. */
  accountDiffers: boolean;
  matchedOn: 'ACCOUNT' | 'TIN' | 'NAME' | null;
}

const NAME = [/^payee/i, /^name$/i, /^(full|employee|payee)?\s*name/i, /^employee/i];
const ACCOUNT = [/atm/i, /account\s*(no|num|#)/i, /acct/i, /account(?!\s*name)/i, /card/i];
const TIN = [/^tin/i, /\btin\b/i];
const AMOUNT = [/net/i, /amount/i, /^amt/i, /share/i];

const digits = (v: string) =>
  String(v ?? '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
/**
 * An account number as compared: digits and letters only, leading zeros
 * dropped - a sheet saved from Excel loses them ("0011223344" becomes
 * 11223344), and that is still the same account.
 */
const accountKey = (v: string) => digits(v).replace(/^0+/, '');
const normName = (v: string) =>
  String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The rows of the uploaded sheet: Name, ATM / Account No., Amount (TIN optional). */
export function parsePayeeSheet(rows: SheetRow[]): { rows: UploadedPayee[]; problems: string[] } {
  const out: UploadedPayee[] = [];
  const problems: string[] = [];
  rows.forEach((row, i) => {
    const lineNo = i + 2; // the heading is line 1
    const name = findText(row, NAME);
    const accountNumber = findText(row, ACCOUNT);
    const tin = findText(row, TIN);
    const amountText = findText(row, AMOUNT);
    if (!name && !accountNumber && !amountText) return; // a blank line
    const amount = parsePeso(amountText);
    if (!name) problems.push(`Line ${lineNo}: no name.`);
    if (amount === null || amount <= 0)
      problems.push(`Line ${lineNo}: the amount "${amountText}" is not a figure above zero.`);
    out.push({ lineNo, name, accountNumber, tin, amount: amount ?? 0 });
  });
  if (out.length === 0) {
    problems.push(
      'No payees found. The sheet needs columns for the Name, the ATM / Account No. and the Amount.',
    );
  }
  return { rows: out, problems };
}

/**
 * Each row matched to the payee master list: by account number first (the
 * one thing two people never share), then by TIN, then by the exact name
 * where only one record carries it. Never by a near name - two people with
 * similar names merged into one is worse than a row left to be matched by
 * hand.
 */
export function matchPayees(
  rows: UploadedPayee[],
  payees: MasterPayeeLike[],
  employees: MasterEmployeeLike[],
): MatchedPayee[] {
  const employeeAccount = new Map(employees.map((e) => [e.id, e.bankAccountNumber ?? '']));
  const accountOf = (p: MasterPayeeLike) =>
    (p.employeeId ? employeeAccount.get(p.employeeId) : '') || p.bankAccountNumber || '';

  const byAccount = new Map<string, MasterPayeeLike>();
  const byTin = new Map<string, MasterPayeeLike>();
  const byName = new Map<string, MasterPayeeLike[]>();
  for (const p of payees) {
    const a = accountKey(accountOf(p));
    if (a) byAccount.set(a, p);
    const t = digits(p.tin ?? '');
    if (t) byTin.set(t, p);
    const n = normName(p.name);
    byName.set(n, [...(byName.get(n) ?? []), p]);
  }

  return rows.map((r) => {
    let found: MasterPayeeLike | undefined;
    let matchedOn: MatchedPayee['matchedOn'] = null;
    if (accountKey(r.accountNumber) && byAccount.has(accountKey(r.accountNumber))) {
      found = byAccount.get(accountKey(r.accountNumber));
      matchedOn = 'ACCOUNT';
    } else if (digits(r.tin) && byTin.has(digits(r.tin))) {
      found = byTin.get(digits(r.tin));
      matchedOn = 'TIN';
    } else {
      const same = byName.get(normName(r.name)) ?? [];
      if (same.length === 1) {
        found = same[0];
        matchedOn = 'NAME';
      }
    }
    const masterAccount = found ? accountOf(found) : '';
    const sameAccount =
      Boolean(masterAccount) && accountKey(r.accountNumber) === accountKey(masterAccount);
    // The master record's spelling wins when it is the same account (its zeros kept).
    const accountNumber = sameAccount ? masterAccount : r.accountNumber || masterAccount;
    return {
      ...r,
      accountNumber,
      payeeId: found?.id ?? null,
      payeeName: found?.name ?? r.name,
      masterAccount,
      accountDiffers: Boolean(found && r.accountNumber && masterAccount && !sameAccount),
      matchedOn,
    };
  });
}
