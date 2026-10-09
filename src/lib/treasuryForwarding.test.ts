import { describe, it, expect } from 'vitest';
import { awaitingForward, isForwarded } from './treasuryForwarding';

/** Patch 143: certify and forward are two acts. */
describe('forwarding a certified report', () => {
  it('holds a report certified from patch 143 on until it is forwarded', () => {
    expect(isForwarded({ status: 'CERTIFIED', forwardedAt: null })).toBe(false);
    expect(awaitingForward({ status: 'CERTIFIED', forwardedAt: null })).toBe(true);
    expect(isForwarded({ status: 'CERTIFIED', forwardedAt: '2026-10-10T01:00:00Z' })).toBe(true);
  });

  it('treats a report certified before patch 143 as forwarded', () => {
    expect(isForwarded({ status: 'CERTIFIED' })).toBe(true);
    expect(awaitingForward({ status: 'CERTIFIED' })).toBe(false);
  });

  it('never forwards a draft or a withdrawn report', () => {
    expect(isForwarded({ status: 'DRAFT', forwardedAt: null })).toBe(false);
    expect(isForwarded({ status: 'CANCELLED' })).toBe(false);
    expect(isForwarded({ status: 'JOURNALIZED' })).toBe(true);
  });
});
