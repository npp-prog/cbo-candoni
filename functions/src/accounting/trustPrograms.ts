import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, notFound, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import {
  checkProgrammedAmendment,
  checkTrustProgram,
  deriveTrustFigures,
  type TrustProgramStatus,
} from '../lib/trustPrograms';

/**
 * recordTrustProgram — create or amend a Trust Fund programme.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS BELONGS TO ACCOUNTING
 * ---------------------------------------------------------------------------
 * There is no ordinance behind a trust programme and nothing for the Budget
 * Officer to release. The money arrived under a memorandum of agreement, a
 * deed or an advice; the Accountant books it, reports on it and answers to the
 * source for it. So the register is the Accounting office's, and the roles
 * below say so.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A CALLABLE
 * ---------------------------------------------------------------------------
 * The programmed amount is the ceiling every Funding Utilization Request is
 * checked against. It is the same kind of figure as a released allotment, and
 * it gets the same treatment: raising it is how a utilisation that should have
 * been refused is let through, so it is not a write a browser can make.
 *
 * The three worked figures - utilised, disbursed and what is derived from them
 * - are never accepted from the caller at all. They are maintained inside the
 * transactions that certify a utilisation and approve a voucher, so that the
 * programme balance cannot drift from the documents that moved it.
 */

const TRUST_RECORDERS: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

interface ProgramDoc {
  programCode?: string;
  programmed?: number;
  received?: number;
  utilised?: number;
  disbursed?: number;
  status?: string;
}

const peso = (c: number) => (c / 100).toFixed(2);

export const recordTrustProgram = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, TRUST_RECORDERS);
    const data = (request.data ?? {}) as {
      programId?: string;
      programCode?: string;
      programName?: string;
      sourceAgency?: string;
      reference?: string;
      startYear?: number;
      accountCode?: string;
      programmed?: number;
      received?: number;
      status?: string;
      notes?: string;
      fundSource?: string | null;
      location?: string | null;
      dateStarted?: string | null;
      targetCompletion?: string | null;
      extensions?: number | null;
      percentComplete?: number | null;
      statusRemarks?: string | null;
    };

    /*
     * The Revised Chart of Accounts code the trust liability sits in, which
     * GAM Appendix 18 heads the Registry of Special Trust Fund with.
     *
     * Optional - the Accountant classifies a programme, and nothing here can
     * derive the account from a source agency and a purpose. But a value that
     * IS given is checked, because a mistyped code prints on a statutory form
     * as though it were the account, and nothing downstream would query it.
     */
    const accountCode = String(data.accountCode ?? '').trim();
    if (accountCode && !/^\d{8}$/.test(accountCode)) {
      throw new HttpsError(
        'invalid-argument',
        `"${accountCode}" is not an eight-digit account code. Leave it empty if the programme's ` +
          'trust liability account has not been decided yet.',
      );
    }

    const input = {
      programCode: String(data.programCode ?? '').trim().toUpperCase(),
      programName: String(data.programName ?? '').trim(),
      sourceAgency: String(data.sourceAgency ?? '').trim(),
      reference: String(data.reference ?? '').trim(),
      programmed: Math.round(Number(data.programmed ?? 0)),
      received: Math.round(Number(data.received ?? 0)),
      status: String(data.status ?? 'ACTIVE').trim().toUpperCase(),
    };

    const check = checkTrustProgram(input);
    if (!check.ok) {
      throw new HttpsError('failed-precondition', check.violations[0].message, {
        violations: check.violations,
      });
    }

    const programId = String(data.programId ?? '').trim();

    /*
     * The code is the programme's identity on a utilisation, so two programmes
     * may not share one. Checked before the transaction: a query cannot be
     * made inside a Firestore transaction, and the window this leaves is the
     * two administrators of the Accounting office creating the same programme
     * code in the same second, which the register would then show twice and
     * somebody would notice.
     */
    const clash = await db
      .collection(COL.trustPrograms)
      .where('programCode', '==', input.programCode)
      .limit(2)
      .get();

    for (const doc of clash.docs) {
      if (doc.id !== programId) {
        throw new HttpsError(
          'already-exists',
          `Programme code ${input.programCode} is already used by "${
            (doc.data() as { programName?: string }).programName ?? doc.id
          }". A utilisation is charged to the code, so two programmes cannot share one.`,
        );
      }
    }

    const now = new Date().toISOString();
    const stamp = { uid: caller.uid, name: caller.name };

    return db.runTransaction(async (tx) => {
      const ref = programId
        ? db.collection(COL.trustPrograms).doc(programId)
        : db.collection(COL.trustPrograms).doc();

      let existing: ProgramDoc | null = null;
      if (programId) {
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('The trust programme');
        existing = snap.data() as ProgramDoc;
      }

      const utilised = existing?.utilised ?? 0;
      const disbursed = existing?.disbursed ?? 0;

      /*
       * An amendment may lower the ceiling, but not beneath what has already
       * been committed. The utilisations exist and their numbers have been
       * issued; a ceiling below them would show a negative balance that no
       * document caused and none can undo.
       */
      if (existing) {
        const amendment = checkProgrammedAmendment({
          newProgrammed: input.programmed,
          alreadyUtilised: utilised,
        });
        if (!amendment.ok) {
          throw new HttpsError('failed-precondition', amendment.violations[0].message, {
            violations: amendment.violations,
          });
        }

        if (input.status === 'CLOSED' && utilised !== disbursed) {
          throw new HttpsError(
            'failed-precondition',
            `This programme has ${peso(utilised - disbursed)} utilised and not yet paid. ` +
              'Closing it would settle a set of figures with the source while vouchers against ' +
              'it are still outstanding. Pay or cancel them first.',
            { utilised, disbursed },
          );
        }
      }

      const figures = deriveTrustFigures({
        programmed: input.programmed,
        received: input.received,
        utilised,
        disbursed,
      });

      tx.set(
        ref,
        {
          programCode: input.programCode,
          programName: input.programName,
          sourceAgency: input.sourceAgency,
          reference: input.reference,
          startYear: Number.isInteger(Number(data.startYear)) ? Number(data.startYear) : null,
          accountCode: accountCode || null,
          status: input.status as TrustProgramStatus,
          notes: String(data.notes ?? '').trim() || null,
          ...fdpFields(data),
          ...figures,
          updatedAt: now,
          updatedBy: stamp,
        },
        { merge: true },
      );

      recordTransition(tx, {
        caller,
        event: 'SETTINGS_CHANGE',
        entityType: COL.trustPrograms,
        entityId: ref.id,
        entityRef: `Trust programme ${input.programCode}`,
        fiscalYear: Number(data.startYear) || new Date().getFullYear(),
        fundCode: 'TF',
        action: 'APPROVE',
        previousStatus: existing ? String(existing.status ?? 'ACTIVE') : 'DRAFT',
        newStatus: input.status,
        remarks:
          `${existing ? 'Amended' : 'Recorded'} ${input.programName} (${input.sourceAgency}, ` +
          `${input.reference}). Programmed ${peso(input.programmed)}, received ` +
          `${peso(input.received)}.`,
      });

      return { programId: ref.id, programCode: input.programCode, ...figures };
    });
  },
);

/**
 * Patch 163 - the FDP report fields: where the money came from (FDP Form 6
 * reports only programmes funded by a national agency or another LGU) and
 * the Form 6 columns the office states. Each is cleaned, never trusted as
 * sent: an unknown source is dropped, a date must be YYYY-MM-DD, the
 * completion is held to 0-100.
 */
const FUND_SOURCES = ['NATIONAL', 'LOCAL', 'OWN', 'LDRRMF'];
export function fdpFields(data: {
  fundSource?: string | null;
  location?: string | null;
  dateStarted?: string | null;
  targetCompletion?: string | null;
  extensions?: number | null;
  percentComplete?: number | null;
  statusRemarks?: string | null;
}) {
  const text = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max) || null;
  const date = (v: unknown) => {
    const d = String(v ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };
  const source = String(data.fundSource ?? '').trim().toUpperCase();
  const ext = Number(data.extensions);
  const pctRaw = data.percentComplete;
  const pct = pctRaw === null || pctRaw === undefined || String(pctRaw) === '' ? NaN : Number(pctRaw);
  return {
    fundSource: FUND_SOURCES.includes(source) ? source : null,
    location: text(data.location),
    dateStarted: date(data.dateStarted),
    targetCompletion: date(data.targetCompletion),
    extensions: Number.isInteger(ext) && ext >= 0 ? ext : null,
    percentComplete: Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct * 100) / 100)) : null,
    statusRemarks: text(data.statusRemarks),
  };
}

/** Loaded by the certification and the voucher, so the shape is defined once. */
export interface TrustProgramData {
  programCode: string;
  programName: string;
  programmed: number;
  /** Stated by the Accountant. */
  received: number;
  /** Worked from the receipts by postRcd. */
  receivedPosted: number;
  utilised: number;
  disbursed: number;
  status: string;
}

export async function readTrustProgram(
  tx: FirebaseFirestore.Transaction,
  programId: string,
): Promise<TrustProgramData> {
  const snap = await tx.get(db.collection(COL.trustPrograms).doc(programId));
  if (!snap.exists) {
    throw invalid(
      `Trust programme ${programId} does not exist. A utilisation must be charged to a ` +
        'programme on the register.',
    );
  }
  const d = snap.data() as Partial<TrustProgramData>;
  return {
    programCode: String(d.programCode ?? ''),
    programName: String(d.programName ?? ''),
    programmed: d.programmed ?? 0,
    received: d.received ?? 0,
    receivedPosted: d.receivedPosted ?? 0,
    utilised: d.utilised ?? 0,
    disbursed: d.disbursed ?? 0,
    status: String(d.status ?? 'ACTIVE'),
  };
}

/**
 * Applies a signed movement to a programme and writes it. Call only after
 * every read in the transaction is complete.
 */
export function applyTrustDelta(
  tx: FirebaseFirestore.Transaction,
  programId: string,
  current: TrustProgramData,
  delta: { utilised?: number; disbursed?: number; receivedPosted?: number },
): void {
  const figures = deriveTrustFigures({
    programmed: current.programmed,
    received: current.received,
    receivedPosted: current.receivedPosted + (delta.receivedPosted ?? 0),
    utilised: current.utilised + (delta.utilised ?? 0),
    disbursed: current.disbursed + (delta.disbursed ?? 0),
  });

  tx.set(
    db.collection(COL.trustPrograms).doc(programId),
    { ...figures, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}
