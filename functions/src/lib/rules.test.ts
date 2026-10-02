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
        forLaterRelease: 0,
      }).ok,
    ).toBe(false);
  });

  it('counts the hold against what may be released', () => {
    // 1,000,000 appropriated with 400,000 held for later release leaves
    // 600,000 releasable, so a request that would take the total past it is
    // refused even though the appropriation itself is nowhere near exhausted.
    expect(
      checkAllotmentAgainstAppropriation({
        appropriationRevised: 1_000_000_00,
        allotmentAlreadyReleased: 599_999_99,
        requestedRelease: 2,
        forLaterRelease: 400_000_00,
      }).ok,
    ).toBe(false);
  });

  it('refuses rather than passes when an input is not a number', () => {
    /*
     * This test is the reason the one above was wrong for weeks without
     * anything failing. The old call omitted forLaterRelease, which made
     *
     *     releasable = appropriationRevised - undefined   ->  NaN
     *
     * and every comparison with NaN is false, so the guard returned ok for
     * any amount against any appropriation. A control that stops controlling
     * when its input is wrong is worse than no control, because the screen
     * still reports that the release was checked.
     *
     * These functions run on the server against data assembled from Firestore
     * documents, where a field that was never written reads as undefined and
     * no type annotation is there to stop it. So the arithmetic is guarded at
     * run time, and the guard FAILS CLOSED.
     */
    const result = checkAllotmentAgainstAppropriation({
      appropriationRevised: 1_000_000_00,
      allotmentAlreadyReleased: 999_999_99,
      requestedRelease: 2,
      forLaterRelease: undefined as unknown as number,
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('CHECK_INPUT_NOT_A_NUMBER');
  });

  it('fails closed on the obligation guard too', () => {
    const result = checkObligationAgainstAllotment({
      allotmentReleased: undefined as unknown as number,
      alreadyObligated: 0,
      requestedObligation: 500_000_00,
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('CHECK_INPUT_NOT_A_NUMBER');
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
