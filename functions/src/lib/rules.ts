// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// Copied verbatim from src/lib/accounting-rules.ts by scripts/sync-rules.mjs.
// Edit the canonical file and run `npm run functions:build` (or `npm --prefix
// functions run sync:rules`) to regenerate. CI fails if the two diverge.
// =============================================================================
/**
 * CFMS accounting invariants - pure functions, no I/O, no Firebase.
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

/**
 * Every figure a guard compares must be a real number, and a guard handed
 * something else must REFUSE rather than pass.
 *
 * This exists because of a defect that sat in the build for weeks without
 * failing anything visible. `checkAllotmentAgainstAppropriation` computed
 *
 *     releasable = appropriationRevised - forLaterRelease
 *
 * and a caller that omitted `forLaterRelease` made that NaN. The test below
 * it is `resulting > releasable`, and EVERY comparison with NaN is false - so
 * the guard returned ok, for any amount, against any appropriation. A control
 * that stops controlling when its input is wrong is worse than no control,
 * because the screen still says the release was checked.
 *
 * TypeScript marks these fields required, which is why nothing complained.
 * But these functions are vendored into the Cloud Functions build and run
 * against data assembled from Firestore documents, where a field that was
 * never written reads as undefined and no type annotation is present to stop
 * it. So the arithmetic is guarded at run time as well.
 */
function nonFinite(values: Record<string, unknown>): CheckResult | null {
  const bad = Object.entries(values).filter(
    ([, v]) => typeof v !== 'number' || !Number.isFinite(v),
  );
  if (bad.length === 0) return null;

  return fail(
    'CHECK_INPUT_NOT_A_NUMBER',
    `This check was given ${bad.map(([k]) => k).join(', ')} as something other than a number, ` +
      'so it cannot be made. Nothing is approved on a check that could not run.',
    { fields: bad.map(([k, v]) => ({ field: k, value: String(v) })) },
  );
}

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
  /**
   * The part of the appropriation the Budget Officer has deliberately held
   * back, and which is therefore not available to release.
   *
   * The Budget Operations Manual calls it "For Later Release" and says it
   * exists "to provide safeguards for shortfalls in the collection of
   * revenues". It is not a reduction of the appropriation - the authority
   * still exists and can be released later - so it cannot be recorded as a
   * negative appropriation. It is a hold, and the only thing it does is make
   * the held amount unavailable.
   *
   * ---------------------------------------------------------------------
   * REQUIRED, AND IT WAS OPTIONAL
   * ---------------------------------------------------------------------
   * When the hold was introduced this field was optional, defaulting to
   * nothing so that the call sites that already existed would keep
   * compiling. They did - and they kept the OLD BEHAVIOUR. Three of the four
   * places that check an allotment against its appropriation went on
   * ignoring the hold entirely, so an amount the Budget Officer had withheld
   * could be released through any of them, and nothing anywhere said so.
   *
   * An optional parameter on a safety rule defaults to no safety. It is
   * required now, so the compiler is what makes a new call site answer the
   * question. Pass 0 only where there genuinely is no hold to consider.
   */
  forLaterRelease: Centavos;
}

/**
 * Allotment control: cumulative allotments may not exceed the revised
 * appropriation for the same budget line, less anything held for later
 * release.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HOLD IS SUBTRACTED HERE AND NOT SHOWN AS A SMALLER APPROPRIATION
 * ---------------------------------------------------------------------------
 * A department reading its available balance must see what it may actually
 * commit. If the hold were left out of this test, CFMS would let the Budget
 * Officer release authority they had explicitly decided to withhold - and it
 * would do so silently, because everything else would still foot.
 *
 * Reducing the appropriation instead would be worse: the appropriation is what
 * the Sanggunian enacted, and a registry that showed less than the ordinance
 * says would disagree with the ordinance on its face.
 *
 * A negative `requestedRelease` is a withdrawal of allotment, which is always
 * permitted against the appropriation but may not pull the released total
 * below what has already been obligated - that second test belongs to
 * `checkAllotmentWithdrawal`.
 */
export function checkAllotmentAgainstAppropriation(input: AllotmentCheckInput): CheckResult {
  const { appropriationRevised, allotmentAlreadyReleased, requestedRelease } = input;
  const heldBack = input.forLaterRelease;

  const unusable = nonFinite({
    appropriationRevised,
    allotmentAlreadyReleased,
    requestedRelease,
    forLaterRelease: heldBack,
  });
  if (unusable) return unusable;

  const releasable = appropriationRevised - heldBack;
  const resulting = allotmentAlreadyReleased + requestedRelease;

  if (resulting > releasable) {
    const excess = resulting - releasable;
    return fail(
      'ALLOTMENT_EXCEEDS_APPROPRIATION',
      `Allotment release exceeds the available appropriation by ${(excess / 100).toFixed(2)}.` +
        (heldBack > 0
          ? ` ${(heldBack / 100).toFixed(2)} of this line is held for later release and is not available.`
          : ''),
      {
        appropriationRevised,
        forLaterRelease: heldBack,
        allotmentAlreadyReleased,
        requestedRelease,
        available: releasable - allotmentAlreadyReleased,
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
  const unusable = nonFinite({
    allotmentAlreadyReleased: input.allotmentAlreadyReleased,
    obligated: input.obligated,
    requestedWithdrawal: input.requestedWithdrawal,
  });
  if (unusable) return unusable;

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

  const unusable = nonFinite({ allotmentReleased, alreadyObligated, requestedObligation });
  if (unusable) return unusable;

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
 * Patch 139. The budget line of a voucher's entry comes from its obligation.
 *
 * The journal entry grids no longer carry a budget line (FPP) column: every
 * entry that spends a budget is raised from a voucher, and every voucher from
 * an Obligation Request that already names the budget line. Asking for it a
 * second time on the JEV only invited a different answer.
 *
 * The ledger still keeps the FPP on each expense debit - the comparison of
 * budget and actual amounts and the SRE's ledger basis read it - and this is
 * where it comes from. A debit that already carries one (proposed from the
 * obligation) keeps it. One that does not takes the budget line of the
 * obligation line with the same object code, when exactly one budget line
 * carries it; otherwise the obligation's only budget line, when it has one.
 * Where the obligation names several and none fits, it is left blank rather
 * than guessed: a charge against the wrong line is worse than one against
 * none.
 *
 * Only debits are filled. A credit (payable, cash, a tax withheld) is not
 * budget spending and an FPP on it would be counted as such.
 */
export function fppFromObligation<
  L extends { debit: number; accountCode: string; fppCode?: string | null; fppName?: string | null },
>(
  lines: L[],
  obligationLines: Array<{ accountCode?: string | null; fppCode?: string | null; fppName?: string | null }>,
): L[] {
  const withFpp = obligationLines.filter((o) => String(o.fppCode ?? '').trim());
  if (withFpp.length === 0) return lines;
  const distinct = (rows: typeof withFpp) => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(String(r.fppCode).trim(), String(r.fppName ?? '').trim());
    return [...m.entries()];
  };
  const all = distinct(withFpp);
  return lines.map((l) => {
    if (!(l.debit > 0) || String(l.fppCode ?? '').trim()) return l;
    const code = String(l.accountCode ?? '').trim();
    const same = distinct(withFpp.filter((o) => String(o.accountCode ?? '').trim() === code));
    const pick = same.length === 1 ? same[0] : all.length === 1 ? all[0] : null;
    return pick ? { ...l, fppCode: pick[0], fppName: pick[1] || l.fppName || null } : l;
  });
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
// 2a2. What kind of voucher this is
// ---------------------------------------------------------------------------

/**
 * A disbursement voucher is one of two things, and they are not variations of
 * each other.
 *
 * An OBLIGATED voucher pays an expenditure. It draws on an Obligation Request
 * that was certified against a released allotment, so by the time it is paid
 * the money has passed appropriation, allotment and obligation.
 *
 * A TRUST LIABILITY voucher settles something the municipality is merely
 * holding: retention on a contract, a bidder's bond, the employees' share of a
 * premium, tax withheld and now remitted. It is not expenditure, it was never
 * appropriated, and requiring an obligation for it would mean inventing an
 * appropriation for money that was never the municipality's to spend.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A RULE AND NOT A LABEL
 * ---------------------------------------------------------------------------
 * Before the category existed, a voucher with no obligation simply went
 * through. There was no way to tell a deliberate trust settlement from a
 * voucher whose obligation the encoder had forgotten to attach, and the
 * difference is the whole budget control: the second one is an expenditure
 * that never touched an allotment.
 *
 * So the category is declared, and each kind is held to what it is:
 *
 *   OBLIGATED         must carry an obligation.
 *   TRUST_LIABILITY   must not carry one, AND must not debit an expense.
 *
 * The second half of that is the part that matters. A trust-liability voucher
 * that debited an expense account would be an expenditure with no obligation
 * behind it, wearing the one label that excuses the missing obligation. It
 * would escape the budget control entirely and still look deliberate.
 */
export type DvCategory = 'OBLIGATED' | 'TRUST_LIABILITY';

export interface DvCategoryInput {
  category: string;
  hasObligation: boolean;
  lines: FppCheckLine[];
}

export function checkDvCategory(
  input: DvCategoryInput,
  isExpenseAccount: (accountCode: string) => boolean,
): CheckResult {
  const results: CheckResult[] = [];

  if (input.category !== 'OBLIGATED' && input.category !== 'TRUST_LIABILITY') {
    return fail(
      'DV_CATEGORY_UNKNOWN',
      `"${input.category}" is not a kind of voucher. A disbursement voucher either pays an ` +
        'obligation or settles a trust liability, and which one it is decides whether an ' +
        'Obligation Request is required.',
      { category: input.category },
    );
  }

  if (input.category === 'OBLIGATED' && !input.hasObligation) {
    results.push(
      fail(
        'DV_OBLIGATION_MISSING',
        'This voucher pays an expenditure, so it must draw on a certified Obligation Request. ' +
          'Attach the OBR, or - if this settles money the municipality is only holding, such as ' +
          'retention or a remittance - record it as a trust liability instead.',
      ),
    );
  }

  if (input.category === 'TRUST_LIABILITY') {
    if (input.hasObligation) {
      results.push(
        fail(
          'DV_TRUST_HAS_OBLIGATION',
          'A trust liability settles money the municipality is holding, not an expenditure, so ' +
            'it cannot draw on an Obligation Request. Paying it against an obligation would ' +
            'consume an allotment for something that was never appropriated.',
        ),
      );
    }

    const expenseDebits = input.lines.filter(
      (l) => l.debit > 0 && isExpenseAccount(String(l.accountCode).trim()),
    );

    if (expenseDebits.length > 0) {
      results.push(
        fail(
          'DV_TRUST_DEBITS_EXPENSE',
          `Line${expenseDebits.length === 1 ? '' : 's'} ${expenseDebits
            .map((l) => l.lineNo)
            .join(', ')} debit${expenseDebits.length === 1 ? 's' : ''} an expense ` +
            `(${expenseDebits.map((l) => l.accountCode).join(', ')}). A trust liability settles ` +
            'a liability the municipality is holding; an expense on this voucher would be ' +
            'spending with no obligation and no allotment behind it. Record it as an obligated ' +
            'voucher against an OBR.',
          {
            lineNos: expenseDebits.map((l) => l.lineNo),
            accountCodes: expenseDebits.map((l) => l.accountCode),
          },
        ),
      );
    }
  }

  return merge(...results);
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
 * The two acts that move authority between budget lines.
 *
 * They look identical in the books, they are not the same act in law, and the
 * office names them differently. CFMS used to present them as one transaction
 * with a choice of "instrument" buried inside it, which is not how anybody in
 * the Budget Office thinks about them.
 *
 * AUGMENTATION - Section 336. WITHIN ONE EXPENSE CLASS: Personal Services to
 * Personal Services, MOOE to MOOE, Capital Outlay to Capital Outlay. Approved
 * by the LOCAL CHIEF EXECUTIVE alone, and only where the annual budget's
 * General Provisions carry the omnibus authority - which is the convenience it
 * exists for, and the reason for its limits.
 *
 * REALIGNMENT - Section 321. ACROSS EXPENSE CLASSES: Personal Services to
 * MOOE, and anything else an augmentation may not reach. Approved by the
 * SANGGUNIAN, by ordinance, because moving authority between classes changes
 * what the Sanggunian appropriated and only the Sanggunian may do that.
 *
 * So the rule of thumb the office uses: same class, the Mayor may sign it;
 * different class, it goes to the Sanggunian.
 *
 * 'SUPPLEMENTAL' is the value CFMS stored for a realignment before this was
 * straightened out, and it is still read so that records made under it keep
 * their meaning. Nothing writes it any more. It was a poor name in any case -
 * a supplemental BUDGET appropriates new money from new revenue, which is a
 * third thing again and has its own appropriation kind.
 */
export type RealignmentInstrument = 'AUGMENTATION' | 'REALIGNMENT' | 'SUPPLEMENTAL';

/** True for the Sanggunian's act, under either the new name or the old one. */
export function isRealignmentInstrument(instrument: string | undefined): boolean {
  return instrument === 'REALIGNMENT' || instrument === 'SUPPLEMENTAL';
}

export interface AugmentationLine {
  lineNo: number;
  expenseClass: string;
  amount: Centavos;
}

/**
 * The two limits on an augmentation, from LBE Form No. 2.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE REFUSALS AND NOT WARNINGS
 * ---------------------------------------------------------------------------
 * An augmentation that moves MOOE savings into Capital Outlay is not a
 * borderline case. It is spending the Sanggunian never authorised, made under
 * an omnibus authority that does not reach it - and the act that does reach
 * it, a Realignment, exists and is one ordinance away.
 *
 * Posted, it is indistinguishable in the books from a lawful one, and a
 * reviewer finding it months later disallows it after the money is spent. So
 * CFMS refuses it and names the other instrument.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND LIMIT, WHICH CFMS USED TO MISS
 * ---------------------------------------------------------------------------
 * Note 2 under LBE Form No. 2 of the Budget Operations Manual for LGUs (2023
 * edition, page 186, revised as of reprinting for FY2024) is two rules in one
 * sentence:
 *
 *   "Savings can augment only items of appropriation in the same expense
 *    (e.g., PS to PS and MOOE to MOOE). SAVINGS FROM CO CANNOT BE USED FOR
 *    AUGMENTATION PURPOSES."
 *
 * CFMS enforced the first half and not the second, so a Capital Outlay line
 * could be drained into another Capital Outlay line and nothing objected: the
 * set never crossed a class, so the old check was satisfied.
 *
 * It is a separate prohibition and a stricter one. Capital Outlay savings
 * arise because a project was not built, and the authority to build it does
 * not become authority to build something else under an omnibus clause. The
 * act for that is a Realignment, by ordinance.
 *
 * A source is a line with a NEGATIVE amount: a realignment is recorded as
 * pairs of equal magnitude and opposite sign, and the negative half is the one
 * the authority is taken from.
 *
 * Nothing is checked for a REALIGNMENT: the Sanggunian, enacting the
 * ordinance, may move authority wherever the ordinance says - across expense
 * classes included, which is the whole reason a realignment is the act for
 * Personal Services to MOOE.
 * ---------------------------------------------------------------------------
 */
export function checkAugmentationExpenseClass(lines: AugmentationLine[]): CheckResult {
  const live = lines.filter((l) => l.amount !== 0);

  // Checked first, because it is the more specific prohibition: a set drawn
  // from CO and applied to CO does not cross a class at all, so the rule below
  // would pass it.
  const fromCapitalOutlay = live.filter((l) => l.amount < 0 && l.expenseClass === 'CO');
  if (fromCapitalOutlay.length > 0) {
    return fail(
      'AUGMENTATION_FROM_CAPITAL_OUTLAY',
      `Savings from Capital Outlay cannot be used for augmentation. LBE Form No. 2 of the Budget ` +
        `Operations Manual says so in terms: "Savings from CO cannot be used for augmentation ` +
        `purposes." Capital Outlay savings arise because a project was not built, and the ` +
        `authority to build it does not become authority to build something else under the ` +
        `omnibus clause. Move it by Realignment instead, which is an ordinance of the Sanggunian.`,
      { lineNos: fromCapitalOutlay.map((l) => l.lineNo) },
    );
  }

  const classes = [...new Set(live.map((l) => l.expenseClass))];
  if (classes.length <= 1) return ok;

  return fail(
    'AUGMENTATION_CROSSES_EXPENSE_CLASS',
    `An augmentation may only move savings within one expense class, and this one spans ${classes
      .sort()
      .join(', ')}. Section 336 of the Local Government Code limits the omnibus authority to items ` +
      `"within the same expense class" - Personal Services to Personal Services, MOOE to MOOE, ` +
      `Capital Outlay to Capital Outlay. Moving authority between classes is a Realignment, and ` +
      `that is an ordinance of the Sanggunian rather than a signature of the Local Chief ` +
      `Executive. Change the type at the top of this form to Realignment.`,
    { expenseClasses: classes.sort() },
  );
}

/**
 * What a budget line can give up to a realignment or an augmentation: the
 * part of its appropriation NOT YET ALLOTTED. Patch 130 (patch 128 had used
 * appropriation less obligations).
 *
 * Neil: "the available amount to be realigned and augmented is the difference
 * of Appropriation and Allotment only. When it hits zero it can withdraw the
 * amount of the release order so that there will be available to augment or
 * realign - provided that the allotment minus obligated will not result in a
 * negative amount."
 *
 * So a realignment or augmentation moves APPROPRIATION only, never allotment.
 * Where the appropriation is all allotted, the office first withdraws allotment
 * (Allotments > Withdraw) - and a withdrawal is refused if it would leave the
 * allotment below what is obligated against it (`checkAllotmentWithdrawal`).
 *
 * An amount held For Later Release on an Allotment Release Order IS
 * realignable (patch 131 - Neil: "Yes they are realignable."). It was never
 * released, so it is still appropriation not yet allotted. Realigning it
 * cancels that much of the hold: the engine takes the unheld part first, then
 * reduces the hold on the release order lines (heldTakenByRealignment), so
 * the hold can never be released afterwards for money that has gone.
 */
export const realignableBalance = (b: {
  appropriationRevised: number;
  allotmentReleased: number;
  forLaterRelease?: number;
}): number => Math.max(0, b.appropriationRevised - b.allotmentReleased);

/**
 * How much of a realignment's take comes out of the hold. The part of the
 * appropriation neither released nor held goes first; only the rest reduces
 * the hold. Patch 131.
 */
export const heldTakenByRealignment = (
  b: { appropriationRevised: number; allotmentReleased: number; forLaterRelease?: number },
  taken: number,
): number => {
  const held = b.forLaterRelease ?? 0;
  const unheld = Math.max(0, b.appropriationRevised - b.allotmentReleased - held);
  return Math.min(held, Math.max(0, taken - unheld));
};

export interface RealignableSource {
  lineNo: number;
  /** How the line is named in a message - office and object. */
  label: string;
  /** Negative on the side the authority is taken from. Several lines on one budget line are summed by the caller. */
  amount: number;
  appropriationRevised: number;
  allotmentReleased: number;
  forLaterRelease?: number;
}

/**
 * Every source of a realignment or augmentation within its unallotted
 * balance. Checked when the set is prepared and again when it is posted.
 */
export function checkRealignableBalances(lines: RealignableSource[]): CheckResult {
  const violations: Violation[] = [];
  const php = (c: number) =>
    (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const l of lines) {
    if (l.amount >= 0) continue;
    const taken = -l.amount;
    const available = realignableBalance(l);
    if (taken > available) {
      const held = l.forLaterRelease ?? 0;
      violations.push({
        code: 'REALIGNMENT_EXCEEDS_UNALLOTTED',
        message:
          `${l.label} can give up at most ${php(available)} - its appropriation of ` +
          `${php(l.appropriationRevised)} less ${php(l.allotmentReleased)} released as allotment` +
          (held ? ` (the ${php(held)} held for later release is included and may be taken)` : '') +
          ` - and this takes ${php(taken)}. Withdraw allotment first (Allotments) to free the rest; ` +
          'only allotment not yet obligated can be withdrawn.',
        details: {
          lineNo: l.lineNo,
          taken,
          available,
          appropriationRevised: l.appropriationRevised,
          allotmentReleased: l.allotmentReleased,
          forLaterRelease: held,
        },
      });
    }
  }
  return violations.length ? { ok: false, violations } : ok;
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
// 2b. Moving the allotment with the appropriation
//
// NOT CALLED BY THE ENGINE SINCE PATCH 130. A realignment or augmentation now
// moves appropriation only, from what is not yet allotted; allotment is freed
// by a withdrawal of its own (Neil). Kept, with its tests, because the
// reasoning below is the record of why it once did - and so a return to it is
// a decision, not a rewrite.
// ---------------------------------------------------------------------------

/**
 * What a realignment must do to the allotment, as well as to the appropriation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A realignment used to move the appropriation and nothing else, and the
 * posting was refused outright the moment the reduced appropriation fell below
 * the allotment already released: "Withdraw the allotment first. Nothing was
 * posted."
 *
 * That refusal describes the normal case, not an edge one. Savings are what is
 * left of an item after its allotment has been released and not all of it
 * spent - so an augmentation made in, say, October is made from an account
 * whose allotment IS released, and the refusal blocked it. The office was left
 * to withdraw the allotment by hand, post the realignment, and release a new
 * allotment on the far side: three acts for one decision, two of which nothing
 * checked and nothing tied back to the first.
 *
 * An augmentation is one budget transaction. It moves authority from one
 * account to another, and the allotment is part of that authority.
 *
 * ---------------------------------------------------------------------------
 * HOW MUCH ALLOTMENT MOVES DEPENDS ON THE INSTRUMENT
 * ---------------------------------------------------------------------------
 * An earlier version of this file had one rule for both instruments: take the
 * savings from unreleased appropriation first, and move only the shortfall.
 * That is right for a realignment and WRONG for an augmentation, and
 * the difference is not a detail.
 *
 * AN AUGMENTATION IS MADE AFTER THE ALLOTMENT. Savings are the balance of a
 * released allotment left free of obligation once an activity is completed,
 * abandoned or discontinued. Before the allotment is released there is nothing
 * that answers to that description - the money has not been made available to
 * spend, so none of it can be left over. An augmentation therefore moves the
 * allotment peso for peso with the appropriation, and a source line carrying
 * no released allotment is refused rather than quietly contributing nothing.
 *
 * Under the old rule such a line passed, moved no allotment, and left the
 * augmented item holding appropriation it could not obligate - the exact
 * outcome this work set out to prevent.
 *
 * A SUPPLEMENTAL BUDGET under Section 321 is a different act. The Sanggunian
 * is re-appropriating, and it may move appropriation that was never released.
 * There the older rule stands:
 *
 *     unreleased = appropriation - allotment released
 *     withdrawn  = max(0, amount moved - unreleased)
 *
 * Whatever is withdrawn is released on the receiving side, under either
 * instrument. The fund's total allotment does not change, because neither act
 * creates new spending authority - both move what was already there.
 *
 * ---------------------------------------------------------------------------
 * THE AUTHORITY IS A SEPARATE QUESTION, AND IT IS NOT THIS FILE'S
 * ---------------------------------------------------------------------------
 * Section 336 lets the Local Chief Executive augment only where the annual
 * budget's General Provisions carry the omnibus authority. That is a fact
 * about the appropriation ordinance for a fiscal year, not about these lines,
 * so it is checked on the server against what the office has recorded, before
 * any of the arithmetic below is reached.
 */

export interface AugmentationAllotmentLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  officeName: string;
  /** Signed: negative where savings are taken, positive where they are used. */
  amount: Centavos;
  /** The balances as they stand BEFORE this realignment is applied. */
  appropriationRevised: Centavos;
  allotmentReleased: Centavos;
  obligated: Centavos;
  /** Held back by an Allotment Release Order and not available to release. */
  forLaterRelease: Centavos;
}

export interface AllotmentMove {
  lineNo: number;
  /** Negative where allotment is withdrawn, positive where it is released. */
  allotmentDelta: Centavos;
}

export interface AugmentationAllotmentPlan extends CheckResult {
  moves: AllotmentMove[];
  /** Withdrawn from the savings side, and released on the augmented side. */
  totalMoved: Centavos;
}

export function planAugmentationAllotment(
  lines: AugmentationAllotmentLine[],
  instrument: RealignmentInstrument = 'AUGMENTATION',
): AugmentationAllotmentPlan {
  const violations: Violation[] = [];
  const moves: AllotmentMove[] = [];

  const sources = lines.filter((l) => l.amount < 0);
  const destinations = lines.filter((l) => l.amount > 0);

  // --- the savings side ----------------------------------------------------
  let totalMoved = 0;
  for (const line of sources) {
    const taken = -line.amount;
    const free = line.allotmentReleased - line.obligated;

    /*
     * How much allotment must come back depends on which instrument this is,
     * and the two are genuinely different acts.
     *
     * AN AUGMENTATION IS MADE AFTER THE ALLOTMENT. Savings are the balance of
     * a released allotment left free of obligation once an activity is done,
     * abandoned or discontinued - so until the allotment is released there is
     * nothing to call savings, and nothing to augment from. The allotment
     * therefore moves peso for peso with the appropriation, and a line with no
     * released allotment cannot be a source at all.
     *
     * A SUPPLEMENTAL BUDGET IS A DIFFERENT THING. The Sanggunian is enacting a
     * re-appropriation under Section 321, and it may move appropriation that
     * was never released as allotment. There the savings come out of the
     * unreleased part first, because moving that costs the account no spending
     * authority it currently holds, and only the shortfall is taken back out
     * of the allotment.
     */
    let withdrawn: number;
    if (instrument === 'AUGMENTATION') {
      if (line.allotmentReleased === 0) {
        violations.push({
          code: 'AUGMENTATION_BEFORE_ALLOTMENT',
          message:
            `${line.accountCode} ${line.accountName} in ${line.officeName} has no allotment ` +
            'released, so it has no savings to give. An augmentation is made from savings, and ' +
            'savings are what is left of a released allotment once the activity is finished or ' +
            'abandoned - so the allotment comes first. Release the allotment, or move this ' +
            'appropriation by Realignment instead, which is an ordinance of the Sanggunian.',
          details: {
            lineNo: line.lineNo,
            accountCode: line.accountCode,
            taken,
            appropriationRevised: line.appropriationRevised,
          },
        });
        continue;
      }
      withdrawn = taken;
    } else {
      const unreleased = line.appropriationRevised - line.allotmentReleased;
      withdrawn = Math.max(0, taken - unreleased);
    }

    if (withdrawn === 0) continue;

    const check = checkAllotmentWithdrawal({
      allotmentAlreadyReleased: line.allotmentReleased,
      obligated: line.obligated,
      requestedWithdrawal: withdrawn,
    });
    if (!check.ok) {
      violations.push({
        code: 'AUGMENTATION_ALLOTMENT_OBLIGATED',
        message:
          `${line.accountCode} ${line.accountName} in ${line.officeName} cannot give up ` +
          `${(taken / 100).toFixed(2)}. Taking it needs ${(withdrawn / 100).toFixed(2)} of the ` +
          `allotment back, and only ${(free / 100).toFixed(2)} is unobligated - ` +
          `${(line.obligated / 100).toFixed(2)} is already committed. Cancel the obligations ` +
          'first, or take less from this account.',
        details: {
          lineNo: line.lineNo,
          accountCode: line.accountCode,
          taken,
          withdrawn,
          available: free,
          obligated: line.obligated,
        },
      });
      continue;
    }

    moves.push({ lineNo: line.lineNo, allotmentDelta: -withdrawn });
    totalMoved += withdrawn;
  }

  if (violations.length > 0) {
    return { ok: false, violations, moves: [], totalMoved: 0 };
  }
  if (totalMoved === 0) {
    // Every peso came out of unreleased appropriation. The augmented side gets
    // appropriation only, and the allotment is released in the ordinary way.
    return { ok: true, violations: [], moves: [], totalMoved: 0 };
  }

  // --- the augmented side --------------------------------------------------
  /*
   * Where the allotment withdrawn is less than the appropriation moved, it has
   * to be spread over the augmented items, and the split is apportionment
   * rather than a fact about any one of them. It is done in proportion to the
   * amounts, with the odd centavos going to the largest item so the two sides
   * agree exactly. In the ordinary case - a source whose allotment is fully
   * released - the proportion is one to one and every item receives allotment
   * equal to its own increase, so no apportionment is visible at all.
   */
  const totalReceived = destinations.reduce((s, l) => s + l.amount, 0);
  const shares = destinations.map((l) => ({
    line: l,
    exact: (totalMoved * l.amount) / totalReceived,
    share: Math.floor((totalMoved * l.amount) / totalReceived),
  }));
  let remainder = totalMoved - shares.reduce((s, x) => s + x.share, 0);
  for (const x of [...shares].sort((a, b) => b.exact - a.exact)) {
    if (remainder <= 0) break;
    x.share += 1;
    remainder -= 1;
  }

  for (const { line, share } of shares) {
    if (share === 0) continue;
    const check = checkAllotmentAgainstAppropriation({
      // The appropriation AFTER this realignment, which is what the released
      // allotment has to sit inside.
      appropriationRevised: line.appropriationRevised + line.amount,
      forLaterRelease: line.forLaterRelease,
      allotmentAlreadyReleased: line.allotmentReleased,
      requestedRelease: share,
    });
    if (!check.ok) {
      const details = check.violations[0].details as Record<string, number>;
      violations.push({
        code: 'AUGMENTATION_ALLOTMENT_HELD',
        message:
          `${line.accountCode} ${line.accountName} in ${line.officeName} cannot receive the ` +
          `${(share / 100).toFixed(2)} of allotment that comes with this augmentation: ` +
          check.violations[0].message +
          ' Release the hold on this line, or post the augmentation and issue the allotment separately.',
        details: { lineNo: line.lineNo, accountCode: line.accountCode, share, ...details },
      });
      continue;
    }
    moves.push({ lineNo: line.lineNo, allotmentDelta: share });
  }

  if (violations.length > 0) {
    return { ok: false, violations, moves: [], totalMoved: 0 };
  }

  return { ok: true, violations: [], moves, totalMoved };
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

// ---------------------------------------------------------------------------
// "Payee, et al." - one voucher, several payees, one ADA. Patch 138.
// ---------------------------------------------------------------------------

/**
 * The suffix a group request carries on its payee name, the way the office
 * writes it on the OBR and the voucher: "Juan Dela Cruz, et al."
 */
export const ET_AL = ', et al.';

/** The name with the suffix, once. */
export const withEtAl = (name: string): string => {
  const base = withoutEtAl(name);
  return base ? `${base}${ET_AL}` : '';
};

/** The name without it. */
export const withoutEtAl = (name: string): string =>
  String(name ?? '')
    // Patch 180: "et al" only as its own word - "NEGROS STEEL AND METAL"
    // lost its last three letters to the old pattern.
    .replace(/(?:\s*,\s*|\s+)et\.?\s*al\.?\s*$/i, '')
    .trim();

export interface PayeeShare {
  payeeId?: string | null;
  payeeName: string;
  accountNumber?: string | null;
  amount: number;
}

/**
 * The payees of a group voucher, before it may be submitted or approved.
 *
 * At least two (one payee is an ordinary voucher); each a payee on the
 * master list (so the payable is kept per person); each with an account
 * number (the bank file has a row per payee and a blank one is either
 * rejected or, on a careless bank application, paid into the row above); no
 * payee twice; every share above zero; and the shares adding up to the net
 * amount exactly - the ADA pays the net, and the bank credits the shares.
 */
export function checkDvPayees(payees: PayeeShare[], netAmount: number): CheckResult {
  const v: Violation[] = [];
  const php = (c: number) =>
    (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (payees.length < 2) {
    v.push({
      code: 'PAYEES_TOO_FEW',
      message: 'A voucher for several payees lists at least two. For one payee, clear "Several payees".',
    });
  }
  // A row is named by its payee, or by its line number while it has none.
  const who = (p: PayeeShare) =>
    String(p.payeeName ?? '').trim() || `line ${payees.indexOf(p) + 1}`;
  const list = (rows: PayeeShare[]) =>
    `${rows.map(who).slice(0, 5).join(', ')}${rows.length > 5 ? ' and others' : ''}`;
  const unlisted = payees.filter((p) => !String(p.payeeId ?? '').trim());
  if (unlisted.length) {
    v.push({
      code: 'PAYEE_NOT_ON_FILE',
      message: `No payee from the master list on ${list(unlisted)}. Choose one, or add them with "Add a payee", so what is owed is kept per person.`,
    });
  }
  const noAccount = payees.filter((p) => !String(p.accountNumber ?? '').trim());
  if (noAccount.length) {
    v.push({
      code: 'PAYEE_NO_ACCOUNT',
      message: `No ATM / account number for ${list(noAccount)}. The bank file needs one for every payee.`,
    });
  }
  // Patch 140: the bank's upload file takes a 10-digit account number.
  const badAccount = payees.filter((p) => {
    const d = String(p.accountNumber ?? '').replace(/\D/g, '');
    return d.length > 0 && d.length !== 10;
  });
  if (badAccount.length) {
    v.push({
      code: 'PAYEE_ACCOUNT_NOT_10_DIGITS',
      message: `The ATM / account number of ${list(badAccount)} is not 10 digits. The bank file takes exactly 10 - if Excel dropped the leading zeros, type them back.`,
    });
  }
  const seen = new Map<string, number>();
  for (const p of payees) {
    const k = String(p.payeeId ?? '').trim();
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const twice = payees.filter((p, i) => {
    const k = String(p.payeeId ?? '').trim();
    return k && (seen.get(k) ?? 0) > 1 && payees.findIndex((q) => q.payeeId === p.payeeId) === i;
  });
  if (twice.length) {
    v.push({
      code: 'PAYEE_TWICE',
      message: `${twice.map((p) => p.payeeName).join(', ')} ${twice.length === 1 ? 'is' : 'are'} listed twice. Put each payee once, with the whole of their share.`,
    });
  }
  const zero = payees.filter((p) => !(p.amount > 0));
  if (zero.length) {
    v.push({
      code: 'PAYEE_ZERO',
      message: `No share entered for ${list(zero)}. Every payee is paid more than zero.`,
    });
  }
  const total = payees.reduce((t, p) => t + (p.amount ?? 0), 0);
  if (payees.length && total !== netAmount) {
    v.push({
      code: 'PAYEES_NOT_NET',
      message: `The payees add up to ${php(total)}; the net amount of the voucher is ${php(netAmount)}. The ADA pays the net, so the shares must add up to it exactly.`,
      details: { total, netAmount },
    });
  }
  return v.length ? { ok: false, violations: v } : ok;
}
