import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, notFound, reporting, assertFundInScope, type Role } from '../lib/context';
import { recordTransition, auditInTransaction } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';

/**
 * Reserving, retiring and voiding ADA numbers.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MATTERS
 * ---------------------------------------------------------------------------
 * A number, once drawn, is never returned to the pool.
 *
 * The convenience of handing it back is obvious and it is a trap: the bank may
 * already hold that number against an instruction the office withdrew. Giving
 * it to a different payee is how a municipality ends up with two ADAs the bank
 * cannot tell apart, and only one of them in its own register.
 *
 * So a reservation that is not used is RETIRED - consumed for good, with a
 * written reason - rather than released. The hole it leaves in the series is
 * not a problem to be avoided; it is a fact to be explained, and explaining it
 * is what this file is for.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COUNTER IS THE RESERVATION
 * ---------------------------------------------------------------------------
 * Reserving a number means actually drawing it from the same counter that
 * `issueAda` draws from, inside a transaction. Anything softer - marking an
 * intention, remembering the next number - leaves two officers able to reserve
 * the same one on two machines. Drawing it is what makes the reservation real.
 * ---------------------------------------------------------------------------
 */

const TREASURY_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF'];
const RETIRING_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER'];

/** Reserving more than this at once is a sign something else is wrong. */
const MAX_RESERVE = 20;

const recordId = (fiscalYear: number, fundCode: string, adaNo: string) =>
  `${fiscalYear}__${fundCode}__${adaNo.trim().toUpperCase()}`;

// ---------------------------------------------------------------------------
// reserveAdaNumbers
// ---------------------------------------------------------------------------

export const reserveAdaNumbers = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Reserving the ADA numbers', async () => {
      const caller = await requireCaller(request, TREASURY_ROLES);
      const data = (request.data ?? {}) as {
        fiscalYear?: number;
        fundCode?: string;
        slotDate?: string;
        count?: number;
        withRadai?: boolean;
        note?: string;
      };

      const fiscalYear = Number(data.fiscalYear);
      const fundCode = String(data.fundCode ?? '').trim();
      if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');
      if (!fundCode) throw invalid('A fund is required.');
      assertFundInScope(caller, fundCode);

      const slotDate = String(data.slotDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate)) {
        throw invalid('A date for the reserved slot, in the form YYYY-MM-DD, is required.');
      }

      const count = Math.trunc(Number(data.count ?? 1));
      if (!Number.isInteger(count) || count < 1 || count > MAX_RESERVE) {
        throw invalid(
          `Reserve between 1 and ${MAX_RESERVE} numbers at a time. Reserving more than that at ` +
            'once usually means the batch should be prepared instead.',
        );
      }

      const adaConfig = await loadNumberingConfig('ADA');
      const radaiConfig = data.withRadai ? await loadNumberingConfig('RADAI') : null;
      const bookCode = await bookCodeForFund(fundCode);
      const month = Number(slotDate.slice(5, 7));

      const reserved = await db.runTransaction(async (tx) => {
        const out: Array<{ id: string; adaNo: string; radaiNo: string | null }> = [];
        const now = new Date().toISOString();

        // Drawing from the real counter is what makes the reservation binding:
        // a second officer reserving at the same instant gets the next number,
        // not the same one.
        for (let i = 0; i < count; i += 1) {
          const adaNo = await issueNumber(tx, adaConfig, {
            bookCode,
            fundCode,
            fiscalYear,
            month,
          });
          const radaiNo = radaiConfig
            ? await issueNumber(tx, radaiConfig, { bookCode, fundCode, fiscalYear, month })
            : null;
          out.push({ id: recordId(fiscalYear, fundCode, adaNo), adaNo, radaiNo });
        }

        for (const r of out) {
          tx.create(db.collection(COL.adaNumbers).doc(r.id), {
            fiscalYear,
            fundCode,
            adaNo: r.adaNo,
            radaiNo: r.radaiNo,
            slotDate,
            state: 'RESERVED',
            note: String(data.note ?? '').trim() || null,
            usedByAdaId: null,
            reason: null,
            createdBy: { uid: caller.uid, name: caller.name, at: now },
            createdAt: now,
          });
        }

        auditInTransaction(tx, {
          caller,
          event: 'CREATE',
          entityType: COL.adaNumbers,
          entityRef: `ADA ${out[0].adaNo}${out.length > 1 ? ` to ${out[out.length - 1].adaNo}` : ''}`,
          fiscalYear,
          fundCode,
          remarks: `${out.length} ADA number${out.length === 1 ? '' : 's'} reserved for ${slotDate}`,
        });

        return out;
      });

      return { reserved };
    }),
);

// ---------------------------------------------------------------------------
// retireAdaReservation
// ---------------------------------------------------------------------------

export const retireAdaReservation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Retiring the reservation', async () => {
      const caller = await requireCaller(request, RETIRING_ROLES);
      const data = (request.data ?? {}) as { recordId?: string; reason?: string };

      const id = String(data.recordId ?? '').trim();
      if (!id) throw invalid('Which reserved number should be retired?');
      const reason = String(data.reason ?? '').trim();
      if (reason.length < 10) {
        throw invalid('Give a reason of at least ten characters. It is what explains the gap.');
      }

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.adaNumbers).doc(id);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That reserved number');

        const r = snap.data() as {
          state: string;
          adaNo: string;
          fiscalYear: number;
          fundCode: string;
        };
        assertFundInScope(caller, r.fundCode);

        if (r.state === 'USED') {
          throw new HttpsError(
            'failed-precondition',
            `ADA ${r.adaNo} has already been issued. Cancel the ADA itself; the number cannot be ` +
              'retired out from under it.',
          );
        }
        if (r.state !== 'RESERVED') {
          throw new HttpsError('failed-precondition', `That number is already ${r.state.toLowerCase()}.`);
        }

        const now = new Date().toISOString();
        tx.update(ref, {
          state: 'RETIRED',
          reason,
          closedBy: { uid: caller.uid, name: caller.name, at: now },
        });

        recordTransition(tx, {
          caller,
          entityType: COL.adaNumbers,
          entityId: id,
          entityRef: `ADA ${r.adaNo}`,
          fiscalYear: r.fiscalYear,
          fundCode: r.fundCode,
          action: 'CANCEL',
          previousStatus: 'RESERVED',
          newStatus: 'RETIRED',
          event: 'CANCEL',
          remarks: `Retired, never to be issued. ${reason}`,
          severity: 'NOTICE',
        });
      });

      return { recordId: id };
    }),
);

// ---------------------------------------------------------------------------
// voidSkippedAdaNumber
// ---------------------------------------------------------------------------

/**
 * Records that a number was passed over and will never be issued.
 *
 * Unlike a retirement, this number was never drawn from the counter - the hole
 * already exists and this is the explanation being written into it, usually
 * after the fact, when somebody reading the register asks where 0219 went.
 */
export const voidSkippedAdaNumber = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Recording the skipped number', async () => {
      const caller = await requireCaller(request, RETIRING_ROLES);
      const data = (request.data ?? {}) as {
        fiscalYear?: number;
        fundCode?: string;
        adaNo?: string;
        slotDate?: string;
        reason?: string;
      };

      const fiscalYear = Number(data.fiscalYear);
      const fundCode = String(data.fundCode ?? '').trim();
      if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');
      if (!fundCode) throw invalid('A fund is required.');
      assertFundInScope(caller, fundCode);

      const adaNo = String(data.adaNo ?? '').trim().toUpperCase();
      if (!adaNo) throw invalid('Which number was skipped?');

      const slotDate = String(data.slotDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate)) {
        throw invalid('A date for the skipped slot is required, so it sits in the right place.');
      }

      const reason = String(data.reason ?? '').trim();
      if (reason.length < 10) {
        throw invalid(
          'Give a reason of at least ten characters. An unexplained gap is the only thing this ' +
            'record exists to remove.',
        );
      }

      const id = recordId(fiscalYear, fundCode, adaNo);

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.adaNumbers).doc(id);
        const existing = await tx.get(ref);
        if (existing.exists) {
          const r = existing.data() as { state: string };
          throw new HttpsError(
            'already-exists',
            `ADA ${adaNo} is already recorded as ${r.state.toLowerCase()}. Nothing was written twice.`,
          );
        }

        // An issued ADA carries this number, so the gap is not a gap.
        const issued = await tx.get(
          db
            .collection(COL.ada)
            .where('fiscalYear', '==', fiscalYear)
            .where('adaNo', '==', adaNo)
            .limit(1),
        );
        if (!issued.empty) {
          throw new HttpsError(
            'failed-precondition',
            `ADA ${adaNo} was issued and is in the register. It is not a skipped number.`,
          );
        }

        const now = new Date().toISOString();
        tx.create(ref, {
          fiscalYear,
          fundCode,
          adaNo,
          radaiNo: null,
          slotDate,
          state: 'VOID_SKIPPED',
          note: null,
          usedByAdaId: null,
          reason,
          createdBy: { uid: caller.uid, name: caller.name, at: now },
          createdAt: now,
        });

        auditInTransaction(tx, {
          caller,
          event: 'CANCEL',
          entityType: COL.adaNumbers,
          entityId: id,
          entityRef: `ADA ${adaNo}`,
          fiscalYear,
          fundCode,
          remarks: `Skipped serial, voided and never issued. ${reason}`,
          severity: 'NOTICE',
        });
      });

      return { recordId: id, adaNo };
    }),
);
