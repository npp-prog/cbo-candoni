import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { ActorStamp } from '@/types/common';
import { withoutUndefined } from '@/lib/firestoreValues';

/**
 * Direct client writes.
 *
 * These cover drafts and master data only. Every state change with financial
 * consequence - certification, approval, posting, payment, reconciliation -
 * goes through `engine` (Cloud Functions) instead, and Firestore Security
 * Rules refuse those transitions from the client regardless of what is
 * attempted here.
 *
 * The split is worth stating plainly, because it is the thing a future
 * maintainer is most likely to get wrong: if a change alters a balance,
 * consumes a document number, or moves a document past DRAFT or SUBMITTED, it
 * belongs in a Cloud Function. If it edits a draft or a reference record, it
 * belongs here.
 */

export function actorStamp(user: { uid: string; name: string; position?: string }): ActorStamp {
  const stamp: ActorStamp = {
    uid: user.uid,
    name: user.name,
    at: new Date().toISOString(),
  };

  // Firestore here is configured to reject `undefined` rather than quietly drop
  // it, which is the right setting for an accounting system - a field that was
  // meant to carry a figure should never vanish unnoticed. The consequence is
  // that an *optional* field must be left out entirely, not written as
  // undefined. Position is optional and is blank until the user's profile
  // document records one, which is the normal state for a freshly granted
  // account.
  if (user.position) stamp.position = user.position;

  return stamp;
}

/** Create a draft document. Returns the new id. */
export async function createDraft<T extends Record<string, unknown>>(
  collectionName: string,
  data: T,
  actor: ActorStamp,
): Promise<string> {
  const ref = await addDoc(collection(db, collectionName), {
    ...withoutUndefined(data),
    createdBy: actor,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/** Update a draft document. */
export async function updateDraft<T extends Record<string, unknown>>(
  collectionName: string,
  id: string,
  data: T,
  actor: ActorStamp,
): Promise<void> {
  await updateDoc(doc(db, collectionName, id), {
    ...withoutUndefined(data),
    updatedBy: actor,
    updatedAt: serverTimestamp(),
  });
}

/** Create or replace a master-data record with a chosen id. */
export async function upsertMaster<T extends Record<string, unknown>>(
  collectionName: string,
  id: string,
  data: T,
  actor: ActorStamp,
): Promise<void> {
  await setDoc(
    doc(db, collectionName, id),
    { ...data, updatedBy: actor, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

/**
 * Deactivate a master-data record.
 *
 * Master data is never hard-deleted: a posted voucher from 2023 still refers
 * to the payee and the account it used, and deleting either would leave those
 * records pointing at nothing. Deactivating removes it from the pickers while
 * keeping history intact.
 */
export async function deactivateMaster(
  collectionName: string,
  id: string,
  actor: ActorStamp,
  reason?: string,
): Promise<void> {
  await updateDoc(doc(db, collectionName, id), {
    active: false,
    deactivatedBy: actor,
    deactivationReason: reason ?? null,
  });
}

export async function reactivateMaster(collectionName: string, id: string, actor: ActorStamp): Promise<void> {
  await updateDoc(doc(db, collectionName, id), {
    active: true,
    deactivatedBy: null,
    deactivationReason: null,
    updatedBy: actor,
  });
}

/**
 * Delete a draft. Permitted by security rules only for an administrator and
 * only while the document is still DRAFT - nothing that has entered a
 * workflow can be deleted, only cancelled.
 */
export async function deleteDraft(collectionName: string, id: string): Promise<void> {
  await deleteDoc(doc(db, collectionName, id));
}
