import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, notFound, reporting, assertFundInScope, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';

/**
 * The primary report: the layer above the collector's own RCD.
 *
 * ---------------------------------------------------------------------------
 * THE TWO CONTROLS THAT JUSTIFY THIS FILE
 * ---------------------------------------------------------------------------
 * 1. A secondary RCD belongs to at most one primary. If the same collector's
 *    remittance could be gathered into two reports, the day's collections would
 *    appear twice in the cash position, and the second appearance would look
 *    exactly like a real one.
 *
 * 2. A collection primary is liquidated by at most one deposit. The same
 *    money cannot be banked twice, and a deposit that claims a day already
 *    claimed is either a mistake or the shape of a concealed shortage.
 *
 * Neither check can be written as a security rule, because both need to read
 * every other report for the fund before they can answer. So they live here,
 * inside the transaction that writes, and the collections are read once and
 * checked in memory rather than one query per line.
 *
 * ---------------------------------------------------------------------------
 * WHY CLOSING AND NOT SAVING IS THE EVENT
 * ---------------------------------------------------------------------------
 * A primary is edited freely while it is OPEN - collectors remit through the
 * afternoon and the list grows. Nothing downstream may depend on an open
 * report, because it is still changing. Closing is the officer's signature: it
 * draws the number, stamps the secondaries so they cannot be altered from under
 * it, and is the point at which the report becomes evidence.
 * ---------------------------------------------------------------------------
 */

const TREASURY_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF'];
const CLOSING_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER'];

type PrimaryType = 'COLLECTION' | 'CONSOLIDATED' | 'DEPOSIT';
const TYPES: PrimaryType[] = ['COLLECTION', 'CONSOLIDATED', 'DEPOSIT'];

interface PrimaryDoc {
  fiscalYear: number;
  fundCode: string;
  primaryNo?: string;
  reportDate: string;
  reportType: PrimaryType;
  accountableOfficerId: string;
  accountableOfficerName: string;
  rcdIds: string[];
  coveredPrimaryIds: string[];
  totalAmount: number;
  deposit?: {
    bankAccountId: string;
    bankName: string;
    bankAccountNumber: string;
    cash: number;
    checks: Array<{ checkNo: string; payor: string; amount: number }>;
    online: Array<{ referenceNo: string; particulars: string; amount: number }>;
    total: number;
  } | null;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  reopenedCount?: number;
}

const peso = (centavos: number) => `₱${(centavos / 100).toFixed(2)}`;

const cents = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** Every live primary for a fund and year, read once for the overlap checks. */
async function readLivePrimaries(
  tx: Transaction,
  fiscalYear: number,
  fundCode: string,
): Promise<Array<{ id: string; data: PrimaryDoc }>> {
  const snap = await tx.get(
    db
      .collection(COL.primaryReports)
      .where('fiscalYear', '==', fiscalYear)
      .where('fundCode', '==', fundCode),
  );
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() as PrimaryDoc }))
    .filter((p) => p.data.status !== 'CANCELLED');
}

// ---------------------------------------------------------------------------
// savePrimaryReport
// ---------------------------------------------------------------------------

export const savePrimaryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Saving the primary report', async () => {
      const caller = await requireCaller(request, TREASURY_ROLES);
      const data = (request.data ?? {}) as {
        primaryId?: string;
        fiscalYear?: number;
        fundCode?: string;
        reportDate?: string;
        reportType?: string;
        accountableOfficerId?: string;
        accountableOfficerName?: string;
        accountableOfficerPosition?: string;
        rcdIds?: string[];
        coveredPrimaryIds?: string[];
        deposit?: PrimaryDoc['deposit'];
        remarks?: string;
      };

      const fiscalYear = Number(data.fiscalYear);
      const fundCode = String(data.fundCode ?? '').trim();
      if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');
      if (!fundCode) throw invalid('A fund is required.');
      assertFundInScope(caller, fundCode);

      const reportType = String(data.reportType ?? '') as PrimaryType;
      if (!TYPES.includes(reportType)) throw invalid('Choose the kind of primary report.');

      const reportDate = String(data.reportDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
        throw invalid('A report date in the form YYYY-MM-DD is required.');
      }

      const officerId = String(data.accountableOfficerId ?? '').trim();
      const officerName = String(data.accountableOfficerName ?? '').trim();
      if (!officerId || !officerName) throw invalid('Choose the accountable officer.');

      const rcdIds = [...new Set((data.rcdIds ?? []).map(String).filter(Boolean))];
      const coveredPrimaryIds = [
        ...new Set((data.coveredPrimaryIds ?? []).map(String).filter(Boolean)),
      ];

      const result = await db.runTransaction(async (tx) => {
        const ref = data.primaryId
          ? db.collection(COL.primaryReports).doc(String(data.primaryId))
          : db.collection(COL.primaryReports).doc();

        const existing = data.primaryId ? await tx.get(ref) : null;
        if (data.primaryId && !existing?.exists) throw notFound('That primary report');
        if (existing?.exists && (existing.data() as PrimaryDoc).status !== 'OPEN') {
          throw new HttpsError(
            'failed-precondition',
            'This report has been closed. Reopen it before changing what it covers.',
          );
        }

        const others = (await readLivePrimaries(tx, fiscalYear, fundCode)).filter(
          (p) => p.id !== ref.id,
        );

        // -- Control 1: a secondary belongs to one primary ---------------
        let totalAmount = 0;
        if (reportType !== 'DEPOSIT') {
          if (rcdIds.length === 0) {
            throw invalid('Choose at least one report of collections to gather into this report.');
          }

          const claimed = new Map<string, string>();
          for (const p of others) {
            for (const id of p.data.rcdIds ?? []) {
              claimed.set(id, p.data.primaryNo ?? 'another open report');
            }
          }
          const clash = rcdIds.filter((id) => claimed.has(id));
          if (clash.length > 0) {
            throw new HttpsError(
              'failed-precondition',
              `${clash.length} of the reports chosen ${clash.length === 1 ? 'is' : 'are'} already ` +
                `covered by ${[...new Set(clash.map((id) => claimed.get(id)))].join(', ')}. ` +
                'A collector’s report belongs to one primary; gathering it twice would put the ' +
                'same collections into the cash position twice.',
            );
          }

          for (const id of rcdIds) {
            const snap = await tx.get(db.collection(COL.rcds).doc(id));
            if (!snap.exists) throw notFound(`Report of collections ${id}`);
            const r = snap.data() as {
              fundCode: string;
              fiscalYear: number;
              status: string;
              totalCollections: number;
              rcdNo?: string;
            };
            if (r.fundCode !== fundCode || r.fiscalYear !== fiscalYear) {
              throw new HttpsError(
                'failed-precondition',
                `${r.rcdNo ?? id} belongs to another fund or year and cannot be gathered here.`,
              );
            }
            if (r.status === 'CANCELLED') {
              throw new HttpsError('failed-precondition', `${r.rcdNo ?? id} is cancelled.`);
            }
            totalAmount += r.totalCollections ?? 0;
          }
        }

        // -- Control 2: a collection day is banked once ------------------
        let deposit: PrimaryDoc['deposit'] = null;
        if (reportType === 'DEPOSIT') {
          const d = data.deposit;
          if (!d || !d.bankAccountId) throw invalid('Choose the bank account the money was deposited to.');

          const checks = (d.checks ?? []).filter((c) => c.checkNo?.trim() && cents(c.amount) > 0);
          const online = (d.online ?? []).filter((o) => o.referenceNo?.trim() && cents(o.amount) > 0);
          const cash = cents(d.cash);
          const total = cash + checks.reduce((s, c) => s + cents(c.amount), 0) +
            online.reduce((s, o) => s + cents(o.amount), 0);

          if (total <= 0) {
            throw invalid('Enter a cash amount, at least one check, or an online receipt.');
          }

          const claimedBy = new Map<string, string>();
          for (const p of others) {
            if (p.data.reportType !== 'DEPOSIT') continue;
            for (const id of p.data.coveredPrimaryIds ?? []) {
              claimedBy.set(id, p.data.primaryNo ?? 'another deposit');
            }
          }
          const clash = coveredPrimaryIds.filter((id) => claimedBy.has(id));
          if (clash.length > 0) {
            throw new HttpsError(
              'failed-precondition',
              `${clash.length} of the collection reports chosen ${clash.length === 1 ? 'is' : 'are'} ` +
                `already liquidated by ${[...new Set(clash.map((id) => claimedBy.get(id)))].join(', ')}. ` +
                'The same collections cannot be banked twice.',
            );
          }

          deposit = {
            bankAccountId: String(d.bankAccountId),
            bankName: String(d.bankName ?? ''),
            bankAccountNumber: String(d.bankAccountNumber ?? ''),
            cash,
            checks: checks.map((c) => ({
              checkNo: String(c.checkNo).trim(),
              payor: String(c.payor ?? '').trim(),
              amount: cents(c.amount),
            })),
            online: online.map((o) => ({
              referenceNo: String(o.referenceNo).trim(),
              particulars: String(o.particulars ?? '').trim(),
              amount: cents(o.amount),
            })),
            total,
          };
          totalAmount = total;
        }

        const now = new Date().toISOString();
        const doc = {
          fiscalYear,
          fundCode,
          reportDate,
          reportType,
          accountableOfficerId: officerId,
          accountableOfficerName: officerName,
          accountableOfficerPosition: String(data.accountableOfficerPosition ?? '').trim() || null,
          rcdIds: reportType === 'DEPOSIT' ? [] : rcdIds,
          coveredPrimaryIds: reportType === 'DEPOSIT' ? coveredPrimaryIds : [],
          totalAmount,
          deposit,
          status: 'OPEN' as const,
          remarks: String(data.remarks ?? '').trim() || null,
          ...(existing?.exists
            ? { updatedBy: { uid: caller.uid, name: caller.name, at: now } }
            : {
                reopenedCount: 0,
                createdBy: { uid: caller.uid, name: caller.name, at: now },
                createdAt: now,
              }),
        };

        tx.set(ref, doc, { merge: true });

        recordTransition(tx, {
          caller,
          entityType: COL.primaryReports,
          entityId: ref.id,
          entityRef: `Primary report, ${reportDate}`,
          fiscalYear,
          fundCode,
          action: 'CREATE',
          newStatus: 'OPEN',
          event: existing?.exists ? 'EDIT' : 'CREATE',
          remarks: `${reportType}, ${peso(totalAmount)}`,
        });

        return { primaryId: ref.id, totalAmount };
      });

      return result;
    }),
);

// ---------------------------------------------------------------------------
// closePrimaryReport
// ---------------------------------------------------------------------------

export const closePrimaryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Closing the primary report', async () => {
      const caller = await requireCaller(request, CLOSING_ROLES);
      const primaryId = String((request.data ?? {}).primaryId ?? '').trim();
      if (!primaryId) throw invalid('Which report should be closed?');

      const cfg = await loadNumberingConfig('PRN');

      const primaryNo = await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.primaryReports).doc(primaryId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That primary report');

        const p = snap.data() as PrimaryDoc;
        if (p.status !== 'OPEN') {
          throw new HttpsError('failed-precondition', `This report is already ${p.status.toLowerCase()}.`);
        }
        assertFundInScope(caller, p.fundCode);

        // Read the secondaries before writing anything.
        const rcdSnaps = await Promise.all(
          (p.rcdIds ?? []).map((id) => tx.get(db.collection(COL.rcds).doc(id))),
        );

        const bookCode = await bookCodeForFund(p.fundCode);
        const month = Number(p.reportDate.slice(5, 7));
        const number = await issueNumber(tx, cfg, {
          bookCode,
          fundCode: p.fundCode,
          fiscalYear: p.fiscalYear,
          month,
        });

        const now = new Date().toISOString();
        tx.update(ref, {
          primaryNo: number,
          status: 'CLOSED',
          closedBy: { uid: caller.uid, name: caller.name, at: now },
        });

        // Stamp the secondaries so they cannot be altered from under the
        // report that now accounts for them.
        for (const s of rcdSnaps) {
          if (!s.exists) continue;
          tx.update(s.ref, { primaryReportId: primaryId, primaryReportNo: number });
        }

        recordTransition(tx, {
          caller,
          entityType: COL.primaryReports,
          entityId: primaryId,
          entityRef: `Primary ${number}`,
          fiscalYear: p.fiscalYear,
          fundCode: p.fundCode,
          action: 'CERTIFY',
          previousStatus: 'OPEN',
          newStatus: 'CLOSED',
          event: 'CERTIFY',
          remarks: `${p.reportType}, ${peso(p.totalAmount)}, ${rcdSnaps.length} report(s) covered`,
        });

        return number;
      });

      return { primaryId, primaryNo };
    }),
);

// ---------------------------------------------------------------------------
// reopenPrimaryReport
// ---------------------------------------------------------------------------

export const reopenPrimaryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Reopening the primary report', async () => {
      const caller = await requireCaller(request, CLOSING_ROLES);
      const data = (request.data ?? {}) as { primaryId?: string; reason?: string };

      const primaryId = String(data.primaryId ?? '').trim();
      if (!primaryId) throw invalid('Which report should be reopened?');
      const reason = String(data.reason ?? '').trim();
      if (reason.length < 15) {
        throw invalid(
          'Give a reason of at least fifteen characters. It stays on the report and is counted.',
        );
      }

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.primaryReports).doc(primaryId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That primary report');

        const p = snap.data() as PrimaryDoc;
        if (p.status !== 'CLOSED') {
          throw new HttpsError('failed-precondition', 'Only a closed report can be reopened.');
        }
        assertFundInScope(caller, p.fundCode);

        const rcdSnaps = await Promise.all(
          (p.rcdIds ?? []).map((id) => tx.get(db.collection(COL.rcds).doc(id))),
        );

        const now = new Date().toISOString();
        // The number is kept. A reopened report that came back with a new
        // number would leave a hole in the series that nobody could explain.
        tx.update(ref, {
          status: 'OPEN',
          reopenedCount: (p.reopenedCount ?? 0) + 1,
          lastReopenReason: reason,
          reopenedBy: { uid: caller.uid, name: caller.name, at: now },
        });

        for (const s of rcdSnaps) {
          if (!s.exists) continue;
          tx.update(s.ref, { primaryReportId: null, primaryReportNo: null });
        }

        recordTransition(tx, {
          caller,
          entityType: COL.primaryReports,
          entityId: primaryId,
          entityRef: `Primary ${p.primaryNo ?? primaryId}`,
          fiscalYear: p.fiscalYear,
          fundCode: p.fundCode,
          action: 'REOPEN',
          previousStatus: 'CLOSED',
          newStatus: 'OPEN',
          event: 'PERIOD_REOPEN',
          remarks: reason,
          severity: 'CRITICAL',
        });
      });

      return { primaryId };
    }),
);

// ---------------------------------------------------------------------------
// cancelPrimaryReport
// ---------------------------------------------------------------------------

export const cancelPrimaryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Cancelling the primary report', async () => {
      const caller = await requireCaller(request, CLOSING_ROLES);
      const data = (request.data ?? {}) as { primaryId?: string; reason?: string };

      const primaryId = String(data.primaryId ?? '').trim();
      if (!primaryId) throw invalid('Which report should be cancelled?');
      const reason = String(data.reason ?? '').trim();
      if (reason.length < 10) {
        throw invalid('Give a reason of at least ten characters. It stays on the report.');
      }

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.primaryReports).doc(primaryId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That primary report');

        const p = snap.data() as PrimaryDoc;
        if (p.status === 'CANCELLED') {
          throw new HttpsError('failed-precondition', 'That report is already cancelled.');
        }
        assertFundInScope(caller, p.fundCode);

        const rcdSnaps = await Promise.all(
          (p.rcdIds ?? []).map((id) => tx.get(db.collection(COL.rcds).doc(id))),
        );

        const now = new Date().toISOString();
        tx.update(ref, {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledBy: { uid: caller.uid, name: caller.name, at: now },
        });

        for (const s of rcdSnaps) {
          if (!s.exists) continue;
          tx.update(s.ref, { primaryReportId: null, primaryReportNo: null });
        }

        recordTransition(tx, {
          caller,
          entityType: COL.primaryReports,
          entityId: primaryId,
          entityRef: `Primary ${p.primaryNo ?? primaryId}`,
          fiscalYear: p.fiscalYear,
          fundCode: p.fundCode,
          action: 'CANCEL',
          previousStatus: p.status,
          newStatus: 'CANCELLED',
          event: 'CANCEL',
          remarks: reason,
          severity: 'NOTICE',
        });
      });

      return { primaryId };
    }),
);
