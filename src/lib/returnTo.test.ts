import { describe, it, expect } from 'vitest';
import {
  isInternalPath,
  returnPathFrom,
  returnPathname,
  withReturn,
  hereAsReturn,
  originPathname,
  backTarget,
  placeName,
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

describe('backTarget - patch 114', () => {
  const fallback = { to: '/budget/obligations', label: 'Obligations' };

  it('goes to the document list when nothing says where it was opened from', () => {
    expect(backTarget('', fallback)).toEqual(fallback);
  });

  it('goes back to the very table it was opened from, with its tab', () => {
    const search = `?from=${encodeURIComponent('/accounting/index-of-payments?tab=PAID')}`;
    expect(backTarget(search, { to: '/accounting/disbursements', label: 'Disbursement Vouchers' })).toEqual({
      to: '/accounting/index-of-payments?tab=PAID',
      label: 'Index of Payment',
    });
  });

  it('goes back to the voucher a link was followed from', () => {
    const search = `?from=${encodeURIComponent('/accounting/disbursements/abc')}`;
    expect(backTarget(search, fallback)).toEqual({
      to: '/accounting/disbursements/abc',
      label: 'the voucher',
    });
  });

  it('names the own list by its proper name, keeping its query', () => {
    const search = `?from=${encodeURIComponent('/budget/obligations?status=PAID')}`;
    expect(backTarget(search, fallback)).toEqual({
      to: '/budget/obligations?status=PAID',
      label: 'Obligations',
    });
  });

  it('ignores a return path that is not inside CFMS', () => {
    expect(backTarget('?from=%2F%2Fevil.example', fallback)).toEqual(fallback);
  });
});

describe('placeName', () => {
  it('names the lists and documents a document is opened from', () => {
    expect(placeName('/accounting/journal-entries')).toBe('Journal Entries Register');
    expect(placeName('/accounting/general-transactions/x1')).toBe('the journal entry');
    expect(placeName('/accounting/jev/x1')).toBe('the journal entry');
    expect(placeName('/budget/obligations/x1?from=%2Fbudget%2Fobligations')).toBe('the obligation');
    expect(placeName('/')).toBe('Dashboard');
    expect(placeName('/somewhere/new')).toBe('where you were');
  });
});
