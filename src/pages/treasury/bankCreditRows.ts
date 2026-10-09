/**
 * Bank Credits - patch 144. Every credit of every advice to debit account:
 * each payee of a group advice, or the one payee - and whether the bank
 * posted it online.
 *
 *   AWAITING    the advice is prepared; the bank has not posted it yet
 *   POSTED      posted online
 *   NOT_POSTED  the bank did not post it - a trust liability, to be repaid
 *               by a new voucher
 *
 * Cancelled advices are left out: nothing was sent to the bank.
 */

export type CreditStatus = 'AWAITING' | 'POSTED' | 'NOT_POSTED';

export interface AdviceLike {
  id: string;
  adaNo: string;
  adaDate: string;
  status: string;
  payeeId?: string | null;
  payeeName: string;
  amount: number;
  treasuryReportNo?: string | null;
  dateSubmittedToBank?: string | null;
  bankReferenceNo?: string | null;
  payees?: Array<{ lineNo?: number; payeeName: string; accountNumber: string; amount: number }>;
  notPosted?: Array<{ lineNo?: number; payeeName: string; accountNumber: string; amount: number }>;
  notPostedJevId?: string | null;
}

export interface BankCredit {
  key: string;
  adaId: string;
  adaNo: string;
  adaDate: string;
  radaiNo: string;
  lineNo: number;
  payeeName: string;
  accountNumber: string;
  amount: number;
  postedDate: string;
  bankReferenceNo: string;
  status: CreditStatus;
  notPostedJevId: string | null;
}

export const CREDIT_STATUS_LABEL: Record<CreditStatus, string> = {
  AWAITING: 'Awaiting posting',
  POSTED: 'Posted',
  NOT_POSTED: 'Not posted - trust liability',
};

export function buildBankCredits(
  advices: AdviceLike[],
  accountOf: (payeeId: string | null | undefined) => string,
): BankCredit[] {
  const out: BankCredit[] = [];
  for (const a of advices) {
    if (a.status === 'CANCELLED' || a.status === 'DRAFT') continue;
    const lines =
      a.payees && a.payees.length > 0
        ? a.payees.map((p, i) => ({ ...p, lineNo: p.lineNo ?? i + 1 }))
        : [{ lineNo: 1, payeeName: a.payeeName, accountNumber: accountOf(a.payeeId), amount: a.amount }];
    const unposted = new Set((a.notPosted ?? []).map((p, i) => p.lineNo ?? i + 1));
    const posted = a.status !== 'PREPARED';
    for (const l of lines) {
      const notPosted = posted && unposted.has(l.lineNo);
      out.push({
        key: `${a.id}#${l.lineNo}`,
        adaId: a.id,
        adaNo: a.adaNo,
        adaDate: a.adaDate,
        radaiNo: a.treasuryReportNo ?? '',
        lineNo: l.lineNo,
        payeeName: l.payeeName,
        accountNumber: l.accountNumber,
        amount: l.amount,
        postedDate: posted ? (a.dateSubmittedToBank ?? '') : '',
        bankReferenceNo: a.bankReferenceNo ?? '',
        status: !posted ? 'AWAITING' : notPosted ? 'NOT_POSTED' : 'POSTED',
        notPostedJevId: notPosted ? (a.notPostedJevId ?? null) : null,
      });
    }
  }
  return out;
}
