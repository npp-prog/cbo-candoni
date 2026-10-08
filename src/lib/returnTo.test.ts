import { describe, it, expect } from 'vitest';
import {
  isInternalPath,
  returnPathFrom,
  returnPathname,
  withReturn,
  hereAsReturn,
  originPathname,
} from './returnTo';

describe('withReturn and returnPathFrom', () => {
  it('carries a list, with its tab, there and back', () => {
    const list = '/accounting/treasury-reports?tab=RCI&status=CERTIFIED';
    const href = withReturn('/treasury/reports/abc', list);

    expect(href.startsWith('/treasury/reports/abc?from=')).toBe(true);
    const search = href.slice(href.indexOf('?'));
    // The tab and the filter come back exactly as they were.
    expect(returnPathFrom(search)).toBe(list);
    expect(returnPathname(search)).toBe('/accounting/treasury-reports');
  });

  it('adds to an address that already has a query', () => {
    const href = withReturn('/treasury/reports/abc/form?copy=1', '/accounting/treasury-reports');
    expect(href).toBe(
      '/treasury/reports/abc/form?copy=1&from=%2Faccounting%2Ftreasury-reports',
    );
  });

  it('leaves the address alone when there is nowhere to return to', () => {
    expect(withReturn('/treasury/reports/abc', null)).toBe('/treasury/reports/abc');
    expect(withReturn('/treasury/reports/abc', '')).toBe('/treasury/reports/abc');
  });

  it('builds the return path from the current location', () => {
    expect(hereAsReturn({ pathname: '/accounting/treasury-reports', search: '?tab=RCD' })).toBe(
      '/accounting/treasury-reports?tab=RCD',
    );
  });

  it('finds nothing when the address carries nothing', () => {
    expect(returnPathFrom('')).toBeNull();
    expect(returnPathFrom('?tab=RCI')).toBeNull();
  });
});

/**
 * Anything in an address can be typed by anyone, and a Back button that went
 * wherever `from` said would follow a link built to send the officer somewhere
 * else. Only a path inside CFMS is accepted; the rest is ignored, and the page
 * falls back to its ordinary default.
 */
describe('isInternalPath', () => {
  it('accepts a path inside CFMS, with or without a query', () => {
    expect(isInternalPath('/accounting/treasury-reports')).toBe(true);
    expect(isInternalPath('/accounting/treasury-reports?tab=RCI')).toBe(true);
  });

  it('refuses another site, however it is written', () => {
    for (const bad of [
      '//evil.example/x',
      'https://evil.example',
      'http:/evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/x/javascript:alert(1)',
      'evil.example',
    ]) {
      expect(isInternalPath(bad), bad).toBe(false);
    }
  });

  it('refuses the empty, the missing and the absurdly long', () => {
    expect(isInternalPath('')).toBe(false);
    expect(isInternalPath(null)).toBe(false);
    expect(isInternalPath(undefined)).toBe(false);
    expect(isInternalPath(`/${'a'.repeat(600)}`)).toBe(false);
  });

  it('does not let a refused path through returnPathFrom', () => {
    expect(returnPathFrom(`?from=${encodeURIComponent('//evil.example')}`)).toBeNull();
    expect(returnPathname(`?from=${encodeURIComponent('https://evil.example')}`)).toBeNull();
  });
});

describe('originPathname', () => {
  it('follows a report back to the list that opened it, through the printed form', () => {
    const list = '/accounting/treasury-reports?tab=RCI';
    const report = withReturn('/treasury/reports/abc', list);
    const form = withReturn('/treasury/reports/abc/form', report);
    const search = form.slice(form.indexOf('?'));

    // One step back is the report; the place the officer started is the list.
    expect(returnPathname(search)).toBe('/treasury/reports/abc');
    expect(originPathname(search)).toBe('/accounting/treasury-reports');
  });

  it('is the return path itself when there is no chain', () => {
    expect(originPathname(`?from=${encodeURIComponent('/treasury/disbursements?x=1')}`)).toBe(
      '/treasury/disbursements',
    );
  });

  it('stops at a bad link in the chain rather than following it', () => {
    const bad = `/treasury/reports/abc?from=${encodeURIComponent('//evil.example')}`;
    expect(originPathname(`?from=${encodeURIComponent(bad)}`)).toBe('/treasury/reports/abc');
  });

  it('is null when nothing was carried', () => {
    expect(originPathname('')).toBeNull();
  });
});
