import { db, COL } from './firebase';
import { resolveAf56Accounts, type Af56Accounts } from './af56';

/**
 * Patch 179: the AF 56 accounts as the office's Chart of Accounts names them
 * (see resolveAf56Accounts). Read outside any transaction - the chart is
 * master data and is not what a transaction decides on.
 */
export async function loadAf56Accounts(): Promise<Af56Accounts> {
  const snap = await db.collection(COL.accounts).get();
  return resolveAf56Accounts(
    snap.docs.map((d) => {
      const a = d.data() as { code?: string; name?: string; active?: boolean };
      return { code: String(a.code ?? d.id), name: String(a.name ?? ''), active: a.active ?? true };
    }),
  );
}
