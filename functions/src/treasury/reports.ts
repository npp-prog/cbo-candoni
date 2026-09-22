import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import {
  requireCaller,
  notFound,
  invalid,
  assertFundInScope,
  type Caller,
  type Role,
} from '../lib/context';
import { recordTransition, notifyInTransaction } from '../lib/audit';
import { issueNumber, loadNumberingConfig, bookCodeForFund } from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import {
  createJevInTransaction,
  postJevInTransaction,
  type JevData,
  type JevLineData,
} from '../lib/ledger';

/**
 * Treasury reports: RCI, RADAI, RCD and RCDisb.
 *
 * How the two offices actually work, and therefore how this is built.
 *
 * The Treasurer's office prepares documents through the day. Checks are drawn
 * against approved vouchers; ADA are sent to the bank; official receipts are
 * issued and the cash deposited; a payroll officer pays a cash payroll. None of
 * that touches the General Ledger. At the end of the period the office batches
 * what it prepared into a report, the Treasurer certifies it, and it is
 * forwarded to Accounting. Accounting raises **one** Journal Entry Voucher from
 * the report and posts it.
 *
 * That last point is the one most likely to be got wrong by someone rebuilding
 * this. The JEV is per report, not per check. Twenty-five checks drawn on
 * Tuesday produce one RCI and one JEV in the Check Disbursements Journal,
 * footing to the report total. Raising a JEV per check would produce a journal
 * that no longer agrees line-for-line with the report the Accountant signed,
 * and would bury the Accountant in entries.
 *
 * The split of authority is deliberate and is enforced here, not merely
 * documented:
 *
 *   Treasury certifies   - owns the list. Which documents are in the report,
 *                          and that the report is complete and correct.
 *   Accounting journalizes - owns the entry. Which accounts are debited and
 *                          credited, and when it reaches the ledger.
 *
 * `certifyTreasuryReport` accepts only treasury roles; `journalizeTreasuryReport`
 * accepts only the Accountant. Neither can do the other's half. So cash cannot
 * move in the books on a Treasury action alone, and Accounting cannot quietly
 * add a check to a report the Treasurer certified.
 */

const TREASURY: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_TREASURER', 'TREASURY_STAFF'];

/**
 * Only the Municipal Accountant posts. Not the reviewer, not an encoder: this
 * is the act that puts a figure in the General Ledger.
 */
const ACCOUNTANT: Role[] = ['SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT'];

type ReportType = 'RCI' | 'RADAI' | 'RCD' | 'RCDISB';

interface ReportLine {
  sourceId: string;
  sourceNo: string;
  date: string;
  payeeName?: string | null;
  particulars?: string | null;
  amount: number;
  /** RCDisb only - the payroll figures behind the net, for the printed report. */
  gross?: number;
  deductions?: number;
  excluded?: boolean;
}

interface EntryLine {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  particulars?: string | null;
}

interface ReportDoc {
  reportType: ReportType;
  reportNo?: string;
  reportDate: string;
  fiscalYear: number;
  fundCode: string;
  bankAccountId?: string;
  bankName?: string;
  bankAccountNumber?: string;
  accountableOfficerId?: string;
  accountableOfficerName?: string;
  lines: ReportLine[];
  totalAmount: number;
  totalGross?: number;
  totalDeductions?: number;
  entry?: EntryLine[];
  status: string;
  jevId?: string;
}

/** Which collection each report type draws its documents from. */
const SOURCE_COLLECTION: Record<ReportType, string> = {
  RCI: COL.checks,
  RADAI: COL.ada,
  RCD: COL.collections,
  RCDISB: COL.payrolls,
};

/** The field on the source document that records which report claimed it. */
const SOURCE_REPORT_FIELD = 'treasuryReportId';

const JOURNAL_BOOK: Record<ReportType, string> = {
  RCI: 'CHECK_DISBURSEMENTS_JOURNAL',
  RADAI: 'ADA_DISBURSEMENTS_JOURNAL',
  RCD: 'CASH_RECEIPTS_JOURNAL',
  RCDISB: 'CASH_DISBURSEMENTS_JOURNAL',
};

const REPORT_LABEL: Record<ReportType, string> = {
  RCI: 'Report of Checks Issued',
  RADAI: 'Report of ADA Issued',
  RCD: 'Report of Collections and Deposits',
  RCDISB: 'Report of Cash Disbursement',
};

function assertReportType(value: unknown): ReportType {
  if (value === 'RCI' || value === 'RADAI' || value === 'RCD' || value === 'RCDISB') return value;
  throw invalid('Unknown treasury report type.');
}

function totalOf(lines: ReportLine[]): number {
  return lines.reduce((sum, l) => (l.excluded ? sum : sum + l.amount), 0);
}

function footings(entry: EntryLine[]): { debit: number; credit: number } {
  return entry.reduce(
    (acc, l) => ({ debit: acc.debit + (l.debit || 0), credit: acc.credit + (l.credit || 0) }),
    { debit: 0, credit: 0 },
  );
}

/**
 * certifyTreasuryReport - the Treasurer closes the report and forwards it.
 *
 * Everything that makes the report trustworthy is checked here, against the
 * source documents themselves rather than against what the browser sent:
 *
 *   - every listed document exists, belongs to this fund, and is not cancelled
 *   - no document is already claimed by another report; a check is reported
 *     once and only once, which is what stops a disbursement being journalized
 *     twice
 *   - the amounts on the report equal the amounts on the documents
 *
 * The report number is drawn here, not when the draft is created, so an
 * abandoned draft does not consume a number out of the statutory series.
 */
export const certifyTreasuryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, TREASURY);
    const { reportId } = (request.data ?? {}) as { reportId?: string };
    if (!reportId) throw invalid('A report id is required.');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.treasuryReports).doc(reportId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The treasury report');

      const report = snap.data() as ReportDoc;
      const type = assertReportType(report.reportType);
      const label = REPORT_LABEL[type];

      if (report.status !== 'DRAFT') {
        throw new HttpsError(
          'failed-precondition',
          `This ${label} is ${report.status.toLowerCase()} and can no longer be certified.`,
        );
      }

      assertFundInScope(caller, report.fundCode);

      const period = periodOf(report.reportDate);
      await assertFiscalYearOpen(report.fiscalYear, tx);
      await assertPeriodOpen(
        report.fiscalYear,
        period,
        report.fundCode,
        `${label} dated ${report.reportDate}`,
        tx,
      );

      const lines = (report.lines ?? []).filter((l) => !l.excluded);
      if (!lines.length) {
        throw invalid(`This ${label} lists no documents.`);
      }

      // ---- verify every covered document against its own record -----------

      const sourceCollection = SOURCE_COLLECTION[type];
      const sourceSnaps = await Promise.all(
        lines.map((l) => tx.get(db.collection(sourceCollection).doc(l.sourceId))),
      );

      let verifiedTotal = 0;
      /** RCDisb only: the payroll figures behind the total, for the report. */
      let verifiedGross = 0;
      let verifiedDeductions = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sourceSnap = sourceSnaps[i];

        if (!sourceSnap.exists) {
          throw invalid(
            `${line.sourceNo} is listed on this ${label} but its record no longer exists. Remove it from the report.`,
          );
        }

        const source = sourceSnap.data() as Record<string, unknown>;

        if (source.status === 'CANCELLED') {
          throw invalid(
            `${line.sourceNo} has been cancelled and must not be reported. Remove it from this ${label}.`,
          );
        }
        if (source.fundCode !== report.fundCode) {
          throw invalid(
            `${line.sourceNo} belongs to the ${String(source.fundCode)} fund but this ${label} covers ${report.fundCode}. Funds must not be commingled in one report.`,
          );
        }

        const claimedBy = source[SOURCE_REPORT_FIELD];
        if (typeof claimedBy === 'string' && claimedBy && claimedBy !== reportId) {
          throw invalid(
            `${line.sourceNo} has already been reported. A document is reported once only - otherwise the same disbursement reaches the General Ledger twice.`,
          );
        }

        // ---- a payroll on an RCDisb --------------------------------------
        //
        // The report prints gross, deductions and net, so all three are checked
        // against the payroll's own record - a printed report whose columns do
        // not add up is worse than no report. Only the net reaches the entry:
        // the RCDisb liquidates a cash advance, and the expense and the
        // deductions were recognised on the voucher that set the payroll up.
        if (type === 'RCDISB') {
          const gross = Number(source.totalGross);
          const deductions = Number(source.totalDeductions ?? 0);
          const net = Number(source.totalNet);

          if (!Number.isFinite(gross) || !Number.isFinite(net)) {
            throw invalid(`Payroll ${line.sourceNo} has no gross or net recorded against it.`);
          }
          if (gross - deductions !== net) {
            throw invalid(
              `Payroll ${line.sourceNo} does not add up on its own record: ${(gross / 100).toFixed(2)} less ${(deductions / 100).toFixed(2)} is not ${(net / 100).toFixed(2)}. Correct the payroll before reporting it.`,
            );
          }
          if (Math.round(line.gross ?? 0) !== gross || Math.round(line.deductions ?? 0) !== deductions) {
            throw invalid(
              `Payroll ${line.sourceNo} shows a different gross or deductions on this ${label} than on its own record. Rebuild the report from the payrolls.`,
            );
          }
          if (net !== line.amount) {
            throw invalid(
              `Payroll ${line.sourceNo} is ${(net / 100).toFixed(2)} net on its own record but ${(line.amount / 100).toFixed(2)} on this ${label}.`,
            );
          }

          verifiedGross += gross;
          verifiedDeductions += deductions;
          verifiedTotal += net;
          continue;
        }

        // The amount that actually left, taken from the document, not the report.
        const amount =
          typeof source.netAmount === 'number'
            ? source.netAmount
            : typeof source.amount === 'number'
              ? source.amount
              : typeof source.totalAmount === 'number'
                ? source.totalAmount
                : typeof source.netPay === 'number'
                  ? source.netPay
                  : NaN;

        if (!Number.isFinite(amount)) {
          throw invalid(`${line.sourceNo} has no amount recorded against it.`);
        }
        if (amount !== line.amount) {
          throw invalid(
            `${line.sourceNo} is ${(amount / 100).toFixed(2)} on its own record but ${(line.amount / 100).toFixed(2)} on this ${label}. Rebuild the report from the documents.`,
          );
        }

        verifiedTotal += amount;
      }

      if (verifiedTotal !== report.totalAmount) {
        throw invalid(
          `The documents listed total ${(verifiedTotal / 100).toFixed(2)} but the ${label} states ${(report.totalAmount / 100).toFixed(2)}.`,
        );
      }

      // ---- the proposed entry ---------------------------------------------

      const entry = report.entry ?? [];
      if (!entry.length) {
        throw invalid(
          `This ${label} carries no proposed accounting entry. It cannot be forwarded to Accounting without one.`,
        );
      }
      const foot = footings(entry);
      if (foot.debit !== foot.credit) {
        throw invalid(
          `The proposed entry does not balance: debits ${(foot.debit / 100).toFixed(2)}, credits ${(foot.credit / 100).toFixed(2)}.`,
        );
      }
      if (foot.debit !== verifiedTotal) {
        throw invalid(
          `The proposed entry is for ${(foot.debit / 100).toFixed(2)} but the documents total ${(verifiedTotal / 100).toFixed(2)}.`,
        );
      }

      // ---- number, lock the documents, forward ----------------------------

      const bookCode = await bookCodeForFund(report.fundCode);
      const numbering = await loadNumberingConfig(type);
      const reportNo =
        report.reportNo ??
        (await issueNumber(tx, numbering, {
          bookCode,
          fundCode: report.fundCode,
          fiscalYear: report.fiscalYear,
          month: period,
        }));

      const now = new Date().toISOString();

      for (const line of lines) {
        tx.update(db.collection(sourceCollection).doc(line.sourceId), {
          [SOURCE_REPORT_FIELD]: reportId,
          treasuryReportNo: reportNo,
          treasuryReportType: type,
        });
      }

      const serials = lines.map((l) => l.sourceNo).sort();

      tx.update(ref, {
        reportNo,
        period,
        status: 'CERTIFIED',
        serialFrom: serials[0],
        serialTo: serials[serials.length - 1],
        totalAmount: verifiedTotal,
        ...(type === 'RCDISB'
          ? { totalGross: verifiedGross, totalDeductions: verifiedDeductions }
          : {}),
        certifiedAt: now,
        certifiedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      notifyInTransaction(tx, {
        recipientRole: 'MUNICIPAL_ACCOUNTANT',
        kind: 'TREASURY_REPORT_FORWARDED',
        title: `${type} ${reportNo} forwarded for journalizing`,
        body: `${label} ${reportNo} covering ${lines.length} document${lines.length === 1 ? '' : 's'}, ${(verifiedTotal / 100).toFixed(2)}, has been certified and is awaiting its journal entry.`,
        entityType: COL.treasuryReports,
        entityId: reportId,
        link: `/accounting/treasury-reports/${reportId}`,
        severity: 'INFO',
      });

      recordTransition(tx, {
        caller,
        event: 'CERTIFY',
        entityType: COL.treasuryReports,
        entityId: reportId,
        entityRef: `${type} ${reportNo}`,
        fiscalYear: report.fiscalYear,
        fundCode: report.fundCode,
        action: 'CERTIFY',
        previousStatus: 'DRAFT',
        newStatus: 'CERTIFIED',
        assignedToRole: 'MUNICIPAL_ACCOUNTANT',
        remarks: `${lines.length} documents, ${(verifiedTotal / 100).toFixed(2)}.`,
      });

      return { reportId, reportNo, totalAmount: verifiedTotal, documentCount: lines.length };
    });
  },
);

/**
 * journalizeTreasuryReport - the Accountant raises the JEV and posts it.
 *
 * The entry is the Accountant's to decide, so an adjusted entry may be supplied
 * and it replaces the report's proposal. What the Accountant may not do is
 * change the amount: the entry must still foot to the certified total. That
 * keeps the journal in agreement with the report the Treasurer signed, which is
 * the whole point of having the report.
 *
 * Creation and posting happen in the same transaction. There is no state in
 * which a report is journalized but its entry is sitting unposted - a gap that
 * would show up as a trial balance that does not agree with the registers.
 */
export const journalizeTreasuryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, ACCOUNTANT);
    const { reportId, entry: adjustedEntry } = (request.data ?? {}) as {
      reportId?: string;
      entry?: EntryLine[];
    };
    if (!reportId) throw invalid('A report id is required.');

    const jevConfig = await loadNumberingConfig('JEV');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.treasuryReports).doc(reportId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The treasury report');

      const report = snap.data() as ReportDoc;
      const type = assertReportType(report.reportType);
      const label = REPORT_LABEL[type];

      if (report.status === 'JOURNALIZED') {
        throw new HttpsError(
          'failed-precondition',
          `${type} ${report.reportNo} has already been journalized as JEV ${report.jevId ? '' : ''}${report.reportNo}. To correct it, reverse that journal entry.`,
        );
      }
      if (report.status !== 'CERTIFIED') {
        throw new HttpsError(
          'failed-precondition',
          `${label} ${report.reportNo ?? ''} is ${report.status.toLowerCase()}. Only a report the Treasurer has certified can be journalized.`,
        );
      }
      if (!report.reportNo) {
        throw invalid('This report has no number and cannot be journalized.');
      }

      const period = periodOf(report.reportDate);
      await assertFiscalYearOpen(report.fiscalYear, tx);
      await assertPeriodOpen(
        report.fiscalYear,
        period,
        report.fundCode,
        `${label} ${report.reportNo}`,
        tx,
      );

      const entry = adjustedEntry?.length ? adjustedEntry : (report.entry ?? []);
      if (!entry.length) throw invalid('The journal entry has no lines.');

      for (const line of entry) {
        if (!line.accountCode) throw invalid('Every line of the entry needs an account.');
        if ((line.debit || 0) < 0 || (line.credit || 0) < 0) {
          throw invalid('A journal line cannot carry a negative debit or credit.');
        }
        if ((line.debit || 0) > 0 && (line.credit || 0) > 0) {
          throw invalid(
            `Account ${line.accountCode} carries both a debit and a credit on one line. Split it into two lines.`,
          );
        }
      }

      const foot = footings(entry);
      if (foot.debit !== foot.credit) {
        throw invalid(
          `The entry does not balance: debits ${(foot.debit / 100).toFixed(2)}, credits ${(foot.credit / 100).toFixed(2)}.`,
        );
      }
      if (foot.debit !== report.totalAmount) {
        throw invalid(
          `The entry is for ${(foot.debit / 100).toFixed(2)} but ${type} ${report.reportNo} was certified at ${(report.totalAmount / 100).toFixed(2)}. The journal entry must agree with the report.`,
        );
      }

      const bookCode = await bookCodeForFund(report.fundCode);
      const jevNo = await issueNumber(tx, jevConfig, {
        bookCode,
        fundCode: report.fundCode,
        fiscalYear: report.fiscalYear,
        month: period,
      });

      const jevLines: JevLineData[] = entry.map((l, i) => ({
        lineNo: i + 1,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: l.debit || 0,
        credit: l.credit || 0,
        officeId: null,
        officeName: null,
        responsibilityCenterId: null,
        subsidiaryType: null,
        subsidiaryId: null,
        subsidiaryName: null,
        cashFlowClass: 'OPERATING',
        particulars: l.particulars ?? `Per ${type} ${report.reportNo}`,
      }));

      const particulars = `${label} ${report.reportNo} - ${report.lines.filter((l) => !l.excluded).length} documents`;

      const jevData: JevData = {
        jevNo,
        jevDate: report.reportDate,
        fiscalYear: report.fiscalYear,
        period,
        fundCode: report.fundCode,
        book: JOURNAL_BOOK[type],
        sourceType: type,
        sourceId: reportId,
        referenceNo: report.reportNo,
        particulars,
        lines: jevLines,
        totalDebit: foot.debit,
        totalCredit: foot.credit,
        status: 'DRAFT',
      };

      const { jevId } = createJevInTransaction(tx, caller, jevData);
      postJevInTransaction(tx, caller, jevId, jevData);

      const now = new Date().toISOString();

      tx.update(ref, {
        status: 'JOURNALIZED',
        entry,
        jevId,
        jevNo,
        journalizedAt: now,
        postedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      recordTransition(tx, {
        caller,
        event: 'POST',
        entityType: COL.treasuryReports,
        entityId: reportId,
        entityRef: `${type} ${report.reportNo}`,
        fiscalYear: report.fiscalYear,
        fundCode: report.fundCode,
        action: 'POST',
        previousStatus: 'CERTIFIED',
        newStatus: 'JOURNALIZED',
        remarks: `JEV ${jevNo}, ${(foot.debit / 100).toFixed(2)}.`,
      });

      return { reportId, reportNo: report.reportNo, jevId, jevNo };
    });
  },
);

/**
 * cancelTreasuryReport - withdraws a report and releases its documents.
 *
 * Refused once journalized. At that point the entry is in the General Ledger,
 * and the honest correction is a reversing entry dated today, not the quiet
 * disappearance of a report the Accountant signed and the ledger relied on.
 */
export const cancelTreasuryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, TREASURY);
    const { reportId, reason } = (request.data ?? {}) as { reportId?: string; reason?: string };
    if (!reportId) throw invalid('A report id is required.');
    if (!reason?.trim()) throw invalid('A reason for withdrawing the report is required.');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.treasuryReports).doc(reportId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The treasury report');

      const report = snap.data() as ReportDoc;
      const type = assertReportType(report.reportType);

      if (report.status === 'JOURNALIZED') {
        throw new HttpsError(
          'failed-precondition',
          `${type} ${report.reportNo} has been journalized and is in the General Ledger. Reverse its journal entry instead - Accounting, Journal Entry Voucher, Reverse. A report the ledger has relied on is not withdrawn.`,
        );
      }
      if (report.status === 'CANCELLED') {
        throw new HttpsError('failed-precondition', 'This report is already withdrawn.');
      }

      const sourceCollection = SOURCE_COLLECTION[type];
      const now = new Date().toISOString();

      for (const line of report.lines ?? []) {
        tx.update(db.collection(sourceCollection).doc(line.sourceId), {
          [SOURCE_REPORT_FIELD]: null,
          treasuryReportNo: null,
          treasuryReportType: null,
        });
      }

      tx.update(ref, {
        status: 'CANCELLED',
        cancelledReason: reason.trim(),
        cancelledBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      recordTransition(tx, {
        caller,
        event: 'CANCEL',
        entityType: COL.treasuryReports,
        entityId: reportId,
        entityRef: `${type} ${report.reportNo ?? '(unnumbered)'}`,
        fiscalYear: report.fiscalYear,
        fundCode: report.fundCode,
        action: 'CANCEL',
        previousStatus: report.status,
        newStatus: 'CANCELLED',
        remarks: reason.trim(),
        severity: 'NOTICE',
      });

      return { reportId };
    });
  },
);

/** Exposed for the unit tests, which exercise the arithmetic without Firestore. */
export const __test = { totalOf, footings };
