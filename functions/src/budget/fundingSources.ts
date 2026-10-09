import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, invalid, notFound, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import {
  actId,
  actKindOfLine,
  actsLeftUnfunded,
  sectionLabel,
  SOURCE_SECTIONS,
  type ActKind,
  type SourceEntry,
} from '../lib/budgetActs';

/**
 * saveFundingSource - encode, correct or delete a source of financing.
 * Patch 123.
 *
 * 1.0 New Revenue Sources and 2.0 Actual Collection in Excess of the
 * Estimated Income finance a supplemental budget; the Continuing sources
 * finance continuing appropriations. A source is encoded inside the act it
 * finances, or on the Sources tab, where it is open to any act of its kind.
 *
 * WHY A CALLABLE. A source is what lets an act become authority, so taking
 * one away can strand an act already approved: authority in the books with
 * nothing financing it. The client cannot see the other acts to know that,
 * so the engine refuses a deletion or a reduction that would do it, and names
 * the act.
 */

const SOURCE_RECORDERS: Role[] = [
  'SUPER_ADMIN',
  'BUDGET_OFFICER',
  'BUDGET_STAFF',
  'MUNICIPAL_TREASURER',
  'MUNICIPAL_ACCOUNTANT',
];

export const saveFundingSource = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, SOURCE_RECORDERS);
    const d = (request.data ?? {}) as {
      id?: string;
      remove?: boolean;
      fiscalYear?: number;
      fundCode?: string;
      section?: string;
      particulars?: string;
      accountCode?: string | null;
      accountName?: string | null;
      amount?: number;
      actId?: string | null;
    };

    return db.runTransaction(async (tx) => {
      // ---- the record as it stands, when correcting or deleting -------------
      const ref = d.id
        ? db.collection(COL.fundingSources).doc(d.id)
        : db.collection(COL.fundingSources).doc();
      const before = d.id ? await tx.get(ref) : null;
      if (d.id && !before?.exists) throw notFound('That source');
      const prior = before?.data() as
        | {
            fiscalYear: number;
            fundCode: string;
            section: string;
            amount: number;
            actId?: string | null;
            particulars?: string;
          }
        | undefined;

      const fiscalYear = prior?.fiscalYear ?? Number(d.fiscalYear);
      const fundCode = prior?.fundCode ?? String(d.fundCode ?? '').trim();
      if (!Number.isInteger(fiscalYear) || !fundCode)
        throw invalid('The fiscal year and the fund are required.');
      assertFundInScope(caller, fundCode);

      let next: {
        section: string;
        particulars: string;
        accountCode: string | null;
        accountName: string | null;
        amount: number;
        actId: string | null;
        actReference: string | null;
      } | null = null;

      if (!d.remove) {
        const section = String(d.section ?? prior?.section ?? '').toUpperCase();
        const meta = SOURCE_SECTIONS.find((s) => s.value === section);
        if (!meta)
          throw invalid(
            'Choose which source this is: 1.0 New Revenue, 2.0 Excess Collection, 3.0 Savings, or Continuing.',
          );
        const particulars = String(d.particulars ?? '').trim();
        if (!particulars)
          throw invalid(
            'Say what the source is - "Real Property Tax", "Excess collection, FY 2025", and so on.',
          );
        const amount = Number(d.amount);
        if (!Number.isInteger(amount) || amount <= 0)
          throw invalid('The amount must be more than zero.');

        // The act it is encoded in, if any, must be one this section finances.
        let linkedAct: string | null = null;
        let actReference: string | null = null;
        if (d.actId) {
          const act = await tx.get(db.collection(COL.ordinances).doc(String(d.actId)));
          if (!act.exists) throw notFound('That act');
          const a = act.data() as {
            fiscalYear: number;
            fundCode: string;
            kind: string;
            reference: string;
          };
          if (a.fiscalYear !== fiscalYear || a.fundCode !== fundCode) {
            throw invalid(`${a.reference} is in another year or fund.`);
          }
          if (a.kind !== meta.finances) {
            throw invalid(
              `${meta.label} finances a ${meta.finances.toLowerCase()} act, and ${a.reference} is ${a.kind.toLowerCase()}.`,
            );
          }
          linkedAct = act.id;
          actReference = a.reference;
        }
        next = {
          section,
          particulars,
          accountCode: d.accountCode ? String(d.accountCode).trim() : null,
          accountName: d.accountName ? String(d.accountName).trim() : null,
          amount,
          actId: linkedAct,
          actReference,
        };
      }

      // ---- would the change strand an approved act? -------------------------
      const kinds = new Set<ActKind>(
        [prior?.section, next?.section]
          .filter(Boolean)
          .map((s) => SOURCE_SECTIONS.find((x) => x.value === s)!.finances),
      );
      const sourcesSnap = await tx.get(
        db
          .collection(COL.fundingSources)
          .where('fiscalYear', '==', fiscalYear)
          .where('fundCode', '==', fundCode),
      );
      const sources: SourceEntry[] = sourcesSnap.docs
        .filter((x) => x.id !== ref.id)
        .map((x) => ({
          section: x.data().section,
          amount: x.data().amount ?? 0,
          actId: x.data().actId ?? null,
        }));
      if (next) sources.push({ section: next.section, amount: next.amount, actId: next.actId });

      for (const kind of kinds) {
        const lines = await tx.get(
          db
            .collection(COL.appropriations)
            .where('fiscalYear', '==', fiscalYear)
            .where('fundCode', '==', fundCode)
            .where('status', '==', 'APPROVED')
            .where('kind', '==', kind),
        );
        const approved = new Map<string, number>();
        const refs = new Map<string, string>();
        for (const l of lines.docs) {
          const a = l.data() as {
            kind: string;
            instrument?: string;
            authorityReference?: string;
            amount?: number;
          };
          if (actKindOfLine(a) !== kind) continue;
          const id = actId({ fiscalYear, fundCode, kind, reference: a.authorityReference ?? '' });
          approved.set(id, (approved.get(id) ?? 0) + (a.amount ?? 0));
          refs.set(id, a.authorityReference ?? id);
        }
        const stranded = actsLeftUnfunded({ kind, sources, approvedByAct: approved });
        if (stranded.length) {
          throw new HttpsError(
            'failed-precondition',
            `This would leave ${stranded.map((id) => refs.get(id)).join(', ')} - already approved - without enough sources. ` +
              'A source may be corrected or removed only while what it finances is still covered.',
            { stranded },
          );
        }
      }

      // ---- write ------------------------------------------------------------
      const now = new Date().toISOString();
      const by = { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now };
      if (!next) {
        tx.delete(ref);
      } else if (before) {
        tx.update(ref, { ...next, updatedBy: by, updatedAt: now });
      } else {
        tx.set(ref, { ...next, fiscalYear, fundCode, createdBy: by, createdAt: now });
      }

      recordTransition(tx, {
        caller,
        event: next ? (before ? 'EDIT' : 'CREATE') : 'CANCEL',
        entityType: COL.fundingSources,
        entityId: ref.id,
        entityRef: `${sectionLabel(next?.section ?? prior!.section)} - ${next?.particulars ?? prior?.particulars ?? ''}`,
        fiscalYear,
        fundCode,
        action: next ? 'CREATE' : 'CANCEL',
        newStatus: next ? 'RECORDED' : 'REMOVED',
        remarks: next
          ? `${(next.amount / 100).toFixed(2)}${next.actReference ? `, encoded in ${next.actReference}` : ', open on the Sources tab'}`
          : `Removed (was ${((prior?.amount ?? 0) / 100).toFixed(2)}).`,
      });

      return { id: ref.id, removed: !next };
    });
  },
);
