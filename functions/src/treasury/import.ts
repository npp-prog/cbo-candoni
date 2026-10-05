import { HttpsError } from 'firebase-functions/v2/https';
import {
  cashInBankLine,
  ACCOUNTS_PAYABLE as SHARED_ACCOUNTS_PAYABLE,
} from '../lib/chartOfAccounts';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import { requireCaller, notFound, invalid, assertFundInScope, type Role } from '../lib/context';
import { recordTransition, notifyInTransaction } from '../lib/audit';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';

/**
 * Uploading the Treasurer's RCI and RADAI.
 *
 * How this office actually works. The Treasurer's own system produces the
 * Report of Checks Issued and the Report of ADA Issued as files: one row per
 * payment, each naming the voucher it paid. Nobody is going to re-key those
 * rows into CFMS - they already exist, correctly, somewhere else, and asking a
 * clerk to type them again is asking for a second set of figures that disagrees
 * with the first.
 *
 * So the file is the input. CFMS reads each row, finds the disbursement voucher
 * it names, and raises the check or the ADA against that voucher. What it will
 * not do is take the file's word for anything that matters: the amount posted
 * is the voucher's net, not the file's figure, and a row whose figure disagrees
 * with its voucher is not posted at all. The file says which vouchers were
 * paid; the books say how much they were for.
 *
 * ---------------------------------------------------------------------------
 * The rule that shapes the rest of this file
 * ---------------------------------------------------------------------------
 *
 * A row CFMS cannot place is HELD, not rejected, and the rest of the file goes
 * through.
 *
 * The temptation is to refuse the whole upload on the first unmatched row -
 * it is simpler, and it keeps the report obviously complete. But the usual
 * reason a row will not match is dull and one-sided: the voucher was paid
 * before somebody in Accounting finished encoding it. Refusing all forty rows
 * because of that one means the file is re-uploaded tomorrow, and the day after,
 * and before long the office decides the upload does not work and goes back to
 * paper.
 *
 * So unmatched rows are kept on the import, marked PENDING, with the reason
 * stated in figures. They are not in the books and not on the report. Somebody
 * links them to the right voucher, or sets them aside with a note saying how
 * they were handled - and until every one of them is dealt with, the report
 * cannot be certified. That last part is what keeps the leniency honest: the
 * report the Treasurer signs still covers everything on the paper it was made
 * from, because it cannot be signed until it does.
 */

const TREASURY: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF'];

type ImportType = 'RCI' | 'RADAI';

/** Accounts Payable, from the COA Revised Chart of Accounts for LGUs. */
/*
 * Taken from the shared chart rather than written out here.
 *
 * A second copy of an account's title is a second thing to be wrong, and the
 * one place it is wrong is the place nobody looks at - this file posts the
 * entry for an uploaded report, which is the path a person never reads.
 */
const ACCOUNTS_PAYABLE = SHARED_ACCOUNTS_PAYABLE;

/**
 * A ceiling on one upload.
 *
 * Not a policy about how big a report may be - it is the Firestore transaction
 * write limit showing through. Each matched row writes a payment document and
 * updates its voucher, so two hundred rows is four hundred writes against a
 * limit of five hundred, with the report, the import record and the audit entry
 * to fit alongside. A larger file is split by date rather than the limit being
 * quietly raised until an upload fails halfway.
 */
const MAX_ROWS = 200;

type Reason =
  | 'NO_DV_NUMBER'
  | 'DV_NOT_FOUND'
  | 'DV_NOT_APPROVED'
  | 'DV_ALREADY_PAID'
  | 'FUND_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'NO_SERIAL'
  | 'DUPLICATE_SERIAL';

interface RawRow {
  lineNo?: number;
  date?: string;
  serialNo?: string;
  dvNo?: string;
  obrNo?: string;
  payeeName?: string;
  particulars?: string;
  responsibilityCenter?: string;
  amount?: number;
}

interface CleanRow {
  lineNo: number;
  date: string;
  serialNo: string;
  dvNo: string;
  obrNo: string;
  payeeName: string;
  particulars: string;
  responsibilityCenter: string;
  amount: number;
}

interface Dv {
  dvNo: string;
  fiscalYear: number;
  fundCode: string;
  payeeId: string;
  payeeName: string;
  particulars: string;
  grossAmount: number;
  totalDeductions: number;
  netAmount: number;
  status: string;
  checkId?: string;
  adaId?: string;
  obrNo?: string;
}

const peso = (centavos: number) => (centavos / 100).toFixed(2);

function cleanRows(raw: unknown): CleanRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid('The uploaded file has no rows to import.');
  }
  if (raw.length > MAX_ROWS) {
    throw invalid(
      `That file has ${raw.length} rows. One upload takes at most ${MAX_ROWS}; split it by date and upload the parts separately.`,
    );
  }

  return (raw as RawRow[]).map((row, i) => {
    const amount = Math.round(Number(row.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw invalid(
        `Row ${row.lineNo ?? i + 1} of the file has no readable amount. Every row must carry the amount paid.`,
      );
    }
    const date = String(row.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw invalid(
        `Row ${row.lineNo ?? i + 1} of the file has no readable date. Dates must read as year-month-day, for example 2026-09-15.`,
      );
    }
    return {
      lineNo: Number(row.lineNo ?? i + 1),
      date,
      serialNo: String(row.serialNo ?? '').trim().toUpperCase(),
      dvNo: String(row.dvNo ?? '').trim().toUpperCase(),
      obrNo: String(row.obrNo ?? '').trim().toUpperCase(),
      payeeName: String(row.payeeName ?? '').trim(),
      particulars: String(row.particulars ?? '').trim(),
      responsibilityCenter: String(row.responsibilityCenter ?? '').trim(),
      amount,
    };
  });
}

/**
 * importTreasuryPayments - reads one RCI or RADAI file into a draft report.
 *
 * Everything the file asserts is checked against CFMS's own records inside the
 * transaction, never taken on trust. The browser parsed the columns; it did not
 * decide anything.
 */
export const importTreasuryPayments = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, TREASURY);
    const data = (request.data ?? {}) as {
      importType?: string;
      fiscalYear?: number;
      fundCode?: string;
      reportDate?: string;
      bankAccountId?: string;
      adaNo?: string;
      fileName?: string;
      rows?: unknown;
    };

    const importType = data.importType as ImportType;
    if (importType !== 'RCI' && importType !== 'RADAI') {
      throw invalid('An upload must be either an RCI or a RADAI.');
    }
    if (!data.bankAccountId) throw invalid('Choose the bank account the payments were drawn on.');
    if (!data.fundCode) throw invalid('A fund is required.');
    if (!data.reportDate || !/^\d{4}-\d{2}-\d{2}$/.test(data.reportDate)) {
      throw invalid('A report date is required.');
    }
    const fiscalYear = Number(data.fiscalYear);
    if (!Number.isInteger(fiscalYear)) throw invalid('A fiscal year is required.');

    const adaNo = String(data.adaNo ?? '').trim().toUpperCase();
    if (importType === 'RADAI' && !adaNo) {
      // One ADA number covers the whole batch sent to the bank - it is on the
      // face of the RADAI, not in the rows - so there is nothing in the file to
      // fall back on if it is missing.
      throw invalid('A RADAI needs the ADA number the batch was sent to the bank under.');
    }

    const rows = cleanRows(data.rows);
    const fundCode = data.fundCode;
    const reportDate = data.reportDate;
    const period = periodOf(reportDate);
    const bankAccountId = data.bankAccountId;

    assertFundInScope(caller, fundCode);

    return db.runTransaction(async (tx) => {
      await assertFiscalYearOpen(fiscalYear, tx);
      await assertPeriodOpen(
        fiscalYear,
        period,
        fundCode,
        `${importType} dated ${reportDate}`,
        tx,
      );

      // ---- reads -----------------------------------------------------------
      //
      // A Firestore transaction takes every read before its first write, so the
      // whole file is looked up first and only then written. That is also why
      // the decisions below are made in a second pass rather than as each
      // voucher arrives.

      const bankSnap = await tx.get(db.collection(COL.bankAccounts).doc(bankAccountId));
      if (!bankSnap.exists) throw notFound('The bank account');
      const bank = bankSnap.data() as {
        bankName: string;
        accountNumber: string;
        fundCode: string;
        active?: boolean;
        glAccountCode?: string;
        accountName?: string;
      };

      if (bank.active === false) {
        throw new HttpsError('failed-precondition', 'That bank account is no longer active.');
      }
      if (bank.fundCode !== fundCode) {
        throw new HttpsError(
          'failed-precondition',
          `That bank account belongs to the ${bank.fundCode} fund but this ${importType} covers ${fundCode}. Funds must not be commingled in one report.`,
        );
      }
      if (!bank.glAccountCode) {
        throw new HttpsError(
          'failed-precondition',
          `Bank account ${bank.bankName} ${bank.accountNumber} has no General Ledger account recorded against it. Set it under Master Data - Banks before uploading payments drawn on this account.`,
        );
      }

      const dvSnaps = await Promise.all(
        rows.map((row) =>
          row.dvNo
            ? tx.get(
                db
                  .collection(COL.disbursementVouchers)
                  .where('dvNo', '==', row.dvNo)
                  .limit(5),
              )
            : null,
        ),
      );

      // A check number is unique within a bank account, and that is enforced by
      // the document id rather than by looking - so the existence of the id is
      // the whole test.
      const checkSnaps = await Promise.all(
        rows.map((row) =>
          importType === 'RCI' && row.serialNo
            ? tx.get(db.collection(COL.checks).doc(`${bankAccountId}__${row.serialNo}`))
            : null,
        ),
      );

      // ---- decide ----------------------------------------------------------

      const reportRef = db.collection(COL.treasuryReports).doc();
      const importRef = db.collection(COL.treasuryImports).doc();
      const now = new Date().toISOString();

      interface Decision {
        row: CleanRow;
        dvId?: string;
        dv?: Dv;
        reason?: Reason;
        detail?: string;
      }

      const seenSerials = new Set<string>();
      const decisions: Decision[] = rows.map((row, i) => {
        if (!row.dvNo) return { row, reason: 'NO_DV_NUMBER' as const };

        const candidates = dvSnaps[i]?.docs ?? [];
        if (!candidates.length) {
          return { row, reason: 'DV_NOT_FOUND' as const };
        }

        const inFund = candidates.find((d) => (d.data() as Dv).fundCode === fundCode);
        if (!inFund) {
          const other = (candidates[0].data() as Dv).fundCode;
          return {
            row,
            reason: 'FUND_MISMATCH' as const,
            detail: `DV ${row.dvNo} belongs to the ${other} fund.`,
          };
        }

        const dv = inFund.data() as Dv;

        if (dv.status !== 'APPROVED' && dv.status !== 'PAID') {
          return {
            row,
            reason: 'DV_NOT_APPROVED' as const,
            detail: `DV ${row.dvNo} is ${dv.status.toLowerCase()}.`,
          };
        }

        const existingPayment = importType === 'RCI' ? dv.checkId : dv.adaId;
        const otherPayment = importType === 'RCI' ? dv.adaId : dv.checkId;
        if (existingPayment || otherPayment) {
          return {
            row,
            reason: 'DV_ALREADY_PAID' as const,
            detail: `DV ${row.dvNo} already has ${existingPayment ? 'a payment' : importType === 'RCI' ? 'an ADA' : 'a check'} recorded against it.`,
          };
        }

        // The file's figure is compared with the voucher, and the voucher wins.
        // A disagreement is held rather than reconciled by preferring one of
        // them: either the voucher is wrong and Accounting must correct it, or
        // the payment was not for this voucher at all.
        if (dv.netAmount !== row.amount) {
          return {
            row,
            reason: 'AMOUNT_MISMATCH' as const,
            detail: `The file says ${peso(row.amount)} but DV ${row.dvNo} is ${peso(dv.netAmount)} net.`,
          };
        }

        if (importType === 'RCI') {
          if (!row.serialNo) return { row, reason: 'NO_SERIAL' as const };
          if (checkSnaps[i]?.exists) {
            const prior = checkSnaps[i]?.data() as { dvNo?: string } | undefined;
            return {
              row,
              reason: 'DUPLICATE_SERIAL' as const,
              detail: `Check ${row.serialNo} is already recorded on this bank account${prior?.dvNo ? ` for DV ${prior.dvNo}` : ''}.`,
            };
          }
          if (seenSerials.has(row.serialNo)) {
            return {
              row,
              reason: 'DUPLICATE_SERIAL' as const,
              detail: `Check ${row.serialNo} appears more than once in this file.`,
            };
          }
          seenSerials.add(row.serialNo);
        }

        return { row, dvId: inFund.id, dv };
      });

      // ---- writes ----------------------------------------------------------

      const reportLines: Array<Record<string, unknown>> = [];
      const importRows: Array<Record<string, unknown>> = [];
      let matchedTotal = 0;
      let pendingTotal = 0;

      for (const decision of decisions) {
        const { row } = decision;

        if (decision.reason || !decision.dv || !decision.dvId) {
          pendingTotal += row.amount;
          importRows.push({
            lineNo: row.lineNo,
            date: row.date,
            serialNo: row.serialNo || null,
            dvNo: row.dvNo,
            obrNo: row.obrNo || null,
            payeeName: row.payeeName || null,
            particulars: row.particulars || null,
            responsibilityCenter: row.responsibilityCenter || null,
            amount: row.amount,
            status: 'PENDING',
            reason: decision.reason,
            detail: decision.detail ?? null,
          });
          continue;
        }

        const { dv, dvId } = decision;
        // The posted amount is the voucher's, not the file's. They are equal by
        // the check above; taking it from the voucher is what makes that true
        // rather than assumed.
        const amount = dv.netAmount;
        matchedTotal += amount;

        const sourceNo = importType === 'RCI' ? row.serialNo : adaNo;
        const sourceRef =
          importType === 'RCI'
            ? db.collection(COL.checks).doc(`${bankAccountId}__${row.serialNo}`)
            : db.collection(COL.ada).doc();

        const common = {
          fiscalYear,
          fundCode,
          bankAccountId,
          bankName: bank.bankName,
          bankAccountNumber: bank.accountNumber,
          dvId,
          dvNo: dv.dvNo,
          payeeId: dv.payeeId,
          payeeName: dv.payeeName,
          particulars: row.particulars || dv.particulars,
          // The report the payment arrived on, and where in it. Kept so a
          // figure in the books can be traced back to the row of the file it
          // came from without anyone having to remember which upload it was.
          importId: importRef.id,
          importLineNo: row.lineNo,
          obrNo: row.obrNo || dv.obrNo || null,
          createdBy: {
            uid: caller.uid,
            name: caller.name,
            position: caller.position ?? null,
            at: now,
          },
        };

        if (importType === 'RCI') {
          tx.create(sourceRef, {
            ...common,
            checkNo: row.serialNo,
            checkDate: row.date,
            grossAmount: dv.grossAmount,
            totalDeductions: dv.totalDeductions,
            netAmount: amount,
            // Uploaded from the Treasurer's own report, which is written after
            // the checks are signed and handed out. Recording them as merely
            // prepared would put the whole batch back through three clicks
            // apiece to describe something that already happened.
            status: 'RELEASED',
            dateReleased: row.date,
            responsibilityCenter: row.responsibilityCenter || null,
          });
          tx.update(db.collection(COL.disbursementVouchers).doc(dvId), {
            checkId: sourceRef.id,
            checkNo: row.serialNo,
            bankAccountId,
          });
        } else {
          tx.create(sourceRef, {
            ...common,
            adaNo,
            adaDate: row.date,
            amount,
            status: 'SUBMITTED',
            dateSubmittedToBank: row.date,
          });
          tx.update(db.collection(COL.disbursementVouchers).doc(dvId), {
            adaId: sourceRef.id,
            adaNo,
            bankAccountId,
          });
        }

        reportLines.push({
          sourceId: sourceRef.id,
          sourceNo,
          date: row.date,
          payeeName: dv.payeeName,
          particulars: row.particulars || dv.particulars,
          amount,
        });

        importRows.push({
          lineNo: row.lineNo,
          date: row.date,
          serialNo: row.serialNo || null,
          dvNo: dv.dvNo,
          obrNo: row.obrNo || dv.obrNo || null,
          payeeName: dv.payeeName,
          particulars: row.particulars || dv.particulars,
          responsibilityCenter: row.responsibilityCenter || null,
          amount,
          status: 'MATCHED',
          dvId,
          sourceId: sourceRef.id,
          sourceNo,
        });
      }

      const pendingCount = importRows.filter((r) => r.status === 'PENDING').length;
      const matchedCount = importRows.length - pendingCount;

      const serials = reportLines.map((l) => String(l.sourceNo)).sort();

      tx.create(reportRef, {
        reportType: importType,
        reportDate,
        fiscalYear,
        period,
        fundCode,
        bankAccountId,
        bankName: bank.bankName,
        bankAccountNumber: bank.accountNumber,
        accountableOfficerId: caller.uid,
        accountableOfficerName: caller.name,
        serialFrom: serials[0] ?? null,
        serialTo: serials[serials.length - 1] ?? null,
        lines: reportLines,
        totalAmount: matchedTotal,
        entry: buildEntry(importType, matchedTotal, bank),
        status: 'DRAFT',
        importId: importRef.id,
        pendingRowCount: pendingCount,
        createdBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      tx.create(importRef, {
        importType,
        fiscalYear,
        period,
        fundCode,
        reportDate,
        bankAccountId,
        bankName: bank.bankName,
        bankAccountNumber: bank.accountNumber,
        adaNo: importType === 'RADAI' ? adaNo : null,
        fileName: data.fileName ?? null,
        treasuryReportId: reportRef.id,
        rows: importRows,
        rowCount: importRows.length,
        matchedCount,
        pendingCount,
        fileTotal: matchedTotal + pendingTotal,
        matchedTotal,
        pendingTotal,
        status: pendingCount > 0 ? 'PENDING' : 'COMPLETE',
        uploadedAt: now,
        uploadedByName: caller.name,
        uploadedByUid: caller.uid,
      });

      recordTransition(tx, {
        caller,
        event: 'UPLOAD',
        entityType: COL.treasuryImports,
        entityId: importRef.id,
        entityRef: `${importType} upload${data.fileName ? ` - ${data.fileName}` : ''}`,
        fiscalYear,
        fundCode,
        action: 'CREATE',
        newStatus: pendingCount > 0 ? 'PENDING' : 'COMPLETE',
        remarks: `${importRows.length} rows read, ${matchedCount} matched to vouchers for ${peso(matchedTotal)}, ${pendingCount} held for manual handling for ${peso(pendingTotal)}.`,
        severity: pendingCount > 0 ? 'NOTICE' : undefined,
      });

      if (pendingCount > 0) {
        notifyInTransaction(tx, {
          recipientRole: 'MUNICIPAL_ACCOUNTANT',
          kind: 'IMPORT_ROWS_PENDING',
          title: `${pendingCount} row${pendingCount === 1 ? '' : 's'} of an uploaded ${importType} could not be placed`,
          body: `${peso(pendingTotal)} of payments on the Treasurer's ${importType} name vouchers CFMS could not match. The report cannot be certified until each is linked or set aside.`,
          entityType: COL.treasuryImports,
          entityId: importRef.id,
          link: `/treasury/${importType === 'RCI' ? 'checks' : 'ada'}/uploads`,
          severity: 'WARNING',
        });
      }

      return {
        importId: importRef.id,
        reportId: reportRef.id,
        rowCount: importRows.length,
        matchedCount,
        pendingCount,
        matchedTotal,
        pendingTotal,
      };
    });
  },
);

function buildEntry(
  importType: ImportType,
  total: number,
  bank: {
    id?: string;
    glAccountCode?: string;
    accountName?: string;
    bankName: string;
    accountNumber: string;
  },
) {
  if (total === 0) return [];
  const label = importType === 'RCI' ? 'RCI' : 'RADAI';

  /*
   * Named from the ACCOUNT CODE, never from the bank account's own name.
   *
   * This path - the RCI and RADAI upload - had the same fault as the screen
   * that prepares a report by hand: the code came from `glAccountCode` and the
   * name from `accountName`, which is what the OFFICE calls the bank account
   * ("General Fund"). The proposal then read "10102020 General Fund", an
   * account in nobody's chart, and the label travelled into every ledger line.
   */
  const cash = cashInBankLine(bank);
  if (!cash) return [];

  return [
    {
      accountCode: ACCOUNTS_PAYABLE.code,
      accountName: ACCOUNTS_PAYABLE.name,
      debit: total,
      credit: 0,
      particulars: `Payments per ${label}`,
    },
    {
      ...cash,
      debit: 0,
      credit: total,
      particulars: `Payments per ${label}`,
    },
  ];
}

/**
 * resolveImportRow - dealing with a row that was held.
 *
 * Two answers, and they are different in kind.
 *
 * LINK says the payment is real and CFMS now knows which voucher it belongs to,
 * usually because Accounting has since encoded it. The row is matched, the
 * payment raised and the line added to the report. Every test the upload
 * applied is applied again here, because the voucher named now is not the one
 * that was looked for then.
 *
 * SET_ASIDE says the payment is real but will not be recorded through this
 * report - it was posted by hand, or it belongs to a period already closed.
 * A note is required. The row stays on the import, visibly set aside, because
 * a row that simply disappeared would leave the report footing to less than the
 * file with nothing to say why.
 *
 * Neither is available once the report is certified. At that point the report
 * is a signed statement and its contents are fixed; the way to add a payment to
 * it is to withdraw it.
 */
export const resolveImportRow = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, TREASURY);
    const { importId, lineNo, action, dvId, serialNo, note } = (request.data ?? {}) as {
      importId?: string;
      lineNo?: number;
      action?: 'LINK' | 'SET_ASIDE';
      dvId?: string;
      serialNo?: string;
      note?: string;
    };

    if (!importId) throw invalid('An upload id is required.');
    if (typeof lineNo !== 'number') throw invalid('A row number is required.');
    if (action !== 'LINK' && action !== 'SET_ASIDE') {
      throw invalid('A held row is either linked to a voucher or set aside.');
    }
    if (action === 'LINK' && !dvId) throw invalid('Choose the voucher this payment paid.');
    if (action === 'SET_ASIDE' && !note?.trim()) {
      throw invalid('Say how this payment was handled. The note is what the report is read against.');
    }

    return db.runTransaction(async (tx) => {
      const importRef = db.collection(COL.treasuryImports).doc(importId);
      const importSnap = await tx.get(importRef);
      if (!importSnap.exists) throw notFound('The upload');

      const batch = importSnap.data() as {
        importType: ImportType;
        fiscalYear: number;
        fundCode: string;
        bankAccountId: string;
        bankName: string;
        bankAccountNumber: string;
        adaNo?: string;
        treasuryReportId: string;
        rows: Array<Record<string, unknown>>;
        matchedCount: number;
        pendingCount: number;
        matchedTotal: number;
        pendingTotal: number;
      };

      assertFundInScope(caller, batch.fundCode);

      const index = batch.rows.findIndex((r) => Number(r.lineNo) === lineNo);
      if (index < 0) throw notFound(`Row ${lineNo} of this upload`);
      const row = batch.rows[index];
      if (row.status !== 'PENDING') {
        throw new HttpsError(
          'failed-precondition',
          `Row ${lineNo} has already been dealt with. It is ${String(row.status).toLowerCase()}.`,
        );
      }

      const reportRef = db.collection(COL.treasuryReports).doc(batch.treasuryReportId);
      const reportSnap = await tx.get(reportRef);
      if (!reportSnap.exists) throw notFound('The treasury report');
      const report = reportSnap.data() as {
        status: string;
        reportNo?: string;
        lines: Array<Record<string, unknown>>;
        totalAmount: number;
        entry?: Array<{ debit: number; credit: number; [k: string]: unknown }>;
      };

      if (report.status !== 'DRAFT') {
        throw new HttpsError(
          'failed-precondition',
          `${batch.importType} ${report.reportNo ?? ''} is ${report.status.toLowerCase()} and its contents are fixed. Withdraw it first if this payment belongs on it.`,
        );
      }

      const now = new Date().toISOString();
      const resolvedRow: Record<string, unknown> = {
        ...row,
        resolvedAt: now,
        resolvedByName: caller.name,
      };

      let lines = report.lines ?? [];
      let total = report.totalAmount ?? 0;

      if (action === 'SET_ASIDE') {
        resolvedRow.status = 'MANUAL';
        resolvedRow.note = note!.trim();
      } else {
        const dvSnap = await tx.get(db.collection(COL.disbursementVouchers).doc(dvId!));
        if (!dvSnap.exists) throw notFound('The disbursement voucher');
        const dv = dvSnap.data() as Dv;

        if (dv.fundCode !== batch.fundCode) {
          throw new HttpsError(
            'failed-precondition',
            `DV ${dv.dvNo} belongs to the ${dv.fundCode} fund but this ${batch.importType} covers ${batch.fundCode}.`,
          );
        }
        if (dv.status !== 'APPROVED' && dv.status !== 'PAID') {
          throw new HttpsError(
            'failed-precondition',
            `A payment can only be recorded against an approved voucher. DV ${dv.dvNo} is ${dv.status.toLowerCase()}.`,
          );
        }
        if (dv.checkId || dv.adaId) {
          throw new HttpsError(
            'failed-precondition',
            `DV ${dv.dvNo} already has a payment recorded against it.`,
          );
        }
        if (dv.netAmount !== Number(row.amount)) {
          throw new HttpsError(
            'failed-precondition',
            `The file shows ${peso(Number(row.amount))} for this row but DV ${dv.dvNo} is ${peso(dv.netAmount)} net. Correct the voucher, or set the row aside with a note.`,
          );
        }

        const serial = String(serialNo ?? row.serialNo ?? '').trim().toUpperCase();
        if (batch.importType === 'RCI' && !serial) {
          throw invalid('A check needs its number. Type the number written on the check.');
        }

        const sourceRef =
          batch.importType === 'RCI'
            ? db.collection(COL.checks).doc(`${batch.bankAccountId}__${serial}`)
            : db.collection(COL.ada).doc();

        if (batch.importType === 'RCI') {
          const existing = await tx.get(sourceRef);
          if (existing.exists) {
            throw new HttpsError(
              'already-exists',
              `Check number ${serial} is already recorded on this bank account. Check numbers are unique within an account.`,
            );
          }
        }

        const common = {
          fiscalYear: batch.fiscalYear,
          fundCode: batch.fundCode,
          bankAccountId: batch.bankAccountId,
          bankName: batch.bankName,
          bankAccountNumber: batch.bankAccountNumber,
          dvId: dvId!,
          dvNo: dv.dvNo,
          payeeId: dv.payeeId,
          payeeName: dv.payeeName,
          particulars: (row.particulars as string) || dv.particulars,
          importId,
          importLineNo: lineNo,
          obrNo: (row.obrNo as string) || dv.obrNo || null,
          createdBy: {
            uid: caller.uid,
            name: caller.name,
            position: caller.position ?? null,
            at: now,
          },
        };

        const date = String(row.date);

        if (batch.importType === 'RCI') {
          tx.create(sourceRef, {
            ...common,
            checkNo: serial,
            checkDate: date,
            grossAmount: dv.grossAmount,
            totalDeductions: dv.totalDeductions,
            netAmount: dv.netAmount,
            status: 'RELEASED',
            dateReleased: date,
          });
          tx.update(db.collection(COL.disbursementVouchers).doc(dvId!), {
            checkId: sourceRef.id,
            checkNo: serial,
            bankAccountId: batch.bankAccountId,
          });
        } else {
          tx.create(sourceRef, {
            ...common,
            adaNo: batch.adaNo,
            adaDate: date,
            amount: dv.netAmount,
            status: 'SUBMITTED',
            dateSubmittedToBank: date,
          });
          tx.update(db.collection(COL.disbursementVouchers).doc(dvId!), {
            adaId: sourceRef.id,
            adaNo: batch.adaNo,
            bankAccountId: batch.bankAccountId,
          });
        }

        const sourceNo = batch.importType === 'RCI' ? serial : (batch.adaNo ?? '');

        resolvedRow.status = 'MATCHED';
        resolvedRow.reason = null;
        resolvedRow.detail = null;
        resolvedRow.dvId = dvId;
        resolvedRow.dvNo = dv.dvNo;
        resolvedRow.sourceId = sourceRef.id;
        resolvedRow.sourceNo = sourceNo;
        resolvedRow.serialNo = batch.importType === 'RCI' ? serial : null;
        if (note?.trim()) resolvedRow.note = note.trim();

        lines = [
          ...lines,
          {
            sourceId: sourceRef.id,
            sourceNo,
            date,
            payeeName: dv.payeeName,
            particulars: (row.particulars as string) || dv.particulars,
            amount: dv.netAmount,
          },
        ];
        total += dv.netAmount;
      }

      const rows = [...batch.rows];
      rows[index] = resolvedRow;
      const pendingCount = rows.filter((r) => r.status === 'PENDING').length;
      const matchedCount = rows.filter((r) => r.status === 'MATCHED').length;
      const pendingTotal = rows
        .filter((r) => r.status === 'PENDING')
        .reduce((s, r) => s + Number(r.amount), 0);

      tx.update(importRef, {
        rows,
        pendingCount,
        matchedCount,
        pendingTotal,
        matchedTotal: total,
        status: pendingCount > 0 ? 'PENDING' : 'COMPLETE',
      });

      const serials = lines.map((l) => String(l.sourceNo)).sort();
      tx.update(reportRef, {
        lines,
        totalAmount: total,
        serialFrom: serials[0] ?? null,
        serialTo: serials[serials.length - 1] ?? null,
        // The entry follows the total. It is only a proposal - the Accountant
        // may replace it - but a proposal that no longer foots to the report is
        // worse than none.
        entry: rebuildEntry(report.entry, total),
        pendingRowCount: pendingCount,
      });

      recordTransition(tx, {
        caller,
        event: action === 'LINK' ? 'CREATE' : 'CANCEL',
        entityType: COL.treasuryImports,
        entityId: importId,
        entityRef: `${batch.importType} upload row ${lineNo}`,
        fiscalYear: batch.fiscalYear,
        fundCode: batch.fundCode,
        action: action === 'LINK' ? 'CREATE' : 'CANCEL',
        previousStatus: 'PENDING',
        newStatus: action === 'LINK' ? 'MATCHED' : 'MANUAL',
        remarks:
          action === 'LINK'
            ? `Linked to a voucher for ${peso(Number(row.amount))}.`
            : `Set aside: ${note!.trim()}`,
        severity: action === 'SET_ASIDE' ? 'NOTICE' : undefined,
      });

      return { importId, lineNo, pendingCount, totalAmount: total };
    });
  },
);

/** Keeps the proposed entry's two sides at the report's total. */
function rebuildEntry(
  entry: Array<{ debit: number; credit: number; [k: string]: unknown }> | undefined,
  total: number,
) {
  if (!entry?.length) return entry ?? [];
  return entry.map((line) => ({
    ...line,
    debit: line.debit > 0 ? total : 0,
    credit: line.credit > 0 ? total : 0,
  }));
}
