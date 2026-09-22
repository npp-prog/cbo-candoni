import { describe, it, expect } from 'vitest';
import {
  checkDoubleEntry,
  checkObligationAgainstAllotment,
  checkAllotmentAgainstAppropriation,
  computeReconciliation,
} from './rules';

/**
 * A smoke test of the vendored copy of the accounting invariants.
 *
 * The exhaustive suite lives beside the canonical file at
 * `src/lib/accounting-rules.test.ts`. What is verified here is that the copy
 * the *server* decides with behaves identically on the cases that matter most -
 * so that a botched sync is caught by a failing test rather than by a wrongly
 * approved obligation. `npm test` in this package also runs `check:rules`,
 * which fails if the two files differ at all.
 */

describe('vendored invariants (server copy)', () => {
  it('enforces debit equals credit', () => {
    expect(
      checkDoubleEntry([
        { lineNo: 1, accountCode: '1', debit: 100_00, credit: 0 },
        { lineNo: 2, accountCode: '2', debit: 0, credit: 100_00 },
      ]).ok,
    ).toBe(true);

    expect(
      checkDoubleEntry([
        { lineNo: 1, accountCode: '1', debit: 100_00, credit: 0 },
        { lineNo: 2, accountCode: '2', debit: 0, credit: 99_99 },
      ]).ok,
    ).toBe(false);
  });

  it('enforces obligation within available allotment', () => {
    expect(
      checkObligationAgainstAllotment({
        allotmentReleased: 500_000_00,
        alreadyObligated: 300_000_00,
        requestedObligation: 200_000_00,
      }).ok,
    ).toBe(true);

    expect(
      checkObligationAgainstAllotment({
        allotmentReleased: 500_000_00,
        alreadyObligated: 300_000_00,
        requestedObligation: 200_000_01,
      }).ok,
    ).toBe(false);
  });

  it('enforces allotment within appropriation', () => {
    expect(
      checkAllotmentAgainstAppropriation({
        appropriationRevised: 1_000_000_00,
        allotmentAlreadyReleased: 999_999_99,
        requestedRelease: 2,
      }).ok,
    ).toBe(false);
  });

  it('reconciles to zero', () => {
    expect(
      computeReconciliation({
        balancePerBank: 100_000_00,
        depositsInTransit: 5_000_00,
        outstandingChecks: 3_000_00,
        bankAdjustments: 0,
        balancePerBooks: 102_500_00,
        bookAdjustments: -500_00,
      }).reconciled,
    ).toBe(true);
  });
});
