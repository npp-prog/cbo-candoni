import { db, COL } from './firebase';
import { namedAccountTitle } from './chartOfAccounts';

/**
 * The title of an account, taken from the chart rather than written out.
 *
 * ---------------------------------------------------------------------------
 * WHY A LOOKUP AND NOT A STRING
 * ---------------------------------------------------------------------------
 * A journal line carries both a code and a title, and the title is what every
 * report prints. Writing the title out beside a code that comes from a record
 * is how CFMS came to post "10102020 General Fund" on every RCI, and
 * "10101010 Cash in Vault" on every liquidation refund - for an account the
 * chart calls Cash Local Treasury.
 *
 * Nothing refuses either of them. The entry balances, the code is real, and
 * the wrong title travels into the ledger where it is printed as though it
 * were the account's name.
 *
 * Accounts are keyed by their code, so this is one document read.
 */
export async function titleForAccountCode(code: string): Promise<string | null> {
  const wanted = String(code ?? '').trim();
  if (!wanted) return null;

  const snap = await db.collection(COL.accounts).doc(wanted).get();
  const name = snap.exists ? ((snap.data()?.name as string) ?? '').trim() : '';

  // The chart first, because an office may have renamed an account; the
  // accounts CFMS posts to by name as the fallback.
  return name || namedAccountTitle(wanted);
}
