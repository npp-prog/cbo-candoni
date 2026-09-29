import { describe, it, expect } from 'vitest';
import { NAVIGATION, groupForPath, toBlocks, type NavChild } from './navigation';

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
   */
  it('keeps the Treasury registers to the four books the office keeps', () => {
    const treasury = NAVIGATION.find((i) => i.to === '/treasury');
    const registers = (treasury?.children ?? []).filter((c) => c.group === 'Registers');
    expect(registers.map((r) => r.label)).toEqual([
      'Checks',
      'ADA',
      'Collections and Deposits',
      'Payroll',
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

  it('every heading holds at least one item', () => {
    for (const item of NAVIGATION) {
      for (const block of toBlocks(item.children ?? [])) {
        expect(block.items.length).toBeGreaterThan(0);
      }
    }
  });
});
