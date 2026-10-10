import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, notFound, invalid, type Role } from '../lib/context';
import { matchECollectionCredit } from '../lib/eCollectionMatch';
import { recordTransition } from '../lib/audit';
import { ledgerBalance } from '../lib/ledger';
import { computeReconciliation, checkReconciliationFinalizable } from '../lib/rules';
import { periodOf } from '../lib/period';

const RECONCILERS: Role[] = [
  'SUPER_ADMIN',
  'MUNICIPAL_ACCOUNTANT',
  'ACCOUNTING_REVIEWER',
  'MUNICIPAL_TREASURER',
  'TREASURY_STAFF',
];

const FINALIZERS: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

interface StatementRow {
  transactionDate: string;
  postingDate?: string;
  referenceNo?: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance?: number;
}

/**
 * importBankStatement - ingests parsed statement rows.
 *
 * The file itself (CSV or XLSX) is parsed in the browser, because bank formats
 * vary wildly and a human needs to map the columns interactively. What is NOT
 * left to the browser is duplicate detection: re-importing the same statement
 * is the single most common mistake in bank reconciliation, and it silently
 * doubles every figure. A content fingerprint per row is computed here, and a
 * row whose fingerprint already exists for this bank account is skipped.
 */
export const importBankStatement = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK, timeoutSeconds: 300 },
  async (request) => {
    const caller = await requireCaller(request, RECONCILERS);
    const { bankAccountId, statementDate, rows } = (request.data ?? {}) as {
      bankAccountId?: string;
      statementDate?: string;
      rows?: StatementRow[];
    };

    if (!bankAccountId || !statementDate) {
      throw invalid('A bank account and statement date are required.');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw invalid('The statement contains no rows.');
    }
    if (rows.length > 5000) {
      throw invalid('That statement has more than 5,000 rows. Split it by month and import each part.');
    }

    const bankSnap = await db.collection(COL.bankAccounts).doc(bankAccountId).get();
    if (!bankSnap.exists) throw notFound('The bank account');
    const bank = bankSnap.data() as { fundCode: string; bankName: string };

    const fiscalYear = Number(statementDate.slice(0, 4));

    // Fingerprint existing rows for this account so a re-import is a no-op
    // rather than a duplication.
    const existingSnap = await db
      .collection(COL.bankTransactions)
      .where('bankAccountId', '==', bankAccountId)
      .where('fiscalYear', '==', fiscalYear)
      .get();

    const seen = new Set(existingSnap.docs.map((d) => d.data().fingerprint as string));

    const batchId = db.collection(COL.importBatches).doc().id;
    const now = new Date().toISOString();

    let imported = 0;
    let duplicatesSkipped = 0;

    // Firestore caps a write batch at 500 operations.
    const chunks: StatementRow[][] = [];
    for (let i = 0; i < rows.length; i += 400) chunks.push(rows.slice(i, i + 400));

    for (const chunk of chunks) {
      const batch = db.batch();
      for (const row of chunk) {
        const fingerprint = rowFingerprint(bankAccountId, row);
        if (seen.has(fingerprint)) {
          duplicatesSkipped++;
          continue;
        }
        seen.add(fingerprint);

        const ref = db.collection(COL.bankTransactions).doc();
        batch.create(ref, {
          fiscalYear,
          fundCode: bank.fundCode,
          bankAccountId,
          transactionDate: row.transactionDate,
          postingDate: row.postingDate ?? null,
          referenceNo: row.referenceNo ?? null,
          description: row.description,
          debit: row.debit ?? 0,
          credit: row.credit ?? 0,
          runningBalance: row.runningBalance ?? null,
          matchStatus: 'UNMATCHED',
          importBatchId: batchId,
          fingerprint,
          importedAt: now,
        });
        imported++;
      }
      await batch.commit();
    }

    await db.collection(COL.importBatches).doc(batchId).set({
      bankAccountId,
      bankName: bank.bankName,
      fundCode: bank.fundCode,
      fiscalYear,
      statementDate,
      rowsSubmitted: rows.length,
      imported,
      duplicatesSkipped,
      importedAt: now,
      importedBy: { uid: caller.uid, name: caller.name, at: now },
    });

    await db.collection(COL.auditLogs).add({
      at: now,
      actorUid: caller.uid,
      actorName: caller.name,
      actorRoles: caller.roles,
      ipAddress: caller.ip ?? null,
      event: 'UPLOAD',
      entityType: COL.importBatches,
      entityId: batchId,
      entityRef: `Bank statement ${bank.bankName} ${statementDate}`,
      fiscalYear,
      fundCode: bank.fundCode,
      remarks: `${imported} rows imported, ${duplicatesSkipped} duplicates skipped of ${rows.length} submitted.`,
      severity: 'INFO',
    });

    return { importBatchId: batchId, imported, duplicatesSkipped };
  },
);

/**
 * A row's identity, for duplicate detection. Date + reference + amounts +
 * description is enough to distinguish genuine same-day same-amount
 * transactions (which do happen - two identical fees) from a re-import,
 * because a re-import reproduces the description byte for byte.
 */
function rowFingerprint(bankAccountId: string, row: StatementRow): string {
  const raw = [
    bankAccountId,
    row.transactionDate,
    row.referenceNo ?? '',
    row.debit ?? 0,
    row.credit ?? 0,
    (row.description ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
  ].join('|');

  // A short non-cryptographic digest is sufficient: this guards against
  // accidental duplication, not against an adversary.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/**
 * autoMatchBankTransactions - proposes matches between statement lines and
 * recorded checks, ADA and deposits.
 *
 * Matching is graded, and nothing is ever auto-confirmed on a weak signal:
 *
 *   check number found in the description + exact amount  -> MATCHED
 *   RADAI bank ref / number + posted amount (patch 146)   -> MATCHED
 *   RADAI posted amount within 10 days                    -> SUGGESTED
 *   ADA reference + exact amount (less not posted)        -> MATCHED
 *   deposit slip number + exact amount                    -> MATCHED
 *   e-collection / eRCD (patch 159, see below)             -> MATCHED
 *   exact amount within 5 days, single candidate          -> SUGGESTED
 *   exact amount, several candidates                      -> SUGGESTED (first)
 *   otherwise                                             -> UNMATCHED
 *
 * A SUGGESTED match waits for a human. Auto-confirming a same-amount
 * coincidence is how a reconciliation ends up balanced and wrong.
 */
export const autoMatchBankTransactions = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK, timeoutSeconds: 300 },
  async (request) => {
    const caller = await requireCaller(request, RECONCILERS);
    const { bankAccountId, reconciliationId } = (request.data ?? {}) as {
      bankAccountId?: string;
      reconciliationId?: string;
    };
    if (!bankAccountId) throw invalid('A bank account is required.');

    const [txSnap, checkSnap, adaSnap, depositSnap, radaiSnap, ercdSnap] = await Promise.all([
      db
        .collection(COL.bankTransactions)
        .where('bankAccountId', '==', bankAccountId)
        .where('matchStatus', '==', 'UNMATCHED')
        .get(),
      db
        .collection(COL.checks)
        .where('bankAccountId', '==', bankAccountId)
        .where('status', 'in', ['RELEASED', 'SIGNED', 'PREPARED'])
        .get(),
      db
        .collection(COL.ada)
        .where('bankAccountId', '==', bankAccountId)
        .where('status', 'in', ['SUBMITTED', 'PREPARED'])
        .get(),
      db
        .collection(COL.deposits)
        .where('bankAccountId', '==', bankAccountId)
        .where('status', 'in', ['IN_TRANSIT', 'RECORDED'])
        .get(),
      // Patch 146: the RADAIs posted online, matched at their POSTED amount.
      db
        .collection(COL.treasuryReports)
        .where('bankAccountId', '==', bankAccountId)
        .where('reportType', '==', 'RADAI')
        .get(),
      // Patch 159: the e-collection reports credited to this account.
      db.collection(COL.treasuryReports).where('bankAccountId', '==', bankAccountId).get(),
    ]);

    const checks = checkSnap.docs.map((d) => ({
      id: d.id,
      checkNo: (d.data().checkNo as string) ?? '',
      amount: (d.data().netAmount as number) ?? 0,
      date: (d.data().checkDate as string) ?? '',
      payeeName: (d.data().payeeName as string) ?? '',
    }));
    /*
     * Patch 146: an advice is matched at what the bank POSTED - its amount
     * less the credits the bank did not post (taken up as trust liabilities).
     */
    const adas = adaSnap.docs.map((d) => ({
      id: d.id,
      adaNo: (d.data().adaNo as string) ?? '',
      amount: ((d.data().amount as number) ?? 0) - ((d.data().notPostedAmount as number) ?? 0),
      date: (d.data().adaDate as string) ?? '',
      payeeName: (d.data().payeeName as string) ?? '',
    }));
    /*
     * Patch 146: the bank posts a RADAI's file as one debit, so the RADAI is
     * matched as a whole at its POSTED amount - the report total less the
     * credits not posted - by its bank reference or number, or by amount and
     * date. Only RADAIs posted online and not yet matched.
     */
    const radais = radaiSnap.docs
      .map((d) => ({
        id: d.id,
        reportNo: (d.data().reportNo as string) ?? '',
        bankRef: (d.data().bankReferenceNo as string) ?? '',
        amount: ((d.data().totalAmount as number) ?? 0) - ((d.data().notPostedAmount as number) ?? 0),
        date: (d.data().postedOnlineDate as string) ?? '',
        posted: Boolean(d.data().postedOnlineAt),
        debited: Boolean(d.data().bankDebitedAt),
        status: (d.data().status as string) ?? '',
      }))
      .filter((r) => r.posted && !r.debited && r.status !== 'CANCELLED' && r.amount > 0);
    const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const deposits = depositSnap.docs.map((d) => ({
      id: d.id,
      slipNo: (d.data().depositSlipNo as string) ?? '',
      amount: (d.data().amount as number) ?? 0,
      date: (d.data().depositDate as string) ?? '',
    }));

    /*
     * Patch 159 - E-COLLECTIONS, MATCHED AUTOMATICALLY.
     *
     * An e-collection is credited by the bank itself - the payor paid the
     * account, or the intermediary remitted to it - and the eRCD that reports
     * it debits Cash in Bank directly (patch 156). So its credit on the
     * statement is matched to the e-collection, or to the eRCD as a whole when
     * the intermediary remitted the batch as one credit:
     *
     *   receipt number in the statement text + exact amount   -> MATCHED
     *   eRCD number in the text + the eRCD's total             -> MATCHED
     *   the only e-collection of that amount within 5 days     -> MATCHED
     *   the only eRCD of that total within 5 days              -> MATCHED
     *   several of the same amount within 5 days               -> SUGGESTED
     *
     * Only certified or journalized eRCDs not yet matched; each e-collection
     * and each eRCD is matched to one statement line at most.
     */
    const E_REPORTS = new Set(['ERCD_AR', 'ERCD_EOR', 'ERCD_DIRECT']);
    const ercds = ercdSnap.docs
      .map((d) => ({ ...(d.data() as Record<string, unknown>), id: d.id }) as Record<string, unknown> & { id: string })
      .filter(
        (r) =>
          E_REPORTS.has(String(r.reportType)) &&
          (r.status === 'CERTIFIED' || r.status === 'JOURNALIZED') &&
          !r.bankCreditedAt,
      )
      .map((r) => ({
        id: r.id,
        reportNo: String(r.reportNo ?? ''),
        date: String(r.reportDate ?? ''),
        amount: Number(r.totalAmount ?? 0),
        lines: ((r.lines ?? []) as Array<{
          sourceId: string;
          sourceNo: string;
          date: string;
          amount: number;
          excluded?: boolean;
          bankTransactionId?: string;
        }>).filter((l) => !l.excluded),
      }));
    const usedE = new Set<string>();

    let matched = 0;
    let suggested = 0;
    let unmatched = 0;

    const batch = db.batch();

    for (const doc of txSnap.docs) {
      const t = doc.data() as {
        description: string;
        referenceNo?: string;
        debit: number;
        credit: number;
        transactionDate: string;
      };
      const haystack = `${t.description} ${t.referenceNo ?? ''}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const isWithdrawal = (t.debit ?? 0) > 0;
      const amount = isWithdrawal ? t.debit : t.credit;

      let result:
        | { status: string; type: string; id: string; ref: string; method: string; confidence: number }
        | null = null;

      if (isWithdrawal) {
        // Strong: check number appears in the statement text and amount agrees.
        const byNumber = checks.find(
          (c) => c.checkNo && haystack.includes(c.checkNo.replace(/[^A-Z0-9]/g, '')) && c.amount === amount,
        );
        if (byNumber) {
          result = {
            status: 'MATCHED',
            type: 'CHECK',
            id: byNumber.id,
            ref: byNumber.checkNo,
            method: 'CHECK_NO',
            confidence: 1,
          };
        }

        if (!result) {
          const byRadai = radais.find(
            (r) =>
              r.amount === amount &&
              ((r.bankRef && haystack.includes(norm(r.bankRef))) ||
                (r.reportNo && haystack.includes(norm(r.reportNo)))),
          );
          if (byRadai) {
            result = {
              status: 'MATCHED',
              type: 'RADAI',
              id: byRadai.id,
              ref: byRadai.reportNo,
              method: 'RADAI_REF',
              confidence: 1,
            };
          }
        }

        if (!result) {
          const candidates = radais.filter(
            (r) => r.amount === amount && withinDays(r.date, t.transactionDate, 10),
          );
          if (candidates.length > 0) {
            result = {
              status: 'SUGGESTED',
              type: 'RADAI',
              id: candidates[0].id,
              ref: candidates[0].reportNo,
              method: 'AMOUNT_DATE',
              confidence: candidates.length === 1 ? 0.75 : 0.4,
            };
          }
        }

        if (!result) {
          const byAda = adas.find(
            (a) => a.adaNo && haystack.includes(a.adaNo.replace(/[^A-Z0-9]/g, '')) && a.amount === amount,
          );
          if (byAda) {
            result = {
              status: 'MATCHED',
              type: 'ADA',
              id: byAda.id,
              ref: byAda.adaNo,
              method: 'ADA_NO',
              confidence: 1,
            };
          }
        }

        if (!result) {
          const candidates = checks.filter(
            (c) => c.amount === amount && withinDays(c.date, t.transactionDate, 10),
          );
          if (candidates.length > 0) {
            result = {
              status: 'SUGGESTED',
              type: 'CHECK',
              id: candidates[0].id,
              ref: candidates[0].checkNo,
              method: 'AMOUNT_DATE',
              confidence: candidates.length === 1 ? 0.7 : 0.4,
            };
          }
        }
      } else {
        const bySlip = deposits.find(
          (d) => d.slipNo && haystack.includes(d.slipNo.replace(/[^A-Z0-9]/g, '')) && d.amount === amount,
        );
        if (bySlip) {
          result = {
            status: 'MATCHED',
            type: 'DEPOSIT',
            id: bySlip.id,
            ref: bySlip.slipNo,
            method: 'DEPOSIT_REF',
            confidence: 1,
          };
        }

        // ---- patch 159: e-collections (lib/eCollectionMatch.ts) ---------
        if (!result) {
          result = matchECollectionCredit(
            { text: haystack, amount, date: t.transactionDate },
            ercds,
            usedE,
          );
        }

        if (!result) {
          const candidates = deposits.filter(
            (d) => d.amount === amount && withinDays(d.date, t.transactionDate, 5),
          );
          if (candidates.length > 0) {
            result = {
              status: 'SUGGESTED',
              type: 'DEPOSIT',
              id: candidates[0].id,
              ref: candidates[0].slipNo,
              method: 'AMOUNT_DATE',
              confidence: candidates.length === 1 ? 0.75 : 0.4,
            };
          }
        }

        // Bank-originated credits that will never match a municipal document.
        if (!result && /INTEREST|CREDIT MEMO|INT\.?\s?EARNED/i.test(t.description)) {
          result = {
            status: 'INTEREST_INCOME',
            type: 'OTHER',
            id: '',
            ref: '',
            method: 'MANUAL',
            confidence: 0.6,
          };
        }
      }

      if (!result && isWithdrawal && /SERVICE CHARGE|BANK CHARGE|DEBIT MEMO|FEE|DST/i.test(t.description)) {
        result = { status: 'BANK_CHARGE', type: 'OTHER', id: '', ref: '', method: 'MANUAL', confidence: 0.6 };
      }

      if (result) {
        batch.update(doc.ref, {
          matchStatus: result.status,
          matchedType: result.type === 'OTHER' ? null : result.type,
          matchedId: result.id || null,
          matchedRef: result.ref || null,
          matchMethod: result.method,
          matchConfidence: result.confidence,
          reconciliationId: reconciliationId ?? null,
        });
        if (result.status === 'MATCHED') matched++;
        else if (result.status === 'SUGGESTED') suggested++;
        else unmatched++;
      } else {
        unmatched++;
      }
    }

    await batch.commit();

    await db.collection(COL.auditLogs).add({
      at: new Date().toISOString(),
      actorUid: caller.uid,
      actorName: caller.name,
      actorRoles: caller.roles,
      event: 'EDIT',
      entityType: COL.bankReconciliations,
      entityId: reconciliationId ?? null,
      entityRef: 'Automatic bank matching',
      remarks: `${matched} matched, ${suggested} suggested for review, ${unmatched} unmatched.`,
      severity: 'INFO',
    });

    return { matched, suggested, unmatched };
  },
);

function withinDays(a: string, b: string, days: number): boolean {
  const t1 = Date.parse(`${a}T00:00:00Z`);
  const t2 = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return false;
  return Math.abs(t1 - t2) <= days * 86_400_000;
}

/**
 * finalizeReconciliation - closes a bank reconciliation.
 *
 * Two things make this meaningful rather than ceremonial:
 *
 *   1. The book balance is re-read from the General Ledger, here, at
 *      finalisation. A reconciliation built against a hand-typed book balance
 *      proves nothing at all - it reconciles the bank to a number somebody
 *      chose.
 *
 *   2. The difference must be exactly zero. Not "within tolerance", not
 *      "immaterial". A one-centavo difference is a real error somewhere, and
 *      the discipline of chasing it is what keeps the books trustworthy.
 */
export const finalizeReconciliation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, FINALIZERS);
    const { reconciliationId } = (request.data ?? {}) as { reconciliationId?: string };
    if (!reconciliationId) throw invalid('A reconciliation id is required.');

    const ref = db.collection(COL.bankReconciliations).doc(reconciliationId);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('The bank reconciliation');

    const rec = snap.data() as {
      fiscalYear: number;
      fundCode: string;
      bankAccountId: string;
      bankName: string;
      statementDate: string;
      balancePerBank: number;
      depositsInTransit: number;
      outstandingChecks: number;
      bankAdjustments: number;
      bookAdjustments: number;
      adjustments: Array<{ side: string; kind: string; amount: number; jevId?: string; description: string }>;
      status: string;
    };

    if (rec.status === 'FINALIZED') {
      throw new HttpsError('failed-precondition', 'This reconciliation has already been finalised.');
    }

    // Every book-side adjustment must already be journalised. Otherwise the
    // reconciliation "balances" against an adjustment that exists only on the
    // reconciliation sheet and never reached the ledger.
    const unjournalised = (rec.adjustments ?? []).filter((a) => a.side === 'BOOK' && !a.jevId);
    if (unjournalised.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        `${unjournalised.length} book adjustment(s) have not been journalised: ${unjournalised
          .map((a) => a.description)
          .join('; ')}. Post the journal entries first, so the ledger reflects what this reconciliation asserts.`,
        { unjournalised },
      );
    }

    const bankSnap = await db.collection(COL.bankAccounts).doc(rec.bankAccountId).get();
    if (!bankSnap.exists) throw notFound('The bank account');
    const glAccountCode = bankSnap.data()?.glAccountCode as string;

    // The book balance comes from the ledger, not from the document.
    const balancePerBooks = await ledgerBalance({
      fiscalYear: rec.fiscalYear,
      fundCode: rec.fundCode,
      accountCode: glAccountCode,
      throughPeriod: periodOf(rec.statementDate),
    });

    const totals = computeReconciliation({
      balancePerBank: rec.balancePerBank,
      depositsInTransit: rec.depositsInTransit,
      outstandingChecks: rec.outstandingChecks,
      bankAdjustments: rec.bankAdjustments,
      balancePerBooks,
      bookAdjustments: rec.bookAdjustments,
    });

    const check = checkReconciliationFinalizable({
      balancePerBank: rec.balancePerBank,
      depositsInTransit: rec.depositsInTransit,
      outstandingChecks: rec.outstandingChecks,
      bankAdjustments: rec.bankAdjustments,
      balancePerBooks,
      bookAdjustments: rec.bookAdjustments,
    });

    if (!check.ok) {
      // Write the recomputed figures back even on failure, so the user sees
      // the real book balance rather than the stale one they were working from.
      await ref.update({
        balancePerBooks,
        adjustedBankBalance: totals.adjustedBankBalance,
        adjustedBookBalance: totals.adjustedBookBalance,
        difference: totals.difference,
      });
      throw new HttpsError('failed-precondition', check.violations[0].message, {
        ...totals,
        balancePerBooks,
      });
    }

    const now = new Date().toISOString();

    await db.runTransaction(async (tx) => {
      tx.update(ref, {
        balancePerBooks,
        adjustedBankBalance: totals.adjustedBankBalance,
        adjustedBookBalance: totals.adjustedBookBalance,
        difference: 0,
        status: 'FINALIZED',
        finalizedAt: now,
        approvedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
      });

      tx.set(
        db.collection(COL.cashPositions).doc(`${rec.fiscalYear}__${rec.bankAccountId}`),
        {
          fiscalYear: rec.fiscalYear,
          fundCode: rec.fundCode,
          bankAccountId: rec.bankAccountId,
          bankName: rec.bankName,
          glAccountCode,
          bookBalance: balancePerBooks,
          lastBankBalance: rec.balancePerBank,
          lastReconciledOn: rec.statementDate,
          updatedAt: now,
        },
        { merge: true },
      );

      recordTransition(tx, {
        caller,
        event: 'APPROVE',
        entityType: COL.bankReconciliations,
        entityId: reconciliationId,
        entityRef: `Bank reconciliation ${rec.bankName} ${rec.statementDate}`,
        fiscalYear: rec.fiscalYear,
        fundCode: rec.fundCode,
        action: 'APPROVE',
        previousStatus: rec.status,
        newStatus: 'FINALIZED',
        remarks: `Adjusted balances agree at ${(totals.adjustedBankBalance / 100).toFixed(2)}.`,
        severity: 'NOTICE',
      });
    });

    // Mark the matched items as cleared, outside the reconciliation
    // transaction: these are consequences of the reconciliation, and a partial
    // failure here leaves the reconciliation valid and the sweep re-runnable.
    const matchedTx = await db
      .collection(COL.bankTransactions)
      .where('reconciliationId', '==', reconciliationId)
      .where('matchStatus', '==', 'MATCHED')
      .get();

    const clearBatch = db.batch();
    for (const doc of matchedTx.docs) {
      const d = doc.data();
      if (d.matchedType === 'CHECK' && d.matchedId) {
        clearBatch.update(db.collection(COL.checks).doc(d.matchedId as string), {
          status: 'CLEARED',
          clearedDate: d.transactionDate,
          bankTransactionId: doc.id,
        });
      }
      if (d.matchedType === 'ADA' && d.matchedId) {
        clearBatch.update(db.collection(COL.ada).doc(d.matchedId as string), {
          status: 'DEBITED',
          dateDebited: d.transactionDate,
          bankTransactionId: doc.id,
        });
      }
      // Patch 146: a RADAI matched as one debit clears every advice on it.
      if (d.matchedType === 'RADAI' && d.matchedId) {
        const reportRef = db.collection(COL.treasuryReports).doc(d.matchedId as string);
        const report = await reportRef.get();
        clearBatch.update(reportRef, {
          bankDebitedAt: d.transactionDate,
          bankTransactionId: doc.id,
        });
        const lines = (report.data()?.lines ?? []) as Array<{ sourceId: string; excluded?: boolean }>;
        for (const l of lines.filter((x) => !x.excluded)) {
          clearBatch.update(db.collection(COL.ada).doc(l.sourceId), {
            status: 'DEBITED',
            dateDebited: d.transactionDate,
            bankTransactionId: doc.id,
          });
        }
      }
      // Patch 159: an e-collection, or an eRCD credited as one batch.
      if (d.matchedType === 'COLLECTION' && d.matchedId) {
        clearBatch.update(db.collection(COL.collections).doc(d.matchedId as string), {
          bankCreditedDate: d.transactionDate,
          bankTransactionId: doc.id,
        });
      }
      if (d.matchedType === 'ERCD' && d.matchedId) {
        const reportRef = db.collection(COL.treasuryReports).doc(d.matchedId as string);
        const report = await reportRef.get();
        clearBatch.update(reportRef, {
          bankCreditedAt: d.transactionDate,
          bankTransactionId: doc.id,
        });
        const lines = (report.data()?.lines ?? []) as Array<{ sourceId: string; excluded?: boolean }>;
        for (const l of lines.filter((x) => !x.excluded)) {
          clearBatch.update(db.collection(COL.collections).doc(l.sourceId), {
            bankCreditedDate: d.transactionDate,
            bankTransactionId: doc.id,
          });
        }
      }
      if (d.matchedType === 'DEPOSIT' && d.matchedId) {
        clearBatch.update(db.collection(COL.deposits).doc(d.matchedId as string), {
          status: 'CREDITED',
          creditedDate: d.transactionDate,
          bankTransactionId: doc.id,
        });
      }
    }
    await clearBatch.commit();

    return { reconciliationId, difference: 0 };
  },
);
