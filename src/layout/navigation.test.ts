import { describe, it, expect } from 'vitest';
import { NAVIGATION, groupForPath, toBlocks, type NavChild } from './navigation';
import {
  ADA_TABS,
  CHECK_TABS,
  COLLECTION_TABS,
  PAYROLL_TABS,
} from '@/pages/treasury/sections';

/**
 * The menu is data, and these are the properties of that data the sidebar
 * relies on. A folded menu makes them matter more than they did: a heading
 * that opens for the wrong screen now hides the screen the user is on.
 */

describe('toBlocks', () => {
  it('cuts consecutive children of the same heading into one run', () => {
    const children: NavChild[] = [
      { group: 'A', label: 'one', to: '/1' },
      { group: 'A', label: 'two', to: '/2' },
      { group: 'B', label: 'three', to: '/3' },
    ];
    const blocks = toBlocks(children);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].group).toBe('A');
    expect(blocks[0].items.map((i) => i.to)).toEqual(['/1', '/2']);
    expect(blocks[1].items).toHaveLength(1);
  });

  it('gives ungrouped children a run of their own with no heading', () => {
    const blocks = toBlocks([
      { label: 'plain', to: '/p' },
      { group: 'A', label: 'one', to: '/1' },
    ]);
    expect(blocks[0].group).toBeUndefined();
    expect(blocks[1].group).toBe('A');
  });

  /**
   * Separated runs of the same name stay separate. Merging them would hide a
   * mistake in navigation.ts - two headings with one name on screen - behind a
   * renderer that quietly tidied it away.
   */
  it('does not merge two runs of the same name that were written apart', () => {
    const blocks = toBlocks([
      { group: 'A', label: 'one', to: '/1' },
      { group: 'B', label: 'two', to: '/2' },
      { group: 'A', label: 'three', to: '/3' },
    ]);
    expect(blocks).toHaveLength(3);
  });

  it('handles a section with no children at all', () => {
    expect(toBlocks([])).toEqual([]);
  });
});

describe('groupForPath', () => {
  it('finds the heading a screen sits under', () => {
    expect(groupForPath('/treasury/print/receipts')).toEqual({
      sectionTo: '/treasury',
      group: 'Printing',
    });
  });

  /**
   * The case that motivated the longest-match rule. Both /treasury/checks and
   * /treasury/checks/rci are menu items; the second is under a different
   * heading from the first, and opening the first would leave the highlighted
   * item folded out of sight.
   */
  it('prefers the longest matching item when two both match', () => {
    expect(groupForPath('/treasury/checks')?.group).toBe('Registers');
    expect(groupForPath('/treasury/checks/rci')?.group).toBe('Treasury Reports');
  });

  it('matches a detail screen below a menu item', () => {
    expect(groupForPath('/accounting/disbursements/abc123')?.group).toBe(
      'Journal Entry Transactions',
    );
  });

  it('does not match a sibling whose path merely starts with the same text', () => {
    // /treasury/collections is a menu item; /treasury/collections-x is not a
    // child of it and must not borrow its heading.
    expect(groupForPath('/treasury/collections-x')).toBeNull();
  });

  it('returns null for a screen with no heading', () => {
    expect(groupForPath('/audit-trail')).toBeNull();
    expect(groupForPath('/nowhere')).toBeNull();
  });
});

describe('the menu itself', () => {
  it('lists no screen twice', () => {
    const targets = NAVIGATION.flatMap((item) => (item.children ?? []).map((c) => c.to));
    const seen = new Set<string>();
    const twice = targets.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    expect(twice).toEqual([]);
  });

  /**
   * Within one section, either everything carries a heading or nothing does.
   * A section with some grouped and some loose items renders the loose ones
   * with no heading above them, which reads as though they belonged to
   * whichever heading happened to come before.
   */
  it('groups a section all or nothing', () => {
    for (const item of NAVIGATION) {
      const children = item.children ?? [];
      if (children.length === 0) continue;
      const grouped = children.filter((c) => c.group).length;
      expect(grouped === 0 || grouped === children.length, `${item.label} is half grouped`).toBe(
        true,
      );
    }
  });

  /**
   * Four registers: Checks, ADA, Collections and Deposits, Payroll. The
   * temptation, every time a screen is added, is to put it here - it is the
   * first heading and everything is arguably a register. That is how the
   * heading came to hold eight items and stopped answering "which book am I
   * working in today". A new screen goes in a tab on the book it belongs to,
   * or under a heading that fits, and this test is the thing that says so.
   *
   * These five are books the office WRITES IN. A document drawn off one of
   * them is a tab on it, however much it looks like a register from outside.
   */
  it('keeps the Treasury registers to the books the office writes in', () => {
    const treasury = NAVIGATION.find((i) => i.to === '/treasury');
    const registers = (treasury?.children ?? []).filter((c) => c.group === 'Registers');
    expect(registers.map((r) => r.label)).toEqual([
      'Checks',
      'ADA',
      'Collections and Deposits',
      'Payroll',
      'Accountable Forms',
    ]);
  });

  /**
   * A heading is written as a person would say it. The sidebar no longer
   * shouts it in capitals, so a heading typed in capitals here would be the
   * only one on screen that shouts.
   */
  it('writes every heading in sentence case', () => {
    for (const item of NAVIGATION) {
      for (const child of item.children ?? []) {
        if (!child.group) continue;
        expect(child.group, `${child.group} is written in capitals`).not.toBe(
          child.group.toUpperCase(),
        );
      }
    }
  });

  /**
   * A screen reached by a tab is not also a sidebar item.
   *
   * Both doors lead to the same place, so nothing breaks - which is exactly
   * why it goes unnoticed. What it costs is the meaning of the sidebar: four
   * documents about collections listed beside Collections say they are
   * separate activities, and the clerk who has just recorded the day's
   * receipts goes back out to the menu to report on them.
   *
   * The four section reports the municipality submits - RCD, RCI, RADAI,
   * RCDisb - are the deliberate exception. They are listed in Treasury Reports
   * as well, because "where do I find the RCD" is asked by people who are not
   * in the collections screen at the time.
   */
  it('does not list a tab screen in the sidebar as well, except the submitted reports', () => {
    const tabTargets = new Set(
      [...COLLECTION_TABS, ...CHECK_TABS, ...ADA_TABS, ...PAYROLL_TABS].map((t) => t.to),
    );
    const submitted = new Set([
      '/treasury/collections/rcd',
      '/treasury/checks/rci',
      '/treasury/ada/radai',
      '/treasury/payroll/rcdisb',
    ]);
    // The register each strip hangs off is itself a sidebar item, by design.
    const registers = new Set([
      '/treasury/checks',
      '/treasury/ada',
      '/treasury/collections',
      '/treasury/payroll',
    ]);

    const menuTargets = NAVIGATION.flatMap((i) => (i.children ?? []).map((c) => c.to));
    const both = menuTargets.filter(
      (t) => tabTargets.has(t) && !submitted.has(t) && !registers.has(t),
    );
    expect(both).toEqual([]);
  });

  /**
   * Three Local Budget Accountability reports, and only three.
   *
   * The manual defines six. LBAc 3, 5 and 6 want physical targets and outputs,
   * which belong to the Planning Office and which CBO holds none of. The
   * temptation with a numbered series is completeness - build all six, leave
   * the physical columns blank - and the result is three mostly-empty forms in
   * the menu that somebody eventually fills the financial half of and submits.
   *
   * If a fourth appears here, it should be because the municipality decided to
   * hold physical performance data, not because the list looked incomplete.
   */
  it('lists the three LBAc reports the municipality files, under Budget', () => {
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    const reports = (budget?.children ?? []).filter((c) => c.group === 'Reports');
    expect(reports.map((r) => r.to)).toEqual([
      '/budget/reports/receipts',
      '/budget/reports/quarterly-financial',
      '/budget/reports/sre',
    ]);
  });

  /**
   * And they are not also in the Reports menu. That menu holds statements
   * drawn off the books; these account for the budget, and a report in two
   * menus tells a clerk they are two different reports.
   */
  it('does not leave the accountability reports in the Reports menu as well', () => {
    const reportsMenu = NAVIGATION.find((i) => i.to === '/reports');
    const targets = (reportsMenu?.children ?? []).map((c) => c.to);
    expect(targets).not.toContain('/reports/sre');
    expect(targets).not.toContain('/reports/quarterly-financial');
  });

  /**
   * The two halves of LBP Form No. 1, in the form's own order: what will pay
   * for the year, then what the year will spend. The ordinance enacts only
   * the second, which is why the first needed a record of its own - and why
   * it belongs in front rather than beside it as an afterthought.
   */
  it('puts the estimated receipts immediately before the appropriation', () => {
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    const transactions = (budget?.children ?? []).filter(
      (c) => c.group === 'Budget transactions',
    );
    const receipts = transactions.findIndex((c) => c.to === '/budget/estimated-receipts');
    const appropriation = transactions.findIndex((c) => c.to === '/budget/appropriations');
    expect(receipts).toBe(0);
    expect(appropriation).toBe(receipts + 1);
  });

  /**
   * Allotment is ONE menu item.
   *
   * It was two - "Allotment Release Orders" and "Allotment Register" - sitting
   * next to each other and reading almost identically, and Neil opened the
   * wrong one. Renaming helped and did not fix it: the officer still had to
   * choose between two entries before knowing what was in either.
   *
   * The register and the orders are one subject with two faces, and they are
   * tabs now. A second allotment entry brings the confusion back with it.
   */
  it('gives allotment exactly one menu item', () => {
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    const allotment = (budget?.children ?? []).filter((c) =>
      c.label.toLowerCase().includes('allotment'),
    );
    expect(allotment.map((c) => c.to)).toEqual(['/budget/allotments']);
  });

  /** The order of the group is the order the work happens in. */
  it('lists the budget transactions in the order the work happens', () => {
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    const transactions = (budget?.children ?? []).filter(
      (c) => c.group === 'Budget transactions',
    );
    expect(transactions.map((c) => c.to)).toEqual([
      '/budget/estimated-receipts',
      '/budget/appropriations',
      '/budget/allotments',
      '/budget/obligations',
    ]);
  });

  /**
   * The forms are submitted quarterly and looked at far more often than that.
   * The period is chosen on the screen now, so a label saying "Quarterly"
   * would describe one of the four things the screen does.
   */
  it('does not call the LBAc forms quarterly in the menu', () => {
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    const reports = (budget?.children ?? []).filter((c) => c.group === 'Reports');
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      expect(r.label.toLowerCase()).not.toContain('quarterly');
    }
  });


  it('every heading holds at least one item', () => {
    for (const item of NAVIGATION) {
      for (const block of toBlocks(item.children ?? [])) {
        expect(block.items.length).toBeGreaterThan(0);
      }
    }
  });
});
