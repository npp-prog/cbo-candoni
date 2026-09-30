import { describe, it, expect } from 'vitest';
import {
  checkFursAgainstProgram,
  checkProgrammedAmendment,
  checkTrustProgram,
  deriveTrustFigures,
  type TrustProgramInput,
} from './trustPrograms';

const program = (over: Partial<TrustProgramInput> = {}): TrustProgramInput => ({
  programCode: 'SBDP-2026',
  programName: 'Support to Barangay Development Program 2026',
  sourceAgency: 'Department of the Interior and Local Government',
  reference: 'MOA 2026-014',
  programmed: 5_000_000_00,
  received: 5_000_000_00,
  status: 'ACTIVE',
  ...over,
});

describe('deriveTrustFigures', () => {
  it('computes what may still be utilised and what is utilised but unpaid', () => {
    const f = deriveTrustFigures({
      programmed: 1_000_00,
      received: 600_00,
      utilised: 400_00,
      disbursed: 250_00,
    });
    expect(f.availableToUtilise).toBe(600_00);
    expect(f.unpaidUtilisations).toBe(150_00);
  });

  it('treats a missing figure as nothing rather than failing', () => {
    expect(deriveTrustFigures({}).availableToUtilise).toBe(0);
    expect(deriveTrustFigures({ programmed: 100 }).unpaidUtilisations).toBe(0);
  });

  /**
   * Received is reported, never controlled on. A programme spent against
   * before the last tranche arrives is ordinary, and the derived figures must
   * not quietly depend on it.
   */
  it('does not let the amount received affect what may be utilised', () => {
    const f = deriveTrustFigures({ programmed: 1_000_00, received: 0, utilised: 100_00 });
    expect(f.availableToUtilise).toBe(900_00);
  });
});

describe('checkTrustProgram', () => {
  it('passes a complete programme', () => {
    expect(checkTrustProgram(program()).ok).toBe(true);
  });

  it('requires a code, a name, a source and a reference', () => {
    const result = checkTrustProgram(
      program({ programCode: ' ', programName: '', sourceAgency: '  ', reference: '' }),
    );
    expect(result.violations.map((v) => v.code).sort()).toEqual([
      'TRUST_NO_CODE',
      'TRUST_NO_NAME',
      'TRUST_NO_REFERENCE',
      'TRUST_NO_SOURCE',
    ]);
  });

  it('refuses a programme with no ceiling to check against', () => {
    expect(checkTrustProgram(program({ programmed: 0 })).violations[0].code).toBe(
      'TRUST_PROGRAMMED_NOT_POSITIVE',
    );
    expect(checkTrustProgram(program({ programmed: -1 })).violations[0].code).toBe(
      'TRUST_PROGRAMMED_NOT_POSITIVE',
    );
  });

  it('allows a programme with nothing received yet', () => {
    expect(checkTrustProgram(program({ received: 0 })).ok).toBe(true);
  });

  it('refuses a negative amount received', () => {
    expect(checkTrustProgram(program({ received: -1 })).violations[0].code).toBe(
      'TRUST_RECEIVED_NEGATIVE',
    );
  });

  it('refuses a status outside the two', () => {
    expect(checkTrustProgram(program({ status: 'SUSPENDED' })).violations[0].code).toBe(
      'TRUST_BAD_STATUS',
    );
  });

  /** Centavos are integers throughout CBO; a float would round elsewhere. */
  it('refuses a fractional centavo', () => {
    expect(checkTrustProgram(program({ programmed: 100.5 })).violations[0].code).toBe(
      'TRUST_PROGRAMMED_NOT_POSITIVE',
    );
  });
});

describe('checkProgrammedAmendment', () => {
  it('allows a reduction that stays above what is already committed', () => {
    expect(
      checkProgrammedAmendment({ newProgrammed: 500_00, alreadyUtilised: 400_00 }).ok,
    ).toBe(true);
  });

  it('allows a reduction to exactly what is committed', () => {
    expect(
      checkProgrammedAmendment({ newProgrammed: 400_00, alreadyUtilised: 400_00 }).ok,
    ).toBe(true);
  });

  /**
   * A ceiling beneath the utilisations already certified would show a negative
   * balance that no document caused and none can undo.
   */
  it('refuses a reduction below what is already committed', () => {
    const result = checkProgrammedAmendment({ newProgrammed: 300_00, alreadyUtilised: 400_00 });
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('TRUST_PROGRAMMED_BELOW_UTILISED');
    expect(result.violations[0].details).toMatchObject({ alreadyUtilised: 400_00 });
  });

  it('allows any amount on a programme nothing has been utilised against', () => {
    expect(checkProgrammedAmendment({ newProgrammed: 1, alreadyUtilised: 0 }).ok).toBe(true);
  });
});

describe('checkFursAgainstProgram', () => {
  it('allows a utilisation inside the programmed amount', () => {
    expect(
      checkFursAgainstProgram({
        programmed: 5_000_000_00,
        alreadyUtilised: 1_000_000_00,
        requestedUtilisation: 500_000_00,
      }).ok,
    ).toBe(true);
  });

  it('allows a utilisation that exactly exhausts the programme', () => {
    expect(
      checkFursAgainstProgram({
        programmed: 1_000_00,
        alreadyUtilised: 600_00,
        requestedUtilisation: 400_00,
      }).ok,
    ).toBe(true);
  });

  it('refuses one peso beyond it, and says by how much', () => {
    const result = checkFursAgainstProgram({
      programmed: 1_000_00,
      alreadyUtilised: 600_00,
      requestedUtilisation: 400_01,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('TRUST_UTILISATION_EXCEEDS_PROGRAM');
    expect(result.violations[0].details).toMatchObject({ available: 400_00, excess: 1 });
  });

  /**
   * Received does not gate a utilisation. A programme spent against before the
   * last tranche arrives is normal practice, and refusing it would stop work
   * the source agency expects to be done.
   */
  it('does not refuse a utilisation merely because the money has not arrived', () => {
    expect(
      checkFursAgainstProgram({
        programmed: 1_000_00,
        alreadyUtilised: 0,
        requestedUtilisation: 900_00,
      }).ok,
    ).toBe(true);
  });

  it('refuses anything at all against a closed programme', () => {
    const result = checkFursAgainstProgram({
      programmed: 1_000_00,
      alreadyUtilised: 0,
      requestedUtilisation: 1_00,
      status: 'CLOSED',
    });
    expect(result.violations[0].code).toBe('TRUST_PROGRAM_CLOSED');
  });

  it('checks the programme before the arithmetic, so a closed one is refused as closed', () => {
    const result = checkFursAgainstProgram({
      programmed: 1_000_00,
      alreadyUtilised: 1_000_00,
      requestedUtilisation: 5_000_00,
      status: 'CLOSED',
    });
    expect(result.violations[0].code).toBe('TRUST_PROGRAM_CLOSED');
  });

  it('reports the shortfall in the same shape the allotment check does', () => {
    const details = checkFursAgainstProgram({
      programmed: 100_00,
      alreadyUtilised: 0,
      requestedUtilisation: 250_00,
    }).violations[0].details as Record<string, number>;
    expect(details.available).toBe(100_00);
    expect(details.requested).toBe(250_00);
    expect(details.excess).toBe(150_00);
  });
});
