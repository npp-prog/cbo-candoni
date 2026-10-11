import { HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { db, COL } from './firebase';

/**
 * The supporting documents are required at APPROVAL and POSTING, not at
 * certification (patch 177).
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINE MOVED
 * ---------------------------------------------------------------------------
 * The certifying officers sign the paper first and scan it afterwards, and a
 * certificate refused for want of a scan only held the paper up on a desk. The
 * act that the scan must be on the record for is the one that writes the
 * books: approving a voucher, posting a journal entry, journalizing a treasury
 * report, posting a liquidation. Those refuse without it, here, in the server.
 *
 * ---------------------------------------------------------------------------
 * COUNTED FROM /documents, NOT FROM attachmentCount
 * ---------------------------------------------------------------------------
 * The counter on the parent is written by the browser, and the security rules
 * only let the browser write the parent while it is a draft. A file attached
 * AFTER certification therefore never reaches the counter, and a gate that
 * read it would refuse a record whose scan is plainly there. The documents
 * themselves are the evidence, so they are what is read - inside the
 * transaction, so nothing can be taken off between the check and the commit.
 */
export async function hasActiveAttachment(
  tx: Transaction,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const snap = await tx.get(
    db
      .collection(COL.documents)
      .where('entityType', '==', entityType)
      .where('entityId', '==', entityId)
      .where('active', '==', true)
      .limit(1),
  );
  return !snap.empty;
}

/** Refuses the step when nothing is attached. Call in the READ phase. */
export async function assertAttachedBeforePosting(
  tx: Transaction,
  entityType: string,
  entityId: string,
  what: string,
  step: string,
): Promise<void> {
  if (await hasActiveAttachment(tx, entityType, entityId)) return;
  throw new HttpsError(
    'failed-precondition',
    `Nothing is attached to ${what}. Attach the signed supporting documents under Supporting documents before ${step} - the entry cannot go into the books without them.`,
  );
}
