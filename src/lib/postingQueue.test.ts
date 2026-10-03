import { describe, it, expect } from 'vitest';
import { awaitingPosting, totalAwaitingPosting } from './postingQueue';

const jev = (status: string, totalDebit = 1_000_00) => ({ status, totalDebit });

describe('awaitingPosting', () => {
  it('counts a draft entry raised from a voucher', () => {
    // This is the case that made the Accountant think the reports were not
    // connected to the journal entries at all: the voucher said an entry had
    // been generated, and the General Ledger showed nothing.
    expect(awaitingPosting([jev('DRAFT')])).toHaveLength(1);
  });

  it('counts every state before posting', () => {
    const rows = awaitingPosting([
      jev('DRAFT'),
      jev('FOR_REVIEW'),
      jev('REVIEWED'),
      jev('APPROVED'),
    ]);

    expect(rows).toHaveLength(4);
  });

  it('does not count an entry that has reached the ledger', () => {
    expect(awaitingPosting([jev('POSTED')])).toEqual([]);
  });

  it('does not count one whose life is over', () => {
    expect(awaitingPosting([jev('CANCELLED'), jev('REVERSED')])).toEqual([]);
  });

  it('is empty when everything has been posted', () => {
    expect(awaitingPosting([jev('POSTED'), jev('POSTED')])).toEqual([]);
  });
});

describe('totalAwaitingPosting', () => {
  it('adds only what is waiting', () => {
    expect(totalAwaitingPosting([jev('DRAFT', 500), jev('POSTED', 9_999), jev('REVIEWED', 250)]))
      .toBe(750);
  });

  it('copes with an entry carrying no total', () => {
    expect(totalAwaitingPosting([{ status: 'DRAFT' }])).toBe(0);
  });
});
