import { describe, it, expect } from 'vitest';
import { isCertifiedCopy } from './FormPrintStyle';
import { TREASURY_REPORT_STATUSES, RCD_STATUSES } from '@/types/enums';

/**
 * Which printed copies carry the "not yet certified" band.
 *
 * The band exists because a draft printed on the prescribed form is otherwise
 * indistinguishable from the certified one - same letterhead, same
 * certification paragraph, same signature lines - and a copy left on a desk can
 * be signed. So the question "is this the finished document" has to be answered
 * correctly for every status in BOTH flows, and the two flows do not use the
 * same words.
 *
 * These tests walk the status enums themselves rather than a list written out
 * here, so a status added to either flow and not considered fails the build
 * instead of quietly printing with the wrong band.
 */
describe('isCertifiedCopy', () => {
  it('clears the band once a treasury report is certified', () => {
    expect(isCertifiedCopy('CERTIFIED')).toBe(true);
  });

  it('clears it after Accounting has journalized it, which is later still', () => {
    // The case that was wrong when this was written: every report Accounting
    // had already journalized would have reprinted stamped DRAFT.
    expect(isCertifiedCopy('JOURNALIZED')).toBe(true);
  });

  it('keeps the band on a draft and on a withdrawn report', () => {
    expect(isCertifiedCopy('DRAFT')).toBe(false);
    expect(isCertifiedCopy('CANCELLED')).toBe(false);
  });

  it('clears it on a posted legacy RCD and keeps it on the stages before', () => {
    expect(isCertifiedCopy('POSTED')).toBe(true);
    // Stages on the way. The cautious reading is the right one: a band on a
    // copy that did not need it costs a reprint; a missing band on one that did
    // costs a signature on the wrong paper.
    expect(isCertifiedCopy('SUBMITTED')).toBe(false);
    expect(isCertifiedCopy('VERIFIED')).toBe(false);
  });

  it('keeps the band when there is no status at all', () => {
    expect(isCertifiedCopy(undefined)).toBe(false);
    expect(isCertifiedCopy(null)).toBe(false);
    expect(isCertifiedCopy('')).toBe(false);
  });

  /**
   * The one that fails when somebody adds a status and does not come here.
   * Every value in both flows must get a deliberate answer, and the only way
   * for this test to pass is for each to be in one bucket or the other.
   */
  it('has an answer for every status in both flows', () => {
    const certified = ['CERTIFIED', 'JOURNALIZED', 'POSTED'];
    const drafts = ['DRAFT', 'SUBMITTED', 'VERIFIED', 'CANCELLED'];

    for (const status of [...TREASURY_REPORT_STATUSES, ...RCD_STATUSES]) {
      const considered = certified.includes(status) || drafts.includes(status);
      expect(considered, `${status} is a status nobody decided about`).toBe(true);
      expect(isCertifiedCopy(status), status).toBe(certified.includes(status));
    }
  });
});
