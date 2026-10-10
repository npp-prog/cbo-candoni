import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, invalid, assertFundInScope, type Role } from '../lib/context';
import { auditInTransaction } from '../lib/audit';
import {
  PRIOR_TB_KINDS,
  PRIOR_TB_LABELS,
  compareWithOpening,
  netByCode,
  openNominalAccounts,
  priorTbId,
  type PriorTbKind,
} from '../lib/priorTrialBalance';

/**
 * Patch 169 - savePriorTrialBalance.
 *
 * Stores the preceding year's pre-closing or post-closing trial balance of a
 * fund, for the comparative column of the financial statements. See
 * src/lib/priorTrialBalance.ts.
 *
 * It is a callable, and the collection is closed to the browser, because a
 * trial balance is a set of financial balances and the browser is not the
 * authority for those. The engine checks every account against the Chart of
 * Accounts, that the debits equal the credits, that a post-closing trial
 * balance has no revenue or expense left open, and - where the Opening
 * Balances of the next year are posted - that it agrees with them account by
 * account.
 *
 * It posts nothing. The General Ledger is not touched; these figures are
 * printed beside it as the preceding year, and only where the General Ledger
 * has no preceding year of its own.
 */

const ACCOUNTANT: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

interface InLine {
  accountCode?: unknown;
  accountName?: unknown;
  debit?: unknown;
  credit?: unknown;
}

const peso = (c: number) =>
  (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const savePriorTrialBalance = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ACCOUNTANT);
    const { fiscalYear, fundCode, kind, asOfDate, fileName, lines } = (request.data ?? {}) as {
      fiscalYear?: number;
      fundCode?: string;
      kind?: PriorTbKind;
      asOfDate?: string;
      fileName?: string;
      lines?: InLine[];
    };

    if (!Number.isInteger(fiscalYear) || fiscalYear! < 2000 || fiscalYear! > 2100) {
      throw invalid('The year of the trial balance is required.');
    }
    if (!fundCode || typeof fundCode !== 'string') throw invalid('The fund is required.');
    if (!kind || !PRIOR_TB_KINDS.includes(kind)) {
      throw invalid('Say whether this is the pre-closing or the post-closing trial balance.');
    }
    if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      throw invalid('The date is written YYYY-MM-DD.');
    }
    if (!Array.isArray(lines) || lines.length === 0) throw invalid('The trial balance is empty.');
    if (lines.length > 3000) throw invalid('More than 3,000 lines - is this the right file?');
    assertFundInScope(caller, fundCode);
    const year = fiscalYear!;

    // --- the lines: one per account, whole centavos, never negative ----------
    const merged = new Map<
      string,
      { accountCode: string; fileTitle: string; debit: number; credit: number }
    >();
    for (const l of lines) {
      const code = String(l.accountCode ?? '').trim();
      const debit = Math.round(Number(l.debit ?? 0));
      const credit = Math.round(Number(l.credit ?? 0));
      if (!code) continue;
      if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) {
        throw invalid(`Account ${code} carries an amount that is not a positive figure.`);
      }
      if (!debit && !credit) continue;
      const m = merged.get(code) ?? {
        accountCode: code,
        fileTitle: String(l.accountName ?? '')
          .trim()
          .slice(0, 200),
        debit: 0,
        credit: 0,
      };
      m.debit += debit;
      m.credit += credit;
      merged.set(code, m);
    }
    if (merged.size === 0) throw invalid('No account on the trial balance carries an amount.');

    const totalDebit = [...merged.values()].reduce((s, l) => s + l.debit, 0);
    const totalCredit = [...merged.values()].reduce((s, l) => s + l.credit, 0);
    if (totalDebit !== totalCredit) {
      throw invalid(
        `The trial balance does not foot: debits ${peso(totalDebit)}, credits ${peso(totalCredit)}.`,
      );
    }

    const net = netByCode([...merged.values()]);
    if (kind === 'POST') {
      const open = openNominalAccounts(net);
      if (open.length) {
        throw invalid(
          `A post-closing trial balance has no revenue or expense left open, but ${open
            .slice(0, 8)
            .join(
              ', ',
            )}${open.length > 8 ? ` and ${open.length - 8} more` : ''} still carry a balance. Is this the pre-closing one?`,
        );
      }
    }

    const ref = db.collection(COL.priorTrialBalances).doc(priorTbId(year, fundCode, kind));
    const markerRef = db.collection(COL.openingBalances).doc(`${year + 1}__${fundCode}`);

    return db.runTransaction(async (tx) => {
      // --- reads -------------------------------------------------------------
      const codes = [...merged.keys()];
      const accountSnaps = await Promise.all(
        codes.map((c) => tx.get(db.collection(COL.accounts).doc(c))),
      );
      const marker = kind === 'POST' ? await tx.get(markerRef) : null;
      const markerData = marker?.exists
        ? (marker.data() as { jevId?: string; jevNo?: string })
        : null;
      const jevSnap = markerData?.jevId
        ? await tx.get(db.collection(COL.jevs).doc(markerData.jevId))
        : null;

      // --- the chart ---------------------------------------------------------
      const missing: string[] = [];
      const grouping: string[] = [];
      const out: Array<{
        accountCode: string;
        accountName: string;
        fileTitle: string;
        debit: number;
        credit: number;
      }> = [];
      let namesDiffer = 0;
      codes.forEach((code, i) => {
        const snap = accountSnaps[i];
        const l = merged.get(code)!;
        if (!snap.exists) {
          missing.push(code);
          return;
        }
        const a = snap.data() as { name?: string; postable?: boolean };
        if (a.postable === false) grouping.push(code);
        const name = String(a.name ?? '');
        if (l.fileTitle && l.fileTitle.toLowerCase() !== name.toLowerCase()) namesDiffer++;
        out.push({
          accountCode: code,
          accountName: name,
          fileTitle: l.fileTitle,
          debit: l.debit,
          credit: l.credit,
        });
      });
      if (missing.length) {
        throw invalid(
          `Not in the Chart of Accounts: ${missing.slice(0, 10).join(', ')}${
            missing.length > 10 ? ` and ${missing.length - 10} more` : ''
          }. Add them, or correct the codes in the file.`,
        );
      }
      if (grouping.length) {
        throw invalid(
          `Grouping accounts cannot carry a balance: ${grouping.slice(0, 10).join(', ')}. Use the accounts beneath them.`,
        );
      }

      // --- the post-closing trial balance against the next year's opening ----
      let openingJevNo: string | null = null;
      if (kind === 'POST' && markerData) {
        const jevLines =
          (
            jevSnap?.data() as {
              lines?: Array<{ accountCode: string; debit?: number; credit?: number }>;
            }
          )?.lines ?? [];
        const diffs = compareWithOpening(net, netByCode(jevLines));
        if (diffs.length) {
          throw invalid(
            `The post-closing trial balance does not agree with the Opening Balances of ${
              year + 1
            } (JEV ${markerData.jevNo ?? ''}) on ${diffs.length} account${
              diffs.length === 1 ? '' : 's'
            }: ${diffs
              .slice(0, 6)
              .map(
                (d) =>
                  `${d.accountCode} trial balance ${peso(d.trialBalance)}, opening ${peso(d.opening)}`,
              )
              .join('; ')}${diffs.length > 6 ? '; ...' : ''}. Debit less credit.`,
          );
        }
        openingJevNo = markerData.jevNo ?? null;
      }

      // --- write ---------------------------------------------------------------
      const now = new Date().toISOString();
      out.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
      tx.set(ref, {
        fiscalYear: year,
        fundCode,
        kind,
        asOfDate: asOfDate || `${year}-12-31`,
        fileName: typeof fileName === 'string' ? fileName.slice(0, 200) : null,
        lines: out,
        lineCount: out.length,
        totalDebit,
        totalCredit,
        namesDiffer,
        /** Whether the next year's opening balances were there to check against. */
        openingChecked: Boolean(markerData),
        openingJevNo,
        uploadedAt: now,
        uploadedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null },
      });

      auditInTransaction(tx, {
        caller,
        event: 'UPLOAD',
        entityType: COL.priorTrialBalances,
        entityId: ref.id,
        entityRef: `${PRIOR_TB_LABELS[kind]} ${fundCode} ${year}`,
        fiscalYear: year,
        fundCode,
        remarks: `${out.length} accounts, ${peso(totalDebit)}.${
          kind === 'POST'
            ? markerData
              ? ` Agrees with the Opening Balances of ${year + 1}.`
              : ` The Opening Balances of ${year + 1} are not yet posted.`
            : ''
        }`,
        severity: 'NOTICE',
      });

      return {
        id: ref.id,
        lineCount: out.length,
        total: totalDebit,
        namesDiffer,
        openingChecked: Boolean(markerData),
      };
    });
  },
);
