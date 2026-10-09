import type { Centavos } from '@/types/common';

/**
 * The bank's upload file for an ADA paid to several payees. Patch 140.
 *
 * The format, as the bank takes it:
 *
 *   column 1  ATM / account number - 10 digits, leading zeros kept
 *   column 2  the payee's name in CAPITAL letters - letters, digits and
 *             spaces only; no special character, not even a dot or a comma
 *   column 3  the amount in centavos, with no decimal point - the last two
 *             digits are the centavos: 10,000.10 is 1000010, 10,000.00 is
 *             1000000
 *
 * No heading row: row 1 is the first payee.
 *
 * Nothing is fixed silently that the bank would read differently. An account
 * that is not 10 digits is reported, not padded or cut: a number padded with
 * the wrong zeros credits somebody else.
 */

export const BANK_ACCOUNT_DIGITS = 10;

export interface BankFilePayee {
  payeeName: string;
  accountNumber: string;
  amount: Centavos;
}

export interface BankFileRow {
  account: string;
  name: string;
  amount: string;
}

/** The account number as the bank reads it: its digits, nothing else. */
export function bankAccount(v: string | null | undefined): string {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * The name as the bank reads it. Letters with an accent or tilde become the
 * plain letter (Pena for Pe\u00f1a); every other character that is not a letter,
 * a digit or a space - the dot of "Ma.", the comma of "Dela Cruz, Juan", a
 * hyphen - becomes a space, and runs of spaces become one. In capitals
 * (patch 141), as the bank asked.
 */
export function bankName(v: string | null | undefined): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** The amount as the bank reads it: whole centavos, no decimal point. */
export function bankAmount(c: Centavos): string {
  return String(Math.round(c));
}

export function buildBankFile(payees: BankFilePayee[]): {
  rows: BankFileRow[];
  problems: string[];
} {
  const problems: string[] = [];
  const rows = payees.map((p, i) => {
    const who = p.payeeName?.trim() || `line ${i + 1}`;
    const account = bankAccount(p.accountNumber);
    const name = bankName(p.payeeName);
    if (account.length !== BANK_ACCOUNT_DIGITS) {
      problems.push(
        `${who}: the ATM / account number "${p.accountNumber ?? ''}" has ${account.length} digit${account.length === 1 ? '' : 's'}; the bank needs ${BANK_ACCOUNT_DIGITS}.`,
      );
    }
    if (!name) problems.push(`Line ${i + 1}: no name.`);
    if (!(p.amount > 0)) problems.push(`${who}: no amount.`);
    return { account, name, amount: bankAmount(p.amount) };
  });
  if (rows.length === 0) problems.push('There are no payees to send to the bank.');
  return { rows, problems };
}

/** The file as text: one payee per line, comma-separated, no heading. */
export function bankFileCsv(rows: BankFileRow[]): string {
  return rows.map((r) => `${r.account},${r.name},${r.amount}`).join('\r\n') + '\r\n';
}

const fileStem = (ref: string) => `bank-${ref.replace(/[^A-Za-z0-9-]+/g, '-')}`;

/** Downloads the file as .csv. */
export function downloadBankCsv(rows: BankFileRow[], ref: string): void {
  const blob = new Blob([bankFileCsv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileStem(ref)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
