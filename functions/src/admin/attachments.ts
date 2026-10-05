import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, ATTACHMENT_LOCK_ROLES, notFound, invalid } from '../lib/context';
import { auditInTransaction } from '../lib/audit';

/**
 * The entity types whose supporting documents may be closed.
 *
 * It is a list, not "whatever the caller sends". The lock is written on the
 * parent document and the Firestore rule reads it back from exactly that path
 * when the next upload is attempted, so a type that is not a real collection
 * would be a lock nothing enforces: the screen would say closed and the
 * database would take the next file.
 *
 * It matches LOCKABLE_ENTITY_TYPES in src/lib/attachmentTypes.ts, and the
 * build compares the two.
 */
const LOCKABLE: Record<string, string> = {
  [COL.obligations]: 'obligation request',
  [COL.disbursementVouchers]: 'disbursement voucher',
  [COL.treasuryReports]: 'treasury report',
  [COL.liquidations]: 'liquidation report',
};

/**
 * lockAttachments - close the supporting documents on a transaction, for good.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A ONE-WAY DOOR
 * ---------------------------------------------------------------------------
 * Replacing a scan is ordinary and must stay easy. The commonest reason to do
 * it is that somebody looked at the file and found it unreadable or the wrong
 * page, and a system that makes that hard gets a wrong document left on the
 * record instead.
 *
 * But at some point the office needs to be able to say: THIS is the signed
 * form, and it has not changed since. That statement is worth nothing if the
 * closing can be reopened - "locked, unlocked, replaced, locked again" proves
 * exactly as much as never having locked it. So there is no unlock, for
 * anybody, including an administrator.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A CALLABLE AND NOT A FIELD THE SCREEN WRITES
 * ---------------------------------------------------------------------------
 * The lock is the thing the security rule consults before accepting the next
 * upload. A client that could write the lock field could also write it back
 * off, whatever the screen offered - and the rule would be enforcing a value
 * the person it is meant to constrain controls. The engine writes it; the
 * rules refuse every client write to it.
 */
export const lockAttachments = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ATTACHMENT_LOCK_ROLES);
    const { entityType, entityId } = (request.data ?? {}) as {
      entityType?: string;
      entityId?: string;
    };

    if (!entityType || !entityId) {
      throw invalid('A document type and id are required.');
    }

    const label = LOCKABLE[entityType];
    if (!label) {
      throw invalid(
        'Supporting documents cannot be closed on that kind of record. Only an obligation request, a disbursement voucher, a treasury report or a liquidation report carries a closing.',
      );
    }

    /*
     * There must be something to close.
     *
     * Closing an empty record would leave a document that can never carry its
     * signed form - and the only way out of it would be an unlock, which does
     * not exist. The query is outside the transaction because Firestore
     * cannot run one inside; the race is an attachment uploaded in the same
     * second, and losing it means the officer closed a record whose scan
     * arrived a moment later, which the message below tells them to check.
     */
    const attached = await db
      .collection(COL.documents)
      .where('entityType', '==', entityType)
      .where('entityId', '==', entityId)
      .limit(1)
      .get();

    if (attached.empty) {
      throw new HttpsError(
        'failed-precondition',
        `Nothing is attached to this ${label} yet. Attach the signed form first - once the supporting documents are closed, nothing further can be attached and it cannot be undone.`,
      );
    }

    return db.runTransaction(async (tx) => {
      const ref = db.collection(entityType).doc(entityId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound(`The ${label}`);

      const parent = snap.data() as {
        attachmentsLockedAt?: string;
        attachmentsLockedBy?: { name?: string };
        fiscalYear?: number;
        fundCode?: string;
        status?: string;
        obrNo?: string;
        dvNo?: string;
        reportNo?: string;
        liquidationNo?: string;
      };

      if (parent.attachmentsLockedAt) {
        throw new HttpsError(
          'failed-precondition',
          `The supporting documents on this ${label} were already closed by ${
            parent.attachmentsLockedBy?.name ?? 'an officer'
          } on ${parent.attachmentsLockedAt.slice(0, 10)}. A closing cannot be undone.`,
        );
      }

      const now = new Date().toISOString();

      tx.update(ref, {
        attachmentsLockedAt: now,
        attachmentsLockedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      const documentRef =
        parent.obrNo ?? parent.dvNo ?? parent.reportNo ?? parent.liquidationNo ?? entityId;

      /*
       * An audit entry, not a workflow transition.
       *
       * The document's status does not change - a draft obligation whose scan
       * has been closed is still a draft. Writing it into the workflow history
       * would put a step in the trail that never happened, and the history is
       * what somebody reads to see how a transaction moved.
       */
      auditInTransaction(tx, {
        caller,
        event: 'ATTACHMENTS_LOCKED',
        entityType,
        entityId,
        entityRef: documentRef,
        fiscalYear: parent.fiscalYear,
        fundCode: parent.fundCode,
        remarks: `The supporting documents on ${label} ${documentRef} were closed. Nothing further can be attached, and this cannot be undone.`,
        severity: 'NOTICE',
      });

      return { entityType, entityId, attachmentsLockedAt: now };
    });
  },
);
