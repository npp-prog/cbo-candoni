import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, notFound, reporting, assertFundInScope, type Role } from '../lib/context';
import { recordTransition, auditInTransaction } from '../lib/audit';

/**
 * Cash in Bank: the entries only the bank originates.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY WILL NOT ACCEPT
 * ---------------------------------------------------------------------------
 * Checks, ADA and deposits are NOT keyed here. CFMS already holds them, and a
 * second copy typed into a bank book is the classic way two records of the
 * same payment come to disagree - the check is cancelled in one place and
 * stands in the other, and the reconciliation quietly absorbs the difference.
 *
 * The screen reads those from their own registers. What is keyed here is only
 * what the bank does on its own account: interest, charges, the withholding on
 * that interest, a national tax allotment landing, an error and its
 * correction. Those exist nowhere else in CFMS, which is the whole test for
 * whether something belongs in this file.
 *
 * ---------------------------------------------------------------------------
 * THE BUFFER IS NOT AN ENTRY
 * ---------------------------------------------------------------------------
 * It reduces what may be committed without being a movement. Posting it as a
 * line would mean reversing it to spend, and it would foot into the bank
 * reconciliation, where a figure the bank has never heard of does not belong.
 * So it lives on the ledger record beside the beginning balance.
 * ---------------------------------------------------------------------------
 */

const TREASURY_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF'];
const OPENING_ROLES: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'MUNICIPAL_ACCOUNTANT'];

const KINDS = [
  'DEPOSIT',
  'INTEREST',
  'NTA',
  'BANK_CHARGE',
  'INTEREST_WITHHELD',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
] as const;
type Kind = (typeof KINDS)[number];

const ledgerId = (fiscalYear: number, bankAccountId: string) => `${fiscalYear}__${bankAccountId}`;

const cents = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

async function loadBankAccount(bankAccountId: string) {
  const snap = await db.collection(COL.bankAccounts).doc(bankAccountId).get();
  if (!snap.exists) throw notFound('That bank account');
  return snap.data() as { bankName: string; accountNumber: string; fundCode: string };
}

// ---------------------------------------------------------------------------
// setBankLedgerOpening
// ---------------------------------------------------------------------------

export const setBankLedgerOpening = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Setting the opening balance', async () => {
      const caller = await requireCaller(request, OPENING_ROLES);
      const data = (request.data ?? {}) as {
        fiscalYear?: number;
        bankAccountId?: string;
        beginningBalance?: number;
        buffer?: number;
      };

      const fiscalYear = Number(data.fiscalYear);
      const bankAccountId = String(data.bankAccountId ?? '').trim();
      if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');
      if (!bankAccountId) throw invalid('Choose the bank account.');

      const bank = await loadBankAccount(bankAccountId);
      assertFundInScope(caller, bank.fundCode);

      const beginningBalance = cents(data.beginningBalance);
      const buffer = cents(data.buffer);
      if (buffer < 0) {
        throw invalid('A buffer is an amount held back, so it cannot be negative.');
      }

      const id = ledgerId(fiscalYear, bankAccountId);
      const now = new Date().toISOString();

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.bankLedgers).doc(id);
        const prior = await tx.get(ref);
        const before = prior.exists
          ? (prior.data() as { beginningBalance?: number; buffer?: number })
          : null;

        tx.set(
          ref,
          {
            fiscalYear,
            bankAccountId,
            fundCode: bank.fundCode,
            beginningBalance,
            buffer,
            updatedBy: { uid: caller.uid, name: caller.name, at: now },
            updatedAt: now,
          },
          { merge: true },
        );

        // Restating an opening balance moves every figure below it, so it is
        // logged with both numbers rather than only the new one.
        auditInTransaction(tx, {
          caller,
          event: before ? 'EDIT' : 'CREATE',
          entityType: COL.bankLedgers,
          entityId: id,
          entityRef: `${bank.bankName} ${bank.accountNumber}`,
          fiscalYear,
          fundCode: bank.fundCode,
          severity: before ? 'NOTICE' : 'INFO',
          changes: before
            ? [
                { field: 'beginningBalance', previous: before.beginningBalance ?? 0, next: beginningBalance },
                { field: 'buffer', previous: before.buffer ?? 0, next: buffer },
              ]
            : undefined,
        });
      });

      return { ledgerId: id };
    }),
);

// ---------------------------------------------------------------------------
// recordBankLedgerEntry
// ---------------------------------------------------------------------------

export const recordBankLedgerEntry = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Recording the bank entry', async () => {
      const caller = await requireCaller(request, TREASURY_ROLES);
      const data = (request.data ?? {}) as {
        fiscalYear?: number;
        bankAccountId?: string;
        entryDate?: string;
        kind?: string;
        referenceNo?: string;
        particulars?: string;
        amount?: number;
        remarks?: string;
      };

      const fiscalYear = Number(data.fiscalYear);
      const bankAccountId = String(data.bankAccountId ?? '').trim();
      if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');
      if (!bankAccountId) throw invalid('Choose the bank account.');

      const kind = String(data.kind ?? '') as Kind;
      if (!KINDS.includes(kind)) {
        throw invalid(
          `"${data.kind}" is not something this book records. Checks, ADA and deposits are read ` +
            'from their own registers and must not be keyed here.',
        );
      }

      const entryDate = String(data.entryDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
        throw invalid('A date in the form YYYY-MM-DD is required.');
      }

      const amount = cents(data.amount);
      if (amount <= 0) {
        throw invalid(
          'Enter the amount as a positive figure. Whether it adds to the balance or takes from ' +
            'it is decided by the kind of entry, not by a minus sign.',
        );
      }

      const particulars = String(data.particulars ?? '').trim();
      if (!particulars) throw invalid('Describe the entry, so the book can be read a year from now.');

      const bank = await loadBankAccount(bankAccountId);
      assertFundInScope(caller, bank.fundCode);

      const now = new Date().toISOString();
      const ref = db.collection(COL.bankLedgerEntries).doc();

      await db.runTransaction(async (tx) => {
        tx.create(ref, {
          fiscalYear,
          bankAccountId,
          fundCode: bank.fundCode,
          entryDate,
          kind,
          referenceNo: String(data.referenceNo ?? '').trim() || null,
          particulars,
          amount,
          remarks: String(data.remarks ?? '').trim() || null,
          voided: false,
          createdBy: { uid: caller.uid, name: caller.name, at: now },
          createdAt: now,
        });

        recordTransition(tx, {
          caller,
          entityType: COL.bankLedgerEntries,
          entityId: ref.id,
          entityRef: `${bank.bankName} ${bank.accountNumber} — ${kind}`,
          fiscalYear,
          fundCode: bank.fundCode,
          action: 'CREATE',
          newStatus: kind,
          event: 'CREATE',
          remarks: `${particulars} (₱${(amount / 100).toFixed(2)})`,
        });
      });

      return { entryId: ref.id };
    }),
);

// ---------------------------------------------------------------------------
// voidBankLedgerEntry
// ---------------------------------------------------------------------------

export const voidBankLedgerEntry = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) =>
    reporting('Voiding the entry', async () => {
      const caller = await requireCaller(request, TREASURY_ROLES);
      const data = (request.data ?? {}) as { entryId?: string; reason?: string };

      const entryId = String(data.entryId ?? '').trim();
      if (!entryId) throw invalid('Which entry should be voided?');
      const reason = String(data.reason ?? '').trim();
      if (reason.length < 10) {
        throw invalid('Give a reason of at least ten characters. It stays on the entry.');
      }

      await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.bankLedgerEntries).doc(entryId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound('That entry');

        const e = snap.data() as {
          voided?: boolean;
          fiscalYear: number;
          fundCode: string;
          kind: string;
          particulars: string;
        };
        if (e.voided) throw new HttpsError('failed-precondition', 'That entry is already void.');
        assertFundInScope(caller, e.fundCode);

        const now = new Date().toISOString();
        tx.update(ref, {
          voided: true,
          voidReason: reason,
          voidedBy: { uid: caller.uid, name: caller.name, at: now },
        });

        recordTransition(tx, {
          caller,
          entityType: COL.bankLedgerEntries,
          entityId: entryId,
          entityRef: `${e.kind} — ${e.particulars}`,
          fiscalYear: e.fiscalYear,
          fundCode: e.fundCode,
          action: 'CANCEL',
          previousStatus: e.kind,
          newStatus: 'VOID',
          event: 'CANCEL',
          remarks: reason,
          severity: 'NOTICE',
        });
      });

      return { entryId };
    }),
);
