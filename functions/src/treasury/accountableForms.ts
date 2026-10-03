import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import type { Transaction } from 'firebase-admin/firestore';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, notFound, reporting, type Role } from '../lib/context';
import { recordTransition, auditInTransaction } from '../lib/audit';
import { issueNumber, loadNumberingConfig } from '../lib/numbering';
import {
  accountability,
  analyzeContinuity,
  collapse,
  count,
  normalise,
  rangeFrom,
  renderSet,
  subtract,
  union,
  type NumericRange,
} from '../lib/serials';

/**
 * Custody of accountable forms, and the report that proves it.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 * A municipality loses money through accountable forms in one of two ways. A
 * booklet is issued to an officer and never accounted for; or a receipt is
 * written out of a booklet the officer was never given, so the money it
 * collected has no record to go missing from.
 *
 * Both are invisible to a system that tracks quantities. Both are impossible to
 * hide from one that tracks serial ranges, because a serial can be in exactly
 * one officer's custody at a time and the arithmetic either foots or it does
 * not. That is the whole design:
 *
 *   - `recordFormMovement` refuses to issue a serial that is not in stock, to
 *     receive one that already exists anywhere, or to take one back from an
 *     officer who is not holding it. These are read-then-decide checks made
 *     inside the transaction that writes, against the movement ledger itself.
 *
 *   - `prepareRaaf` computes the report rather than accepting it. A collecting
 *     officer's "issued" column is read from the receipts actually encoded in
 *     Collections, not from anything the officer types. If those receipts
 *     include a serial the officer was never issued, the report says so and
 *     cannot be certified.
 *
 * Nothing here is deleted. A movement entered wrongly is voided with a reason
 * and re-entered, because the ledger is the evidence and a ledger you can edit
 * is not evidence.
 * ---------------------------------------------------------------------------
 */

const TREASURY_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF'];
const CERTIFY_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER'];

/** The serial ranges held by the office itself, as opposed to by an officer. */
const STOCK = '__STOCK__';

type MovementKind = 'RECEIPT' | 'ISSUE' | 'RETURN' | 'SPOILED' | 'CANCELLED';
const MOVEMENT_KINDS: MovementKind[] = ['RECEIPT', 'ISSUE', 'RETURN', 'SPOILED', 'CANCELLED'];

interface MovementDoc {
  fiscalYear: number;
  formCode: string;
  kind: MovementKind;
  movementDate: string;
  serialFrom: string;
  serialTo: string;
  quantity: number;
  custodianId: string | null;
  custodianName: string | null;
  fromCustodianId: string | null;
  fromCustodianName: string | null;
  voided?: boolean;
}

interface FormTypeDoc {
  code: string;
  name: string;
  printedAs?: string;
  bookletSize?: number;
  serialLength?: number;
  unitValue?: number;
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalises how an office writes a form code.
 *
 * "AF 51", "af51" and "AF-51" all mean the same booklet, and the abstract
 * upload, the collection form and the master data screen each spell it their
 * own way. Comparing the normalised form is what lets a receipt encoded from a
 * spreadsheet be matched to the booklet it came out of.
 */
function normaliseFormCode(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function loadFormType(code: string): Promise<FormTypeDoc & { id: string }> {
  const snap = await db.collection(COL.accountableFormTypes).doc(code).get();
  if (!snap.exists) {
    throw new HttpsError(
      'not-found',
      `The accountable form "${code}" is not in Master Data. Add it under Master Data > ` +
        'Accountable Forms before recording movements against it.',
    );
  }
  return { id: snap.id, ...(snap.data() as FormTypeDoc) };
}

/**
 * Reads every live movement for one form, inside the caller's transaction.
 *
 * The whole ledger for a form is read rather than a slice of it, because
 * custody is cumulative: whether serial 7705420 may be issued today depends on
 * a receipt that may have been recorded two years ago. Reading it all is the
 * only answer that is correct; one form's ledger is a few hundred rows.
 */
async function readMovements(
  tx: Transaction | null,
  fiscalYear: number,
  formCode: string,
): Promise<MovementDoc[]> {
  const query = db
    .collection(COL.accountableFormMovements)
    .where('formCode', '==', formCode)
    .where('fiscalYear', '<=', fiscalYear);

  const snap = tx ? await tx.get(query) : await query.get();
  return snap.docs
    .map((d) => d.data() as MovementDoc)
    .filter((m) => m.voided !== true);
}

interface Custody {
  /** Ranges held by the office, not yet issued to anyone. */
  stock: NumericRange[];
  /** Ranges held by each accountable officer. */
  byOfficer: Map<string, NumericRange[]>;
  /** Ranges out of circulation: spoiled or cancelled. */
  retired: NumericRange[];
}

function emptyCustody(): Custody {
  return { stock: [], byOfficer: new Map(), retired: [] };
}

function holderOf(custody: Custody, key: string): NumericRange[] {
  return key === STOCK ? custody.stock : (custody.byOfficer.get(key) ?? []);
}

function setHolder(custody: Custody, key: string, ranges: NumericRange[]): void {
  if (key === STOCK) custody.stock = ranges;
  else custody.byOfficer.set(key, ranges);
}

/**
 * Replays the ledger up to a date and returns who holds what.
 *
 * `upTo` is exclusive, so passing the first day of a month gives the position
 * at the start of that month - which is precisely the RAAF's beginning balance,
 * and is reproducible for any month however long ago.
 */
function foldCustody(movements: MovementDoc[], upTo?: string): Custody {
  const custody = emptyCustody();

  const ordered = [...movements]
    .filter((m) => (upTo ? m.movementDate < upTo : true))
    .sort((a, b) => a.movementDate.localeCompare(b.movementDate));

  for (const m of ordered) {
    const range = rangeFrom(m.serialFrom, m.serialTo);
    if (!range) continue; // A non-numeric range cannot take part in arithmetic.
    const one = [range];

    switch (m.kind) {
      case 'RECEIPT':
        custody.stock = union(custody.stock, one);
        break;
      case 'ISSUE': {
        const to = m.custodianId ?? STOCK;
        custody.stock = subtract(custody.stock, one);
        setHolder(custody, to, union(holderOf(custody, to), one));
        break;
      }
      case 'RETURN': {
        const from = m.fromCustodianId ?? STOCK;
        setHolder(custody, from, subtract(holderOf(custody, from), one));
        custody.stock = union(custody.stock, one);
        break;
      }
      case 'SPOILED':
      case 'CANCELLED': {
        const from = m.fromCustodianId ?? STOCK;
        setHolder(custody, from, subtract(holderOf(custody, from), one));
        custody.retired = union(custody.retired, one);
        break;
      }
    }
  }

  return custody;
}

/** Every serial the ledger has ever seen, in any custody or retired. */
function everIssuedSerials(movements: MovementDoc[]): NumericRange[] {
  const receipts = movements
    .filter((m) => m.kind === 'RECEIPT')
    .map((m) => rangeFrom(m.serialFrom, m.serialTo))
    .filter((r): r is NumericRange => r !== null);
  return normalise(receipts);
}

function describeRanges(ranges: NumericRange[], limit = 3): string {
  const rendered = renderSet(ranges);
  const shown = rendered
    .slice(0, limit)
    .map((r) => (r.from === r.to ? r.from : `${r.from} to ${r.to}`));
  return shown.join(', ') + (rendered.length > limit ? ' and others' : '');
}

/** A reference made safe for a document id, which may not contain a slash. */
function slug(value: string): string {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// recordFormMovement
// ---------------------------------------------------------------------------

/**
 * Records a receipt into stock, an issue to an officer, a return, or a
 * spoilage - and refuses the ones that would break custody.
 */
export const recordFormMovement = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Recording the accountable form movement', async () => {
      const caller = await requireCaller(request, TREASURY_ROLES);
      const data = (request.data ?? {}) as {
        fiscalYear?: number;
        formCode?: string;
        kind?: string;
        movementDate?: string;
        serialFrom?: string;
        serialTo?: string;
        custodianId?: string;
        custodianName?: string;
        sourceRef?: string;
        remarks?: string;
      };

      const fiscalYear = Number(data.fiscalYear);
      if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

      const kind = String(data.kind ?? '') as MovementKind;
      if (!MOVEMENT_KINDS.includes(kind)) {
        throw invalid(`"${data.kind}" is not a kind of movement this system records.`);
      }

      const movementDate = String(data.movementDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(movementDate)) {
        throw invalid('A movement date in the form YYYY-MM-DD is required.');
      }

      const formCode = normaliseFormCode(data.formCode);
      if (!formCode) throw invalid('Choose the accountable form.');
      const formType = await loadFormType(formCode);

      const serialFrom = String(data.serialFrom ?? '').trim().toUpperCase();
      const serialTo = String(data.serialTo ?? '').trim().toUpperCase() || serialFrom;
      const range = rangeFrom(serialFrom, serialTo);
      if (!range) {
        throw invalid(
          `"${serialFrom}" to "${serialTo}" is not a serial range this system can account for. ` +
            'Both serials must be numeric and the range must not run backwards.',
        );
      }
      const quantity = range.to - range.from + 1;

      // An officer is required for an issue and for a return; a receipt into
      // stock and a spoilage out of stock name none.
      const custodianId = String(data.custodianId ?? '').trim() || null;
      const custodianName = String(data.custodianName ?? '').trim() || null;
      if ((kind === 'ISSUE' || kind === 'RETURN') && !custodianId) {
        throw invalid('Choose the accountable officer the forms are issued to or returned by.');
      }

      const docId = [
        fiscalYear,
        formCode,
        kind,
        movementDate,
        String(range.from),
        String(range.to),
        slug(data.sourceRef ?? custodianId ?? ''),
      ].join('__');

      const result = await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.accountableFormMovements).doc(docId);
        const existing = await tx.get(ref);
        if (existing.exists && existing.data()?.voided !== true) {
          throw new HttpsError(
            'already-exists',
            `This movement is already recorded: ${formType.name}, ${serialFrom} to ${serialTo}, ` +
              `${movementDate}. Nothing was written twice.`,
          );
        }

        const movements = await readMovements(tx, fiscalYear, formCode);
        const custody = foldCustody(movements);

        // -- The custody checks, one per kind -----------------------------
        if (kind === 'RECEIPT') {
          const known = everIssuedSerials(movements);
          const clash = [range].flatMap((r) => (count(subtract([r], known)) < quantity ? [r] : []));
          if (clash.length > 0) {
            const already = subtract([range], subtract([range], known));
            throw new HttpsError(
              'failed-precondition',
              `${count(already)} of these serials have already been received into stock ` +
                `(${describeRanges(already)}). A serial is received once; if this is a ` +
                'correction, void the earlier receipt first.',
            );
          }
        }

        if (kind === 'ISSUE') {
          const shortfall = subtract([range], custody.stock);
          if (count(shortfall) > 0) {
            throw new HttpsError(
              'failed-precondition',
              `${count(shortfall)} of these serials are not in stock (${describeRanges(shortfall)}). ` +
                'They are either already issued to an officer, or were never received. Record the ' +
                'receipt from the Bureau of Treasury first, or take them back from the officer holding them.',
            );
          }
        }

        if (kind === 'RETURN') {
          const held = holderOf(custody, custodianId as string);
          const shortfall = subtract([range], held);
          if (count(shortfall) > 0) {
            throw new HttpsError(
              'failed-precondition',
              `${custodianName ?? 'That officer'} is not holding ${count(shortfall)} of these serials ` +
                `(${describeRanges(shortfall)}). Forms can only be returned by the officer they were issued to.`,
            );
          }
        }

        if (kind === 'SPOILED' || kind === 'CANCELLED') {
          const holderKey = custodianId ?? STOCK;
          const held = holderOf(custody, holderKey);
          const shortfall = subtract([range], held);
          if (count(shortfall) > 0) {
            throw new HttpsError(
              'failed-precondition',
              `${count(shortfall)} of these serials are not held by ` +
                `${custodianId ? (custodianName ?? 'that officer') : 'the office'} ` +
                `(${describeRanges(shortfall)}), so they cannot be written off from there.`,
            );
          }
        }

        const now = new Date().toISOString();
        const unitValue = formType.unitValue ?? 0;

        const doc = {
          fiscalYear,
          formCode,
          formName: formType.name,
          kind,
          movementDate,
          serialFrom,
          serialTo,
          quantity,
          // Who holds the range afterwards, and who held it before.
          custodianId: kind === 'ISSUE' ? custodianId : null,
          custodianName: kind === 'ISSUE' ? custodianName : null,
          fromCustodianId: kind === 'ISSUE' ? null : custodianId,
          fromCustodianName: kind === 'ISSUE' ? null : custodianName,
          sourceRef: String(data.sourceRef ?? '').trim() || null,
          unitValue: unitValue || null,
          totalValue: unitValue ? unitValue * quantity : null,
          remarks: String(data.remarks ?? '').trim() || null,
          voided: false,
          createdBy: { uid: caller.uid, name: caller.name, at: now },
          createdAt: now,
        };

        tx.set(ref, doc);

        recordTransition(tx, {
          caller,
          entityType: COL.accountableFormMovements,
          entityId: docId,
          entityRef: `${formType.name} ${serialFrom}-${serialTo}`,
          fiscalYear,
          fundCode: 'ALL',
          action: 'CREATE',
          newStatus: kind,
          event: 'CREATE',
          remarks:
            kind === 'ISSUE'
              ? `${quantity} forms issued to ${custodianName ?? custodianId}`
              : `${quantity} forms ${kind.toLowerCase()}`,
        });

        return { movementId: docId, quantity };
      });

      return result;
    }),
);

// ---------------------------------------------------------------------------
// voidFormMovement
// ---------------------------------------------------------------------------

/**
 * Marks a movement as never having happened, with a reason.
 *
 * A movement is not deleted, because the register's own continuity is part of
 * the evidence: a row that disappears leaves no trace, and an auditor who
 * cannot see the correction cannot tell it from a concealment.
 */
export const voidFormMovement = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Voiding the movement', async () => {
      const caller = await requireCaller(request, CERTIFY_ROLES);
      const data = (request.data ?? {}) as { movementId?: string; reason?: string };

      const movementId = String(data.movementId ?? '').trim();
      if (!movementId) throw invalid('Which movement should be voided?');

      const reason = String(data.reason ?? '').trim();
      if (reason.length < 10) {
        throw invalid('Give a reason of at least ten characters. It is recorded on the movement.');
      }

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.accountableFormMovements).doc(movementId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That movement');

        const m = snap.data() as MovementDoc & { formName?: string };
        if (m.voided) throw new HttpsError('failed-precondition', 'That movement is already void.');

        // Voiding a receipt that has since been issued would leave the issue
        // standing on serials the office never received. Refuse rather than
        // silently break the chain.
        if (m.kind === 'RECEIPT') {
          const movements = await readMovements(tx, m.fiscalYear, m.formCode);
          const later = movements.filter(
            (o) => o.kind !== 'RECEIPT' && o.movementDate >= m.movementDate,
          );
          const range = rangeFrom(m.serialFrom, m.serialTo);
          const touched = later
            .map((o) => rangeFrom(o.serialFrom, o.serialTo))
            .filter((r): r is NumericRange => r !== null);
          if (range && count(subtract([range], subtract([range], normalise(touched)))) > 0) {
            throw new HttpsError(
              'failed-precondition',
              'Some of these serials have already been issued, returned or written off. ' +
                'Void those movements first, or this receipt would leave them standing on ' +
                'forms the office never received.',
            );
          }
        }

        const now = new Date().toISOString();
        tx.update(ref, {
          voided: true,
          voidReason: reason,
          voidedBy: { uid: caller.uid, name: caller.name, at: now },
        });

        auditInTransaction(tx, {
          caller,
          event: 'CANCEL',
          entityType: COL.accountableFormMovements,
          entityId: movementId,
          entityRef: `${m.formName ?? m.formCode} ${m.serialFrom}-${m.serialTo}`,
          fiscalYear: m.fiscalYear,
          remarks: reason,
          severity: 'NOTICE',
        });
      });

      return { movementId };
    }),
);

// ---------------------------------------------------------------------------
// prepareRaaf
// ---------------------------------------------------------------------------

interface CollectionRow {
  orNumber?: string;
  orDate?: string;
  accountableFormId?: string;
  accountableForm?: string;
  status?: string;
}

/**
 * Builds the Report of Accountability for Accountable Forms for one officer
 * and one period.
 *
 * Nothing on this report is typed. The beginning balance is the movement ledger
 * replayed to the first day of the period; receipts are the issues made to this
 * officer within it; and - for a collecting officer - the issued column is the
 * Official Receipts actually encoded in Collections, which is what ties the
 * paper to the revenue accounts.
 *
 * Re-preparing overwrites the draft, so an officer who encodes three more
 * receipts after generating the report simply generates it again. A certified
 * report is never overwritten.
 */
export const prepareRaaf = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Preparing the report of accountability', async () => {
      const caller = await requireCaller(request, TREASURY_ROLES);
      const data = (request.data ?? {}) as {
        fiscalYear?: number;
        officerId?: string;
        officerName?: string;
        officerPosition?: string;
        basis?: string;
        periodFrom?: string;
        periodTo?: string;
      };

      const fiscalYear = Number(data.fiscalYear);
      if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

      const basis = data.basis === 'CUSTODIAN' ? 'CUSTODIAN' : 'COLLECTING_OFFICER';
      const officerId = String(data.officerId ?? '').trim();
      const officerName = String(data.officerName ?? '').trim();
      if (!officerId || !officerName) throw invalid('Choose the accountable officer.');

      const periodFrom = String(data.periodFrom ?? '').trim();
      const periodTo = String(data.periodTo ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(periodFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(periodTo)) {
        throw invalid('A period from and to, both in the form YYYY-MM-DD, are required.');
      }
      if (periodTo < periodFrom) throw invalid('The period ends before it begins.');

      const raafId = `${officerId}__${periodFrom}__${periodTo}`;
      const existing = await db.collection(COL.raafReports).doc(raafId).get();
      if (existing.exists && existing.data()?.status === 'CERTIFIED') {
        throw new HttpsError(
          'failed-precondition',
          `A certified report already covers ${officerName} for this period ` +
            `(${existing.data()?.raafNo}). Cancel it before preparing another.`,
        );
      }

      // -- Every form type this officer has ever touched -------------------
      const typesSnap = await db.collection(COL.accountableFormTypes).get();
      const formTypes = typesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as FormTypeDoc) }));
      if (formTypes.length === 0) {
        throw new HttpsError(
          'failed-precondition',
          'No accountable forms are set up. Add them under Master Data > Accountable Forms first.',
        );
      }

      // -- Receipts this officer issued in the period, by form -------------
      const usedByForm = new Map<string, string[]>();
      if (basis === 'COLLECTING_OFFICER') {
        const colSnap = await db
          .collection(COL.collections)
          .where('collectingOfficerId', '==', officerId)
          .where('orDate', '>=', periodFrom)
          .where('orDate', '<=', periodTo)
          .get();

        for (const doc of colSnap.docs) {
          const c = doc.data() as CollectionRow;
          // A cancelled receipt is still a serial the officer has to account
          // for - it is issued out of the booklet, it just collected nothing.
          const code = normaliseFormCode(c.accountableFormId ?? c.accountableForm ?? '');
          if (!code) continue;
          const list = usedByForm.get(code) ?? [];
          list.push(String(c.orNumber ?? '').trim());
          usedByForm.set(code, list);
        }
      }

      const lines: Array<Record<string, unknown>> = [];
      let hasDiscrepancy = false;

      for (const formType of formTypes) {
        const formCode = normaliseFormCode(formType.code ?? formType.id);
        const movements = await readMovements(null, fiscalYear, formCode);
        const used = usedByForm.get(formCode) ?? [];

        // Position at the start of the period, then the period's own movements.
        const opening = foldCustody(movements, periodFrom);
        const inPeriod = movements.filter(
          (m) => m.movementDate >= periodFrom && m.movementDate <= periodTo,
        );

        const key = basis === 'CUSTODIAN' ? STOCK : officerId;
        let beginning = holderOf(opening, key);

        // A collecting officer's opening balance must exclude the receipts they
        // had already written before the period, which the movement ledger does
        // not know about - only Collections does.
        let priorUsed: NumericRange[] = [];
        if (basis === 'COLLECTING_OFFICER') {
          const priorSnap = await db
            .collection(COL.collections)
            .where('collectingOfficerId', '==', officerId)
            .where('orDate', '<', periodFrom)
            .get();
          const priorSerials = priorSnap.docs
            .map((d) => d.data() as CollectionRow)
            .filter((c) => normaliseFormCode(c.accountableFormId ?? c.accountableForm ?? '') === formCode)
            .map((c) => String(c.orNumber ?? '').trim());
          priorUsed = collapse(priorSerials);
          beginning = subtract(beginning, priorUsed);
        }

        const receiptRanges = inPeriod
          .filter((m) =>
            basis === 'CUSTODIAN' ? m.kind === 'RECEIPT' : m.kind === 'ISSUE' && m.custodianId === officerId,
          )
          .map((m) => rangeFrom(m.serialFrom, m.serialTo))
          .filter((r): r is NumericRange => r !== null);

        const issuedRanges =
          basis === 'CUSTODIAN'
            ? inPeriod
                .filter((m) => m.kind === 'ISSUE')
                .map((m) => rangeFrom(m.serialFrom, m.serialTo))
                .filter((r): r is NumericRange => r !== null)
            : collapse(used);

        const withdrawnRanges = inPeriod
          .filter(
            (m) =>
              (m.kind === 'SPOILED' || m.kind === 'CANCELLED') &&
              (basis === 'CUSTODIAN' ? !m.fromCustodianId : m.fromCustodianId === officerId),
          )
          .map((m) => rangeFrom(m.serialFrom, m.serialTo))
          .filter((r): r is NumericRange => r !== null);

        // A form the officer has never touched has nothing to report.
        if (
          count(beginning) === 0 &&
          count(receiptRanges) === 0 &&
          count(issuedRanges) === 0 &&
          count(withdrawnRanges) === 0
        ) {
          continue;
        }

        const bookletSize = formType.bookletSize && formType.bookletSize > 0 ? formType.bookletSize : 50;
        const acc = accountability(
          {
            beginning,
            receipt: receiptRanges,
            issued: issuedRanges,
            withdrawn: withdrawnRanges,
          },
          bookletSize,
        );

        const continuity = analyzeContinuity(used);
        if (acc.discrepancy) hasDiscrepancy = true;

        lines.push({
          formCode,
          formName: formType.name ?? formCode,
          printedAs: formType.printedAs ?? formType.name ?? formCode,
          unitValue: formType.unitValue ?? null,
          beginningQty: acc.beginning.qty,
          beginningRanges: acc.beginning.ranges,
          receiptQty: acc.receipt.qty,
          receiptRanges: acc.receipt.ranges,
          issuedQty: acc.issued.qty,
          issuedRanges: acc.issued.ranges,
          withdrawnQty: acc.withdrawn.qty,
          withdrawnRanges: acc.withdrawn.ranges,
          endingQty: acc.ending.qty,
          endingRanges: acc.ending.ranges,
          discrepancy: acc.discrepancy,
          duplicates: continuity.duplicates,
          gaps: continuity.gaps,
        });
      }

      if (lines.length === 0) {
        throw new HttpsError(
          'failed-precondition',
          `${officerName} has no accountable forms in custody and issued none in this period, ` +
            'so there is nothing to report.',
        );
      }

      const now = new Date().toISOString();
      const periodLabel =
        periodFrom.slice(0, 7) === periodTo.slice(0, 7)
          ? new Date(`${periodFrom}T00:00:00`).toLocaleDateString('en-PH', {
              month: 'long',
              year: 'numeric',
              timeZone: 'Asia/Manila',
            })
          : `${periodFrom} to ${periodTo}`;

      await db
        .collection(COL.raafReports)
        .doc(raafId)
        .set({
          fiscalYear,
          basis,
          officerId,
          officerName,
          officerPosition: String(data.officerPosition ?? '').trim() || null,
          periodFrom,
          periodTo,
          periodLabel,
          status: 'DRAFT',
          lines,
          hasDiscrepancy,
          preparedBy: { uid: caller.uid, name: caller.name, at: now },
          createdAt: now,
        });

      await db.collection(COL.auditLogs).add({
        event: 'CREATE',
        entityType: COL.raafReports,
        entityId: raafId,
        entityRef: `RAAF ${officerName} ${periodLabel}`,
        fiscalYear,
        actor: { uid: caller.uid, name: caller.name },
        at: now,
        severity: hasDiscrepancy ? 'NOTICE' : 'INFO',
        remarks: hasDiscrepancy ? 'Prepared with an unexplained custody difference.' : null,
      });

      return { raafId, lines: lines.length, hasDiscrepancy };
    }),
);

// ---------------------------------------------------------------------------
// certifyRaaf
// ---------------------------------------------------------------------------

/**
 * Draws the report number and locks the report.
 *
 * Certification is refused while any line does not foot. That is the one place
 * this module says no to an accountable officer, and it is the right place: a
 * certified RAAF is the officer's own statement that they can account for every
 * serial, and the system must not let them make that statement while the
 * arithmetic in front of them says otherwise.
 */
export const certifyRaaf = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Certifying the report', async () => {
      const caller = await requireCaller(request, CERTIFY_ROLES);
      const raafId = String((request.data ?? {}).raafId ?? '').trim();
      if (!raafId) throw invalid('Which report should be certified?');

      const cfg = await loadNumberingConfig('RAAF');

      const raafNo = await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.raafReports).doc(raafId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That report');

        const r = snap.data() as {
          status: string;
          fiscalYear: number;
          officerName: string;
          periodFrom: string;
          periodLabel: string;
          hasDiscrepancy?: boolean;
          lines?: Array<{ discrepancy?: string | null; formName?: string }>;
        };

        if (r.status !== 'DRAFT') {
          throw new HttpsError('failed-precondition', `This report is already ${r.status.toLowerCase()}.`);
        }

        const broken = (r.lines ?? []).filter((l) => l.discrepancy);
        if (broken.length > 0 || r.hasDiscrepancy) {
          throw new HttpsError(
            'failed-precondition',
            `${broken.length || 1} line${broken.length === 1 ? '' : 's'} of this report do not foot. ` +
              `${broken[0]?.formName ? `${broken[0].formName}: ` : ''}${broken[0]?.discrepancy ?? ''} ` +
              'Certifying is the officer’s statement that every serial is accounted for, so the ' +
              'difference has to be explained and the movement recorded before this can be signed.',
          );
        }

        const month = Number(r.periodFrom.slice(5, 7));
        const number = await issueNumber(tx, cfg, {
          bookCode: 'RAAF',
          fundCode: 'ALL',
          fiscalYear: r.fiscalYear,
          month,
        });

        const now = new Date().toISOString();
        tx.update(ref, {
          raafNo: number,
          status: 'CERTIFIED',
          certifiedBy: { uid: caller.uid, name: caller.name, at: now },
        });

        recordTransition(tx, {
          caller,
          entityType: COL.raafReports,
          entityId: raafId,
          entityRef: `RAAF ${number}`,
          fiscalYear: r.fiscalYear,
          fundCode: 'ALL',
          action: 'CERTIFY',
          previousStatus: 'DRAFT',
          newStatus: 'CERTIFIED',
          event: 'CERTIFY',
          remarks: `${r.officerName}, ${r.periodLabel}`,
        });

        return number;
      });

      return { raafId, raafNo };
    }),
);

// ---------------------------------------------------------------------------
// cancelRaaf
// ---------------------------------------------------------------------------

export const cancelRaaf = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Cancelling the report', async () => {
      const caller = await requireCaller(request, CERTIFY_ROLES);
      const data = (request.data ?? {}) as { raafId?: string; reason?: string };

      const raafId = String(data.raafId ?? '').trim();
      if (!raafId) throw invalid('Which report should be cancelled?');
      const reason = String(data.reason ?? '').trim();
      if (reason.length < 10) {
        throw invalid('Give a reason of at least ten characters. It stays on the report.');
      }

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.raafReports).doc(raafId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That report');

        const r = snap.data() as { status: string; fiscalYear: number; raafNo?: string };
        if (r.status === 'CANCELLED') {
          throw new HttpsError('failed-precondition', 'That report is already cancelled.');
        }

        const now = new Date().toISOString();
        tx.update(ref, {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledBy: { uid: caller.uid, name: caller.name, at: now },
        });

        recordTransition(tx, {
          caller,
          entityType: COL.raafReports,
          entityId: raafId,
          entityRef: `RAAF ${r.raafNo ?? raafId}`,
          fiscalYear: r.fiscalYear,
          fundCode: 'ALL',
          action: 'CANCEL',
          previousStatus: r.status,
          newStatus: 'CANCELLED',
          event: 'CANCEL',
          remarks: reason,
          severity: 'NOTICE',
        });
      });

      return { raafId };
    }),
);
