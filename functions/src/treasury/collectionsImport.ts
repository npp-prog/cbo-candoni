import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, assertFundInScope, invalid, type Role } from '../lib/context';
import { recordTransition } from '../lib/audit';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import {
  holdsSerial,
  normaliseFormCode,
  officerHoldings,
  type CustodyMovement,
} from '../lib/formCustody';

/**
 * Uploading the Abstract of Collections.
 *
 * A month of municipal collections is eight hundred rows and seven hundred
 * official receipts, and the MTO's own system already holds every one of them
 * correctly. This reads that file.
 *
 * ---------------------------------------------------------------------------
 * A row is not a receipt
 * ---------------------------------------------------------------------------
 *
 * The abstract writes one row per revenue account, so a receipt that collected
 * two things appears twice under the same O.R. number. The browser groups them
 * before sending; what arrives here is receipts with their lines, and the
 * deterministic document id makes that grouping stick - two rows of one receipt
 * cannot become two receipts however many times the file is uploaded.
 *
 * ---------------------------------------------------------------------------
 * Where the money lands
 * ---------------------------------------------------------------------------
 *
 * The Treasurer's revenue codes are finer than the COA chart - "Market Fee",
 * "Miscellaneous Income - RPT - BRGY EAST", "Cemetery Usage Fee" - and forty of
 * the forty-three in use are not COA codes at all. The mapping in
 * `revenueCodes` says which COA account each one credits.
 *
 * A code that is not mapped stops the whole upload. That is the same rule as
 * the appropriation ordinance and for the same reason: a collection posted to
 * a guessed revenue account is a misstated financial statement, the error is
 * invisible once posted because the cash still foots, and the fix - adding one
 * row to the mapping - is entirely in the office's own hands.
 *
 * The collecting officer is treated differently, and the difference is the
 * principle. An officer who is not in Employees does not change where a single
 * centavo lands; it only leaves the receipt labelled by name rather than by
 * record. So that is kept and reported, not refused. What must be right is what
 * decides the accounting.
 */

const TREASURY: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF'];

/**
 * Receipts per call. Each writes one document and nothing else - a collection
 * touches no balance until its RCD is posted - so this sits well inside the
 * 500-write transaction limit with the audit entry alongside.
 */
const MAX_RECEIPTS = 300;

interface RawLine {
  revenueCode?: string;
  description?: string;
  amount?: number;
  /** Patch 159: the subsidiary ledger account, by name. */
  subsidiary?: string;
}

/** "DELA CRUZ, Juan M." and "Juan M. Dela Cruz" read the same (as lib/names.ts). */
const nameKey = (name: string) =>
  String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');

interface RawReceipt {
  lineNo?: number;
  date?: string;
  reportRef?: string;
  accountableForm?: string;
  orNumber?: string;
  payor?: string;
  collector?: string;
  fund?: string;
  lines?: RawLine[];
  cancelled?: boolean;
  remarks?: string;
}

const peso = (c: number) => (c / 100).toFixed(2);

export const importCollections = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, TREASURY);
    const data = (request.data ?? {}) as {
      fiscalYear?: number;
      fundCode?: string;
      fileName?: string;
      receipts?: unknown;
      /**
       * Patch 156: the bulk upload of e-COLLECTIONS. Set, every receipt in
       * the file is an electronic one of this kind - an eOR, or an
       * intermediary's AR - recorded as the e-Collections screen records one.
       * Absent, the file is cash collections, as before.
       */
      eCollectionKind?: string;
    };

    const kind = data.eCollectionKind ? String(data.eCollectionKind).trim().toUpperCase() : null;
    if (kind && kind !== 'EOR' && kind !== 'AR') {
      throw invalid(`"${data.eCollectionKind}" is not a kind of e-collection. Use EOR or AR.`);
    }

    const fiscalYear = Number(data.fiscalYear);
    if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');
    const fundCode = String(data.fundCode ?? '').trim();
    if (!fundCode) throw invalid('A fund is required.');

    const raw = data.receipts;
    if (!Array.isArray(raw) || raw.length === 0) throw invalid('The file has no receipts to post.');
    if (raw.length > MAX_RECEIPTS) {
      throw invalid(`One call takes at most ${MAX_RECEIPTS} receipts; this one carried ${raw.length}.`);
    }

    assertFundInScope(caller, fundCode);

    // ---- master data, read once ------------------------------------------

    const [codeSnap, accountSnap, employeeSnap, payeeSnap, formTypeSnap, movementSnap] =
      await Promise.all([
        db.collection(COL.revenueCodes).get(),
        db.collection(COL.accounts).get(),
        db.collection(COL.employees).get(),
        db.collection(COL.payees).get(),
        // Patch 162: the accountable forms, to check each receipt's booklet.
        db.collection(COL.accountableFormTypes).get(),
        db
          .collection(COL.accountableFormMovements)
          .where('fiscalYear', 'in', [fiscalYear, fiscalYear - 1])
          .get(),
      ]);

    /*
     * Patch 162 - A RECEIPT MUST COME FROM A BOOKLET ITS COLLECTOR HOLDS.
     *
     * The same rule as the receipt form (lib/formCustody.ts): a counter
     * receipt is posted only if its form is a known accountable form and its
     * number is in a booklet issued to that collecting officer by the receipt
     * date, and not returned, spoiled or cancelled since. The file's own name
     * for the form ("AF 51", "Accountable Form No. 51", "51") is matched to
     * Master Data > Accountable Form Types by code, printed name or number.
     * e-Collections have no booklet and are not checked.
     */
    const formTypes = formTypeSnap.docs.map((d) => {
      const t = d.data() as { code?: string; name?: string; printedAs?: string };
      return { code: String(t.code ?? d.id), name: t.name ?? '', printedAs: t.printedAs ?? '' };
    });
    const movements = movementSnap.docs.map((d) => d.data() as CustodyMovement);
    const digitsOf = (x: string) => (x.match(/\d+/g) ?? []).join('');
    const resolveForm = (text: string): string | null => {
      const n = normaliseFormCode(text);
      if (!n) return null;
      const exact = formTypes.filter(
        (t) =>
          normaliseFormCode(t.code) === n ||
          normaliseFormCode(t.printedAs) === n ||
          normaliseFormCode(t.name) === n,
      );
      if (exact.length === 1) return exact[0].code;
      const d = digitsOf(n);
      if (!d) return null;
      const byNo = formTypes.filter((t) => digitsOf(normaliseFormCode(t.code)) === d);
      return byNo.length === 1 ? byNo[0].code : null;
    };

    const revenueCodes = new Map<
      string,
      { accountCode: string; revenueSource?: string; description?: string }
    >();
    for (const doc of codeSnap.docs) {
      const r = doc.data() as {
        code?: string;
        accountCode?: string;
        revenueSource?: string;
        description?: string;
        active?: boolean;
      };
      if (r.active === false) continue;
      const key = (r.code ?? doc.id).trim().toUpperCase();
      if (r.accountCode) {
        revenueCodes.set(key, {
          accountCode: r.accountCode.trim(),
          revenueSource: r.revenueSource,
          description: r.description,
        });
      }
    }

    const accounts = new Map<
      string,
      { name: string; postable?: boolean; active?: boolean; requiresSubsidiary?: boolean }
    >();
    for (const doc of accountSnap.docs) {
      const a = doc.data() as {
        code?: string;
        name?: string;
        postable?: boolean;
        active?: boolean;
        requiresSubsidiary?: boolean;
      };
      if (a.code)
        accounts.set(a.code.trim(), {
          name: a.name ?? a.code,
          postable: a.postable,
          active: a.active,
          requiresSubsidiary: a.requiresSubsidiary,
        });
    }

    /*
     * Patch 159 - the subsidiary ledger account of a receivable or payable
     * line (or revenue the chart keeps per party), found by name on Names.
     * One person, one subsidiary: a Name tied to an employee record is that
     * employee. Two Names of the same name is a question, not a guess.
     */
    const people = new Map<string, Array<{ type: string; id: string; name: string }>>();
    const tiedEmployees = new Set<string>();
    for (const doc of payeeSnap.docs) {
      const p = doc.data() as { name?: string; active?: boolean; employeeId?: string };
      if (p.active === false || !p.name) continue;
      if (p.employeeId) tiedEmployees.add(p.employeeId);
      const k = nameKey(p.name);
      people.set(k, [
        ...(people.get(k) ?? []),
        p.employeeId
          ? { type: 'EMPLOYEE', id: p.employeeId, name: p.name }
          : { type: 'PAYEE', id: doc.id, name: p.name },
      ]);
    }
    for (const doc of employeeSnap.docs) {
      const e = doc.data() as { displayName?: string; active?: boolean; payeeId?: string };
      if (e.active === false || !e.displayName || tiedEmployees.has(doc.id) || e.payeeId) continue;
      const k = nameKey(e.displayName);
      people.set(k, [...(people.get(k) ?? []), { type: 'EMPLOYEE', id: doc.id, name: e.displayName }]);
    }
    const needsSubsidiary = (code: string) =>
      !code.startsWith('4') || accounts.get(code)?.requiresSubsidiary === true;

    const employees = new Map<string, { id: string; name: string }>();
    for (const doc of employeeSnap.docs) {
      const e = doc.data() as { displayName?: string; active?: boolean };
      if (e.active === false || !e.displayName) continue;
      employees.set(e.displayName.trim().toUpperCase(), { id: doc.id, name: e.displayName });
    }

    // ---- resolve ----------------------------------------------------------

    const unmapped = new Map<string, string>();
    const badAccounts = new Set<string>();
    const problems: Array<{ orNumber: string; problem: string }> = [];
    const unknownOfficers = new Set<string>();

    interface Ready {
      orNumber: string;
      reportRef: string;
      date: string;
      payor: string;
      collectorId: string | null;
      collectorName: string;
      accountableForm: string;
      /** Patch 162: the accountable form type it resolved to. */
      formCode: string | null;
      cancelled: boolean;
      remarks: string;
      revenueSource: string;
      lines: Array<{
        lineNo: number;
        accountCode: string;
        accountName: string;
        amount: number;
        particulars: string;
        subsidiaryType?: string | null;
        subsidiaryId?: string | null;
        subsidiaryName?: string | null;
      }>;
      totalAmount: number;
    }

    const ready: Ready[] = [];

    for (const r of raw as RawReceipt[]) {
      const orNumber = String(r.orNumber ?? '').trim();
      const reportRef = String(r.reportRef ?? '').trim();
      const date = String(r.date ?? '').trim();
      const add = (problem: string) => problems.push({ orNumber: orNumber || '(no O.R.)', problem });

      if (!orNumber) {
        add('no O.R. number');
        continue;
      }
      // Patch 156: an e-collection file need not carry a report reference.
      if (!reportRef && !kind) {
        add('no report reference');
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        add('no readable date');
        continue;
      }

      const collectorName = String(r.collector ?? '').trim();
      const employee = employees.get(collectorName.toUpperCase());
      if (collectorName && !employee) unknownOfficers.add(collectorName);

      // Patch 162: the booklet - cash receipts only.
      let formCode: string | null = null;
      if (!kind) {
        const formText = String(r.accountableForm ?? '').trim();
        formCode = resolveForm(formText);
        if (!formCode) {
          add(
            formText
              ? `accountable form "${formText}" is not a form type in Master Data > Accountable Form Types`
              : 'no accountable form (Type / Form No.)',
          );
          continue;
        }
        if (!employee) {
          add(
            collectorName
              ? `collector "${collectorName}" is not on Names as an employee, so whose booklet it is cannot be checked`
              : 'no collecting officer',
          );
          continue;
        }
        if (!holdsSerial(officerHoldings(movements, employee.id, formCode, date), orNumber)) {
          add(
            `${formCode} No. ${orNumber} was not issued to ${employee.name} by ${date} (Treasury > Accountable Forms > Issue)`,
          );
          continue;
        }
      }

      const lines: Ready['lines'] = [];
      let total = 0;
      let revenueSource = 'OTHER';

      if (!r.cancelled) {
        const rawLines = Array.isArray(r.lines) ? r.lines : [];
        if (!rawLines.length) {
          add('no revenue line');
          continue;
        }
        for (const l of rawLines) {
          const code = String(l.revenueCode ?? '').trim();
          const amount = Math.round(Number(l.amount));
          if (!code || !Number.isFinite(amount) || amount <= 0) {
            add(`a revenue line with no code or no amount`);
            continue;
          }
          const mapped = revenueCodes.get(code.toUpperCase());
          if (!mapped) {
            unmapped.set(code, String(l.description ?? ''));
            continue;
          }
          const account = accounts.get(mapped.accountCode);
          if (!account || account.postable === false || account.active === false) {
            badAccounts.add(`${code} -> ${mapped.accountCode}`);
            continue;
          }
          if (lines.length === 0 && mapped.revenueSource) revenueSource = mapped.revenueSource;
          // Patch 159: the subsidiary, where the account is kept per party -
          // the line's own Subsidiary column, else the payor.
          let sub: { type: string; id: string; name: string } | null = null;
          if (needsSubsidiary(mapped.accountCode)) {
            const wanted = String(l.subsidiary ?? '').trim() || String(r.payor ?? '').trim();
            const hits = wanted ? (people.get(nameKey(wanted)) ?? []) : [];
            if (hits.length !== 1) {
              add(
                !wanted
                  ? `${mapped.accountCode} ${account.name} is kept per party, and the line names no subsidiary (Subsidiary column) and no payor`
                  : hits.length === 0
                    ? `${mapped.accountCode} ${account.name} is kept per party, and "${wanted}" is not on Names`
                    : `${mapped.accountCode} ${account.name} is kept per party, and ${hits.length} Names are called "${wanted}" - put the exact one in the Subsidiary column`,
              );
              continue;
            }
            sub = hits[0];
          }
          lines.push({
            lineNo: lines.length + 1,
            accountCode: mapped.accountCode,
            accountName: account.name,
            amount,
            particulars: String(l.description ?? mapped.description ?? ''),
            ...(sub
              ? { subsidiaryType: sub.type, subsidiaryId: sub.id, subsidiaryName: sub.name }
              : {}),
          });
          total += amount;
        }
      }

      ready.push({
        orNumber,
        reportRef,
        date,
        payor: String(r.payor ?? '').trim(),
        collectorId: employee?.id ?? null,
        collectorName: employee?.name ?? collectorName,
        accountableForm: String(r.accountableForm ?? '').trim(),
        formCode,
        cancelled: Boolean(r.cancelled),
        remarks: String(r.remarks ?? '').trim(),
        revenueSource,
        lines,
        totalAmount: total,
      });
    }

    if (unmapped.size) {
      const list = [...unmapped.entries()]
        .slice(0, 15)
        .map(([code, desc]) => `${code}${desc ? ` (${desc})` : ''}`)
        .join(', ');
      throw new HttpsError(
        'failed-precondition',
        `${unmapped.size} revenue code${unmapped.size === 1 ? '' : 's'} in this file ${unmapped.size === 1 ? 'has' : 'have'} no COA account against ${unmapped.size === 1 ? 'it' : 'them'}, so nothing was posted. ` +
          `A collection posted to a guessed account misstates the revenue and the cash still foots, which is what makes it hard to find later. ` +
          `Add them under Master Data - Revenue Codes: ${list}${unmapped.size > 15 ? `, and ${unmapped.size - 15} more` : ''}.`,
        { unmapped: [...unmapped.keys()] },
      );
    }

    if (badAccounts.size) {
      throw new HttpsError(
        'failed-precondition',
        `Nothing was posted. These revenue codes point at an account that is missing, deactivated, or a grouping account that cannot carry a posting: ${[...badAccounts].join(', ')}.`,
      );
    }

    if (problems.length) {
      throw new HttpsError(
        'failed-precondition',
        `${problems.length} receipt${problems.length === 1 ? '' : 's'} could not be read, so nothing was posted: ` +
          problems.slice(0, 10).map((p) => `${p.orNumber} - ${p.problem}`).join('; ') +
          (problems.length > 10 ? `; and ${problems.length - 10} more.` : '.'),
        { problems },
      );
    }

    // ---- post ---------------------------------------------------------------

    return db.runTransaction(async (tx) => {
      await assertFiscalYearOpen(fiscalYear, tx);

      // Every receipt in one call must sit in one accounting period, which is
      // what lets the period be checked once rather than per receipt.
      const periods = new Set(ready.map((r) => periodOf(r.date)));
      for (const period of periods) {
        await assertPeriodOpen(
          fiscalYear,
          period,
          fundCode,
          `collections for period ${period}`,
          tx,
        );
      }

      // Patch 156: e-collections are keyed by their kind and number.
      const docId = (r: Ready) =>
        kind ? `${fundCode}__${kind}__${r.orNumber}` : `${fundCode}__${r.reportRef}__${r.orNumber}`;

      const existing = await Promise.all(
        ready.map((r) => tx.get(db.collection(COL.collections).doc(docId(r)))),
      );

      /*
       * A receipt already in the books is skipped, not refused.
       *
       * This differs from the appropriation ordinance, where a repeat is
       * refused outright, and the difference is what a repeat means. An
       * ordinance posted twice doubles the budget. A receipt posted twice
       * cannot: the id is the receipt itself, so the second write would be the
       * same receipt again, and skipping it is simply correct.
       *
       * It also makes the upload resumable, which matters at seven hundred
       * receipts: if a call fails halfway through a month, the file is uploaded
       * again and only what is missing goes in.
       */
      const fresh = ready.filter((_, i) => !existing[i].exists);
      const skipped = ready.length - fresh.length;

      const now = new Date().toISOString();
      const stamp = {
        uid: caller.uid,
        name: caller.name,
        position: caller.position ?? null,
        at: now,
      };

      let posted = 0;
      let total = 0;
      let cancelled = 0;

      for (const r of fresh) {
        tx.create(db.collection(COL.collections).doc(docId(r)), {
          fiscalYear,
          period: periodOf(r.date),
          fundCode,
          orNumber: r.orNumber,
          orDate: r.date,
          // Patch 162: the form type it resolved to, as the receipt form saves it.
          accountableForm: r.formCode ?? (r.accountableForm || null),
          ...(r.formCode ? { accountableFormId: r.formCode } : {}),
          collectingOfficerId: r.collectorId,
          collectingOfficerName: r.collectorName,
          revenueSource: r.revenueSource,
          payorName: r.payor,
          lines: r.lines,
          totalAmount: r.totalAmount,
          paymentForm: kind ? 'ONLINE' : 'CASH',
          ...(kind ? { eCollectionKind: kind, accountableFormId: null } : {}),
          // The abstract groups receipts by its own report reference. Keeping
          // it is what will let the RCD be built from the same file later
          // without anybody having to say which receipts belong together.
          abstractReportRef: r.reportRef || null,
          importFileName: data.fileName ?? null,
          status: r.cancelled ? 'CANCELLED' : 'ISSUED',
          cancelledReason: r.cancelled ? r.remarks || 'Cancelled per Abstract of Collections' : null,
          remarks: r.remarks || null,
          createdBy: stamp,
        });
        posted += 1;
        total += r.totalAmount;
        if (r.cancelled) cancelled += 1;
      }

      recordTransition(tx, {
        caller,
        event: 'UPLOAD',
        entityType: COL.collections,
        entityId: `${fundCode}__${ready[0]?.reportRef ?? 'abstract'}`,
        entityRef: `${kind ? `e-Collections (${kind})` : 'Abstract of Collections'}${data.fileName ? ` - ${data.fileName}` : ''}`,
        fiscalYear,
        fundCode,
        action: 'CREATE',
        newStatus: 'ISSUED',
        remarks:
          `${posted} receipts, ${peso(total)}${cancelled ? `, ${cancelled} cancelled` : ''}` +
          `${skipped ? `, ${skipped} already recorded` : ''}.`,
      });

      return {
        posted,
        skipped,
        cancelled,
        total,
        unknownOfficers: [...unknownOfficers],
      };
    });
  },
);
