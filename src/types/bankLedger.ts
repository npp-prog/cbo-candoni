import type { ActorStamp, Centavos, Id, IsoDate, IsoTimestamp } from './common';

/**
 * Cash in Bank: the running book for one bank account.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, GIVEN CBO ALREADY HAS A CASH POSITION SCREEN
 * ---------------------------------------------------------------------------
 * The Cash Position screen answers "where does the municipality stand today",
 * across every account, from the General Ledger. This answers a different
 * question: "what has moved through THIS account, in order, and does the
 * running balance match what the bank says".
 *
 * Most of what moves through the account CBO already knows: the checks it
 * released, the ADA it submitted, the deposits it recorded. Those are read
 * here and never typed.
 *
 * What CBO does not know is the handful of things only the bank originates -
 * interest credited, a service charge, the withholding on that interest, a
 * national tax allotment landing, a bank error and its correction. Those are
 * the entries this file exists to hold, and they are the only ones anybody
 * keys in.
 *
 * ---------------------------------------------------------------------------
 * THE BUFFER
 * ---------------------------------------------------------------------------
 * A maintaining balance, or an amount the office keeps back deliberately. It
 * reduces what may be committed WITHOUT being a movement, so it is a property
 * of the account rather than a line in the book - a buffer posted as an entry
 * would have to be reversed to spend, and would foot into the bank
 * reconciliation where it does not belong.
 * ---------------------------------------------------------------------------
 */

export const BANK_LEDGER_KINDS = [
  'DEPOSIT',
  'INTEREST',
  'NTA',
  'BANK_CHARGE',
  'INTEREST_WITHHELD',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
] as const;
export type BankLedgerKind = (typeof BANK_LEDGER_KINDS)[number];

export const BANK_LEDGER_KIND_LABELS: Record<BankLedgerKind, string> = {
  DEPOSIT: 'Deposit (+)',
  INTEREST: 'Interest credited (+)',
  NTA: 'National Tax Allotment (+)',
  BANK_CHARGE: 'Bank charge (−)',
  INTEREST_WITHHELD: 'Withholding on interest (−)',
  ADJUSTMENT_IN: 'Adjustment (+)',
  ADJUSTMENT_OUT: 'Adjustment (−)',
};

export const BANK_LEDGER_KIND_HINTS: Record<BankLedgerKind, string> = {
  DEPOSIT: 'Money into the account that did not come through a recorded deposit slip.',
  INTEREST: 'Interest the bank credited. It is income and belongs in the books.',
  NTA: 'The Internal Revenue share landing directly in the account.',
  BANK_CHARGE: 'A service charge or penalty the bank took.',
  INTEREST_WITHHELD: 'The final tax the bank withheld on the interest it credited.',
  ADJUSTMENT_IN: 'A bank error in the municipality’s favour, or its correction.',
  ADJUSTMENT_OUT: 'A bank error against the municipality, or its correction.',
};

/** Whether the kind adds to the balance. Everything else subtracts. */
export const BANK_LEDGER_INFLOW: Record<BankLedgerKind, boolean> = {
  DEPOSIT: true,
  INTEREST: true,
  NTA: true,
  BANK_CHARGE: false,
  INTEREST_WITHHELD: false,
  ADJUSTMENT_IN: true,
  ADJUSTMENT_OUT: false,
};

/** bankLedgers/{fiscalYear}__{bankAccountId} */
export interface BankLedger {
  id: Id;
  fiscalYear: number;
  bankAccountId: Id;
  fundCode: string;
  /** The balance the account opened the year with. */
  beginningBalance: Centavos;
  /**
   * A maintaining balance, or an amount held back deliberately. It reduces
   * what may be committed but is never a movement - see the note above.
   */
  buffer: Centavos;
  updatedBy?: ActorStamp;
  updatedAt?: IsoTimestamp;
}

/** bankLedgerEntries/{id} - only what the bank originates. */
export interface BankLedgerEntry {
  id: Id;
  fiscalYear: number;
  bankAccountId: Id;
  fundCode: string;

  entryDate: IsoDate;
  kind: BankLedgerKind;
  referenceNo?: string | null;
  particulars: string;
  amount: Centavos;
  remarks?: string | null;

  /** An entry is voided with a reason, never deleted. */
  voided?: boolean;
  voidReason?: string | null;

  createdBy: ActorStamp;
  createdAt: IsoTimestamp;
  voidedBy?: ActorStamp;
}

/** One line of the running book, from whichever source produced it. */
export interface BankLedgerRow {
  key: string;
  date: IsoDate;
  particulars: string;
  reference: string;
  deposit: Centavos;
  withdrawal: Centavos;
  /** Rows CBO derives are read-only; only keyed entries can be voided. */
  source: 'MANUAL' | 'DEPOSIT' | 'CHECK' | 'ADA';
  entryId?: Id;
}
