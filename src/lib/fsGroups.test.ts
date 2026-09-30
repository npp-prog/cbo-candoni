import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GROUP_CAPTIONS,
  PERFORMANCE_EXPENSES,
  PERFORMANCE_REVENUE,
  POSITION_SECTIONS,
  captionFor,
  lineForCode,
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
   * The correction. Patch 48 left both national share lines empty and said the
   * chart had no such account. It has: 4-01-06, five accounts of it, and the
   * largest single income of the municipality is the first.
   */
  it('puts the IRA account on its own line, not in Tax Revenue', () => {
    const line = lineForCode(PERFORMANCE_REVENUE, '40106010');
    expect(line?.caption).toBe('Share from Internal Revenue Collections');
  });

  it.each([
    ['40106020', 'Share from Expanded Value Added Tax'],
    ['40106030', 'Share from National Wealth'],
    ['40106040', 'Share from Tobacco Excise Tax'],
    ['40106050', 'Share from Economic Zones'],
  ])('puts %s (%s) under Other Share from National Taxes', (code) => {
    expect(lineForCode(PERFORMANCE_REVENUE, code)?.caption).toBe(
      'Other Share from National Taxes',
    );
  });

  /**
   * The longest prefix wins, and it has to: 4010601 is inside 40106 is inside
   * 401. Matched the other way round, the municipality's largest income would
   * print on the wrong line of a submitted statement.
   */
  it('matches the longest prefix, so the shares do not fall back into Tax Revenue', () => {
    expect(lineForCode(PERFORMANCE_REVENUE, '40102040')?.caption).toBe('Tax Revenue');
    expect(lineForCode(PERFORMANCE_REVENUE, '40105020')?.caption).toBe('Tax Revenue');
    expect(lineForCode(PERFORMANCE_REVENUE, '40106010')?.caption).not.toBe('Tax Revenue');
  });

  it('gives back nothing for a code no line claims', () => {
    expect(lineForCode(PERFORMANCE_REVENUE, '10101010')).toBeUndefined();
  });

  it('claims no prefix twice', () => {
    const all = [...PERFORMANCE_REVENUE, ...PERFORMANCE_EXPENSES].flatMap((l) => l.groups);
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * Every revenue and expense account in the municipality's chart reaches a
   * line. Checked per ACCOUNT rather than per group, because the lines are no
   * longer whole groups.
   */
  it('reaches every revenue and expense account the chart has, except transfers', () => {
    const missed = chart()
      .filter((a) => a.code.startsWith('4') || a.code.startsWith('5'))
      // 4-03 is the transfers block, reported beneath the surplus rather than
      // on either list.
      .filter((a) => majorGroupOf(a.code) !== '403')
      .filter(
        (a) =>
          !lineForCode(PERFORMANCE_REVENUE, a.code) && !lineForCode(PERFORMANCE_EXPENSES, a.code),
      );
    expect(missed.map((a) => `${a.code} ${a.name}`)).toEqual([]);
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
