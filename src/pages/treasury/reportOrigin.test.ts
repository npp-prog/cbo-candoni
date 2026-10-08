import { describe, it, expect } from 'vitest';
import { reportOrigin, formBackTarget } from './reportOrigin';
import { withReturn } from '@/lib/returnTo';
import { groupForPath } from '@/layout/navigation';

const TREASURY_RCI = { section: 'Treasury', label: 'RCI', to: '/treasury/disbursements/rci' };
const list = '/accounting/treasury-reports?tab=RCI&status=CERTIFIED';

/**
 * The officer's complaint, as a test: open a report from Accounting, close it,
 * and land back on the Accounting list - on the tab they were on.
 */
describe('reportOrigin', () => {
  it('sends a report opened from Accounting back to Accounting, tab and all', () => {
    const origin = reportOrigin(list, TREASURY_RCI);
    expect(origin).toEqual({ section: 'Accounting', label: 'Treasury reports', to: list });
  });

  it('sends one opened from a Treasury register back to exactly that place', () => {
    const register = '/treasury/disbursements/rci?x=1';
    expect(reportOrigin(register, TREASURY_RCI)).toEqual({ ...TREASURY_RCI, to: register });
  });

  it('falls back to the Treasury register when nothing was carried', () => {
    expect(reportOrigin(null, TREASURY_RCI)).toEqual(TREASURY_RCI);
  });
});

describe('formBackTarget', () => {
  const fallback = { section: 'Treasury', label: 'RCI' };

  it('closes a form opened from the list back to the list (View report)', () => {
    const href = withReturn('/treasury/reports/abc/form', list);
    const search = href.slice(href.indexOf('?'));
    const returnPath = new URLSearchParams(search).get('from');
    expect(formBackTarget('abc', returnPath, fallback)).toEqual({
      to: list,
      label: 'Treasury reports',
    });
  });

  it('closes a form opened from the report back to the report, which still knows the list', () => {
    const report = withReturn('/treasury/reports/abc', list);
    expect(formBackTarget('abc', report, fallback)).toEqual({ to: report, label: 'the report' });
  });

  it('closes a form opened from nowhere back to its report', () => {
    expect(formBackTarget('abc', null, fallback)).toEqual({
      to: '/treasury/reports/abc',
      label: 'the report',
    });
  });
});

/**
 * And the menu. Opened from Accounting, the menu should open the heading the
 * Accountant was standing in - which it does by being asked about the origin
 * rather than about the report's own address.
 */
describe('the menu, asked about the origin', () => {
  it('finds Accounting transactions for the Accounting list', () => {
    expect(groupForPath('/accounting/treasury-reports')).toEqual({
      sectionTo: '/accounting',
      group: 'Accounting transactions',
    });
  });
});
