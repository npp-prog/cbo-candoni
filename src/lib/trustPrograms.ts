/**
 * Trust programmes - the Trust Fund's own funding control.
 *
 * ------------------------------------------------------------------------
 * THIS FILE IS VENDORED INTO THE CLOUD FUNCTIONS BUILD.
 * The copy at `functions/src/lib/trustPrograms.ts` must be byte-identical
 * below the header. `scripts/sync-rules.mjs` copies it and CI compares them.
 * ------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRUST FUND CANNOT USE THE BUDGET CHAIN
 * ---------------------------------------------------------------------------
 * The General Fund and the Special Education Fund are controlled by
 * appropriation, then allotment, then obligation. Every one of those rests on
 * an ordinance the Sanggunian enacted.
 *
 * The Trust Fund has no ordinance. The money is not the municipality's; it was
 * received for a stated purpose from a source that keeps the right to ask for
 * it back. There is nothing to appropriate and nothing to allot.
 *
 * CBO nevertheless checked every fund against `allotmentReleased`, the Trust
 * Fund included. That meant a Funding Utilization Request could not be
 * certified at all unless somebody first invented an appropriation and an
 * Allotment Release Order for trust money - and had they done so, the invented
 * figures would have flowed into the Statement of Receipts and Expenditures
 * and into the bases of the Personal Services cap and the LDRRMF, as though
 * the municipality had been given money it had not.
 *
 * So the Trust Fund gets its own control, of the same shape and none of the
 * same documents:
 *
 *     General Fund      appropriation -> allotment -> obligation -> voucher
 *     Trust Fund        programme     -------------> utilisation -> voucher
 *
 * The programmed amount plays the part the released allotment plays: it is the
 * ceiling, and a utilisation may not pass it.
 *
 * ---------------------------------------------------------------------------
 * WHY A PROGRAMME IS NOT TIED TO A FISCAL YEAR
 * ---------------------------------------------------------------------------
 * Trust money does not expire with the budget year. A grant remitted in
 * November is spent over the following year and sometimes the one after that.
 * Keying the programme to a fiscal year would either strand the balance at the
 * end of December or require it to be re-entered every January, and both of
 * those end with the same figure recorded twice and differing.
 *
 * So the balance is the life of the programme, and the year appears only on
 * the utilisations and the vouchers, which have their own dates.
 */

/**
 * The Trust Fund's code.
 *
 * Here rather than beside the other fund codes because it is the one fund with
 * programmes, and every rule in this file is about it. Defined once: the cash
 * flow statement imports it from here too, and two spellings of 'TF' in two
 * files is the kind of thing that works until somebody changes one of them.
 */
export const TRUST_FUND_CODE = 'TF';

export type Centavos = number;

export interface Violation {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
}

const OK: CheckResult = { ok: true, violations: [] };

const fail = (code: string, message: string, details?: Record<string, unknown>): CheckResult => ({
  ok: false,
  violations: [{ code, message, details }],
});

// ---------------------------------------------------------------------------
// The programme
// ---------------------------------------------------------------------------

export type TrustProgramStatus = 'ACTIVE' | 'CLOSED';

export const TRUST_PROGRAM_STATUSES: TrustProgramStatus[] = ['ACTIVE', 'CLOSED'];

export interface TrustProgramFigures {
  /**
   * The ceiling. What the approved work and financial plan says may be spent
   * on this programme, and the figure a utilisation is checked against.
   */
  programmed: Centavos;
  /**
   * What the source has actually remitted.
   *
   * STATED, and kept now that `receivedPosted` works the same figure out of
   * the receipts - kept deliberately rather than replaced. A programme usually
   * exists in CBO before its collections do: the MOA is recorded, then the
   * money arrives. The stated figure is what the Accountant has been told is
   * coming; the two are compared and the difference shown, and neither
   * overwrites the other.
   *
   * Reported and never controlled on, under either figure: a programme is
   * commonly spent against before the last tranche arrives, and refusing a
   * utilisation for that reason would stop work the source agency expects to
   * be done.
   */
  received: Centavos;
  /**
   * What the receipts actually say, worked out of the collections.
   *
   * Maintained by `postRcd` inside the transaction that posts a Report of
   * Collections and Deposits: every Trust Fund collection line carrying a
   * programme adds to this, and nothing else writes it. So it is a sum of
   * official receipts rather than anybody's recollection, and it is the figure
   * the Registry of Special Trust Fund reports on its Receipt side.
   *
   * A programme whose collections were all recorded before this existed sits
   * at nil with a stated figure beside it, which is what the drift is for.
   */
  receivedPosted: Centavos;
  /** Committed by a certified FURS. */
  utilised: Centavos;
  /** Paid out on an approved voucher. */
  disbursed: Centavos;
  /** programmed - utilised. Derived, never stored independently. */
  availableToUtilise: Centavos;
  /** utilised - disbursed. Derived. */
  unpaidUtilisations: Centavos;
  /**
   * stated less posted. Derived. Zero where the receipts account for
   * everything the Accountant says has come in.
   *
   * Not an error on its own. A positive figure is money stated as remitted
   * that no receipt in CBO carries - right while a tranche is still expected,
   * wrong once it has been banked. A negative one is receipts exceeding what
   * was stated, which usually means the stated figure was never updated after
   * the last tranche arrived.
   */
  receiptDrift: Centavos;
}

export const EMPTY_TRUST_FIGURES: TrustProgramFigures = {
  programmed: 0,
  received: 0,
  receivedPosted: 0,
  utilised: 0,
  disbursed: 0,
  availableToUtilise: 0,
  unpaidUtilisations: 0,
  receiptDrift: 0,
};

/** Recomputes the three derived figures from the five stored ones. */
export function deriveTrustFigures(f: Partial<TrustProgramFigures>): TrustProgramFigures {
  const programmed = f.programmed ?? 0;
  const received = f.received ?? 0;
  const receivedPosted = f.receivedPosted ?? 0;
  const utilised = f.utilised ?? 0;
  const disbursed = f.disbursed ?? 0;
  return {
    programmed,
    received,
    receivedPosted,
    utilised,
    disbursed,
    availableToUtilise: programmed - utilised,
    unpaidUtilisations: utilised - disbursed,
    receiptDrift: received - receivedPosted,
  };
}

// ---------------------------------------------------------------------------
// Recording a programme
// ---------------------------------------------------------------------------

export interface TrustProgramInput {
  programCode: string;
  programName: string;
  /** The agency or person the money came from. */
  sourceAgency: string;
  /** The MOA, deed or advice the money arrived under. */
  reference: string;
  programmed: Centavos;
  received: Centavos;
  status: string;
}

export function checkTrustProgram(input: TrustProgramInput): CheckResult {
  const violations: Violation[] = [];

  if (!input.programCode.trim()) {
    violations.push({
      code: 'TRUST_NO_CODE',
      message: 'A programme code is required. It is what a utilisation is charged to.',
    });
  }

  if (!input.programName.trim()) {
    violations.push({ code: 'TRUST_NO_NAME', message: 'A programme name is required.' });
  }

  if (!input.sourceAgency.trim()) {
    violations.push({
      code: 'TRUST_NO_SOURCE',
      message:
        'Name the source of the money. A trust programme is money held for somebody, and a ' +
        'programme with no named source cannot be reported to them or returned to them.',
    });
  }

  if (!input.reference.trim()) {
    violations.push({
      code: 'TRUST_NO_REFERENCE',
      message:
        'A reference is required - the memorandum of agreement, deed of donation or advice the ' +
        'money arrived under. It is what an auditor traces the programme back to.',
    });
  }

  if (!Number.isInteger(input.programmed) || input.programmed <= 0) {
    violations.push({
      code: 'TRUST_PROGRAMMED_NOT_POSITIVE',
      message:
        'The programmed amount must be greater than zero. It is the ceiling every utilisation ' +
        'is checked against, and a programme with a ceiling of nothing can never be used.',
    });
  }

  if (!Number.isInteger(input.received) || input.received < 0) {
    violations.push({
      code: 'TRUST_RECEIVED_NEGATIVE',
      message: 'The amount received cannot be below nothing.',
    });
  }

  if (!TRUST_PROGRAM_STATUSES.includes(input.status as TrustProgramStatus)) {
    violations.push({
      code: 'TRUST_BAD_STATUS',
      message: `A trust programme is ${TRUST_PROGRAM_STATUSES.join(' or ')}.`,
    });
  }

  return violations.length === 0 ? OK : { ok: false, violations };
}

/**
 * Amending the programmed amount of a programme already in use.
 *
 * A source agency does revise a work and financial plan downwards, and that is
 * a legitimate amendment. What it cannot do is fall below what has already
 * been committed: the utilisations exist, the obligations behind them are
 * numbered, and a ceiling beneath them would show a negative balance that no
 * document caused and none can undo.
 */
export function checkProgrammedAmendment(input: {
  newProgrammed: Centavos;
  alreadyUtilised: Centavos;
}): CheckResult {
  if (input.newProgrammed >= input.alreadyUtilised) return OK;
  return fail(
    'TRUST_PROGRAMMED_BELOW_UTILISED',
    `This programme already carries ${(input.alreadyUtilised / 100).toFixed(2)} of certified ` +
      `utilisations, so its programmed amount cannot be reduced to ` +
      `${(input.newProgrammed / 100).toFixed(2)}. Cancel the utilisations that are no longer ` +
      'wanted first.',
    { newProgrammed: input.newProgrammed, alreadyUtilised: input.alreadyUtilised },
  );
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

export interface FursCheckInput {
  programmed: Centavos;
  alreadyUtilised: Centavos;
  requestedUtilisation: Centavos;
  /** A closed programme accepts nothing further. */
  status?: string;
}

/**
 * The Trust Fund's equivalent of checking an obligation against its allotment.
 *
 * Deliberately the same shape as `checkObligationAgainstAllotment`, down to
 * the details it reports, so the two read alike wherever both appear - a
 * reviewer moving between a General Fund OBR and a Trust Fund FURS should not
 * have to learn two vocabularies for the same refusal.
 */
export function checkFursAgainstProgram(input: FursCheckInput): CheckResult {
  if (input.status === 'CLOSED') {
    return fail(
      'TRUST_PROGRAM_CLOSED',
      'This trust programme is closed. A closed programme has been reported on and settled with ' +
        'its source; utilising it again would reopen a set of figures somebody has already ' +
        'signed off.',
    );
  }

  const available = input.programmed - input.alreadyUtilised;
  const resulting = input.alreadyUtilised + input.requestedUtilisation;

  if (resulting > input.programmed) {
    const excess = resulting - input.programmed;
    return fail(
      'TRUST_UTILISATION_EXCEEDS_PROGRAM',
      `${(input.requestedUtilisation / 100).toFixed(2)} requested against ` +
        `${(available / 100).toFixed(2)} unutilised, short by ${(excess / 100).toFixed(2)}. ` +
        'A utilisation may not pass the programmed amount - that figure is the approved work ' +
        'and financial plan, and the source agency is owed a report against it.',
      {
        available,
        requested: input.requestedUtilisation,
        excess,
        programmed: input.programmed,
      },
    );
  }

  return OK;
}
