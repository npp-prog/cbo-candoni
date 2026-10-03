import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, type Role } from '../lib/context';
import { audit } from '../lib/audit';
import { checkChart, deriveAccount, type ChartRowInput } from '../lib/chartOfAccounts';

/**
 * importChartOfAccounts — load the Revised Chart of Accounts.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER DERIVES RATHER THAN ACCEPTS
 * ---------------------------------------------------------------------------
 * The caller sends a code and a title per row and NOTHING ELSE. Every
 * classification - account class, normal balance, statement classification,
 * cash flow, expense class, whether the account may be posted to - is derived
 * here from the code, by the same vendored rules the screen previewed with.
 *
 * Accepting the classifications from the browser would make the chart's
 * treatment of an account a thing the client decided, and the chart is what
 * every report in the system reads. A tampered or simply stale client could
 * load "Accumulated Depreciation" with a debit normal balance and the
 * Statement of Financial Position would add it to net assets instead of
 * subtracting it, on a hundred and thirty-eight accounts at once, with no
 * error anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NEVER OVERWRITES A CLASSIFICATION THAT WAS EDITED
 * ---------------------------------------------------------------------------
 * The derivation is a starting point, not a ruling. Which accounts need a
 * subsidiary ledger, and where an account sits between current and
 * non-current, are the Accountant's decisions, and the Chart of Accounts
 * screen exists for them to be made.
 *
 * So a second load of the same file - to add accounts, or after COA revises
 * the list - updates the TITLE and leaves every classification on an account
 * that already exists alone. Re-deriving would silently undo a year of
 * corrections, and the office would not find out until a statement moved.
 */

const CHART_LOADERS: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

/** Firestore allows 500 writes per batch; this leaves room for the audit row. */
const BATCH_SIZE = 400;

interface RawRow {
  code?: string;
  name?: string;
}

export const importChartOfAccounts = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK, timeoutSeconds: 300 },
  async (request) => {
    const caller = await requireCaller(request, CHART_LOADERS);
    const data = (request.data ?? {}) as {
      rows?: unknown;
      fileName?: string;
      /** REDERIVE re-classifies accounts that already exist. Off by default. */
      mode?: string;
    };

    const raw = data.rows;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalid('Nothing was sent. A chart of accounts with no accounts is not a chart.');
    }
    if (raw.length > 5000) {
      throw invalid(
        `One call takes at most 5000 accounts; this one carried ${raw.length}. That is far more ` +
          'than the Revised Chart of Accounts contains, so the file is probably not a chart.',
      );
    }

    const mode = String(data.mode ?? 'KEEP_EDITS').trim().toUpperCase();
    if (mode !== 'KEEP_EDITS' && mode !== 'REDERIVE') {
      throw invalid('The mode is either KEEP_EDITS or REDERIVE.');
    }

    const rows: ChartRowInput[] = (raw as RawRow[]).map((r, i) => ({
      lineNo: i + 1,
      code: String(r.code ?? '').trim(),
      name: String(r.name ?? '').replace(/\s+/g, ' ').trim(),
    }));

    // The shared rule: eight-digit codes, a title on every row, no duplicates.
    const check = checkChart(rows);
    if (!check.ok) {
      throw new HttpsError(
        'failed-precondition',
        `${check.violations[0].message} Nothing was loaded.`,
        { violations: check.violations.slice(0, 20) },
      );
    }

    /*
     * Every row is classified BEFORE anything is written.
     *
     * A row the rules cannot place would otherwise be discovered halfway
     * through, leaving the chart half loaded with no record of where it
     * stopped - and a half-loaded chart is worse than none, because the
     * screens all work and the missing accounts only show up as a report that
     * foots low.
     */
    const derived = rows.map((row) => ({ row, account: deriveAccount(row) }));
    const unclassified = derived.filter((d) => d.account === null);
    if (unclassified.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        `${unclassified.length} account${unclassified.length === 1 ? '' : 's'} could not be ` +
          `classified: ${unclassified
            .slice(0, 8)
            .map((d) => d.row.code)
            .join(', ')}${unclassified.length > 8 ? ', …' : ''}. A Revised Chart of Accounts ` +
          'code begins with 1 to 5 for asset, liability, equity, revenue or expense. Nothing ' +
          'was loaded.',
        { codes: unclassified.map((d) => d.row.code) },
      );
    }

    // What is already there, so an existing account keeps the classification
    // the office gave it.
    const existingSnap = await db.collection(COL.accounts).get();
    const existing = new Map<string, Record<string, unknown>>();
    for (const doc of existingSnap.docs) {
      const d = doc.data() as { code?: string };
      if (d.code) existing.set(String(d.code).trim(), { id: doc.id, ...d });
    }

    const now = new Date().toISOString();
    const stamp = { uid: caller.uid, name: caller.name, at: now };

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (let start = 0; start < derived.length; start += BATCH_SIZE) {
      const slice = derived.slice(start, start + BATCH_SIZE);
      const batch = db.batch();

      for (const { account } of slice) {
        const a = account!;
        const prior = existing.get(a.code);
        // The code is the document id, so loading the same file twice updates
        // rather than duplicates.
        const ref = db.collection(COL.accounts).doc(a.code);

        if (!prior) {
          batch.set(ref, {
            code: a.code,
            name: a.name,
            accountClass: a.accountClass,
            normalBalance: a.normalBalance,
            fsClassification: a.fsClassification,
            cashFlowClass: a.cashFlowClass,
            expenseClass: a.expenseClass,
            postable: a.postable,
            isControl: a.isControl,
            requiresSubsidiary: a.requiresSubsidiary,
            majorGroup: a.majorGroup,
            active: true,
            createdBy: stamp,
            updatedAt: now,
          });
          created += 1;
          continue;
        }

        if (mode === 'REDERIVE') {
          batch.set(
            ref,
            {
              name: a.name,
              accountClass: a.accountClass,
              normalBalance: a.normalBalance,
              fsClassification: a.fsClassification,
              cashFlowClass: a.cashFlowClass,
              expenseClass: a.expenseClass,
              postable: a.postable,
              isControl: a.isControl,
              requiresSubsidiary: a.requiresSubsidiary,
              majorGroup: a.majorGroup,
              updatedAt: now,
            },
            { merge: true },
          );
          updated += 1;
          continue;
        }

        // KEEP_EDITS: the title only. Everything the Accountant may have
        // corrected is left exactly as it stands.
        if (String(prior.name ?? '') === a.name) {
          unchanged += 1;
          continue;
        }
        batch.set(ref, { name: a.name, updatedAt: now }, { merge: true });
        updated += 1;
      }

      await batch.commit();
    }

    /*
     * One audit record for the load, not six hundred.
     *
     * A row per account would bury every other entry in the trail for the day
     * the chart was loaded, which is the day somebody is most likely to be
     * looking at it.
     */
    await audit({
      caller,
      event: 'SETTINGS_CHANGE',
      entityType: COL.accounts,
      entityId: 'chart-of-accounts',
      entityRef: 'Chart of Accounts',
      fiscalYear: Number(now.slice(0, 4)),
      severity: 'NOTICE',
      remarks:
        `Loaded ${rows.length} accounts from ${String(data.fileName ?? 'a file').trim()}: ` +
        `${created} new, ${updated} updated, ${unchanged} unchanged` +
        (mode === 'REDERIVE'
          ? '. Existing classifications were RE-DERIVED and any manual corrections overwritten.'
          : '. Existing classifications were left as they stand.'),
    });

    return { total: rows.length, created, updated, unchanged, mode };
  },
);
