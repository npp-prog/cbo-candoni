import { describe, it, expect } from 'vitest';
import { NAVIGATION, groupForPath, toBlocks, type NavChild } from './navigation';
import { TRUST_TABS } from '@/pages/accounting/trustTabs';
import {
  PAYMENT_TABS,
  COLLECTION_TABS,
  PAYROLL_TABS,
  ACCOUNTABLE_FORM_TABS,
} from '@/pages/treasury/sections';
import {
  ACCOUNTING_MONITORING_TABS,
  ACCOUNTING_SETUP_TABS,
  BUDGET_MONITORING_TABS,
  BUDGET_REPORT_TABS,
  CASH_BOOK_TABS,
  PRINTING_TABS,
  REPORT_TABS,
  sectionHeadForPath,
} from './sections';

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
    // Printing stopped being a heading in patch 94 - it is one menu item with
    // two tabs - so the surviving headings are the ones to ask about.
    expect(groupForPath('/treasury/collections')).toEqual({
      sectionTo: '/treasury',
      group: 'Registers',
    });
  });

  /**
   * The longest-match rule, which exists so that a screen under one heading
   * does not open a different heading because a shorter address also matched.
   */
  it('prefers the longest matching item when two both match', () => {
    expect(groupForPath('/treasury/disbursements')?.group).toBe('Registers');
    expect(groupForPath('/master-data/accounts')?.group).toBeUndefined();
  });

  /**
   * A report that is a tab rather than a menu item still opens its heading.
   *
   * Patch 87 took the Treasury Reports group out of the menu, because every
   * entry in it was already a tab on the register it is drawn from. The RCI
   * is no longer a menu item, so nothing matched `/treasury/checks/rci` and
   * the heading holding it stayed shut - standing on the RCI, the sidebar
   * said nothing about where you were.
   *
   * The strips answer it now: a screen belongs to the register at the head of
   * whichever strip carries it.
   */
  it('opens the register heading for a report that is only a tab', () => {
    for (const path of [
      '/treasury/checks/rci',
      '/treasury/ada/radai',
      '/treasury/checks/unreleased',
      '/reports/cancelled-checks',
      '/treasury/payroll/rcdisb',
      '/treasury/collections/rcd',
      '/treasury/raaf',
    ]) {
      expect(groupForPath(path)?.group, path).toBe('Registers');
    }
  });

  it('matches a detail screen below a menu item', () => {
    expect(groupForPath('/accounting/disbursements/abc123')?.group).toBe(
      'Accounting transactions',
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
   * A loose item never comes BEFORE a heading in the same section.
   *
   * ---------------------------------------------------------------------
   * THIS RULE USED TO SAY "ALL OR NOTHING", AND IT WAS RIGHT UNTIL IT WAS NOT
   * ---------------------------------------------------------------------
   * The worry was that a loose item renders with no heading above it, so it
   * reads as though it belonged to whichever heading came before. While every
   * child was grouped, forbidding the mixture was the simplest way to say so.
   *
   * Patch 94 turned four headings into single items with tab strips, so
   * Budget, Accounting and Treasury each have a grouped run followed by two
   * loose ones. The renderer does not have the problem the rule feared: a
   * heading's items are nested INSIDE the heading's own list element, and a
   * loose item is a sibling of the heading, not of its contents.
   *
   * What is still true, and is what this now checks, is the direction. A loose
   * item written BEFORE a heading sits above it with nothing to say which of
   * the two it belongs to - and the one exception, Estimated Receipts, is
   * inside the Budget transactions group precisely because of it.
   */
  it('never puts a loose item between two headings', () => {
    for (const item of NAVIGATION) {
      const blocks = toBlocks(item.children ?? []);
      const firstGrouped = blocks.findIndex((b) => b.group);
      if (firstGrouped === -1) continue;
      const lastGrouped = blocks.map((b) => !!b.group).lastIndexOf(true);
      for (let i = firstGrouped; i <= lastGrouped; i++) {
        expect(
          blocks[i].group,
          `${item.label}: "${blocks[i].items.map((x) => x.label).join(', ')}" sits between two headings`,
        ).toBeTruthy();
      }
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
  /**
   * A check and an advice to debit are two ways of doing one thing, and which
   * is used is decided per payment, on the day. One menu item, opening on the
   * vouchers waiting to be paid - not two, asking the clerk to choose the
   * instrument before they have seen the voucher.
   */
  it('offers Checks and ADA as one item, opening on the payment queue', () => {
    const treasury = NAVIGATION.find((i) => i.to === '/treasury');
    const children = treasury?.children ?? [];

    const section = children.find((c) => c.label === 'Checks and ADA');
    expect(section, 'Treasury has no Checks and ADA item').toBeTruthy();
    expect(section?.to).toBe('/treasury/disbursements');

    expect(children.find((c) => c.label === 'Checks')).toBeUndefined();
    expect(children.find((c) => c.label === 'ADA')).toBeUndefined();
  });

  /**
   * Paying a voucher is a Treasury act. It is reachable under /treasury and
   * nowhere under /accounting, because the Accountant approves a payment and
   * the Treasurer makes one.
   */
  it('puts no payment queue in the Accounting menu', () => {
    const accounting = NAVIGATION.find((i) => i.to === '/accounting');
    for (const child of accounting?.children ?? []) {
      expect(child.to).not.toContain('disbursements-for-payment');
      expect(child.label.toLowerCase()).not.toContain('issue check');
      expect(child.label.toLowerCase()).not.toContain('prepare ada');
    }
  });

  /**
   * The register is read after the fact, so it comes after the four screens
   * that raise entries rather than before them - and it is in that group at
   * all because an accountant looking for an entry looks where entries are
   * made.
   */
  it('puts the Journal Entries Register straight after General Transactions', () => {
    const accounting = NAVIGATION.find((i) => i.to === '/accounting');
    const children = accounting?.children ?? [];
    const others = children.findIndex((c) => c.to === '/accounting/general-transactions');
    const register = children.findIndex((c) => c.to === '/accounting/journal-entries');

    expect(others, 'General Transactions is not in the Accounting menu').toBeGreaterThan(-1);
    expect(register, 'the Journal Entries Register is not in the Accounting menu').toBe(others + 1);
    expect(children[register].group).toBe('Accounting transactions');
  });

  it('keeps the Treasury registers to the books the office writes in', () => {
    const treasury = NAVIGATION.find((i) => i.to === '/treasury');
    const registers = (treasury?.children ?? []).filter((c) => c.group === 'Registers');
    expect(registers.map((r) => r.label)).toEqual([
      'Checks and ADA',
      'Collections and Deposits',
      'Payroll',
      'Accountable Forms',
    ]);
  });

  /**
   * The order you work in: what is owed, what was drawn, what was reported,
   * who is being paid, and what is still out at year end. Fixed here because
   * it is a sequence somebody asked for by name, and a later addition dropped
   * in the middle of it would undo that quietly.
   */
  it('keeps the Check and ADA sequence', () => {
    expect(PAYMENT_TABS.map((t) => t.label)).toEqual([
      'Disbursements for Payment',
      'Checks',
      'ADA',
      'Report of Checks Issued (RCI)',
      'Report of ADA Issued (RADAI)',
      'Claim Sheet',
      'Unreleased Checks (SUC)',
      // Joined in patch 87, when the Treasury Reports group came out of the
      // sidebar. It was the one report in that group on no strip at all.
      'Cancelled Checks (RCC)',
    ]);
  });

  /**
   * The ADA register and the ADA number series are one book. The series is a
   * tab INSIDE the ADA screen, not a tab beside it.
   */
  it('offers no separate ADA Numbers tab', () => {
    expect(PAYMENT_TABS.find((t) => t.to === '/treasury/ada/numbers')).toBeUndefined();
    expect(PAYMENT_TABS.find((t) => t.label.includes('ADA Numbers'))).toBeUndefined();
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
      [...COLLECTION_TABS, ...PAYMENT_TABS, ...PAYROLL_TABS].map((t) => t.to),
    );
    const submitted = new Set([
      '/treasury/collections/rcd',
      '/treasury/checks/rci',
      '/treasury/ada/radai',
      '/treasury/payroll/rcdisb',
      // GAM Appendix 42, submitted to Accounting at year end.
      '/treasury/checks/unreleased',
    ]);
    // The register each strip hangs off is itself a sidebar item, by design.
    const registers = new Set([
      // Checks and ADA is one item and it opens on the payment queue, so the
      // queue is both the sidebar target and the first tab of its own strip.
      '/treasury/disbursements',
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
   * which belong to the Planning Office and which CFMS holds none of. The
   * temptation with a numbered series is completeness - build all six, leave
   * the physical columns blank - and the result is three mostly-empty forms in
   * the menu that somebody eventually fills the financial half of and submits.
   *
   * If a fourth appears here, it should be because the municipality decided to
   * hold physical performance data, not because the list looked incomplete.
   */
  it('lists the three LBAc reports the municipality files, under Budget', () => {
    // They are a tab strip now rather than a heading, and the strip is reached
    // from the Budget menu - which is the part that ever mattered.
    expect(BUDGET_REPORT_TABS.map((r) => r.to)).toEqual([
      '/budget/reports/receipts',
      '/budget/reports/quarterly-financial',
      '/budget/reports/sre',
    ]);

    const budget = NAVIGATION.find((i) => i.to === '/budget');
    expect(
      (budget?.children ?? []).some((c) => c.to === BUDGET_REPORT_TABS[0].to),
      'the Budget menu does not reach the LBAc reports',
    ).toBe(true);
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
   * one page now - no tabs left to switch between. A second allotment entry
   * brings the confusion back with it.
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

  it('offers no augmentation item anywhere in the menu', () => {
    /*
     * An augmentation is recorded on the Appropriation screen, as one of the
     * types in the Type list. A menu entry of its own would be a second door
     * into the same room, and there were briefly three of them - a form, an
     * authority and a limits screen - spread across two groups.
     */
    const everything = NAVIGATION.flatMap((i) => [i, ...(i.children ?? [])]);
    expect(everything.filter((c) => /augmentation/i.test(c.label ?? ''))).toEqual([]);
    expect(everything.filter((c) => /statutory/i.test(c.label ?? ''))).toEqual([]);
  });

  /**
   * The forms are submitted quarterly and looked at far more often than that.
   * The period is chosen on the screen now, so a label saying "Quarterly"
   * would describe one of the four things the screen does.
   */
  it('does not call the LBAc forms quarterly in the menu', () => {
    expect(BUDGET_REPORT_TABS.length).toBeGreaterThan(0);
    for (const r of BUDGET_REPORT_TABS) {
      expect(r.label.toLowerCase()).not.toContain('quarterly');
    }
  });


  /**
   * The registry is ONE menu item, and the five views are tabs on it.
   *
   * The GAM prescribes four registries whose titles share their first nine
   * words - "Registry of Appropriations, Allotments and Obligations - " - and
   * CFMS adds a summary. Five entries reading almost identically in the sidebar
   * is the arrangement Neil opened the wrong one of when allotment had two,
   * and the words that tell these four apart are at the END of the title,
   * where a narrow sidebar truncates them.
   */
  it('gives the expenditure registry exactly one menu item, whatever the GAM prescribes', () => {
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    const perClass = (budget?.children ?? []).filter((c) => c.to.startsWith('/budget/registry/'));
    expect(perClass).toEqual([]);

    const registry = (budget?.children ?? []).filter((c) => c.to === '/budget/registry');
    expect(registry).toHaveLength(1);
  });

  /**
   * The income registry is NOT one of those tabs.
   *
   * The four RAAO tabs are four cuts of one subject, expenditure. Appendix 23
   * is the other subject, and putting it behind an expenditure register's tab
   * strip is how a register nobody opens comes about.
   */
  it('lists the income registry beside the expenditure one, not inside it', () => {
    // Beside it on the Monitoring strip, which is what "Monitoring" was as a
    // heading. What must not happen is Appendix 23 becoming a tab of the
    // EXPENDITURE registry, which is a different subject.
    expect(BUDGET_MONITORING_TABS.map((t) => t.to)).toEqual([
      '/budget/registry',
      '/budget/registry-income',
    ]);
  });

  /**
   * The Registry of Special Trust Fund sits under Accounting.
   *
   * GAM Appendix 18 is the Accounting Unit's book and trust money was never
   * appropriated, which is the same reason the trust programmes themselves are
   * not in the Budget menu.
   */
  it('keeps the trust registry with the accounting office that maintains it', () => {
    // It is a TAB now rather than a menu entry of its own, so the thing to
    // hold is where it is reachable FROM - which is the point the rule was
    // ever about. Budget must not carry it.
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    for (const trust of TRUST_TABS) {
      expect(
        (budget?.children ?? []).some((c) => c.to === trust.to),
        `${trust.label} is in the Budget menu`,
      ).toBe(false);
    }

    // Reached from Accounting > Monitoring, whose first tab it is.
    expect(ACCOUNTING_MONITORING_TABS[0].label).toBe('Trust Accounts');
    expect(TRUST_TABS.some((t) => t.to === ACCOUNTING_MONITORING_TABS[0].to)).toBe(true);

    const accounting = NAVIGATION.find((i) => i.to === '/accounting');
    expect(
      (accounting?.children ?? []).some((c) => c.to === ACCOUNTING_MONITORING_TABS[0].to),
      'the Accounting menu does not reach Trust Accounts',
    ).toBe(true);
  });

  /**
   * The three trust screens are inside Trust Accounts, not beside it.
   *
   * Three entries in a row made the officer pick one before knowing what was
   * in any of them, and they pushed the rest of Monitoring and Setup down the
   * menu - so the smallest of the three funds took the most room in the list.
   */
  it('lists no trust screen as a menu entry of its own', () => {
    const accounting = NAVIGATION.find((i) => i.to === '/accounting');
    const entries = (accounting?.children ?? []).filter((c) =>
      TRUST_TABS.some((t) => t.to === c.to),
    );
    // Exactly one, and it is the Monitoring item - whose first tab is Trust
    // Accounts - not three entries in a row.
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('Monitoring');
  });

  it('every heading holds at least one item', () => {
    for (const item of NAVIGATION) {
      for (const block of toBlocks(item.children ?? [])) {
        expect(block.items.length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * Budget programmes are not master data (patch 86).
 *
 * "Budget Structure" sat under Master Data, among the offices and banks and
 * tax codes - the things that are true until somebody changes them. A budget
 * programme is not one of those: it is what the Sanggunian appropriated to in
 * one annual budget, and it is read and added to while an appropriation is
 * being encoded. It is a tab beside the appropriations now.
 *
 * Both of these would be undone by somebody "restoring" the menu entry, which
 * is the easiest possible thing to do by accident.
 */
describe('the budget programmes', () => {
  it('are not a Master Data entry', () => {
    const master = NAVIGATION.find((i) => i.to === '/master-data');
    const ppa = (master?.children ?? []).filter(
      (c) => c.to === '/master-data/ppa' || /programme|program|budget structure/i.test(c.label),
    );
    expect(ppa).toEqual([]);
  });

  it('are not a menu entry of their own anywhere', () => {
    const everything = NAVIGATION.flatMap((i) => [i, ...(i.children ?? [])]);
    expect(
      everything.filter((i) => i.to === '/budget/appropriations/programmes'),
    ).toEqual([]);
  });

  it('leave appropriations as the one budget entry that reaches them', () => {
    const budget = NAVIGATION.find((i) => i.to === '/budget');
    const appropriation = (budget?.children ?? []).filter((c) =>
      c.to?.startsWith('/budget/appropriations'),
    );
    expect(appropriation.map((c) => c.to)).toEqual(['/budget/appropriations']);
  });
});

/**
 * Nothing left the menu without somewhere else to be reached from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE TEST THAT MATTERS FOR PATCH 87
 * ---------------------------------------------------------------------------
 * The Treasury Reports group was seven entries, and taking it out was right:
 * every one of them is a report drawn from a register already in the menu, and
 * listing them again in a different part of it taught the office that reporting
 * on the day's work is something you leave the screen to do.
 *
 * But a menu entry is the only thing most people ever use to find a screen. Two
 * of those seven - the RCC and the RAAF - were on no section strip at all, and
 * removing the group without putting them on one would have left them reachable
 * only by typing the address. Nobody would have noticed for months, and then
 * somebody would have asked where the RAAF went.
 *
 * So this is not a test about tabs. It is the condition under which that menu
 * group was allowed to be deleted, written down.
 */
describe('the reports that left the Treasury menu', () => {
  const EVERY_STRIP = [
    ...COLLECTION_TABS,
    ...PAYMENT_TABS,
    ...PAYROLL_TABS,
    ...ACCOUNTABLE_FORM_TABS,
  ];

  const REMOVED = [
    ['Report of Collections and Deposits (RCD)', '/treasury/collections/rcd'],
    ['Report of Checks Issued (RCI)', '/treasury/checks/rci'],
    ['Report of ADA Issued (RADAI)', '/treasury/ada/radai'],
    ['Report of Cash Disbursement (RCDisb)', '/treasury/payroll/rcdisb'],
    ['Report of Cancelled Checks (RCC)', '/reports/cancelled-checks'],
    ['Schedule of Unreleased Checks (SUC)', '/treasury/checks/unreleased'],
    ['Accountability for Accountable Forms (RAAF)', '/treasury/raaf'],
  ] as const;

  it.each(REMOVED)('%s is still reachable from a section strip', (_label, to) => {
    expect(EVERY_STRIP.filter((t) => t.to === to)).toHaveLength(1);
  });

  it('leaves no Treasury Reports group behind', () => {
    const treasury = NAVIGATION.find((i) => i.to === '/treasury');
    const groups = new Set((treasury?.children ?? []).map((c) => c.group));
    expect(groups.has('Treasury Reports')).toBe(false);
  });

  /*
   * The strips answer "which register does this belong to" by their first
   * entry, and `groupForPath` relies on that being a real menu item. If a
   * strip were ever reordered so that its head was a report rather than the
   * register, the sidebar would start opening the wrong heading.
   */
  it('starts every strip with the register it belongs to', () => {
    const registers = (NAVIGATION.find((i) => i.to === '/treasury')?.children ?? [])
      .filter((c) => c.group === 'Registers')
      .map((c) => c.to);

    for (const strip of [COLLECTION_TABS, PAYMENT_TABS, PAYROLL_TABS, ACCOUNTABLE_FORM_TABS]) {
      expect(registers, strip[0].label).toContain(strip[0].to);
    }
  });
});


/**
 * The condition under which patch 94 was allowed to delete five menu headings.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE TEST THAT MATTERS
 * ---------------------------------------------------------------------------
 * Monitoring, Reports, Cash Books, Printing and the eight-item Reports section
 * came out of the sidebar, and every screen that was in them is now a tab.
 * That is right - they are read one after the other, and a heading that hides
 * four lines behind an arrow is a fold, not a map.
 *
 * But a menu entry is the only thing most people ever use to find a screen.
 * Delete a heading without putting its contents on a strip, and those screens
 * are reachable only by typing the address: nobody notices for months, and
 * then somebody asks where the Subsidiary Ledger went. That exact thing nearly
 * happened to the RAAF in patch 87.
 *
 * So these are not tests about tabs. They are the deletion's preconditions,
 * written down.
 */
describe('the headings that left the menu in patch 94', () => {
  const STRIPS = {
    'Budget > Monitoring': BUDGET_MONITORING_TABS,
    'Budget > Reports': BUDGET_REPORT_TABS,
    'Accounting > Monitoring': ACCOUNTING_MONITORING_TABS,
    'Accounting > Setup': ACCOUNTING_SETUP_TABS,
    'Treasury > Cash Books': CASH_BOOK_TABS,
    'Treasury > Printing': PRINTING_TABS,
    Reports: REPORT_TABS,
  };

  const menuTargets = () =>
    NAVIGATION.flatMap((i) => [i.to, ...(i.children ?? []).map((c) => c.to)]);

  /**
   * The head of a strip is the screen the menu names. If it were not in the
   * menu, the whole strip would be unreachable - which is the fault this file
   * exists to prevent.
   */
  it.each(Object.entries(STRIPS))('%s is reachable from the sidebar', (_name, strip) => {
    expect(menuTargets()).toContain(strip[0].to);
  });

  /** Every screen on a strip, reachable. Nothing was orphaned by the change. */
  it.each(Object.entries(STRIPS))('%s carries every screen it took', (name, strip) => {
    expect(strip.length, `${name} is empty`).toBeGreaterThan(0);
    for (const tab of strip) {
      expect(sectionHeadForPath(tab.to), `${tab.label} resolves to no section`).toBe(strip[0].to);
    }
  });

  /**
   * Two screens live at an address that does not say which office they belong
   * to, because that is where they were built. Both are the reason
   * sectionHeadForPath exists rather than the sidebar matching on the address.
   */
  it('puts the two misfiled addresses under the office that owns them', () => {
    expect(sectionHeadForPath('/reports/aging')).toBe(ACCOUNTING_MONITORING_TABS[0].to);
    expect(sectionHeadForPath('/reports/cash-in-local-treasury')).toBe(CASH_BOOK_TABS[0].to);
  });

  /** A screen below a tab still belongs to that tab's strip. */
  it('resolves a detail screen to the strip above it', () => {
    expect(sectionHeadForPath('/reports/budget-vs-actual/lines')).toBe(REPORT_TABS[0].to);
  });

  it('claims nothing it does not own', () => {
    expect(sectionHeadForPath('/audit-trail')).toBeNull();
    expect(sectionHeadForPath('/nowhere')).toBeNull();
    // Not a child of /reports/aging, however much the text matches.
    expect(sectionHeadForPath('/reports/aging-x')).toBeNull();
  });

  /**
   * A strip head is named ONCE in the menu. Listed twice - under its own
   * section and again somewhere else - the sidebar would light two entries for
   * one screen, which tells the reader nothing about where they are.
   */
  it('names each strip head once', () => {
    const targets = menuTargets();
    for (const strip of Object.values(STRIPS)) {
      const head = strip[0].to;
      expect(targets.filter((t) => t === head), head).toHaveLength(1);
    }
  });

  /**
   * And the screens BEHIND a head are not also menu entries. That is the
   * whole point of the change: one door per screen.
   */
  it('leaves no tab behind a head also listed in the menu', () => {
    const targets = new Set(menuTargets());
    for (const strip of Object.values(STRIPS)) {
      for (const tab of strip.slice(1)) {
        expect(targets.has(tab.to), `${tab.label} is both a tab and a menu item`).toBe(false);
      }
    }
  });

  /** The headings themselves are gone, not merely emptied. */
  it.each([
    ['/budget', 'Monitoring'],
    ['/budget', 'Reports'],
    ['/accounting', 'Monitoring and Setup'],
    ['/treasury', 'Cash Books'],
    ['/treasury', 'Printing'],
  ])('leaves no %s > %s heading behind', (sectionTo, heading) => {
    const section = NAVIGATION.find((i) => i.to === sectionTo);
    const groups = new Set((section?.children ?? []).map((c) => c.group));
    expect(groups.has(heading)).toBe(false);
  });

  /** Reconciliation and Reports are single items now, with nothing folded. */
  it.each(['/reconciliation', REPORT_TABS[0].to])('%s is a plain item with no children', (to) => {
    const item = NAVIGATION.find((i) => i.to === to);
    expect(item, `${to} is not in the menu`).toBeTruthy();
    expect(item?.children).toBeUndefined();
  });
});
