import { describe, it, expect } from 'vitest';
import {
  isReported,
  canReleaseCheck,
  canSubmitAda,
  canUndoOutright,
} from './releaseControl';

describe('isReported', () => {
  it('is false until a certified report has claimed the document', () => {
    expect(isReported({ status: 'PREPARED' })).toBe(false);
    expect(isReported({ status: 'SIGNED', treasuryReportId: null })).toBe(false);
    expect(isReported({ status: 'SIGNED', treasuryReportId: '' })).toBe(false);
  });

  it('is true once it has', () => {
    expect(isReported({ status: 'SIGNED', treasuryReportId: 'rci-1' })).toBe(true);
  });
});

describe('canReleaseCheck', () => {
  it('refuses a check that is not on a certified RCI', () => {
    const result = canReleaseCheck({ status: 'SIGNED' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Report of Checks Issued');
      // The reason, not just the rule: a clerk who is told only "not allowed"
      // looks for a way round it.
      expect(result.message).toContain('General Ledger');
    }
  });

  it('allows a check that is', () => {
    expect(canReleaseCheck({ status: 'SIGNED', treasuryReportId: 'rci-1' })).toEqual({ ok: true });
  });

  it('refuses a cancelled check whatever its report says', () => {
    const result = canReleaseCheck({ status: 'CANCELLED', treasuryReportId: 'rci-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('cancelled');
  });
});

describe('canSubmitAda', () => {
  it('refuses an advice that is not on a certified RADAI', () => {
    const result = canSubmitAda({ status: 'PREPARED' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Report of ADA Issued');
  });

  it('allows one that is', () => {
    expect(canSubmitAda({ status: 'PREPARED', treasuryReportId: 'radai-1' })).toEqual({ ok: true });
  });
});

describe('canUndoOutright', () => {
  it('allows an undo while nothing has happened to it yet', () => {
    expect(canUndoOutright({ status: 'PREPARED' })).toBe(true);
  });

  it('refuses once it has been signed', () => {
    expect(canUndoOutright({ status: 'SIGNED' })).toBe(false);
  });

  it('refuses once it has been released', () => {
    expect(canUndoOutright({ status: 'RELEASED' })).toBe(false);
  });

  it('refuses once it has been reported, even if still prepared', () => {
    // The RCI has gone to Accounting naming this serial. Undoing it now would
    // leave the report describing a check that does not exist.
    expect(canUndoOutright({ status: 'PREPARED', treasuryReportId: 'rci-1' })).toBe(false);
  });
});
