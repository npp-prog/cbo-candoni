import { HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { db, COL } from '../lib/firebase';
import {
  actId,
  actKindLabel,
  actKindOfLine,
  coverEncoded,
  coverOriginal,
  coverShortfall,
  fundingBasis,
  ACT_KINDS,
  type ActKind,
  type SourceEntry,
} from '../lib/budgetActs';

/**
 * What an act must have before its lines become authority. Patch 123.
 *
 *   1. The act is RECORDED - Budget > Appropriations > Authorities.
 *   2. Its signed copy is ATTACHED.
 *   3. Its SOURCES finance it (lib/budgetActs.ts says which, and how much).
 *
 * Every approval of appropriation runs through here: one line, a whole
 * ordinance, a prepared realignment or augmentation. The reads are plain
 * reads, before the approving transaction, as the rest of the ordinance
 * approval's checks are; the figures that matter to the ledger are re-read
 * inside it.
 */

/** Reads inside or outside a transaction alike. */
type Reader = Pick<Transaction, 'get'> | null;

const read = <T>(tx: Reader, q: FirebaseFirestore.Query | FirebaseFirestore.DocumentReference) =>
  (tx ? tx.get(q as never) : (q as FirebaseFirestore.Query).get()) as Promise<T>;

export interface ActRef {
  fiscalYear: number;
  fundCode: string;
  kind: ActKind;
  reference: string;
}

const where = (kind: ActKind) =>
  'Record it on Budget > Appropriations > Authorities' +
  (kind === 'AUGMENTATION'
    ? ' as an Augmentation'
    : kind === 'CONTINUING'
      ? ' as a Continuing appropriation'
      : '');

/** 1 and 2: the act is recorded and its signed copy is on it. */
export async function assertActDocumented(act: ActRef, tx: Reader = null): Promise<string> {
  const doc = ACT_KINDS.find((k) => k.value === act.kind)?.document ?? 'signed copy';
  const reference = act.reference.trim();
  if (!reference) {
    throw new HttpsError(
      'failed-precondition',
      `This ${actKindLabel(act.kind).toLowerCase()} has no ${act.kind === 'AUGMENTATION' ? 'office order' : 'ordinance'} number, so it cannot be approved. Enter the number it was signed under.`,
    );
  }
  const id = actId({ ...act, reference });
  const snap = await read<FirebaseFirestore.DocumentSnapshot>(
    tx,
    db.collection(COL.ordinances).doc(id),
  );
  if (!snap.exists) {
    throw new HttpsError(
      'failed-precondition',
      `${reference} is not recorded as a ${actKindLabel(act.kind).toLowerCase()} of fiscal year ${act.fiscalYear}, ${act.fundCode}. ${where(act.kind)}, attach the ${doc}, then approve.`,
      { actId: id },
    );
  }
  const docs = await read<FirebaseFirestore.QuerySnapshot>(
    tx,
    db
      .collection(COL.documents)
      .where('entityType', '==', COL.ordinances)
      .where('entityId', '==', id)
      .where('active', '==', true)
      .limit(1),
  );
  if (docs.empty) {
    throw new HttpsError(
      'failed-precondition',
      `${reference} has no signed copy attached. Open it under Budget > Appropriations > Authorities, attach the ${doc} on Supporting documents, then approve.`,
      { actId: id },
    );
  }
  return id;
}

/** The approved total of every act of this kind in the year and fund, by act id. */
async function approvedByAct(tx: Reader, fiscalYear: number, fundCode: string, kind: ActKind) {
  const snap = await read<FirebaseFirestore.QuerySnapshot>(
    tx,
    db
      .collection(COL.appropriations)
      .where('fiscalYear', '==', fiscalYear)
      .where('fundCode', '==', fundCode)
      .where('status', '==', 'APPROVED')
      .where('kind', '==', kind),
  );
  const out = new Map<string, number>();
  for (const d of snap.docs) {
    const a = d.data() as {
      kind: string;
      instrument?: string;
      authorityReference?: string;
      amount?: number;
    };
    if (actKindOfLine(a) !== kind) continue;
    const id = actId({ fiscalYear, fundCode, kind, reference: a.authorityReference ?? '' });
    out.set(id, (out.get(id) ?? 0) + (a.amount ?? 0));
  }
  return out;
}

export async function readSources(
  tx: Reader,
  fiscalYear: number,
  fundCode: string,
): Promise<SourceEntry[]> {
  const snap = await read<FirebaseFirestore.QuerySnapshot>(
    tx,
    db
      .collection(COL.fundingSources)
      .where('fiscalYear', '==', fiscalYear)
      .where('fundCode', '==', fundCode),
  );
  return snap.docs.map((d) => {
    const s = d.data() as { section: string; amount?: number; actId?: string | null };
    return { section: s.section, amount: s.amount ?? 0, actId: s.actId ?? null };
  });
}

/** 3: the sources finance the act, with `adding` approved on top of what it already has. */
export async function assertActFunded(
  act: ActRef,
  adding: number,
  tx: Reader = null,
): Promise<void> {
  const basis = fundingBasis(act.kind);
  // A realignment or augmentation is its own source: the set must come to
  // zero, and the import refuses one that does not.
  if (basis === 'OWN_LINES') return;

  const reference = act.reference.trim();
  if (basis === 'ESTIMATED_REVENUE') {
    const [est, approved] = await Promise.all([
      read<FirebaseFirestore.QuerySnapshot>(
        tx,
        db
          .collection(COL.estimatedReceipts)
          .where('fiscalYear', '==', act.fiscalYear)
          .where('fundCode', '==', act.fundCode),
      ),
      approvedByAct(tx, act.fiscalYear, act.fundCode, 'ORIGINAL'),
    ]);
    const estimated = est.docs.reduce((t, d) => t + ((d.data().annual as number) ?? 0), 0);
    const approvedOriginal = [...approved.values()].reduce((t, n) => t + n, 0);
    const c = coverOriginal({ estimated, approvedOriginal, adding });
    if (!c.ok)
      throw new HttpsError('failed-precondition', coverShortfall('ORIGINAL', reference, c), c);
    return;
  }

  const [sources, approved] = await Promise.all([
    readSources(tx, act.fiscalYear, act.fundCode),
    approvedByAct(tx, act.fiscalYear, act.fundCode, act.kind),
  ]);
  const c = coverEncoded({
    kind: act.kind,
    actId: actId({ ...act, reference }),
    sources,
    approvedByAct: approved,
    adding,
  });
  if (!c.ok) throw new HttpsError('failed-precondition', coverShortfall(act.kind, reference, c), c);
}

/** All three, for one act. */
export async function assertActReady(
  act: ActRef,
  adding: number,
  tx: Reader = null,
): Promise<void> {
  await assertActDocumented(act, tx);
  await assertActFunded(act, adding, tx);
}
