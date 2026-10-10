import { readSheet, findText, findCell, normaliseDate, type SheetRow } from '@/lib/spreadsheet';
import { parsePeso } from '@/lib/money';

/**
 * Reading the Abstract of Collections.
 *
 * The file the MTO produces, as it produces it:
 *
 *   Date | Primary Report No. | Accountable Form | Serial/O.R. No. |
 *   Payor | Collector | Fund | Account Code | Account Name | Amount | Remarks
 *
 * The shape that matters is that a row is not a receipt. A row is one revenue
 * account on one receipt, and a receipt that collected two things appears twice
 * with the same O.R. number:
 *
 *   7707727  ELSIE TOPES  4020220001  Health Certificate            50.00
 *   7707727  ELSIE TOPES  40601010D/S Miscellaneous Income - D/S    30.00
 *
 * That is one official receipt for 80.00 with two lines, and it has to reach
 * CFMS as one. Treating each row as a receipt would put 694 receipts in the
 * books as 823, and the cash would still foot, which is what would make it hard
 * to find later.
 *
 * So the rows are grouped here, by O.R. number within a report reference, and
 * what comes out is receipts with their lines.
 */

export interface AbstractLine {
  /** The Treasurer's own revenue code, not necessarily a COA account code. */
  revenueCode: string;
  description: string;
  amount: number;
  /**
   * Patch 159: whose subsidiary ledger account the line goes to - required
   * where the account is a receivable or a payable (or revenue kept per
   * party). A name as it is on Names. Blank, the server takes the payor.
   */
  subsidiary?: string;
}

export interface AbstractReceipt {
  /** First row of this receipt in the file, for reporting a problem against. */
  lineNo: number;
  date: string;
  /** The report reference the abstract groups by - the RCD this belongs to. */
  reportRef: string;
  accountableForm: string;
  orNumber: string;
  payor: string;
  collector: string;
  fund: string;
  lines: AbstractLine[];
  totalAmount: number;
  cancelled: boolean;
  remarks: string;
  /** Patch 166: an e-collection's transaction reference number. */
  trn: string;
  problem?: string;
}

const COLUMNS = {
  date: [/^date/i, /date/i],
  // "Transaction Reference No." is the TRN below, not a report reference.
  reportRef: [/primary\s*report/i, /report\s*no/i, /^primary/i, /^(?!.*transaction).*reference/i],
  trn: [/^trn\b/i, /\btrn\b/i, /transaction\s*ref/i],
  accountableForm: [/accountable\s*form/i, /^form/i, /^af\b/i],
  orNumber: [/serial\s*\/?\s*o\.?\s*r/i, /o\.?\s*r\.?\s*no/i, /^serial/i, /receipt\s*no/i],
  payor: [/payor/i, /payer/i, /^name/i],
  collector: [/collector/i, /collecting\s*officer/i],
  fund: [/^fund/i, /fund/i],
  accountCode: [/account\s*code/i, /revenue\s*code/i, /^code$/i],
  accountName: [/account\s*name/i, /account\s*title/i, /description/i],
  amount: [/amount/i, /^total/i],
  remarks: [/remarks/i, /status/i, /note/i],
  subsidiary: [/subsidiary/i, /sub.?ledger/i],
};

/**
 * A receipt is cancelled when the abstract says so.
 *
 * It still reaches CFMS, at zero. The accountable-form series has to be
 * continuous for COA, and a cancelled receipt that was simply left out leaves a
 * gap in the serial numbers with nothing to explain it - which is exactly the
 * shape that an unrecorded collection also leaves.
 */
function isCancelled(remarks: string): boolean {
  return /cancel/i.test(remarks);
}

export async function parseAbstractFile(file: File): Promise<AbstractReceipt[]> {
  // Patch 174: a CSV from the offline Collections app is read as text.
  const sheet = await readSheet(file, { csvAsText: true });

  /** Keyed by report reference and O.R. number: what makes one receipt. */
  const receipts = new Map<string, AbstractReceipt>();

  sheet.forEach((raw: SheetRow, i) => {
    const orNumber = findText(raw, COLUMNS.orNumber);
    const reportRef = findText(raw, COLUMNS.reportRef);
    const amount = parsePeso(String(findCell(raw, COLUMNS.amount) ?? '')) ?? 0;

    // Blank lines and the footing the abstract prints under each report.
    if (!orNumber && !reportRef) return;

    const remarks = findText(raw, COLUMNS.remarks);
    const cancelled = isCancelled(remarks);
    const key = `${reportRef}__${orNumber}`;

    let receipt = receipts.get(key);
    if (!receipt) {
      receipt = {
        lineNo: i + 1,
        date: normaliseDate(findCell(raw, COLUMNS.date)),
        reportRef,
        accountableForm: findText(raw, COLUMNS.accountableForm),
        orNumber,
        payor: findText(raw, COLUMNS.payor),
        collector: findText(raw, COLUMNS.collector),
        fund: findText(raw, COLUMNS.fund),
        lines: [],
        totalAmount: 0,
        cancelled,
        remarks,
        trn: findText(raw, COLUMNS.trn),
        problem: undefined,
      };
      receipts.set(key, receipt);
    }

    // A cancelled receipt carries no revenue line. Its amount is nil by
    // definition, whatever figure the file happens to print against it.
    if (cancelled) {
      receipt.cancelled = true;
      receipt.lines = [];
      receipt.totalAmount = 0;
      return;
    }

    const revenueCode = findText(raw, COLUMNS.accountCode);
    if (!revenueCode || !amount) return;

    const subsidiary = findText(raw, COLUMNS.subsidiary);
    receipt.lines.push({
      revenueCode,
      description: findText(raw, COLUMNS.accountName),
      amount,
      ...(subsidiary ? { subsidiary } : {}),
    });
    receipt.totalAmount += amount;
  });

  const out = [...receipts.values()];
  for (const r of out) {
    const problems: string[] = [];
    if (!r.orNumber) problems.push('no O.R. number');
    if (!r.date) problems.push('no readable date');
    if (!r.reportRef) problems.push('no report reference');
    if (!r.cancelled && !r.lines.length) problems.push('no revenue line with an amount');
    if (!r.fund) problems.push('no fund');
    r.problem = problems.length ? problems.join(', ') : undefined;
  }
  return out;
}

/** The distinct revenue codes a parsed file uses, for checking the mapping. */
export function revenueCodesUsed(receipts: AbstractReceipt[]): Map<string, string> {
  const codes = new Map<string, string>();
  for (const r of receipts) {
    for (const l of r.lines) {
      if (!codes.has(l.revenueCode)) codes.set(l.revenueCode, l.description);
    }
  }
  return codes;
}
