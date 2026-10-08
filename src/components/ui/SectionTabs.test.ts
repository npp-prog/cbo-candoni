import { describe, it, expect } from 'vitest';
import { currentTab, type StripTab } from './SectionTabs';

/**
 * Which main tab is lit, for any address - including the sub-tab screens
 * that sit under it. Patch 111.
 */
describe('currentTab', () => {
  const strip: StripTab[] = [
    { label: 'Registry (RAAO)', to: '/budget/registry' },
    { label: 'Registry of Income (REAIRR)', to: '/budget/registry-income' },
  ];

  it('lights the tab whose own address it is', () => {
    expect(currentTab(strip, '/budget/registry')).toBe('/budget/registry');
    expect(currentTab(strip, '/budget/registry-income')).toBe('/budget/registry-income');
  });

  it('lights the parent tab on a sub-tab screen below it', () => {
    expect(currentTab(strip, '/budget/registry/ps')).toBe('/budget/registry');
    expect(currentTab(strip, '/budget/registry/fe')).toBe('/budget/registry');
  });

  it('does not mistake a longer name for a child', () => {
    // registry-income is not under registry, however much the text matches.
    expect(currentTab(strip, '/budget/registry-income')).not.toBe('/budget/registry');
    expect(currentTab(strip, '/budget/registryx')).toBeNull();
  });

  it('lights a tab for the sibling screens it owns', () => {
    const trust: StripTab[] = [
      {
        label: 'Trust Accounts',
        to: '/accounting/trust-programs',
        includes: ['/accounting/trust-registry', '/accounting/fund-utilization'],
      },
      { label: 'Cash Advance Summary', to: '/accounting/cash-advances' },
    ];
    expect(currentTab(trust, '/accounting/trust-registry')).toBe('/accounting/trust-programs');
    expect(currentTab(trust, '/accounting/fund-utilization')).toBe('/accounting/trust-programs');
    expect(currentTab(trust, '/accounting/cash-advances')).toBe('/accounting/cash-advances');
  });

  it('prefers the longest matching address', () => {
    const nested: StripTab[] = [
      { label: 'All', to: '/a' },
      { label: 'Deeper', to: '/b', includes: ['/a/b'] },
    ];
    expect(currentTab(nested, '/a/b/c')).toBe('/b');
    expect(currentTab(nested, '/a/x')).toBe('/a');
  });

  it('lights nothing for an address outside the strip', () => {
    expect(currentTab(strip, '/accounting/jev')).toBeNull();
  });
});
