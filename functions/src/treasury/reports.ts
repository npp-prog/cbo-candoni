import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from '../lib/callable';
import { ENFORCE_APP_CHECK, db, COL, REGION } from '../lib/firebase';
import {
  requireCaller,
  notFound,
  invalid,
  assertFundInScope,
  type Role,
} from '../lib/context';
import { recordTransition, notifyInTransaction } from '../lib/audit';
import {
  issueNumber,
  loadNumberingConfig,
  bookCodeForFund,
  reserveDocumentNumber,
} from '../lib/numbering';
import { assertPeriodOpen, assertFiscalYearOpen, periodOf } from '../lib/period';
import { collectionBelongsOnReport, isECollectionReportType } from '../lib/eCollections';
import {
  TREASURY_SOURCE_COLLECTION,
  TREASURY_SOURCE_REPORT_FIELD,
} from '../lib/treasurySources';
import { renumberPaymentEntry } from '../lib/treasuryEntry';
import { CASH_LOCAL_TREASURY } from '../lib/chartOfAccounts';
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

type ReportType =
  | 'RCI'
  | 'RADAI'
  | 'RCD'
  | 'RCDISB'
  /*
   * COA Circular 2021-014's reports of electronic money, added in patch 91.
   * Two of the three: Annex G is for an agency that issues no receipt when a
   * payor pays its bank account directly, and Candoni issues an eOR, so that
   * money is an eOR collection. See lib/eCollections. They reuse this whole file rather than getting an engine of their own,
   * and that is the point: certify -> journalize, the attachment lock, the
   * document claim, the numbering and the handover to Accounting are the same
   * controls. A second implementation would be a second set of them, and the
   * second set is always the one that is missing a check.
   */
  | 'ERCD_AR'
  | 'ERCD_EOR';

const REPORT_TYPES: ReportType[] = [
  'RCI',
  'RADAI',
  'RCD',
  'RCDISB',
  'ERCD_AR',
  'ERCD_EOR',
];

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
  /** The subsidiary ledger the line belongs to, when the account has one. */
  subsidiaryType?: string | null;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
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
  /**
   * Patch 157 - RCD only: the deposits this report accounts for (Section B).
   *
   * An RCD may carry collections only, deposits only, or both: the collector
   * reports the day's receipts, and the Liquidating Officer banks them -
   * sometimes a week later - on a report of their own. A deposit is booked
   * when it is recorded (Deposits, Post: Dr Cash in Bank / Cr Cash - Local
   * Treasury); the RCD reports it. So the deposits are not in the RCD's
   * entry, and an RCD of deposits only has no entry at all.
   */
  deposits?: Array<{ sourceId: string; depositSlipNo?: string; date?: string; amount: number }>;
  totalDeposits?: number;
  /**
   * Patch 159: the part of the deposits this RCD's entry books (Dr Cash in
   * Bank / Cr Cash - Local Treasury) - every deposit not booked before. Set,
   * from the deposits' own records, when the report is certified.
   */
  depositsBookedTotal?: number;
  /**
   * Patch 161 - RCD only, Section A.2: the collectors' remittances the
   * Liquidating Officer received and reports. They move accountability from
   * the collector to the Liquidating Officer; they book nothing.
   */
  remittances?: Array<{
    sourceId: string;
    collectorName?: string;
    collectorReportNo?: string | null;
    date?: string;
    amount: number;
  }>;
  totalRemittances?: number;
  status: string;
  /**
   * Patch 143. Certifying and forwarding are two acts. A report certified
   * from patch 143 on carries `forwardedAt: null` until the Treasurer forwards
   * it; a report certified before carries no field at all, and was forwarded
   * in the same act.
   */
  forwardedAt?: string | null;
  jevId?: string;
  /** Set when the report was built from an uploaded RCI or RADAI file. */
  importId?: string;
  pendingRowCount?: number;
}

/*
 * Which collection each report type draws its documents from, and the field on
 * that document which records the claim.
 *
 * BOTH NOW COME FROM THE SHARED FILE. They were written out here, and from
 * patch 106 the browser needs the same mapping - a line of a report is
 * clickable and opens the document it covers, which means knowing which
 * register to look in. Two copies of this would not raise an error if they
 * drifted: a report type added here with a new register would be claimed
 * correctly and read from the wrong one by the screen, which would then
 * report the document "no longer in CFMS". The build compares the two copies
 * of the file and fails if they differ.
 */
const SOURCE_COLLECTION: Record<ReportType, string> = TREASURY_SOURCE_COLLECTION;

const SOURCE_REPORT_FIELD = TREASURY_SOURCE_REPORT_FIELD;

const JOURNAL_BOOK: Record<ReportType, string> = {
  RCI: 'CHECK_DISBURSEMENTS_JOURNAL',
  RADAI: 'ADA_DISBURSEMENTS_JOURNAL',
  RCD: 'CASH_RECEIPTS_JOURNAL',
  RCDISB: 'CASH_DISBURSEMENTS_JOURNAL',
  // The Cash Receipts Journal, the same book the RCD posts to. Money received
  // is money received; a separate journal for the electronic kind would split
  // the municipality's receipts across two books for no reason the GAM gives.
  ERCD_AR: 'CASH_RECEIPTS_JOURNAL',
  ERCD_EOR: 'CASH_RECEIPTS_JOURNAL',
};

const REPORT_LABEL: Record<ReportType, string> = {
  RCI: 'Report of Checks Issued',
  RADAI: 'Report of ADA Issued',
  RCD: 'Report of Collections and Deposits',
  RCDISB: 'Report of Cash Disbursement',
  ERCD_AR: 'Report of e-Collections and Deposits (by Intermediary)',
  ERCD_EOR: 'Report of e-Collections and Deposits',
};

function assertReportType(value: unknown): ReportType {
  if (typeof value === 'string' && (REPORT_TYPES as string[]).includes(value)) {
    return value as ReportType;
  }
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
    const { reportId, reportNo: reportNoIn } = (request.data ?? {}) as {
      reportId?: string;
      /**
       * The number the Treasurer assigns, typed at the moment of certifying.
       * It overrides whatever the draft carries, so a mistyped number can be
       * corrected here rather than by discarding the report and rebuilding it.
       */
      reportNo?: string;
    };
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

      /*
       * THE SIGNED FORM MUST BE ON THE RECORD BEFORE THE CERTIFICATE.
       *
       * Certifying forwards the report to Accounting, locks every document it
       * covers to it, and reserves its number. All three are hard to undo and
       * the first one puts another office to work.
       *
       * What CFMS holds is an ENCODING of the report. The signed copy is the
       * evidence that the encoding is true, and the Treasurer's certificate is
       * a statement about that paper. A certificate issued before anybody has
       * put the paper on the record is a statement about nothing - and the
       * practical result, every time, is that the file is attached later if at
       * all, because the thing that needed it has already happened.
       *
       * Read inside the transaction, so a report cannot be certified in the
       * instant between the check and the commit. The browser disables the
       * button for the same reason; the browser is not the authority.
       */
      const attached = await tx.get(
        db
          .collection(COL.documents)
          .where('entityType', '==', COL.treasuryReports)
          .where('entityId', '==', reportId)
          .where('active', '==', true)
          .limit(1),
      );
      if (attached.empty) {
        throw new HttpsError(
          'failed-precondition',
          `Attach the signed ${label} before certifying. Certifying locks the documents it covers to it and reserves its number; the signed copy is the evidence that what CFMS holds is what was signed.`,
        );
      }

      /**
       * A report built from an upload cannot be certified while rows of that
       * upload are still held.
       *
       * The upload is deliberately lenient - a row naming a voucher CFMS cannot
       * find is held rather than rejecting the whole file - and this is what
       * keeps that leniency honest. The report is a signed statement of what the
       * office paid, and it is made from a file that said so. Certifying it with
       * rows still unplaced would forward a report footing to less than the
       * paper it was made from, with the difference recorded nowhere anybody
       * would look.
       *
       * Each held row is either linked to its voucher or set aside with a note
       * saying how it was handled. Both are answers; leaving it is not.
       */
      const pending = report.pendingRowCount ?? 0;
      if (pending > 0) {
        throw new HttpsError(
          'failed-precondition',
          `${pending} row${pending === 1 ? '' : 's'} of the uploaded file could not be matched to a voucher and ${pending === 1 ? 'is' : 'are'} still waiting. Open the upload, and for each one either link it to the voucher it paid or set it aside with a note saying how it was handled. This ${label} covers the whole file or it covers nothing.`,
        );
      }

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
      const depositLines = type === 'RCD' ? (report.deposits ?? []) : [];
      if (!lines.length && !depositLines.length && !(report.remittances ?? []).length) {
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

        /*
         * ---- A COLLECTION MUST BE ON ITS OWN REPORT ----------------------
         *
         * The RCD and the three e-collection reports all draw on `collections`
         * and are divided only by the kind recorded on the document. The
         * screen filters the list it offers, but the screen is not the
         * authority - the browser could send any collection id in this fund.
         *
         * What the mismatch would cost: a GCash receipt certified onto the
         * Report of Collections and Deposits is claimed by it, so the eRCD
         * that should have carried it can never list it again. The eRCD then
         * foots to less than the intermediary's remittance, the Treasurer
         * signs a certificate that is untrue, and the only visible symptom is
         * a bank reconciliation that will not close.
         *
         * Both sides normalise to null, so a collection recorded before patch
         * 91 - no kind field at all - is a counter receipt and belongs on the
         * RCD. Which is what it is.
         */
        if (type === 'RCD' || isECollectionReportType(type)) {
          const kind = source.eCollectionKind as string | null | undefined;
          if (!collectionBelongsOnReport(type, kind)) {
            throw invalid(
              kind
                ? `${line.sourceNo} was received electronically (${kind}) and belongs on its own COA Circular 2021-014 report, not on this ${label}. Remove it and report it under Treasury, Collections and Deposits, e-Collections and Deposits.`
                : `${line.sourceNo} was received over the counter and belongs on the Report of Collections and Deposits, not on this ${label}. Remove it from this report.`,
            );
          }
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

      // ---- patch 157: the deposits an RCD reports -------------------------
      const depositSnaps = await Promise.all(
        depositLines.map((d) => tx.get(db.collection(COL.deposits).doc(d.sourceId))),
      );
      let verifiedDeposits = 0;
      let verifiedToBook = 0;
      for (let i = 0; i < depositLines.length; i++) {
        const d = depositLines[i];
        const ds = depositSnaps[i];
        const no = d.depositSlipNo || 'A deposit';
        if (!ds.exists) throw invalid(`Deposit ${no} on this RCD no longer exists. Remove it.`);
        const dep = ds.data() as {
          status?: string;
          fundCode?: string;
          amount?: number;
          jevId?: string;
          treasuryReportId?: string;
        };
        if (dep.status === 'CANCELLED') {
          throw invalid(`Deposit ${no} is cancelled and must not be reported. Remove it from this RCD.`);
        }
        if (dep.fundCode !== report.fundCode) {
          throw invalid(`Deposit ${no} belongs to the ${String(dep.fundCode)} fund, not ${report.fundCode}.`);
        }
        if (dep.treasuryReportId && dep.treasuryReportId !== reportId) {
          throw invalid(`Deposit ${no} has already been reported on another RCD. A deposit is reported once.`);
        }
        if (Number(dep.amount) !== d.amount) {
          throw invalid(
            `Deposit ${no} is ${(Number(dep.amount) / 100).toFixed(2)} on its own record but ${(d.amount / 100).toFixed(2)} on this RCD. Prepare the RCD again.`,
          );
        }
        verifiedDeposits += d.amount;
        // Patch 159: booked by this RCD unless it was posted on its own before.
        if (!dep.jevId) verifiedToBook += d.amount;
      }

      // ---- patch 161: the remittances received (Section A.2) --------------
      const remittanceLines = type === 'RCD' ? (report.remittances ?? []) : [];
      const remittanceSnaps = await Promise.all(
        remittanceLines.map((r) => tx.get(db.collection(COL.collectionRemittances).doc(r.sourceId))),
      );
      let verifiedRemittances = 0;
      for (let i = 0; i < remittanceLines.length; i++) {
        const r = remittanceLines[i];
        const rs = remittanceSnaps[i];
        const who = r.collectorName || 'A collector';
        if (!rs.exists) throw invalid(`The remittance of ${who} on this RCD no longer exists. Remove it.`);
        const rem = rs.data() as {
          status?: string;
          fundCode?: string;
          amount?: number;
          liquidatingOfficerId?: string;
          liquidatingReportId?: string;
        };
        if (rem.status === 'CANCELLED') {
          throw invalid(`The remittance of ${who} is cancelled and must not be reported. Remove it.`);
        }
        if (rem.fundCode !== report.fundCode) {
          throw invalid(`The remittance of ${who} belongs to the ${String(rem.fundCode)} fund, not ${report.fundCode}.`);
        }
        if (rem.liquidatingReportId && rem.liquidatingReportId !== reportId) {
          throw invalid(`The remittance of ${who} is already reported on another RCD. A remittance is reported once.`);
        }
        if (report.accountableOfficerId && rem.liquidatingOfficerId !== report.accountableOfficerId) {
          throw invalid(
            `The remittance of ${who} was received by another officer, not by ${report.accountableOfficerName ?? 'the officer of this RCD'}. It is reported on the RCD of the officer who received it.`,
          );
        }
        if (Number(rem.amount) !== r.amount) {
          throw invalid(
            `The remittance of ${who} is ${(Number(rem.amount) / 100).toFixed(2)} on its own record but ${(r.amount / 100).toFixed(2)} on this RCD. Prepare the RCD again.`,
          );
        }
        verifiedRemittances += r.amount;
      }

      /*
       * Patch 161: NO DEPOSIT WITHOUT THE MONEY. An officer deposits only what
       * is in their hands: what they collected on this RCD, what collectors
       * remitted to them on it, and what was left undeposited on their earlier
       * RCDs.
       */
      if (type === 'RCD' && verifiedDeposits > 0) {
        let carried = 0;
        if (report.accountableOfficerId) {
          const earlier = await tx.get(
            db
              .collection(COL.treasuryReports)
              .where('accountableOfficerId', '==', report.accountableOfficerId)
              .where('reportType', '==', 'RCD'),
          );
          for (const d of earlier.docs) {
            if (d.id === reportId) continue;
            const e = d.data() as {
              status?: string;
              fundCode?: string;
              totalAmount?: number;
              totalRemittances?: number;
              totalDeposits?: number;
            };
            if (e.fundCode !== report.fundCode) continue;
            if (e.status !== 'CERTIFIED' && e.status !== 'JOURNALIZED') continue;
            carried +=
              Number(e.totalAmount ?? 0) + Number(e.totalRemittances ?? 0) - Number(e.totalDeposits ?? 0);
          }
        }
        const available = Math.max(0, carried) + verifiedTotal + verifiedRemittances;
        if (verifiedDeposits > available) {
          throw invalid(
            `The deposits on this RCD (${(verifiedDeposits / 100).toFixed(2)}) are more than the officer holds: ${(available / 100).toFixed(2)} - collections ${(verifiedTotal / 100).toFixed(2)}, remittances received ${(verifiedRemittances / 100).toFixed(2)}, undeposited from earlier RCDs ${(Math.max(0, carried) / 100).toFixed(2)}. A deposit is made from a remittance in Section A.2 (or the officer's own collections).`,
          );
        }
      }

      // ---- the proposed entry ---------------------------------------------

      const entry = report.entry ?? [];
      /*
       * Patch 157 / 159. An RCD's entry books its collections AND the
       * deposits on it not booked before (Dr Cash in Bank / Cr Cash - Local
       * Treasury). Only an RCD of deposits that were all posted on their own,
       * before patch 159, has no entry.
       */
      const nothingToBook = type === 'RCD' && lines.length === 0 && verifiedToBook === 0;
      if (nothingToBook && entry.length) {
        throw invalid('An RCD of deposits already in the books carries no entry.');
      }
      if (!nothingToBook && !entry.length) {
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
      if (foot.debit !== verifiedTotal + verifiedToBook) {
        throw invalid(
          verifiedToBook
            ? `The proposed entry is for ${(foot.debit / 100).toFixed(2)} but the collections (${(verifiedTotal / 100).toFixed(2)}) and the deposits it books (${(verifiedToBook / 100).toFixed(2)}) come to ${((verifiedTotal + verifiedToBook) / 100).toFixed(2)}.`
            : `The proposed entry is for ${(foot.debit / 100).toFixed(2)} but the documents total ${(verifiedTotal / 100).toFixed(2)}.`,
        );
      }
      // The deposits leave the officer's hands: Cash - Local Treasury is
      // credited by exactly what they bank.
      if (type === 'RCD' && verifiedToBook > 0) {
        const cltCredits = entry
          .filter((l) => l.accountCode === CASH_LOCAL_TREASURY.code)
          .reduce((t, l) => t + (l.credit || 0), 0);
        if (cltCredits !== verifiedToBook) {
          throw invalid(
            `The deposits on this RCD come to ${(verifiedToBook / 100).toFixed(2)}, and the entry credits Cash - Local Treasury with ${(cltCredits / 100).toFixed(2)}. Prepare the RCD again.`,
          );
        }
      }

      // ---- number, lock the documents, forward ----------------------------

      /*
       * The report number is the one the Treasurer's office wrote in its own
       * book, typed on the draft. CFMS does not issue it; it refuses a
       * duplicate. See reserveDocumentNumber.
       */
      const reportNo = await reserveDocumentNumber(tx, {
        kind: type,
        fiscalYear: report.fiscalYear,
        fundCode: report.fundCode,
        number: reportNoIn ?? report.reportNo ?? '',
        documentId: reportId,
        label,
      });

      const now = new Date().toISOString();

      for (const line of lines) {
        tx.update(db.collection(sourceCollection).doc(line.sourceId), {
          [SOURCE_REPORT_FIELD]: reportId,
          treasuryReportNo: reportNo,
          treasuryReportType: type,
        });
      }

      // Patch 157: the deposits are claimed by this report, as the receipts are.
      for (const d of depositLines) {
        tx.update(db.collection(COL.deposits).doc(d.sourceId), {
          treasuryReportId: reportId,
          treasuryReportNo: reportNo,
          treasuryReportType: type,
        });
      }
      // Patch 161: and the remittances it reports, received by its officer.
      for (const r of remittanceLines) {
        tx.update(db.collection(COL.collectionRemittances).doc(r.sourceId), {
          liquidatingReportId: reportId,
          liquidatingReportNo: reportNo,
        });
      }

      const serials = lines.map((l) => l.sourceNo).sort();

      tx.update(ref, {
        reportNo,
        period,
        status: 'CERTIFIED',
        /*
         * Patch 147. The RCI's Cash in Bank lines read "Payment of RCI <no>
         * Check No. ...". The number is only fixed now - an uploaded RCI has
         * none until it is certified, and the Treasurer may correct a typed
         * one - so the lines are given the number the report is certified as.
         */
        ...(type === 'RCI' && report.entry?.length
          ? { entry: renumberPaymentEntry(report.entry, type, reportNo) }
          : {}),
        serialFrom: serials[0] ?? null,
        serialTo: serials[serials.length - 1] ?? null,
        totalAmount: verifiedTotal,
        ...(type === 'RCD'
          ? {
              totalDeposits: verifiedDeposits,
              depositsBookedTotal: verifiedToBook,
              totalRemittances: verifiedRemittances,
            }
          : {}),
        ...(type === 'RCDISB'
          ? { totalGross: verifiedGross, totalDeductions: verifiedDeductions }
          : {}),
        /*
         * THE SIGNED FORM IS FIXED HERE.
         *
         * Certifying forwards the report to Accounting and locks every
         * document it covers to it. The certificate is a statement ABOUT the
         * attached paper, so paper that can still be taken off the record
         * afterwards would make the certificate a statement about nothing.
         *
         * The same field certifyObligation and the manual closing write.
         */
        attachmentsLockedAt: now,
        attachmentsLockedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
        certifiedAt: now,
        certifiedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
        /*
         * Patch 143: certified is not forwarded. Accounting receives the
         * report only when the Treasurer forwards it (forwardTreasuryReport).
         */
        forwardedAt: null,
        forwardedBy: null,
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
        remarks: `${lines.length} documents, ${(verifiedTotal / 100).toFixed(2)}. Not yet forwarded to Accounting.`,
      });

      return { reportId, reportNo, totalAmount: verifiedTotal, documentCount: lines.length };
    });
  },
);

/**
 * forwardTreasuryReport - patch 143. The Treasurer forwards a CERTIFIED
 * report to Accounting.
 *
 * Neil: "Separate the Certify and Forward to Accounting. It doesn't mean
 * certified is automatically forwarded to accounting." Certifying is the
 * Treasurer's statement about the report; forwarding is handing it to another
 * office. Accounting sees the report - and can journalize it - only from here.
 */
export const forwardTreasuryReport = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (request) => {
    const caller = await requireCaller(request, TREASURY);
    const { reportId } = (request.data ?? {}) as { reportId?: string };
    if (!reportId) throw invalid('A report id is required.');

    return db.runTransaction(async (tx) => {
      const ref = db.collection(COL.treasuryReports).doc(reportId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('The treasury report');
      const report = snap.data() as ReportDoc & { reportNo?: string; totalAmount?: number };
      const type = assertReportType(report.reportType);
      const label = REPORT_LABEL[type];
      assertFundInScope(caller, report.fundCode);

      if (report.status !== 'CERTIFIED') {
        throw new HttpsError(
          'failed-precondition',
          `This ${label} is ${report.status.toLowerCase()}. Only a certified report is forwarded to Accounting.`,
        );
      }
      if (report.forwardedAt !== null) {
        throw new HttpsError(
          'failed-precondition',
          `${type} ${report.reportNo ?? ''} has already been forwarded to Accounting.`,
        );
      }

      const now = new Date().toISOString();
      tx.update(ref, {
        forwardedAt: now,
        forwardedBy: {
          uid: caller.uid,
          name: caller.name,
          position: caller.position ?? null,
          at: now,
        },
      });

      const count = (report.lines ?? []).filter((l) => !l.excluded).length;
      notifyInTransaction(tx, {
        recipientRole: 'MUNICIPAL_ACCOUNTANT',
        kind: 'TREASURY_REPORT_FORWARDED',
        title: `${type} ${report.reportNo ?? ''} forwarded for journalizing`,
        body: `${label} ${report.reportNo ?? ''} covering ${count} document${count === 1 ? '' : 's'}, ${((report.totalAmount ?? 0) / 100).toFixed(2)}, has been certified and forwarded, and is awaiting its journal entry.`,
        entityType: COL.treasuryReports,
        entityId: reportId,
        link: `/accounting/treasury-reports/${reportId}`,
        severity: 'INFO',
      });

      recordTransition(tx, {
        caller,
        event: 'SUBMIT',
        entityType: COL.treasuryReports,
        entityId: reportId,
        entityRef: `${type} ${report.reportNo ?? ''}`,
        fiscalYear: report.fiscalYear,
        fundCode: report.fundCode,
        action: 'FORWARD',
        previousStatus: 'CERTIFIED',
        newStatus: 'CERTIFIED',
        assignedToRole: 'MUNICIPAL_ACCOUNTANT',
        remarks: 'Forwarded to Accounting for journalizing.',
      });

      return { reportId };
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
      if (report.forwardedAt === null) {
        throw new HttpsError(
          'failed-precondition',
          `${label} ${report.reportNo ?? ''} is certified but has not been forwarded to Accounting yet. The Treasurer forwards it first.`,
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

      /*
       * Patch 157. An RCD of DEPOSITS ONLY has nothing to journalize: each
       * deposit on it was booked when it was recorded. It is taken up as
       * received - closed, with no journal entry of its own.
       */
      const noCollections = (report.lines ?? []).filter((l) => !l.excluded).length === 0;
      const toBook = type === 'RCD' ? Number(report.depositsBookedTotal ?? 0) : 0;
      if (
        type === 'RCD' &&
        noCollections &&
        toBook === 0 &&
        ((report.deposits?.length ?? 0) > 0 || (report.remittances?.length ?? 0) > 0)
      ) {
        const now = new Date().toISOString();
        tx.update(ref, {
          status: 'JOURNALIZED',
          jevId: null,
          jevNo: null,
          journalizedAt: now,
          remarks: 'Remittances received and/or deposits already in the books only - no entry.',
          postedBy: { uid: caller.uid, name: caller.name, position: caller.position ?? null, at: now },
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
          remarks: 'Deposits only - no entry.',
        });
        return { reportId, reportNo: report.reportNo, jevId: null, jevNo: null };
      }

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
      if (foot.debit !== report.totalAmount + toBook) {
        throw invalid(
          toBook
            ? `The entry is for ${(foot.debit / 100).toFixed(2)} but ${type} ${report.reportNo} was certified at ${(report.totalAmount / 100).toFixed(2)} of collections and ${(toBook / 100).toFixed(2)} of deposits to book. The journal entry must agree with the report.`
            : `The entry is for ${(foot.debit / 100).toFixed(2)} but ${type} ${report.reportNo} was certified at ${(report.totalAmount / 100).toFixed(2)}. The journal entry must agree with the report.`,
        );
      }

      /*
       * Patch 159: the deposits this entry books - read now, before anything
       * is written (a transaction reads first). Each is stamped with the JEV
       * and goes in transit, as Deposits > Post used to do.
       */
      const depositSnaps =
        toBook > 0
          ? await Promise.all(
              (report.deposits ?? []).map((d) =>
                tx.get(db.collection(COL.deposits).doc(d.sourceId)),
              ),
            )
          : [];
      const depositsToStamp = depositSnaps.filter(
        (d) => d.exists && !(d.data() as { jevId?: string }).jevId,
      );

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
        // Carried from the entry the Accountant approved. Cash in Bank is
        // kept per bank account and an advance is kept per officer, so a
        // report posted without these leaves the control accounts with a
        // balance the subsidiary ledger cannot account for.
        subsidiaryType: l.subsidiaryType ?? null,
        subsidiaryId: l.subsidiaryId ?? null,
        subsidiaryName: l.subsidiaryName ?? null,
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

      for (const d of depositsToStamp) {
        tx.update(d.ref, { jevId, jevNo, status: 'IN_TRANSIT', bookedByTreasuryReportId: reportId });
      }

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
      // Patch 157: and the deposits it reported - only once certified were
      // they claimed.
      if (report.status !== 'DRAFT') {
        for (const d of report.deposits ?? []) {
          tx.update(db.collection(COL.deposits).doc(d.sourceId), {
            treasuryReportId: null,
            treasuryReportNo: null,
            treasuryReportType: null,
          });
        }
        // Patch 161: and its remittances received.
        for (const r of report.remittances ?? []) {
          tx.update(db.collection(COL.collectionRemittances).doc(r.sourceId), {
            liquidatingReportId: null,
            liquidatingReportNo: null,
          });
        }
      }

      // The upload the report was built from goes with it. The rows stay
      // readable - what was paid, and what could not be placed - but the batch
      // is no longer an open piece of work waiting on somebody.
      if (report.importId) {
        tx.update(db.collection(COL.treasuryImports).doc(report.importId), {
          status: 'CANCELLED',
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
