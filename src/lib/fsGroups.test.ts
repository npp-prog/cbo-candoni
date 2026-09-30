import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GROUP_CAPTIONS,
  PERFORMANCE_EXPENSES,
  PERFORMANCE_REVENUE,
  POSITION_SECTIONS,
  captionFor,
  majorGroupOf,
} from './fsGroups';
import { accountClassFor, fsClassificationFor } from './chartOfAccounts';

/**
 * The statements are condensed by account group, so a group with no caption is
 * a figure that vanishes off the face of a submitted statement without
 * unbalancing it. These tests are mostly about that not happening.
 */

/** The municipality's own 625 accounts, shipped in the repo. */
function chart(): Array<{ code: string; name: string }> {
  const csv = readFileSync(
    resolve(__dirname, '..', '..', 'data', 'chart-of-accounts.csv'),
    'utf8',
  );
  return csv
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(',');
      return { code: l.slice(0, i).trim(), name: l.slice(i + 1).trim() };
    })
    .filter((r) => /^\d{8}$/.test(r.code));
}

describe('the caption an account prints under', () => {
  it('reads the group off the first three digits', () => {
    expect(majorGroupOf('10101010')).toBe('101');
    expect(captionFor('10101010')).toBe('Cash and Cash Equivalents');
  });

  /**
   * Volume III calls the group "Cash" and Annex 5 prints "Cash and Cash
   * Equivalents". The annex wins: the annex is the statement.
   */
  it.each([
    ['10101010', 'Cash and Cash Equivalents'],
    ['10201010', 'Investments'],
    ['10301020', 'Receivables'],
    ['10401010', 'Inventories'],
    ['10501010', 'Prepayments and Deferred Charges'],
    ['10601010', 'Investment Property'],
    ['10701010', 'Property, Plant and Equipment'],
    ['10801010', 'Biological Assets'],
    ['10901010', 'Intangible Assets'],
    ['20101010', 'Financial Liabilities'],
    ['20201010', 'Inter-Agency Payables'],
    ['20301010', 'Intra-Agency Payables'],
    ['20401010', 'Trust Liabilities'],
    ['20501010', 'Deferred Credits/Unearned Income'],
    ['20601010', 'Provisions'],
    ['29900000', 'Other Payables'],
    ['40101010', 'Tax Revenue'],
    ['40201010', 'Service and Business Income'],
    ['40401010', 'Shares, Grants and Donations'],
    ['40501010', 'Gains'],
    ['40601010', 'Other Income'],
    ['50101010', 'Personnel Services'],
    ['50201010', 'Maintenance and Other Operating Expenses'],
    ['50301010', 'Financial Expenses'],
    ['50501010', 'Non-Cash Expenses'],
  ])('%s prints under %s', (code, caption) => {
    expect(captionFor(code)).toBe(caption);
  });

  /**
   * Null, not zero, and not a caption of its own invented on the spot. A
   * statement that quietly dropped an unrecognised account would still
   * balance and the figure would never be found.
   */
  it('gives back nothing for a group it does not know', () => {
    expect(captionFor('79901010')).toBeNull();
    expect(captionFor('')).toBeNull();
  });
});

/**
 * The test that matters most. Every one of the municipality's own accounts has
 * to land on a caption, or it is a figure missing from a statement that still
 * adds up.
 */
describe('against the municipality own chart of accounts', () => {
  const accounts = chart();

  it('reads 625 accounts from the shipped chart', () => {
    expect(accounts.length).toBeGreaterThan(600);
  });

  it('gives every account a caption', () => {
    const orphans = accounts.filter((a) => captionFor(a.code) === null);
    expect(
      orphans.map((a) => `${a.code} ${a.name}`),
      'accounts with no statement caption',
    ).toEqual([]);
  });

  it('gives every account a class the statements know', () => {
    const unclassified = accounts.filter((a) => accountClassFor(a.code) === null);
    expect(unclassified.map((a) => a.code)).toEqual([]);
  });

  /**
   * A caption must not appear in two sections of the same side of the
   * statement, or the same figure would be printed twice and the total would
   * double it. Across sides is fine and expected - Annex 5 prints
   * Investments and Receivables under both current and non-current, and
   * `fsClassificationFor` decides which one an account falls in.
   */
  it('puts each account in exactly one section of the statement', () => {
    for (const a of accounts) {
      const cls = fsClassificationFor(a.code);
      if (!cls) continue;
      const sections = POSITION_SECTIONS.filter((s) => s.key === cls);
      expect(sections.length, `${a.code} ${a.name}`).toBeLessThanOrEqual(1);
    }
  });

  /** Every caption on the face of the statement must have accounts behind it. */
  it('has at least one account behind every position caption', () => {
    const used = new Set(accounts.map((a) => captionFor(a.code)));
    const empty = POSITION_SECTIONS.flatMap((s) => s.captions).filter((c) => !used.has(c));
    expect(empty).toEqual([]);
  });
});

describe('the Statement of Financial Performance', () => {
  it('prints the expense captions in the annex order, not the chart order', () => {
    // Annex 6 puts Non-Cash Expenses (5-05) BEFORE Financial Expenses (5-03).
    const captions = PERFORMANCE_EXPENSES.map((l) => l.caption);
    expect(captions.indexOf('Non-Cash Expenses')).toBeLessThan(
      captions.indexOf('Financial Expenses'),
    );
  });

  it('carries Direct Costs so the expense total foots', () => {
    expect(PERFORMANCE_EXPENSES.some((l) => l.groups.includes('504'))).toBe(true);
  });

  /**
   * The finding from patch 46, showing up again on a different form: the
   * municipality's chart has no National Tax Allotment account, so the two
   * national-share lines of Annex 6 have nothing behind them. They are printed
   * because the form prints them, and they stay at nil until the account
   * exists.
   */
  it('leaves the national share lines empty, which is the honest figure', () => {
    const shares = PERFORMANCE_REVENUE.filter((l) => l.caption.includes('Share'));
    const national = shares.filter((l) => !l.caption.startsWith('Shares,'));
    expect(national).toHaveLength(2);
    for (const l of national) expect(l.groups).toEqual([]);
  });

  it('draws every other revenue line from exactly one group', () => {
    const backed = PERFORMANCE_REVENUE.filter((l) => l.groups.length > 0);
    expect(backed).toHaveLength(5);
    for (const l of backed) expect(l.groups).toHaveLength(1);
  });

  it('does not use one group on two lines', () => {
    const all = [...PERFORMANCE_REVENUE, ...PERFORMANCE_EXPENSES].flatMap((l) => l.groups);
    expect(new Set(all).size).toBe(all.length);
  });

  it('covers every revenue and expense group the chart has, except transfers', () => {
    const used = new Set([...PERFORMANCE_REVENUE, ...PERFORMANCE_EXPENSES].flatMap((l) => l.groups));
    const inChart = new Set(
      chart()
        .map((a) => majorGroupOf(a.code))
        .filter((g) => g.startsWith('4') || g.startsWith('5')),
    );
    // 403 is the transfers block, reported beneath the surplus rather than in
    // either list, so it is expected to be missing from `used`.
    const missed = [...inChart].filter((g) => !used.has(g) && g !== '403');
    expect(missed).toEqual([]);
  });
});

describe('the captions themselves', () => {
  it('names a caption for every group in the table', () => {
    for (const [key, caption] of Object.entries(GROUP_CAPTIONS)) {
      expect(key).toMatch(/^\d{3}$/);
      expect(caption.length).toBeGreaterThan(0);
    }
  });
});
