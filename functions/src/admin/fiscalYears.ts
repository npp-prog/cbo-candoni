import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid } from '../lib/context';
import { auditInTransaction } from '../lib/audit';
import { nextFiscalYear } from '../lib/fiscalYears';

/**
 * Patch 171 - addFiscalYear.
 *
 * Adds the next fiscal year to the list CFMS offers (src/lib/fiscalYears.ts).
 * Administrators only, and only the year after the latest - so the list
 * never skips a year. The year is created OPEN; closing it is the year-end
 * close's business, not this function's.
 */
export const addFiscalYear = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ['SUPER_ADMIN']);
    const { year } = (request.data ?? {}) as { year?: number };
    if (!Number.isInteger(year)) throw invalid('The year to add is required.');

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection(COL.fiscalYears));
      const added = snap.docs.map((d) => Number(d.data().year ?? d.id)).filter(Number.isInteger);
      const next = nextFiscalYear(added);
      if (year !== next) {
        throw new HttpsError(
          'failed-precondition',
          `The next fiscal year to add is ${next}. Years are added one at a time, in order.`,
        );
      }
      const ref = db.collection(COL.fiscalYears).doc(String(year));
      const now = new Date().toISOString();
      tx.create(ref, {
        year,
        status: 'OPEN',
        addedAt: now,
        addedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null },
      });
      auditInTransaction(tx, {
        caller,
        event: 'SETTINGS_CHANGE',
        entityType: COL.fiscalYears,
        entityId: ref.id,
        entityRef: `Fiscal year ${year}`,
        fiscalYear: year,
        remarks: `Fiscal year ${year} added to the list.`,
        severity: 'NOTICE',
      });
      return { year };
    });
  },
);
