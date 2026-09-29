/**
 * CBO accounting invariants - pure functions, no I/O, no Firebase.
 *
 * ------------------------------------------------------------------------
 * THIS FILE IS VENDORED INTO THE CLOUD FUNCTIONS BUILD.
 * The copy at `functions/src/lib/rules.ts` must be byte-identical below the
 * header. `npm run check:rules-sync` (and CI) compares the two.
 * ------------------------------------------------------------------------
 *
 * Why duplicated rather than imported: Firebase deploys only the `functions`
 * directory, so a relative import into `../src` would build locally and then
 * fail in the cloud. Duplication with an enforced equality check is the least
 * bad option, and it keeps the invariants testable in both runtimes.
 *
 * Why pure: the frontend uses these to give immediate feedback while a user
 * types, and the Cloud Functions use the *same code* to make the real decision
 * against server-read balances. Identical logic, two call sites, one of which
 * is trusted. The browser's answer is a courtesy; the server's answer is the
 * one that counts.
 */

export type Centavos = number;

export interface Violation {
  code: string;
  message: string;
  /** Machine-readable context for the UI to highlight the offending figure. */
  details?: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
}

const ok: CheckResult = { ok: true, violations: [] };

function fail(code: string, message: string, details?: Record<string, unknown>): CheckResult {
  return { ok: false, violations: [{ code, message, details }] };
}

function merge(...results: CheckResult[]): CheckResult {
  const violations = results.flatMap((r) => r.violations);
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// 1. Double entry
// ---------------------------------------------------------------------------

export interface EntryLine {
  lineNo: number;
  accountCode: string;
  debit: Centavos;
  credit: Centavos;
}

/**
 * A journal entry may be posted only when total debits equal total credits.
 * Also rejects the two shapes that are technically balanced but meaningless:
 * an entry with no lines, and a line carrying both a debit and a credit.
 */
export function checkDoubleEntry(lines: EntryLine[]): CheckResult {
  if (lines.length === 0) {
    return fail('JEV_EMPTY', 'A journal entry voucher must have at least one line.');
  }

  const results: CheckResult[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const line of lines) {
    if (!Number.isSafeInteger(line.debit) || !Number.isSafeInteger(line.credit)) {
      results.push(
        fail('AMOUNT_NOT_INTEGER', `Line ${line.lineNo}: amounts must be whole centavos.`, {
          lineNo: line.lineNo,
        }),
      );
      continue;
    }
    if (line.debit < 0 || line.credit < 0) {
      results.push(
        fail('AMOUNT_NEGATIVE', `Line ${line.lineNo}: amounts cannot be negative. Use the opposite column instead.`, {
          lineNo: line.lineNo,
        }),
      );
    }
    if (line.debit > 0 && line.credit > 0) {
      results.push(
        fail('LINE_BOTH_SIDES', `Line ${line.lineNo}: a line may carry a debit or a credit, not both.`, {
          lineNo: line.lineNo,
        }),
      );
    }
    if (line.debit === 0 && line.credit === 0) {
      results.push(
        fail('LINE_ZERO', `Line ${line.lineNo}: enter an amount or remove the line.`, {
          lineNo: line.lineNo,
        }),
      );
    }
    if (!line.accountCode) {
      results.push(
        fail('LINE_NO_ACCOUNT', `Line ${line.lineNo}: select an account.`, { lineNo: line.lineNo }),
      );
    }
    totalDebit += line.debit;
    totalCredit += line.credit;
  }

  if (totalDebit !== totalCredit) {
    results.push(
      fail(
        'JEV_UNBALANCED',
        `Journal entry is out of balance by ${(Math.abs(totalDebit - totalCredit) / 100).toFixed(2)}. Total debits must equal total credits.`,
        { totalDebit, totalCredit, difference: totalDebit - totalCredit },
      ),
    );
  }

  return results.length ? merge(...results) : ok;
}

export function totalsOf(lines: EntryLine[]): { totalDebit: Centavos; totalCredit: Centavos } {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }
  return { totalDebit, totalCredit };
}

// ---------------------------------------------------------------------------
// 2. Budget control
// ---------------------------------------------------------------------------

export interface AllotmentCheckInput {
  appropriationRevised: Centavos;
  allotmentAlreadyReleased: Centavos;
  requestedRelease: Centavos;
}

/**
 * Allotment control: cumulative allotments may not exceed the revised
 * appropriation for the same budget line.
 *
 * A negative `requestedRelease` is a withdrawal of allotment, which is always
 * permitted against the appropriation but may not pull the released total
 * below what has already been obligated - that second test belongs to
 * `checkAllotmentWithdrawal`.
 */
export function checkAllotmentAgainstAppropriation(input: AllotmentCheckInput): CheckResult {
  const { appropriationRevised, allotmentAlreadyReleased, requestedRelease } = input;
  const resulting = allotmentAlreadyReleased + requestedRelease;

  if (resulting > appropriationRevised) {
    const excess = resulting - appropriationRevised;
    return fail(
      'ALLOTMENT_EXCEEDS_APPROPRIATION',
      `Allotment release exceeds the available appropriation by ${(excess / 100).toFixed(2)}.`,
      {
        appropriationRevised,
        allotmentAlreadyReleased,
        requestedRelease,
        available: appropriationRevised - allotmentAlreadyReleased,
        excess,
      },
    );
  }
  return ok;
}

export function checkAllotmentWithdrawal(input: {
  allotmentAlreadyReleased: Centavos;
  obligated: Centavos;
  requestedWithdrawal: Centavos;
}): CheckResult {
  const resulting = input.allotmentAlreadyReleased - Math.abs(input.requestedWithdrawal);
  if (resulting < input.obligated) {
    return fail(
      'WITHDRAWAL_BELOW_OBLIGATIONS',
      'Cannot withdraw allotment below the amount already obligated. Cancel the obligations first.',
      { ...input, resulting },
    );
  }
  return ok;
}

export interface ObligationCheckInput {
  allotmentReleased: Centavos;
  alreadyObligated: Centavos;
  requestedObligation: Centavos;
}

/**
 * Budget control: an obligation may not exceed the available allotment.
 *
 * Returns a violation rather than throwing, because an authorised
 * administrator may deliberately override this - in which case the caller
 * records the override, the amount exceeded, and the reason on the face of the
 * OBR and in the audit log. Nothing here decides whether an override is
 * allowed; that is an authorisation question answered by the caller.
 */
export function checkObligationAgainstAllotment(input: ObligationCheckInput): CheckResult {
  const { allotmentReleased, alreadyObligated, requestedObligation } = input;

  if (requestedObligation <= 0) {
    return fail('OBLIGATION_NOT_POSITIVE', 'An obligation must be greater than zero.');
  }

  const available = allotmentReleased - alreadyObligated;
  if (requestedObligation > available) {
    const excess = requestedObligation - available;
    return fail(
      'OBLIGATION_EXCEEDS_ALLOTMENT',
      `Obligation exceeds the available allotment by ${(excess / 100).toFixed(2)}.`,
      { allotmentReleased, alreadyObligated, available, requestedObligation, excess },
    );
  }
  return ok;
}

// ---------------------------------------------------------------------------
// 1b. An expense must say which budget line it is charged to
// ---------------------------------------------------------------------------

export interface FppCheckLine {
  lineNo: number;
  accountCode: string;
  debit: Centavos;
  credit: Centavos;
  fppCode?: string | null;
}

/**
 * Every debit to an expense account names the budget line it is charged to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * ---------------------------------------------------------------------------
 * The Statement of Comparison of Budget and Actual Amounts is built by matching
 * the General Ledger against the appropriations, on the FPP. An expense posted
 * without one appears in neither column: it is spent money that no
 * appropriation accounts for, and because the statement still foots to its own
 * totals, nothing looks wrong. It would be found by somebody adding the ledger
 * up by hand, which is the thing this system exists to stop.
 *
 * ---------------------------------------------------------------------------
 * WHY ONLY THE DEBIT
 * ---------------------------------------------------------------------------
 * A credit to an expense account undoes something already charged, and it
 * carries the FPP of whatever it undoes - which the person entering it
 * supplies. Requiring one on the credit as well would be requiring the same
 * answer twice, and the second time from somebody who may not know it.
 *
 * Every other line is untouched: the credit to Accounts Payable, the cash
 * line, the opening balance. None of them is budget expenditure, and an FPP
 * invented for them would foot into the comparison as spending that never
 * happened.
 */
export function checkExpenseDebitsHaveFpp(
  lines: FppCheckLine[],
  isExpenseAccount: (accountCode: string) => boolean,
): CheckResult {
  const offending = lines.filter(
    (l) => l.debit > 0 && !l.fppCode && isExpenseAccount(String(l.accountCode).trim()),
  );
  if (offending.length === 0) return ok;

  return fail(
    'EXPENSE_WITHOUT_FPP',
    `Line${offending.length === 1 ? '' : 's'} ${offending.map((l) => l.lineNo).join(', ')} ` +
      `debit${offending.length === 1 ? 's' : ''} an expense with no budget line named ` +
      `(${offending.map((l) => l.accountCode).join(', ')}). An expense posted without an FPP ` +
      `never appears in the comparison of budget against actual, and the statement still foots, ` +
      `so nothing looks wrong.`,
    { lineNos: offending.map((l) => l.lineNo), accountCodes: offending.map((l) => l.accountCode) },
  );
}

// ---------------------------------------------------------------------------
// 2b. Realignment
// ---------------------------------------------------------------------------

export interface RealignmentLine {
  lineNo: number;
  /** Signed: negative takes authority away, positive gives it. */
  amount: Centavos;
}

/**
 * A realignment moves authority; it never creates or destroys any.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WHOLE SET IS CHECKED AND NOT EACH LINE
 * ---------------------------------------------------------------------------
 * A realignment line on its own is meaningless: minus two hundred thousand
 * from Travelling is not a budget act, it is half of one. The act is the pair,
 * or the several lines that between them take from some places and give to
 * others, and what makes it lawful is that the two sides are equal.
 *
 * Checked one line at a time, the rule cannot be expressed at all. So the rule
 * takes the SET, and a realignment can only be posted as a set - which is also
 * why the upload sends a realignment in one call rather than in chunks. Half a
 * realignment committed and the other half refused would silently change the
 * total appropriation of the municipality, which is the one thing a
 * realignment must never do.
 *
 * Two lines that both take, or both give, are refused for the same reason: the
 * set nets to something other than zero, so authority was created or lost.
 * ---------------------------------------------------------------------------
 */
/**
 * The two instruments that move authority between budget lines.
 *
 * They look identical in the books and are not the same act in law.
 *
 * SUPPLEMENTAL - re-appropriation of savings through a supplemental budget,
 * Section 321 of the Local Government Code. It needs an appropriation
 * ordinance of its own, and because the Sanggunian is enacting it, it may move
 * authority across expense classes.
 *
 * AUGMENTATION - Section 336. It needs NO supplemental budget where the annual
 * budget's General Provisions carry the omnibus authority, which is why it is
 * the instrument an office reaches for. The price of that convenience is that
 * the Local Chief Executive or the Presiding Officer may only augment "from
 * savings in other items WITHIN THE SAME EXPENSE CLASS of their respective
 * appropriations".
 */
export type RealignmentInstrument = 'SUPPLEMENTAL' | 'AUGMENTATION';

export interface AugmentationLine {
  lineNo: number;
  expenseClass: string;
  amount: Centavos;
}

/**
 * An augmentation may not cross an expense class.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A REFUSAL AND NOT A WARNING
 * ---------------------------------------------------------------------------
 * An augmentation that moves MOOE savings into Capital Outlay is not a
 * borderline case. It is spending the Sanggunian never authorised, made under
 * an omnibus authority that does not reach it - and the correct instrument for
 * it, a supplemental budget, exists and is one ordinance away.
 *
 * Posted, it is indistinguishable in the books from a lawful one, and a
 * reviewer finding it months later disallows it after the money is spent. So
 * CBO refuses it and names the other instrument.
 *
 * Nothing is checked for a SUPPLEMENTAL: the Sanggunian enacting a
 * supplemental budget may move authority wherever the ordinance says.
 * ---------------------------------------------------------------------------
 */
export function checkAugmentationExpenseClass(lines: AugmentationLine[]): CheckResult {
  const classes = [...new Set(lines.filter((l) => l.amount !== 0).map((l) => l.expenseClass))];
  if (classes.length <= 1) return ok;

  return fail(
    'AUGMENTATION_CROSSES_EXPENSE_CLASS',
    `An augmentation may only move savings within one expense class, and this one spans ${classes
      .sort()
      .join(', ')}. Section 336 of the Local Government Code limits the omnibus authority to items ` +
      `"within the same expense class". Moving authority between classes needs a supplemental ` +
      `budget, which is an ordinance of the Sanggunian.`,
    { expenseClasses: classes.sort() },
  );
}

export function checkRealignmentSet(lines: RealignmentLine[]): CheckResult {
  if (lines.length < 2) {
    return fail(
      'REALIGNMENT_NEEDS_TWO_LINES',
      'A realignment needs at least two lines: one the authority comes from, one it goes to.',
      { lineCount: lines.length },
    );
  }

  const net = lines.reduce((sum, l) => sum + l.amount, 0);
  if (net !== 0) {
    const taken = lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
    const given = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    return fail(
      'REALIGNMENT_NOT_BALANCED',
      `A realignment must come to zero. This one is out by ${(net / 100).toFixed(2)}: ` +
        `${(given / 100).toFixed(2)} given against ${(Math.abs(taken) / 100).toFixed(2)} taken.`,
      { net, taken, given },
    );
  }

  // Once the set nets to zero, "nothing on one side" can only mean every line
  // is zero - a set of non-negative amounts summing to zero is all zeroes - so
  // that is the only remaining shape to refuse, and there is deliberately no
  // separate one-sided check. A realignment of nothing is a row somebody began
  // and did not finish.
  const moved = lines.reduce((s, l) => s + Math.abs(l.amount), 0);
  if (moved === 0) {
    return fail('REALIGNMENT_MOVES_NOTHING', 'Every line of this realignment is zero.');
  }

  return ok;
}

// ---------------------------------------------------------------------------
// 3. Disbursement voucher arithmetic
// ---------------------------------------------------------------------------

export interface DvMathInput {
  grossAmount: Centavos;
  deductions: Array<{ amount: Centavos }>;
  netAmount: Centavos;
  accountLines: EntryLine[];
}

/**
 * A disbursement voucher must satisfy three things at once:
 *   gross - deductions = net
 *   the accounting distribution balances
 *   the credits to cash/payable equal the net amount
 * The third is checked by the caller, which knows which accounts are the cash
 * accounts; here we verify the arithmetic and the balance.
 */
export function checkDvMath(input: DvMathInput): CheckResult {
  const results: CheckResult[] = [];

  if (input.grossAmount <= 0) {
    results.push(fail('DV_GROSS_NOT_POSITIVE', 'Gross amount must be greater than zero.'));
  }

  let totalDeductions = 0;
  for (const d of input.deductions) {
    if (d.amount < 0) {
      results.push(fail('DEDUCTION_NEGATIVE', 'Deductions cannot be negative.'));
    }
    totalDeductions += d.amount;
  }

  if (totalDeductions > input.grossAmount) {
    results.push(
      fail('DEDUCTIONS_EXCEED_GROSS', 'Total deductions cannot exceed the gross amount.', {
        grossAmount: input.grossAmount,
        totalDeductions,
      }),
    );
  }

  const expectedNet = input.grossAmount - totalDeductions;
  if (input.netAmount !== expectedNet) {
    results.push(
      fail(
        'DV_NET_MISMATCH',
        `Net amount does not equal gross less deductions. Expected ${(expectedNet / 100).toFixed(2)}.`,
        { grossAmount: input.grossAmount, totalDeductions, netAmount: input.netAmount, expectedNet },
      ),
    );
  }

  results.push(checkDoubleEntry(input.accountLines));

  return merge(...results);
}

// ---------------------------------------------------------------------------
// 4. Liquidation control
// ---------------------------------------------------------------------------

export interface LiquidationCheckInput {
  amountGranted: Centavos;
  previouslyLiquidated: Centavos;
  previouslyRefunded: Centavos;
  amountLiquidated: Centavos;
  refundAmount: Centavos;
  /** Set when the officer spent beyond the advance and is claiming the excess. */
  reimbursementAmount: Centavos;
}

/**
 * Liquidation control: the total liquidated plus refunded may not exceed the
 * cash advance, unless the excess is explicitly classified as a reimbursement
 * claim - which is a separate payable to the officer, not a liquidation of the
 * advance.
 */
export function checkLiquidation(input: LiquidationCheckInput): CheckResult {
  const results: CheckResult[] = [];

  if (input.amountLiquidated < 0 || input.refundAmount < 0 || input.reimbursementAmount < 0) {
    results.push(fail('LIQ_NEGATIVE', 'Liquidation amounts cannot be negative.'));
  }

  const appliedToAdvance =
    input.previouslyLiquidated + input.previouslyRefunded + input.amountLiquidated + input.refundAmount;

  const overApplied = appliedToAdvance - input.amountGranted;

  if (overApplied > 0 && input.reimbursementAmount === 0) {
    results.push(
      fail(
        'LIQ_EXCEEDS_ADVANCE',
        `Liquidation exceeds the cash advance by ${(overApplied / 100).toFixed(2)}. Classify the excess as a reimbursement claim if the officer spent beyond the advance.`,
        { ...input, overApplied },
      ),
    );
  }

  if (overApplied > 0 && input.reimbursementAmount !== overApplied) {
    results.push(
      fail(
        'LIQ_REIMBURSEMENT_MISMATCH',
        `The reimbursement claim must equal the excess of ${(overApplied / 100).toFixed(2)}.`,
        { overApplied, reimbursementAmount: input.reimbursementAmount },
      ),
    );
  }

  if (overApplied < 0 && input.reimbursementAmount > 0) {
    results.push(
      fail('LIQ_REIMBURSEMENT_UNWARRANTED', 'A reimbursement cannot be claimed while the advance is not fully liquidated.'),
    );
  }

  return merge(...results);
}

export function outstandingAdvance(input: {
  amountGranted: Centavos;
  amountLiquidated: Centavos;
  amountRefunded: Centavos;
}): Centavos {
  return input.amountGranted - input.amountLiquidated - input.amountRefunded;
}

// ---------------------------------------------------------------------------
// 5. Bank reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationInput {
  balancePerBank: Centavos;
  depositsInTransit: Centavos;
  outstandingChecks: Centavos;
  bankAdjustments: Centavos;
  balancePerBooks: Centavos;
  bookAdjustments: Centavos;
}

export interface ReconciliationTotals {
  adjustedBankBalance: Centavos;
  adjustedBookBalance: Centavos;
  difference: Centavos;
  reconciled: boolean;
}

/**
 *   Balance per bank
 *   + deposits in transit
 *   - outstanding checks
 *   +/- bank adjustments (bank errors)
 *   = adjusted bank balance
 *
 *   Balance per books
 *   +/- book adjustments (bank charges, interest income, book errors)
 *   = adjusted book balance
 *
 * The two must be equal for the reconciliation to be finalised.
 */
export function computeReconciliation(input: ReconciliationInput): ReconciliationTotals {
  const adjustedBankBalance =
    input.balancePerBank + input.depositsInTransit - input.outstandingChecks + input.bankAdjustments;
  const adjustedBookBalance = input.balancePerBooks + input.bookAdjustments;
  const difference = adjustedBankBalance - adjustedBookBalance;
  return {
    adjustedBankBalance,
    adjustedBookBalance,
    difference,
    reconciled: difference === 0,
  };
}

export function checkReconciliationFinalizable(input: ReconciliationInput): CheckResult {
  const totals = computeReconciliation(input);
  if (!totals.reconciled) {
    return fail(
      'RECON_NOT_BALANCED',
      `Adjusted bank balance and adjusted book balance differ by ${(Math.abs(totals.difference) / 100).toFixed(2)}. A reconciliation can only be finalised at a difference of 0.00.`,
      totals as unknown as Record<string, unknown>,
    );
  }
  return ok;
}

// ---------------------------------------------------------------------------
// 6. Accounting period control
// ---------------------------------------------------------------------------

export function checkPeriodOpen(status: string | undefined, ref: string): CheckResult {
  if (status === undefined || status === 'OPEN' || status === 'REOPENED') return ok;
  if (status === 'TEMPORARILY_LOCKED') {
    return fail('PERIOD_LOCKED', `${ref} falls in a temporarily locked accounting period.`);
  }
  return fail(
    'PERIOD_CLOSED',
    `${ref} falls in a closed accounting period. Post it to an open period, or ask an administrator to reopen the period with a documented reason.`,
  );
}

// ---------------------------------------------------------------------------
// 7. Duplicate detection
// ---------------------------------------------------------------------------

export interface DuplicateCandidate {
  id: string;
  ref: string;
  payeeId?: string;
  amount: Centavos;
  date: string;
  invoiceNo?: string;
}

/**
 * Heuristic duplicate detection, used to warn rather than to block. Exact
 * document-number collisions are prevented outright by the numbering
 * transaction; what this catches is the same invoice paid twice under two
 * different voucher numbers, which is the failure mode that actually loses
 * public money.
 */
export function findProbableDuplicates(
  candidate: DuplicateCandidate,
  existing: DuplicateCandidate[],
  opts: { dayWindow?: number } = {},
): DuplicateCandidate[] {
  const dayWindow = opts.dayWindow ?? 60;
  const candidateTime = Date.parse(candidate.date);

  return existing.filter((e) => {
    if (e.id === candidate.id) return false;

    // Same supplier invoice number is a duplicate regardless of amount or date.
    if (candidate.invoiceNo && e.invoiceNo && candidate.invoiceNo.trim() === e.invoiceNo.trim()) {
      return true;
    }

    if (e.amount !== candidate.amount) return false;
    if (candidate.payeeId && e.payeeId && candidate.payeeId !== e.payeeId) return false;

    const days = Math.abs(Date.parse(e.date) - candidateTime) / 86_400_000;
    return Number.isFinite(days) && days <= dayWindow;
  });
}

// ---------------------------------------------------------------------------
// 8. Trial balance
// ---------------------------------------------------------------------------

/**
 * A trial balance built from posted ledger entries must foot. If this ever
 * returns a non-zero difference it means a ledger entry was written outside
 * the posting function, which is a security incident, not a rounding problem.
 */
export function checkTrialBalance(
  rows: Array<{ debit: Centavos; credit: Centavos }>,
): CheckResult {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const r of rows) {
    totalDebit += r.debit;
    totalCredit += r.credit;
  }
  if (totalDebit !== totalCredit) {
    return fail(
      'TRIAL_BALANCE_OUT',
      `Trial balance does not foot. Debits ${(totalDebit / 100).toFixed(2)} vs credits ${(totalCredit / 100).toFixed(2)}.`,
      { totalDebit, totalCredit, difference: totalDebit - totalCredit },
    );
  }
  return ok;
}
